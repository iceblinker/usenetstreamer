const axios = require('axios');
const { triageNzbs } = require('./nzbTriage');

const DEFAULT_TIME_BUDGET_MS = 35000;
const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_DOWNLOAD_CONCURRENCY = 8;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30000;
const TIMEOUT_ERROR_CODE = 'TRIAGE_TIMEOUT';

function normalizeTitle(title) {
  if (!title) return '';
  return title.toString().trim().toLowerCase();
}

function logEvent(logger, level, message, context) {
  if (!logger) return;
  const payload = context && Object.keys(context).length > 0 ? context : undefined;
  if (typeof logger === 'function') {
    logger(level, message, payload);
    return;
  }
  const fn = typeof logger[level] === 'function' ? logger[level].bind(logger) : null;
  if (fn) fn(message, payload);
}

function normalizeIndexerSet(indexers) {
  if (!Array.isArray(indexers)) return new Set();
  return new Set(indexers.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean));
}

function buildCandidates(nzbResults) {
  const seen = new Set();
  const candidates = [];
  nzbResults.forEach((result, index) => {
    const downloadUrl = result?.downloadUrl;
    if (!downloadUrl || seen.has(downloadUrl)) {
      return;
    }
    seen.add(downloadUrl);
    const size = Number(result?.size ?? 0);
    const title = typeof result?.title === 'string' ? result.title : null;
    candidates.push({
      result,
      index,
      size: Number.isFinite(size) ? size : 0,
      indexerId: result?.indexerId !== undefined ? String(result.indexerId) : null,
      indexerName: typeof result?.indexer === 'string' ? result.indexer : null,
      downloadUrl,
      title,
      normalizedTitle: normalizeTitle(title),
    });
  });
  return candidates;
}

function rankCandidates(candidates, preferredSizeBytes, preferredIndexerSet) {
  const prioritized = preferredIndexerSet.size > 0
    ? candidates.filter((candidate) => {
        const id = candidate.indexerId ? candidate.indexerId.toLowerCase() : null;
        const name = candidate.indexerName ? candidate.indexerName.toLowerCase() : null;
        if (id && preferredIndexerSet.has(id)) return true;
        if (name && preferredIndexerSet.has(name)) return true;
        return false;
      })
    : [];

  const fallback = preferredIndexerSet.size > 0
    ? candidates.filter((candidate) => {
        const id = candidate.indexerId ? candidate.indexerId.toLowerCase() : null;
        const name = candidate.indexerName ? candidate.indexerName.toLowerCase() : null;
        if (id && preferredIndexerSet.has(id)) return false;
        if (name && preferredIndexerSet.has(name)) return false;
        return true;
      })
    : candidates.slice();

  const comparator = Number.isFinite(preferredSizeBytes)
    ? (a, b) => {
        const deltaA = Math.abs((a.size || 0) - preferredSizeBytes);
        const deltaB = Math.abs((b.size || 0) - preferredSizeBytes);
        if (deltaA !== deltaB) return deltaA - deltaB;
        return (b.size || 0) - (a.size || 0);
      }
    : (a, b) => (b.size || 0) - (a.size || 0);

  prioritized.sort(comparator);
  fallback.sort(comparator);
  return prioritized.concat(fallback);
}

function withTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Triage timed out');
      error.code = TIMEOUT_ERROR_CODE;
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function summarizeDecision(decision) {
  const blockers = Array.isArray(decision?.blockers) ? decision.blockers : [];
  const warnings = Array.isArray(decision?.warnings) ? decision.warnings : [];
  const archiveFindings = Array.isArray(decision?.archiveFindings) ? decision.archiveFindings : [];

  let status = 'blocked';
  if (decision?.decision === 'accept' && blockers.length === 0) {
    const positiveFinding = archiveFindings.some((finding) => {
      const label = String(finding?.status || '').toLowerCase();
      return label === 'rar-stored' || label === 'sevenzip-stored' || label === 'segment-ok';
    });
    if (positiveFinding) {
      status = 'verified';
    } else {
      status = 'unverified';
    }
  }

  return {
    status,
    blockers,
    warnings,
    nzbIndex: decision?.nzbIndex ?? null,
    fileCount: decision?.fileCount ?? null,
    archiveFindings,
  };
}

async function triageAndRank(nzbResults, options = {}) {
  const startTs = Date.now();
  const timeBudgetMs = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const preferredSizeBytes = Number.isFinite(options.preferredSizeBytes) ? options.preferredSizeBytes : null;
  const preferredIndexerSet = normalizeIndexerSet(options.preferredIndexerIds);
  const maxCandidates = Math.max(1, options.maxCandidates ?? DEFAULT_MAX_CANDIDATES);
  const logger = options.logger;
  const triageOptions = { ...(options.triageOptions || {}) };

  const candidates = rankCandidates(buildCandidates(nzbResults), preferredSizeBytes, preferredIndexerSet);
  const uniqueCandidates = [];
  const seenTitles = new Set();
  candidates.forEach((candidate) => {
    const titleKey = candidate.normalizedTitle;
    if (titleKey) {
      if (seenTitles.has(titleKey)) return;
      seenTitles.add(titleKey);
    }
    uniqueCandidates.push(candidate);
  });

  const selectedCandidates = uniqueCandidates.slice(0, Math.min(maxCandidates, uniqueCandidates.length));
  if (selectedCandidates.length === 0) {
    return {
      decisions: new Map(),
      elapsedMs: Date.now() - startTs,
      timedOut: false,
      candidatesConsidered: 0,
      evaluatedCount: 0,
      fetchFailures: 0,
      summary: null,
    };
  }

  const candidateByUrl = new Map();
  selectedCandidates.forEach((candidate) => {
    candidateByUrl.set(candidate.downloadUrl, candidate);
  });

  const decisionMap = new Map();

  const attachMetadata = (url, decision) => {
    const candidateInfo = candidateByUrl.get(url);
    if (candidateInfo) {
      decision.title = candidateInfo.title || null;
      decision.normalizedTitle = candidateInfo.normalizedTitle || null;
      decision.indexerId = candidateInfo.indexerId || null;
      decision.indexerName = candidateInfo.indexerName || null;
    } else {
      decision.title = decision.title ?? null;
      decision.normalizedTitle = decision.normalizedTitle ?? null;
    }
    return decision;
  };
  const downloadConcurrency = Math.max(
    1,
    Math.min(options.downloadConcurrency ?? DEFAULT_DOWNLOAD_CONCURRENCY, selectedCandidates.length),
  );
  const downloadTimeoutMs = options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const triageConfig = { ...triageOptions, reuseNntpPool: true };

  let cursor = 0;
  let timedOut = false;
  let evaluatedCount = 0;
  let fetchFailures = 0;

  const makeTimeoutDecision = (url) => attachMetadata(url, {
    status: 'error',
    blockers: ['triage-error'],
    warnings: ['Triage timed out'],
    archiveFindings: [],
    nzbIndex: null,
    fileCount: null,
  });

  const workers = Array.from({ length: downloadConcurrency }, async () => {
    while (true) {
      if (timedOut) return;
      const index = cursor;
      if (index >= selectedCandidates.length) return;
      cursor += 1;

      const candidate = selectedCandidates[index];
      const { downloadUrl } = candidate;

      if (decisionMap.has(downloadUrl)) continue;

      if (Date.now() - startTs >= timeBudgetMs) {
        timedOut = true;
        decisionMap.set(downloadUrl, makeTimeoutDecision(downloadUrl));
        continue;
      }

      let nzbPayload;
      try {
        const response = await axios.get(downloadUrl, {
          responseType: 'text',
          timeout: downloadTimeoutMs,
          headers: {
            Accept: 'application/x-nzb,text/xml;q=0.9,*/*;q=0.8',
            'User-Agent': 'UsenetStreamer-Triage',
          },
          transitional: { silentJSONParsing: true, forcedJSONParsing: false },
        });
        if (typeof response.data !== 'string' || response.data.length === 0) {
          throw new Error('Empty NZB payload');
        }
        nzbPayload = response.data;
      } catch (err) {
        fetchFailures += 1;
        decisionMap.set(downloadUrl, attachMetadata(downloadUrl, {
          status: 'fetch-error',
          error: err?.message || 'Failed to fetch NZB payload',
          blockers: ['fetch-error'],
          warnings: [],
          archiveFindings: [],
          nzbIndex: null,
          fileCount: null,
        }));
        logEvent(logger, 'warn', 'Failed to download NZB for triage', {
          downloadUrl,
          message: err?.message,
        });
        continue;
      }

      const triageTask = async () => {
        const remaining = timeBudgetMs - (Date.now() - startTs);
        if (remaining <= 0) {
          const timeoutError = new Error('Triage timed out');
          timeoutError.code = TIMEOUT_ERROR_CODE;
          throw timeoutError;
        }
        return withTimeout(triageNzbs([nzbPayload], triageConfig), remaining);
      };

      try {
        const summary = await triageTask();
        const firstDecision = summary?.decisions?.[0];
        if (firstDecision) {
          const summarized = summarizeDecision(firstDecision);
          decisionMap.set(downloadUrl, attachMetadata(downloadUrl, summarized));
          evaluatedCount += 1;
        } else {
          decisionMap.set(downloadUrl, attachMetadata(downloadUrl, {
            status: 'error',
            blockers: ['triage-error'],
            warnings: ['No decision returned'],
            archiveFindings: [],
            nzbIndex: null,
            fileCount: null,
          }));
        }
      } catch (err) {
        if (err?.code === TIMEOUT_ERROR_CODE) {
          timedOut = true;
          decisionMap.set(downloadUrl, makeTimeoutDecision(downloadUrl));
        } else {
          decisionMap.set(downloadUrl, attachMetadata(downloadUrl, {
            status: 'error',
            blockers: ['triage-error'],
            warnings: err?.message ? [err.message] : [],
            archiveFindings: [],
            nzbIndex: null,
            fileCount: null,
          }));
        }
        logEvent(logger, 'warn', 'NZB triage failed', { message: err?.message });
      }
    }
  });

  await Promise.all(workers);

  selectedCandidates.forEach((candidate) => {
    if (!decisionMap.has(candidate.downloadUrl)) {
      decisionMap.set(candidate.downloadUrl, attachMetadata(candidate.downloadUrl, {
        status: timedOut ? 'pending' : 'skipped',
        blockers: [],
        warnings: [],
        archiveFindings: [],
        nzbIndex: null,
        fileCount: null,
      }));
    }
  });

  return {
    decisions: decisionMap,
    elapsedMs: Date.now() - startTs,
    timedOut,
    candidatesConsidered: selectedCandidates.length,
    evaluatedCount,
    fetchFailures,
    summary: null,
  };
}

module.exports = {
  triageAndRank,
};
