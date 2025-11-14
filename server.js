require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const { pipeline } = require('stream');
const { promisify } = require('util');
// webdav is an ES module; we'll import it lazily when first needed
const path = require('path');
const runtimeEnv = require('./config/runtimeEnv');
const {
  testIndexerConnection,
  testNzbdavConnection,
  testUsenetConnection,
} = require('./connectionTests');
const { triageAndRank } = require('./nzbTriageRunner');

runtimeEnv.applyRuntimeEnv();

const app = express();
const port = Number(process.env.PORT || 7000);
const ADDON_VERSION = '1.3.0';

app.use(cors());
app.use('/assets', express.static(path.join(__dirname, 'assets')));

const adminApiRouter = express.Router();
adminApiRouter.use(express.json({ limit: '1mb' }));
const adminStatic = express.static(path.join(__dirname, 'admin'));

adminApiRouter.get('/config', (req, res) => {
  const values = collectConfigValues(ADMIN_CONFIG_KEYS);
  res.json({
    values,
    manifestUrl: computeManifestUrl(),
    runtimeEnvPath: runtimeEnv.RUNTIME_ENV_FILE,
  });
});

function scheduleRestart() {
  setTimeout(() => {
    console.log('[ADMIN] Restarting service to apply configuration changes...');
    process.exit(0);
  }, 300);
}
adminApiRouter.post('/config', (req, res) => {
  const payload = req.body || {};
  const incoming = payload.values;
  if (!incoming || typeof incoming !== 'object') {
    res.status(400).json({ error: 'Invalid payload: expected "values" object' });
    return;
  }

  const updates = {};
  ADMIN_CONFIG_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(incoming, key)) {
      const value = incoming[key];
      if (value === null || value === undefined) {
        updates[key] = '';
      } else if (typeof value === 'boolean') {
        updates[key] = value ? 'true' : 'false';
      } else {
        updates[key] = String(value);
      }
    }
  });

  try {
    runtimeEnv.updateRuntimeEnv(updates);
    runtimeEnv.applyRuntimeEnv();
  } catch (error) {
    console.error('[ADMIN] Failed to update configuration', error);
    res.status(500).json({ error: 'Failed to persist configuration changes' });
    return;
  }

  res.json({ success: true, manifestUrl: computeManifestUrl(), restarting: true });
  scheduleRestart();
});

adminApiRouter.post('/test-connections', async (req, res) => {
  const payload = req.body || {};
  const { type, values } = payload;
  if (!type || typeof values !== 'object') {
    res.status(400).json({ error: 'Invalid payload: expected "type" and "values"' });
    return;
  }

  try {
    let message;
    switch (type) {
      case 'indexer':
        message = await testIndexerConnection(values);
        break;
      case 'nzbdav':
        message = await testNzbdavConnection(values);
        break;
      case 'usenet':
        message = await testUsenetConnection(values);
        break;
      default:
        res.status(400).json({ error: `Unknown test type: ${type}` });
        return;
    }
    res.json({ status: 'ok', message });
  } catch (error) {
    const reason = error?.message || 'Connection test failed';
    res.json({ status: 'error', message: reason });
  }
});

function extractTokenFromRequest(req) {
  const pathMatch = (req.path || '').match(/^\/([^\/]+)\/(manifest\.json|stream|nzb)(?:\b|\/)/i);
  if (pathMatch && pathMatch[1]) {
    return pathMatch[1].trim();
  }
  if (req.params && typeof req.params.token === 'string') {
    return req.params.token.trim();
  }
  const authHeader = req.headers['authorization'] || req.headers['x-addon-token'];
  if (typeof authHeader === 'string') {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && /^token$/i.test(parts[0])) {
      return parts[1].trim();
    }
    return authHeader.trim();
  }
  return '';
}

function ensureSharedSecret(req, res, next) {
  if (!ADDON_SHARED_SECRET) {
    next();
    return;
  }
  if (req.method === 'OPTIONS') {
    next();
    return;
  }
  const providedToken = extractTokenFromRequest(req);
  if (!providedToken || providedToken !== ADDON_SHARED_SECRET) {
    res.status(401).json({ error: 'Unauthorized: invalid or missing addon token' });
    return;
  }
  next();
}

app.use('/admin/api', (req, res, next) => ensureSharedSecret(req, res, next), adminApiRouter);
app.use('/admin', adminStatic);
app.use('/:token/admin', (req, res, next) => {
  ensureSharedSecret(req, res, (err) => {
    if (err) return;
    adminStatic(req, res, next);
  });
});

app.use((req, res, next) => {
  if (req.path.startsWith('/assets/')) return next();
  if (req.path.startsWith('/admin') && !req.path.startsWith('/admin/api')) return next();
  if (/^\/[^/]+\/admin/.test(req.path) && !/^\/[^/]+\/admin\/api/.test(req.path)) return next();
  return ensureSharedSecret(req, res, next);
});

// Additional authentication middleware is registered after admin routes are defined

// Configure indexer manager (Prowlarr or NZBHydra)
const INDEXER_MANAGER = (process.env.INDEXER_MANAGER || 'prowlarr').trim().toLowerCase();
const INDEXER_MANAGER_URL = (process.env.INDEXER_MANAGER_URL || process.env.PROWLARR_URL || '').trim();
const INDEXER_MANAGER_API_KEY = (process.env.INDEXER_MANAGER_API_KEY || process.env.PROWLARR_API_KEY || '').trim();
const INDEXER_MANAGER_STRICT_ID_MATCH = (process.env.INDEXER_MANAGER_STRICT_ID_MATCH || process.env.PROWLARR_STRICT_ID_MATCH || 'false').toLowerCase() === 'true';
const INDEXER_MANAGER_INDEXERS = (() => {
  const fallback = INDEXER_MANAGER === 'nzbhydra' ? '' : '-1';
  const raw = (process.env.INDEXER_MANAGER_INDEXERS || process.env.PROWLARR_INDEXER_IDS || '').trim();
  if (!raw) return fallback;
  const joined = raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .join(',');
  return joined || fallback;
})();
const INDEXER_MANAGER_LABEL = INDEXER_MANAGER === 'nzbhydra' ? 'NZBHydra' : 'Prowlarr';
const INDEXER_LOG_PREFIX = `[${INDEXER_MANAGER_LABEL.toUpperCase()}]`;
const INDEXER_MANAGER_CACHE_MINUTES = (() => {
  const raw = Number(process.env.INDEXER_MANAGER_CACHE_MINUTES);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10;
})();
const INDEXER_MANAGER_BASE_URL = INDEXER_MANAGER_URL.replace(/\/+$/, '');
const ADDON_SHARED_SECRET = (process.env.ADDON_SHARED_SECRET || '').trim();

function decodeBase64Value(value) {
  if (!value) return '';
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch (error) {
    console.warn('[SPECIAL META] Failed to decode base64 value');
    return '';
  }
}

function stripTrailingSlashes(value) {
  if (!value) return '';
  let result = value;
  while (result.endsWith('/')) {
    result = result.slice(0, -1);
  }
  return result;
}

function toFiniteNumber(value, defaultValue = undefined) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const num = Number(value);
  return Number.isFinite(num) ? num : defaultValue;
}

function toPositiveInt(value, defaultValue) {
  const parsed = toFiniteNumber(value, undefined);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.floor(parsed);
}

function toBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function parseCommaList(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parsePathList(value) {
  if (typeof value !== 'string' || value.trim() === '') return [];
  return value
    .split(path.delimiter)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => (path.isAbsolute(segment) ? segment : path.resolve(process.cwd(), segment)));
}

function collectConfigValues(keys) {
  const values = {};
  keys.forEach((key) => {
    values[key] = process.env[key] ?? '';
  });
  return values;
}

function computeManifestUrl() {
  const baseUrl = (process.env.ADDON_BASE_URL || '').trim();
  if (!baseUrl) return '';
  const normalizedBase = baseUrl.replace(/\/$/, '');
  const tokenSegment = ADDON_SHARED_SECRET ? `/${ADDON_SHARED_SECRET}` : '';
  return `${normalizedBase}${tokenSegment}/manifest.json`;
}

function buildTriageNntpConfig() {
  const host = (process.env.NZB_TRIAGE_NNTP_HOST || '').trim();
  if (!host) return null;
  return {
    host,
    port: toPositiveInt(process.env.NZB_TRIAGE_NNTP_PORT, 119),
    user: (process.env.NZB_TRIAGE_NNTP_USER || '').trim() || undefined,
    pass: (process.env.NZB_TRIAGE_NNTP_PASS || '').trim() || undefined,
    useTLS: toBoolean(process.env.NZB_TRIAGE_NNTP_TLS, false),
  };
}

const TRIAGE_ENABLED = toBoolean(process.env.NZB_TRIAGE_ENABLED, false);
const TRIAGE_TIME_BUDGET_MS = toPositiveInt(process.env.NZB_TRIAGE_TIME_BUDGET_MS, 35000);
const TRIAGE_MAX_CANDIDATES = toPositiveInt(process.env.NZB_TRIAGE_MAX_CANDIDATES, 25);
const TRIAGE_DOWNLOAD_CONCURRENCY = toPositiveInt(process.env.NZB_TRIAGE_DOWNLOAD_CONCURRENCY, 8);
const TRIAGE_PREFERRED_SIZE_GB = toFiniteNumber(process.env.NZB_TRIAGE_PREFERRED_SIZE_GB, null);
const TRIAGE_PREFERRED_SIZE_BYTES = Number.isFinite(TRIAGE_PREFERRED_SIZE_GB) && TRIAGE_PREFERRED_SIZE_GB > 0
  ? TRIAGE_PREFERRED_SIZE_GB * 1024 * 1024 * 1024
  : null;
const TRIAGE_PRIORITY_INDEXERS = parseCommaList(process.env.NZB_TRIAGE_PRIORITY_INDEXERS);
const TRIAGE_ARCHIVE_DIRS = parsePathList(process.env.NZB_TRIAGE_ARCHIVE_DIRS);
const TRIAGE_NNTP_CONFIG = buildTriageNntpConfig();
const TRIAGE_MAX_DECODED_BYTES = toPositiveInt(process.env.NZB_TRIAGE_MAX_DECODED_BYTES, 32 * 1024);
const TRIAGE_NNTP_MAX_CONNECTIONS = toPositiveInt(process.env.NZB_TRIAGE_MAX_CONNECTIONS, 60);
const TRIAGE_MAX_PARALLEL_NZBS = toPositiveInt(process.env.NZB_TRIAGE_MAX_PARALLEL_NZBS, 16);
const TRIAGE_STAT_SAMPLE_COUNT = toPositiveInt(process.env.NZB_TRIAGE_STAT_SAMPLE_COUNT, 2);
const TRIAGE_ARCHIVE_SAMPLE_COUNT = toPositiveInt(process.env.NZB_TRIAGE_ARCHIVE_SAMPLE_COUNT, 1);
const TRIAGE_REUSE_POOL = toBoolean(process.env.NZB_TRIAGE_REUSE_POOL, false);
const TRIAGE_NNTP_KEEP_ALIVE_MS = toPositiveInt(process.env.NZB_TRIAGE_NNTP_KEEP_ALIVE_MS, 0);

const TRIAGE_BASE_OPTIONS = {
  archiveDirs: TRIAGE_ARCHIVE_DIRS,
  maxDecodedBytes: TRIAGE_MAX_DECODED_BYTES,
  nntpMaxConnections: TRIAGE_NNTP_MAX_CONNECTIONS,
  maxParallelNzbs: TRIAGE_MAX_PARALLEL_NZBS,
  statSampleCount: TRIAGE_STAT_SAMPLE_COUNT,
  archiveSampleCount: TRIAGE_ARCHIVE_SAMPLE_COUNT,
  reuseNntpPool: TRIAGE_REUSE_POOL,
  nntpKeepAliveMs: TRIAGE_NNTP_KEEP_ALIVE_MS,
  healthCheckTimeoutMs: TRIAGE_TIME_BUDGET_MS,
};

const ADMIN_CONFIG_KEYS = [
  'PORT',
  'ADDON_BASE_URL',
  'ADDON_SHARED_SECRET',
  'INDEXER_MANAGER',
  'INDEXER_MANAGER_URL',
  'INDEXER_MANAGER_API_KEY',
  'INDEXER_MANAGER_STRICT_ID_MATCH',
  'INDEXER_MANAGER_INDEXERS',
  'INDEXER_MANAGER_CACHE_MINUTES',
  'NZBDAV_URL',
  'NZBDAV_API_KEY',
  'NZBDAV_WEBDAV_URL',
  'NZBDAV_WEBDAV_USER',
  'NZBDAV_WEBDAV_PASS',
  'NZBDAV_CATEGORY',
  'NZBDAV_CATEGORY_MOVIES',
  'NZBDAV_CATEGORY_SERIES',
  'SPECIAL_PROVIDER_ID',
  'SPECIAL_PROVIDER_URL',
  'SPECIAL_PROVIDER_SECRET',
  'NZB_TRIAGE_ENABLED',
  'NZB_TRIAGE_TIME_BUDGET_MS',
  'NZB_TRIAGE_MAX_CANDIDATES',
  'NZB_TRIAGE_PREFERRED_SIZE_GB',
  'NZB_TRIAGE_PRIORITY_INDEXERS',
  'NZB_TRIAGE_DOWNLOAD_CONCURRENCY',
  'NZB_TRIAGE_MAX_CONNECTIONS',
  'NZB_TRIAGE_MAX_PARALLEL_NZBS',
  'NZB_TRIAGE_STAT_SAMPLE_COUNT',
  'NZB_TRIAGE_ARCHIVE_SAMPLE_COUNT',
  'NZB_TRIAGE_MAX_DECODED_BYTES',
  'NZB_TRIAGE_NNTP_HOST',
  'NZB_TRIAGE_NNTP_PORT',
  'NZB_TRIAGE_NNTP_TLS',
  'NZB_TRIAGE_NNTP_USER',
  'NZB_TRIAGE_NNTP_PASS',
  'NZB_TRIAGE_ARCHIVE_DIRS',
  'NZB_TRIAGE_REUSE_POOL',
  'NZB_TRIAGE_NNTP_KEEP_ALIVE_MS',
];

function extractTriageOverrides(query) {
  if (!query || typeof query !== 'object') return {};
  const sizeCandidate = query.triageSizeGb ?? query.triage_size_gb ?? query.preferredSizeGb;
  const sizeGb = toFiniteNumber(sizeCandidate, null);
  const sizeBytes = Number.isFinite(sizeGb) && sizeGb > 0 ? sizeGb * 1024 * 1024 * 1024 : null;
  let indexerSource = null;
  if (typeof query.triageIndexerIds === 'string') indexerSource = query.triageIndexerIds;
  else if (Array.isArray(query.triageIndexerIds)) indexerSource = query.triageIndexerIds.join(',');
  const indexers = indexerSource ? parseCommaList(indexerSource) : null;
  const disabled = query.triageDisabled !== undefined ? toBoolean(query.triageDisabled, true) : null;
  const enabled = query.triageEnabled !== undefined ? toBoolean(query.triageEnabled, false) : null;
  return { sizeBytes, indexers, disabled, enabled };
}

const OBFUSCATED_SPECIAL_PROVIDER_URL = 'aHR0cHM6Ly9kaXJ0eS1waW5rLmVycy5wdw==';
const OBFUSCATED_SPECIAL_ID_PREFIX = 'cG9ybmRi';
const SPECIAL_ID_PREFIX = decodeBase64Value(OBFUSCATED_SPECIAL_ID_PREFIX) || String.fromCharCode(112, 111, 114, 110, 100, 98);
const specialCatalogPrefixes = new Set(['pt', SPECIAL_ID_PREFIX]);
const EXTERNAL_SPECIAL_PROVIDER_URL = (() => {
  const configured = (process.env.EXTERNAL_SPECIAL_ADDON_URL || process.env.EXTERNAL_ADDON_URL || '').trim();
  if (configured) {
    return stripTrailingSlashes(configured);
  }
  const decoded = decodeBase64Value(OBFUSCATED_SPECIAL_PROVIDER_URL);
  return decoded ? stripTrailingSlashes(decoded) : '';
})();

// Configure NZBDav
const ADDON_BASE_URL = (process.env.ADDON_BASE_URL || '').trim();
const NZBDAV_URL = (process.env.NZBDAV_URL || '').trim();
const NZBDAV_API_KEY = (process.env.NZBDAV_API_KEY || '').trim();
const NZBDAV_CATEGORY_MOVIES = process.env.NZBDAV_CATEGORY_MOVIES || 'Movies';
const NZBDAV_CATEGORY_SERIES = process.env.NZBDAV_CATEGORY_SERIES || 'Tv';
const NZBDAV_CATEGORY_DEFAULT = process.env.NZBDAV_CATEGORY_DEFAULT || 'Movies';
const NZBDAV_CATEGORY_OVERRIDE = (process.env.NZBDAV_CATEGORY || '').trim();
const NZBDAV_POLL_INTERVAL_MS = 2000;
const NZBDAV_POLL_TIMEOUT_MS = 80000;
const NZBDAV_HISTORY_FETCH_LIMIT = (() => {
  const raw = Number(process.env.NZBDAV_HISTORY_FETCH_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 500) : 400;
})();
const NZBDAV_CACHE_TTL_MINUTES = (() => {
  const raw = Number(process.env.NZBDAV_CACHE_TTL_MINUTES);
  if (Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  if (raw === 0) {
    return 0;
  }
  return 1440; // default 24 hours
})();
const NZBDAV_CACHE_TTL_MS = NZBDAV_CACHE_TTL_MINUTES > 0 ? NZBDAV_CACHE_TTL_MINUTES * 60 * 1000 : 0;
const NZBDAV_MAX_DIRECTORY_DEPTH = 6;
const NZBDAV_WEBDAV_USER = (process.env.NZBDAV_WEBDAV_USER || '').trim();
const NZBDAV_WEBDAV_PASS = (process.env.NZBDAV_WEBDAV_PASS || '').trim();
const NZBDAV_WEBDAV_ROOT = '/';
const NZBDAV_WEBDAV_URL = (process.env.NZBDAV_WEBDAV_URL || NZBDAV_URL).trim();
const NZBDAV_API_TIMEOUT_MS = 80000;
const NZBDAV_HISTORY_TIMEOUT_MS = 60000;
const NZBDAV_STREAM_TIMEOUT_MS = 240000;
const FAILURE_VIDEO_FILENAME = 'failure_video.mp4';
const FAILURE_VIDEO_PATH = path.resolve(__dirname, 'assets', FAILURE_VIDEO_FILENAME);
const STREAM_HIGH_WATER_MARK = (() => {
  const parsed = Number(process.env.STREAM_HIGH_WATER_MARK);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4 * 1024 * 1024;
})();

const CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta';
const pipelineAsync = promisify(pipeline);

const posixPath = path.posix;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const nzbdavStreamCache = new Map();
const NZBDAV_VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mkv',
  '.avi',
  '.mov',
  '.wmv',
  '.flv',
  '.webm',
  '.m4v',
  '.ts',
  '.m2ts',
  '.mpg',
  '.mpeg'
]);
const NZBDAV_SUPPORTED_METHODS = new Set(['GET', 'HEAD']);
const VIDEO_MIME_MAP = new Map([
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.mkv', 'video/x-matroska'],
  ['.webm', 'video/webm'],
  ['.avi', 'video/x-msvideo'],
  ['.mov', 'video/quicktime'],
  ['.wmv', 'video/x-ms-wmv'],
  ['.flv', 'video/x-flv'],
  ['.ts', 'video/mp2t'],
  ['.m2ts', 'video/mp2t'],
  ['.mpg', 'video/mpeg'],
  ['.mpeg', 'video/mpeg']
]);

function ensureNzbdavConfigured() {
  if (!NZBDAV_URL) {
    throw new Error('NZBDAV_URL is not configured');
  }
  if (!NZBDAV_API_KEY) {
    throw new Error('NZBDAV_API_KEY is not configured');
  }
  if (!NZBDAV_WEBDAV_URL) {
    throw new Error('NZBDAV_WEBDAV_URL is not configured');
  }
}

function ensureIndexerManagerConfigured() {
  if (!INDEXER_MANAGER_URL) {
    throw new Error('INDEXER_MANAGER_URL is not configured');
  }
  if (!INDEXER_MANAGER_API_KEY) {
    throw new Error('INDEXER_MANAGER_API_KEY is not configured');
  }
}

function ensureAddonConfigured() {
  if (!ADDON_BASE_URL) {
    throw new Error('ADDON_BASE_URL is not configured');
  }
}

const isUsingProwlarr = () => INDEXER_MANAGER === 'prowlarr';
const isUsingNzbhydra = () => INDEXER_MANAGER === 'nzbhydra';

function buildProwlarrSearchParams(plan) {
  return {
    limit: '25',
    offset: '0',
    type: plan.type,
    query: plan.query,
    indexerIds: INDEXER_MANAGER_INDEXERS || undefined
  };
}

async function executeProwlarrSearch(plan) {
  const params = buildProwlarrSearchParams(plan);
  const response = await axios.get(`${INDEXER_MANAGER_BASE_URL}/api/v1/search`, {
    params,
    headers: { 'X-Api-Key': INDEXER_MANAGER_API_KEY },
    timeout: 60000
  });
  return Array.isArray(response.data) ? response.data : [];
}

function mapHydraSearchType(planType) {
  if (planType === 'tvsearch' || planType === 'movie' || planType === 'search' || planType === 'book') {
    return planType;
  }
  return 'search';
}

function applyTokenToHydraParams(token, params) {
  const match = token.match(/^\{([^:]+):(.*)\}$/);
  if (!match) {
    return;
  }
  const key = match[1].trim().toLowerCase();
  const rawValue = match[2].trim();

  switch (key) {
    case 'imdbid': {
      const value = rawValue.replace(/^tt/i, '');
      if (value) params.imdbid = value;
      break;
    }
    case 'tmdbid':
      if (rawValue) params.tmdbid = rawValue;
      break;
    case 'tvdbid':
      if (rawValue) params.tvdbid = rawValue;
      break;
    case 'season':
      if (rawValue) params.season = rawValue;
      break;
    case 'episode':
      if (rawValue) params.ep = rawValue;
      break;
    default:
      break;
  }
}

function buildHydraSearchParams(plan) {
  const params = {
    apikey: INDEXER_MANAGER_API_KEY,
    t: mapHydraSearchType(plan.type),
    o: 'json'
  };

  if (INDEXER_MANAGER_INDEXERS) {
    params.indexers = INDEXER_MANAGER_INDEXERS;
  }

  if (INDEXER_MANAGER_CACHE_MINUTES > 0) {
    params.cachetime = String(INDEXER_MANAGER_CACHE_MINUTES);
  }

  if (Array.isArray(plan.tokens)) {
    plan.tokens.forEach((token) => applyTokenToHydraParams(token, params));
  }

  if (plan.rawQuery) {
    params.q = plan.rawQuery;
  } else if ((!plan.tokens || plan.tokens.length === 0) && plan.query) {
    params.q = plan.query;
  }

  return params;
}

function extractHydraAttrMap(item) {
  const attrMap = {};
  const attrSources = [];

  const collectSource = (source) => {
    if (!source) return;
    if (Array.isArray(source)) {
      source.forEach((entry) => attrSources.push(entry));
    } else {
      attrSources.push(source);
    }
  };

  collectSource(item.attr);
  collectSource(item.attrs);
  collectSource(item.attributes);
  collectSource(item['newznab:attr']);
  collectSource(item['newznab:attrs']);

  attrSources.forEach((attr) => {
    if (!attr) return;
    const entry = attr['@attributes'] || attr.attributes || attr.$ || attr;
    const rawName =
      entry.name ??
      entry.Name ??
      entry['@name'] ??
      entry['@Name'] ??
      entry.key ??
      entry.Key ??
      entry['@key'] ??
      entry['@Key'] ??
      entry.field ??
      entry.Field ??
      '';
    const name = rawName.toString().trim().toLowerCase();
    if (!name) return;
    const value =
      entry.value ??
      entry.Value ??
      entry['@value'] ??
      entry['@Value'] ??
      entry.val ??
      entry.Val ??
      entry.content ??
      entry.Content ??
      entry['#text'] ??
      entry.text ??
      entry['@text'];
    if (value !== undefined && value !== null) {
      attrMap[name] = value;
    }
  });

  return attrMap;
}

function normalizeHydraResults(data) {
  if (!data) return [];

  const resolveItems = (payload) => {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;
    if (payload.item) return resolveItems(payload.item);
    return [payload];
  };

  const channel = data.channel || data.rss?.channel || data['rss']?.channel;
  const items = resolveItems(channel || data.item || []);

  const results = [];

  for (const item of items) {
    if (!item) continue;
    const title = item.title || item['title'] || null;

    let downloadUrl = null;
    const enclosure = item.enclosure || item['enclosure'];
    if (enclosure) {
      const enclosureObj = Array.isArray(enclosure) ? enclosure[0] : enclosure;
      downloadUrl = enclosureObj?.url || enclosureObj?.['@url'] || enclosureObj?.href || enclosureObj?.link;
    }
    if (!downloadUrl) {
      downloadUrl = item.link || item['link'];
    }
    if (!downloadUrl) {
      const guid = item.guid || item['guid'];
      if (typeof guid === 'string') {
        downloadUrl = guid;
      } else if (guid && typeof guid === 'object') {
        downloadUrl = guid._ || guid['#text'] || guid.url || guid.href;
      }
    }
    if (!downloadUrl) {
      continue;
    }

    const attrMap = extractHydraAttrMap(item);
    const resolveFirst = (...candidates) => {
      for (const candidate of candidates) {
        if (candidate === undefined || candidate === null) continue;
        if (Array.isArray(candidate)) {
          const inner = resolveFirst(...candidate);
          if (inner !== undefined && inner !== null) return inner;
          continue;
        }
        if (typeof candidate === 'string') {
          const trimmed = candidate.trim();
          if (!trimmed) continue;
          return trimmed;
        }
        return candidate;
      }
      return undefined;
    };

    const enclosureObj = Array.isArray(enclosure) ? enclosure?.[0] : enclosure;
    const enclosureLength = enclosureObj?.length || enclosureObj?.['@length'] || enclosureObj?.['$']?.length || enclosureObj?.['@attributes']?.length;

    const sizeValue = resolveFirst(
      attrMap.size,
      attrMap.filesize,
      attrMap['contentlength'],
      attrMap['content-length'],
      attrMap.length,
      attrMap.nzbsize,
      item.size,
      item.Size,
      enclosureLength
    );
    const parsedSize = sizeValue !== undefined ? Number.parseInt(String(sizeValue), 10) : NaN;
    const indexer = resolveFirst(
      attrMap.indexername,
      attrMap.indexer,
      attrMap['hydraindexername'],
      attrMap['hydraindexer'],
      item.hydraIndexerName,
      item.hydraindexername,
      item.hydraIndexer,
      item.hydraindexer,
      item.indexer,
      item.Indexer
    );
    const indexerId = resolveFirst(attrMap.indexerid, attrMap['hydraindexerid'], item.hydraIndexerId, item.hydraindexerid, indexer) || 'nzbhydra';

    const guidRaw = item.guid || item['guid'];
    let guidValue = null;
    if (typeof guidRaw === 'string') {
      guidValue = guidRaw;
    } else if (guidRaw && typeof guidRaw === 'object') {
      guidValue = guidRaw._ || guidRaw['#text'] || guidRaw.url || guidRaw.href || null;
    }

    results.push({
      title: title || downloadUrl,
      downloadUrl,
      guid: guidValue,
      size: Number.isFinite(parsedSize) ? parsedSize : undefined,
      indexer,
      indexerId
    });
  }

  return results;
}

async function executeNzbhydraSearch(plan) {
  const params = buildHydraSearchParams(plan);
  const response = await axios.get(`${INDEXER_MANAGER_BASE_URL}/api`, {
    params,
    timeout: 60000
  });
  return normalizeHydraResults(response.data);
}

function executeIndexerPlan(plan) {
  if (isUsingNzbhydra()) {
    return executeNzbhydraSearch(plan);
  }
  return executeProwlarrSearch(plan);
}

function getNzbdavCategory(type) {
  let baseCategory;
  let suffixKey;

  if (type === 'series' || type === 'tv') {
    baseCategory = NZBDAV_CATEGORY_SERIES;
    suffixKey = 'TV';
  } else if (type === 'movie') {
    baseCategory = NZBDAV_CATEGORY_MOVIES;
    suffixKey = 'MOVIE';
  } else {
    baseCategory = NZBDAV_CATEGORY_DEFAULT;
    suffixKey = 'DEFAULT';
  }

  if (NZBDAV_CATEGORY_OVERRIDE) {
    return `${NZBDAV_CATEGORY_OVERRIDE}_${suffixKey}`;
  }

  return baseCategory;
}

function buildNzbdavApiParams(mode, extra = {}) {
  return {
    mode,
    apikey: NZBDAV_API_KEY,
    ...extra
  };
}

async function addNzbToNzbdav(nzbUrl, category, jobLabel) {
  ensureNzbdavConfigured();

  if (!nzbUrl) {
    throw new Error('Missing NZB download URL');
  }
  if (!category) {
    throw new Error('Missing NZBDav category');
  }

  console.log(`[NZBDAV] Queueing NZB for category=${category} (${jobLabel || 'untitled'})`);

  const params = buildNzbdavApiParams('addurl', {
    name: nzbUrl,
    cat: category,
    nzbname: jobLabel || undefined,
    output: 'json'
  });

  const headers = {};
  if (NZBDAV_API_KEY) {
    headers['x-api-key'] = NZBDAV_API_KEY;
  }

  const response = await axios.get(`${NZBDAV_URL}/api`, {
    params,
    timeout: NZBDAV_API_TIMEOUT_MS,
    headers,
    validateStatus: (status) => status < 500
  });

  if (!response.data?.status) {
    const errorMessage = response.data?.error || `addurl returned status ${response.status}`;
    throw new Error(`[NZBDAV] Failed to queue NZB: ${errorMessage}`);
  }

  const nzoId = response.data?.nzo_id ||
                response.data?.nzoId ||
                response.data?.NzoId ||
                (Array.isArray(response.data?.nzo_ids) && response.data.nzo_ids[0]) ||
                (Array.isArray(response.data?.queue) && response.data.queue[0]?.nzo_id);

  if (!nzoId) {
    throw new Error('[NZBDAV] addurl succeeded but no nzo_id returned');
  }

  console.log(`[NZBDAV] NZB queued with id ${nzoId}`);
  return { nzoId };
}

async function waitForNzbdavHistorySlot(nzoId, category) {
  ensureNzbdavConfigured();
  const deadline = Date.now() + NZBDAV_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const params = buildNzbdavApiParams('history', {
      start: '0',
      limit: '50',
      category
    });

    const headers = {};
    if (NZBDAV_API_KEY) {
      headers['x-api-key'] = NZBDAV_API_KEY;
    }

    const response = await axios.get(`${NZBDAV_URL}/api`, {
      params,
      timeout: NZBDAV_HISTORY_TIMEOUT_MS,
      headers,
      validateStatus: (status) => status < 500
    });

    if (!response.data?.status) {
      const errorMessage = response.data?.error || `history returned status ${response.status}`;
      throw new Error(`[NZBDAV] Failed to query history: ${errorMessage}`);
    }

    const history = response.data?.history || response.data?.History;
    const slots = history?.slots || history?.Slots || [];
    const slot = slots.find((entry) => {
      const entryId = entry?.nzo_id || entry?.nzoId || entry?.NzoId;
      return entryId === nzoId;
    });

    if (slot) {
      const status = (slot.status || slot.Status || '').toString().toLowerCase();
      if (status === 'completed') {
        console.log(`[NZBDAV] NZB ${nzoId} completed in ${category}`);
        return slot;
      }
      if (status === 'failed') {
        const failMessage = slot.fail_message || slot.failMessage || slot.FailMessage || 'Unknown NZBDav error';
        const failureError = new Error(`[NZBDAV] NZB failed: ${failMessage}`);
        failureError.isNzbdavFailure = true;
        failureError.failureMessage = failMessage;
        failureError.nzoId = nzoId;
        failureError.category = category;
        throw failureError;
      }
    }

    await sleep(NZBDAV_POLL_INTERVAL_MS);
  }

  throw new Error('[NZBDAV] Timeout while waiting for NZB to become streamable');
}

const getWebdavClient = (() => {
  let clientPromise = null;
  return async () => {
    if (clientPromise) return clientPromise;

    clientPromise = (async () => {
      const { createClient } = await import('webdav');

      const trimmedBase = NZBDAV_WEBDAV_URL.replace(/\/+$/, '');
      const rootSegment = (NZBDAV_WEBDAV_ROOT || '').replace(/^\/+/, '').replace(/\/+$/, '');
      const baseUrl = rootSegment ? `${trimmedBase}/${rootSegment}` : trimmedBase;

      const authOptions = {};
      if (NZBDAV_WEBDAV_USER && NZBDAV_WEBDAV_PASS) {
        authOptions.username = NZBDAV_WEBDAV_USER;
        authOptions.password = NZBDAV_WEBDAV_PASS;
      }

      return createClient(baseUrl, authOptions);
    })();

    return clientPromise;
  };
})();

async function listWebdavDirectory(directory) {
  const client = await getWebdavClient();
  const normalizedPath = normalizeNzbdavPath(directory);
  const relativePath = normalizedPath === '/' ? '/' : normalizedPath.replace(/^\/+/, '');

  try {
    const entries = await client.getDirectoryContents(relativePath, { deep: false });
    return entries.map((entry) => ({
      name: entry?.basename ?? entry?.filename ?? '',
      isDirectory: entry?.type === 'directory',
      size: entry?.size ?? null,
      href: entry?.filename ?? entry?.href ?? null
    }));
  } catch (error) {
    throw new Error(`[NZBDAV] Failed to list ${relativePath}: ${error.message}`);
  }
}

function isVideoFileName(fileName = '') {
  const extension = posixPath.extname(fileName.toLowerCase());
  return NZBDAV_VIDEO_EXTENSIONS.has(extension);
}

function fileMatchesEpisode(fileName, requestedEpisode) {
  if (!requestedEpisode) {
    return true;
  }
  const { season, episode } = requestedEpisode;
  const patterns = [
    new RegExp(`s0*${season}e0*${episode}(?![0-9])`, 'i'),
    new RegExp(`s0*${season}\.?e0*${episode}(?![0-9])`, 'i'),
    new RegExp(`0*${season}[xX]0*${episode}(?![0-9])`, 'i'),
    new RegExp(`[eE](?:pisode|p)\.?\s*0*${episode}(?![0-9])`, 'i')
  ];
  return patterns.some((regex) => regex.test(fileName));
}

function parseRequestedEpisode(type, id, query = {}) {
  const extractInt = (value) => {
    if (value === undefined || value === null) return null;
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const seasonFromQuery = extractInt(query.season ?? query.Season ?? query.S);
  const episodeFromQuery = extractInt(query.episode ?? query.Episode ?? query.E);

  if (seasonFromQuery && episodeFromQuery) {
    return { season: seasonFromQuery, episode: episodeFromQuery };
  }

  if (type === 'series' && typeof id === 'string' && id.includes(':')) {
    const parts = id.split(':');
    if (parts.length >= 3) {
      const episode = extractInt(parts[parts.length - 1]);
      const season = extractInt(parts[parts.length - 2]);
      if (season && episode) {
        return { season, episode };
      }
    }
  }

  return null;
}

function ensureSpecialProviderConfigured() {
  if (!EXTERNAL_SPECIAL_PROVIDER_URL) {
    throw new Error('External metadata provider URL is not configured');
  }
}

function cleanSpecialSearchTitle(rawTitle) {
  if (!rawTitle) return null;
  const lines = rawTitle
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const candidate = lines.length > 1 ? lines[1] : lines[0];
  if (!candidate) return null;

  const withoutTags = candidate.replace(/\bXXX.*$/i, '').replace(/\[[^\]]+\]/g, '');
  const withoutCodec = withoutTags.replace(/\b\d{3,4}p\b/gi, '');
  const normalized = withoutCodec
    .replace(/[._]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return normalized || null;
}

async function fetchSpecialMetadata(identifier) {
  ensureSpecialProviderConfigured();
  const trimmedBase = stripTrailingSlashes(EXTERNAL_SPECIAL_PROVIDER_URL);
  const requestUrl = `${trimmedBase}/stream/movie/${encodeURIComponent(identifier)}.json`;
  console.log('[SPECIAL META] Fetching metadata for external catalog request');

  const response = await axios.get(requestUrl, { timeout: 10000 });
  const streams = response.data?.streams;
  const firstTitle = Array.isArray(streams) && streams.length > 0 ? streams[0]?.title : null;

  const cleanedTitle = cleanSpecialSearchTitle(firstTitle);
  if (!cleanedTitle) {
    throw new Error('External metadata provider returned no usable title');
  }

  return {
    title: cleanedTitle
  };
}

function normalizeNzbdavPath(pathValue) {
  if (!pathValue) {
    return '/';
  }
  const normalized = pathValue.replace(/\\/g, '/');
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function inferMimeType(fileName) {
  if (!fileName) return 'application/octet-stream';
  const ext = posixPath.extname(fileName.toLowerCase());
  return VIDEO_MIME_MAP.get(ext) || 'application/octet-stream';
}

function normalizeReleaseTitle(title) {
  if (!title) return '';
  return title.toString().trim().toLowerCase();
}

function triageStatusRank(status) {
  switch (status) {
    case 'blocked':
    case 'fetch-error':
    case 'error':
      return 4;
    case 'verified':
      return 3;
    case 'unverified':
      return 2;
    case 'pending':
    case 'skipped':
      return 1;
    default:
      return 0;
  }
}

function buildTriageTitleMap(decisions) {
  const titleMap = new Map();
  if (!(decisions instanceof Map)) return titleMap;

  decisions.forEach((decision, downloadUrl) => {
    if (!decision) return;
    const status = decision.status;
    if (!status || status === 'pending' || status === 'skipped') return;
    const normalizedTitle = decision.normalizedTitle || normalizeReleaseTitle(decision.title);
    if (!normalizedTitle) return;
    const existing = titleMap.get(normalizedTitle);
    if (!existing || triageStatusRank(status) >= triageStatusRank(existing.status)) {
      titleMap.set(normalizedTitle, {
        status,
        blockers: Array.isArray(decision.blockers) ? decision.blockers.slice() : [],
        warnings: Array.isArray(decision.warnings) ? decision.warnings.slice() : [],
        archiveFindings: Array.isArray(decision.archiveFindings) ? decision.archiveFindings.slice() : [],
        fileCount: decision.fileCount ?? null,
        normalizedTitle,
        title: decision.title || null,
        sourceDownloadUrl: downloadUrl,
      });
    }
  });

  return titleMap;
}

async function fetchCompletedNzbdavHistory(categories = []) {
  ensureNzbdavConfigured();
  const categoryList = Array.isArray(categories) && categories.length > 0
    ? Array.from(new Set(categories.filter((value) => value !== undefined && value !== null && String(value).trim() !== '')))
    : [null];

  const results = new Map();

  for (const category of categoryList) {
    try {
      const params = buildNzbdavApiParams('history', {
        start: '0',
        limit: String(NZBDAV_HISTORY_FETCH_LIMIT),
        category: category || undefined
      });

      const headers = {};
      if (NZBDAV_API_KEY) {
        headers['x-api-key'] = NZBDAV_API_KEY;
      }

      const response = await axios.get(`${NZBDAV_URL}/api`, {
        params,
        timeout: NZBDAV_HISTORY_TIMEOUT_MS,
        headers,
        validateStatus: (status) => status < 500
      });

      if (!response.data?.status) {
        const errorMessage = response.data?.error || `history returned status ${response.status}`;
        throw new Error(errorMessage);
      }

      const history = response.data?.history || response.data?.History;
      const slots = history?.slots || history?.Slots || [];

      for (const slot of slots) {
        const status = (slot?.status || slot?.Status || '').toString().toLowerCase();
        if (status !== 'completed') {
          continue;
        }

        const jobName = slot?.job_name || slot?.JobName || slot?.name || slot?.Name || slot?.nzb_name || slot?.NzbName;
        const nzoId = slot?.nzo_id || slot?.nzoId || slot?.NzoId;
        if (!jobName || !nzoId) {
          continue;
        }

        const normalized = normalizeReleaseTitle(jobName);
        if (!normalized) {
          continue;
        }

        if (!results.has(normalized)) {
          results.set(normalized, {
            nzoId,
            jobName,
            category: slot?.category || slot?.Category || category || null,
            size: slot?.size || slot?.Size || null,
            slot
          });
        }
      }
    } catch (error) {
      console.warn(`[NZBDAV] Failed to fetch history for category ${category || 'all'}: ${error.message}`);
    }
  }

  return results;
}

function buildNzbdavCacheKey(downloadUrl, category, requestedEpisode = null) {
  const keyParts = [downloadUrl, category];
  if (requestedEpisode && Number.isFinite(requestedEpisode.season) && Number.isFinite(requestedEpisode.episode)) {
    keyParts.push(`${requestedEpisode.season}x${requestedEpisode.episode}`);
  }
  return keyParts.join('|');
}

async function safeStat(filePath) {
  try {
    return await fs.promises.stat(filePath);
  } catch (error) {
    return null;
  }
}

async function streamFileResponse(req, res, absolutePath, emulateHead, logPrefix, existingStats = null) {
  const stats = existingStats || (await safeStat(absolutePath));
  if (!stats || !stats.isFile()) {
    return false;
  }

  const totalSize = stats.size;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Last-Modified', stats.mtime.toUTCString());
  res.setHeader('Content-Type', 'application/octet-stream');

  if (emulateHead) {
    res.setHeader('Content-Length', totalSize);
    res.status(200).end();
    console.log(`[${logPrefix}] Served HEAD for ${absolutePath}`);
    return true;
  }

  let start = 0;
  let end = totalSize - 1;
  let statusCode = 200;

  const rangeHeader = req.headers.range;
  if (rangeHeader && /^bytes=\d*-\d*$/.test(rangeHeader)) {
    const [, rangeSpec] = rangeHeader.split('=');
    const [rangeStart, rangeEnd] = rangeSpec.split('-');

    if (rangeStart) {
      const parsedStart = Number.parseInt(rangeStart, 10);
      if (Number.isFinite(parsedStart) && parsedStart >= 0) {
        start = parsedStart;
      }
    }

    if (rangeEnd) {
      const parsedEnd = Number.parseInt(rangeEnd, 10);
      if (Number.isFinite(parsedEnd) && parsedEnd >= 0) {
        end = parsedEnd;
      }
    }

    if (!rangeEnd) {
      end = totalSize - 1;
    }

    if (start >= totalSize) {
      res.status(416).setHeader('Content-Range', `bytes */${totalSize}`);
      res.end();
      return true;
    }

    if (end >= totalSize || end < start) {
      end = totalSize - 1;
    }

    statusCode = 206;
  }

  const chunkSize = end - start + 1;
  const readStream = fs.createReadStream(absolutePath, {
    start,
    end,
    highWaterMark: STREAM_HIGH_WATER_MARK
  });

  if (statusCode === 206) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
    res.setHeader('Content-Length', chunkSize);
    console.log(`[${logPrefix}] Serving partial bytes ${start}-${end} from ${absolutePath}`);
  } else {
    res.status(200);
    res.setHeader('Content-Length', totalSize);
    console.log(`[${logPrefix}] Serving full file from ${absolutePath}`);
  }

  try {
    await pipelineAsync(readStream, res);
  } catch (error) {
    if (error?.code === 'ERR_STREAM_PREMATURE_CLOSE') {
      console.warn(`[${logPrefix}] Stream closed early for ${absolutePath}: ${error.message}`);
      return true;
    }
    console.error(`[${logPrefix}] Pipeline error for ${absolutePath}:`, error.message);
    throw error;
  }

  return true;
}

async function streamFailureVideo(req, res, failureError) {
  const stats = await safeStat(FAILURE_VIDEO_PATH);
  if (!stats || !stats.isFile()) {
    console.error(`[FAILURE STREAM] Failure video not found at ${FAILURE_VIDEO_PATH}`);
    return false;
  }

  const emulateHead = (req.method || 'GET').toUpperCase() === 'HEAD';
  const failureMessage = failureError?.failureMessage || failureError?.message || 'NZBDav download failed';

  if (!res.headersSent) {
    res.setHeader('X-NZBDav-Failure', failureMessage);
  }

  console.warn(`[FAILURE STREAM] Serving fallback video due to NZBDav failure: ${failureMessage}`);
  return streamFileResponse(req, res, FAILURE_VIDEO_PATH, emulateHead, 'FAILURE STREAM', stats);
}

async function findBestVideoFile({ category, jobName, requestedEpisode }) {
  const rootPath = normalizeNzbdavPath(`/content/${category}/${jobName}`);
  const queue = [{ path: rootPath, depth: 0 }];
  const visited = new Set();
  let bestMatch = null;
  let bestEpisodeMatch = null;

  while (queue.length > 0) {
    const { path: currentPath, depth } = queue.shift();
    if (depth > NZBDAV_MAX_DIRECTORY_DEPTH) {
      continue;
    }
    if (visited.has(currentPath)) {
      continue;
    }
    visited.add(currentPath);

    let entries;
    try {
      entries = await listWebdavDirectory(currentPath);
    } catch (error) {
      console.error(`[NZBDAV] Failed to list ${currentPath}:`, error.message);
      continue;
    }

    for (const entry of entries) {
      const entryName = entry?.name || entry?.Name;
      const isDirectory = entry?.isDirectory ?? entry?.IsDirectory;
      const entrySize = Number(entry?.size ?? entry?.Size ?? 0);
      const nextPath = normalizeNzbdavPath(`${currentPath}/${entryName}`);

      if (isDirectory) {
        queue.push({ path: nextPath, depth: depth + 1 });
        continue;
      }

      if (!entryName || !isVideoFileName(entryName)) {
        continue;
      }

      const matchesEpisode = fileMatchesEpisode(entryName, requestedEpisode);
      const candidate = {
        name: entryName,
        size: entrySize,
        matchesEpisode,
        absolutePath: nextPath,
        viewPath: nextPath.replace(/^\/+/, '')
      };

      if (matchesEpisode) {
        if (!bestEpisodeMatch || candidate.size > bestEpisodeMatch.size) {
          bestEpisodeMatch = candidate;
        }
      }

      if (!bestMatch || candidate.size > bestMatch.size) {
        bestMatch = candidate;
      }
    }
  }

  return bestEpisodeMatch || bestMatch;
}

function cleanupNzbdavCache() {
  if (NZBDAV_CACHE_TTL_MS <= 0) {
    return;
  }

  const now = Date.now();
  for (const [key, entry] of nzbdavStreamCache.entries()) {
    if (entry.expiresAt && entry.expiresAt <= now) {
      nzbdavStreamCache.delete(key);
    }
  }
}

async function getOrCreateNzbdavStream(cacheKey, builder) {
  cleanupNzbdavCache();
  const existing = nzbdavStreamCache.get(cacheKey);

  if (existing) {
    if (existing.status === 'ready') {
      return existing.data;
    }
    if (existing.status === 'pending') {
      return existing.promise;
    }
    if (existing.status === 'failed') {
      throw existing.error;
    }
  }

  const promise = (async () => {
    const data = await builder();
    nzbdavStreamCache.set(cacheKey, {
      status: 'ready',
      data,
      expiresAt: NZBDAV_CACHE_TTL_MS > 0 ? Date.now() + NZBDAV_CACHE_TTL_MS : null
    });
    return data;
  })();

  nzbdavStreamCache.set(cacheKey, { status: 'pending', promise });

  try {
    return await promise;
  } catch (error) {
    if (error?.isNzbdavFailure) {
      nzbdavStreamCache.set(cacheKey, {
        status: 'failed',
        error,
        expiresAt: NZBDAV_CACHE_TTL_MS > 0 ? Date.now() + NZBDAV_CACHE_TTL_MS : null
      });
    } else {
      nzbdavStreamCache.delete(cacheKey);
    }
    throw error;
  }
}

async function buildNzbdavStream({ downloadUrl, category, title, requestedEpisode, existingSlot = null }) {
  let reuseError = null;
  const attempts = [];
  if (existingSlot?.nzoId) {
    attempts.push('reuse');
  }
  attempts.push('queue');

  for (const mode of attempts) {
    try {
      let slot = null;
      let nzoId = null;
      let slotCategory = category;
      let slotJobName = title;

      if (mode === 'reuse') {
        const reuseCategory = existingSlot?.category || category;
        slot = await waitForNzbdavHistorySlot(existingSlot.nzoId, reuseCategory);
        nzoId = existingSlot.nzoId;
        slotCategory = slot?.category || slot?.Category || reuseCategory;
        slotJobName = slot?.job_name || slot?.JobName || slot?.name || slot?.Name || existingSlot?.jobName || title;
        console.log(`[NZBDAV] Reusing completed NZB ${slotJobName} (${nzoId})`);
      } else {
        const added = await addNzbToNzbdav(downloadUrl, category, title);
        nzoId = added.nzoId;
        slot = await waitForNzbdavHistorySlot(nzoId, category);
        slotCategory = slot?.category || slot?.Category || category;
        slotJobName = slot?.job_name || slot?.JobName || slot?.name || slot?.Name || title;
      }

      if (!slotJobName) {
        throw new Error('[NZBDAV] Unable to determine job name from history');
      }

      const bestFile = await findBestVideoFile({
        category: slotCategory,
        jobName: slotJobName,
        requestedEpisode
      });

      if (!bestFile) {
        throw new Error('[NZBDAV] No playable video files found after mounting NZB');
      }

      console.log(`[NZBDAV] Selected file ${bestFile.viewPath} (${bestFile.size} bytes)`);

      return {
        nzoId,
        category: slotCategory,
        jobName: slotJobName,
        viewPath: bestFile.viewPath,
        size: bestFile.size,
        fileName: bestFile.name
      };
    } catch (error) {
      if (mode === 'reuse') {
        reuseError = error;
        console.warn(`[NZBDAV] Reuse attempt failed for NZB ${existingSlot?.nzoId || 'unknown'}: ${error.message}`);
        continue;
      }
      if (error?.isNzbdavFailure) {
        error.downloadUrl = downloadUrl;
        error.category = category;
        error.title = title;
      }
      throw error;
    }
  }

  if (reuseError) {
    if (reuseError?.isNzbdavFailure) {
      reuseError.downloadUrl = downloadUrl;
      reuseError.category = category;
      reuseError.title = title;
    }
    throw reuseError;
  }

  const fallbackError = new Error('[NZBDAV] Unable to prepare NZB stream');
  fallbackError.downloadUrl = downloadUrl;
  fallbackError.category = category;
  fallbackError.title = title;
  throw fallbackError;
}

async function proxyNzbdavStream(req, res, viewPath, fileNameHint = '') {
  const originalMethod = (req.method || 'GET').toUpperCase();
  if (!NZBDAV_SUPPORTED_METHODS.has(originalMethod)) {
    res.status(405).send('Method Not Allowed');
    return;
  }

  const emulateHead = originalMethod === 'HEAD';
  const proxiedMethod = emulateHead ? 'GET' : originalMethod;

  const normalizedPath = normalizeNzbdavPath(viewPath);
  const encodedPath = normalizedPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const webdavBase = NZBDAV_WEBDAV_URL.replace(/\/+$/, '');
  const targetUrl = `${webdavBase}${encodedPath}`;
  const headers = {};

  console.log(`[NZBDAV] Streaming ${normalizedPath} via WebDAV`);

  const coerceToString = (value) => {
    if (Array.isArray(value)) {
      return value.find((item) => typeof item === 'string' && item.trim().length > 0) || '';
    }
    return typeof value === 'string' ? value : '';
  };

  let derivedFileName = typeof fileNameHint === 'string' ? fileNameHint.trim() : '';
  if (!derivedFileName) {
    const segments = normalizedPath.split('/').filter(Boolean);
    if (segments.length > 0) {
      const lastSegment = segments[segments.length - 1];
      try {
        derivedFileName = decodeURIComponent(lastSegment);
      } catch (decodeError) {
        derivedFileName = lastSegment;
      }
    }
  }
  if (!derivedFileName) {
    derivedFileName = coerceToString(req.query?.title || '').trim();
  }
  if (!derivedFileName) {
    derivedFileName = 'stream';
  }

  const sanitizedFileName = derivedFileName.replace(/[\\/:*?"<>|]+/g, '_') || 'stream';

  if (req.headers.range) headers.Range = req.headers.range;
  if (req.headers['if-range']) headers['If-Range'] = req.headers['if-range'];
  if (req.headers.accept) headers.Accept = req.headers.accept;
  if (req.headers['accept-language']) headers['Accept-Language'] = req.headers['accept-language'];
  if (req.headers['accept-encoding']) headers['Accept-Encoding'] = req.headers['accept-encoding'];
  if (req.headers['user-agent']) headers['User-Agent'] = req.headers['user-agent'];
  if (!headers['Accept-Encoding']) headers['Accept-Encoding'] = 'identity';
  if (emulateHead && !headers.Range) {
    headers.Range = 'bytes=0-0';
  }

  let totalFileSize = null;
  if (!req.headers.range && !emulateHead) {
    const headConfig = {
      url: targetUrl,
      method: 'HEAD',
      headers: {
  'User-Agent': headers['User-Agent'] || `UsenetStreamer/${ADDON_VERSION}`
      },
      timeout: 30000,
      validateStatus: (status) => status < 500
    };

    if (NZBDAV_WEBDAV_USER && NZBDAV_WEBDAV_PASS) {
      headConfig.auth = {
        username: NZBDAV_WEBDAV_USER,
        password: NZBDAV_WEBDAV_PASS
      };
    }

    try {
      const headResponse = await axios.request(headConfig);
      const headHeadersLower = Object.keys(headResponse.headers || {}).reduce((map, key) => {
        map[key.toLowerCase()] = headResponse.headers[key];
        return map;
      }, {});
      const headContentLength = headHeadersLower['content-length'];
      if (headContentLength) {
        totalFileSize = Number(headContentLength);
        console.log(`[NZBDAV] HEAD reported total size ${totalFileSize} bytes for ${normalizedPath}`);
      }
    } catch (headError) {
      console.warn('[NZBDAV] HEAD request failed; continuing without pre-fetched size:', headError.message);
    }
  }

  const requestConfig = {
    url: targetUrl,
    method: proxiedMethod,
    headers,
    responseType: 'stream',
    timeout: NZBDAV_STREAM_TIMEOUT_MS,
    validateStatus: (status) => status < 500
  };

  if (NZBDAV_WEBDAV_USER && NZBDAV_WEBDAV_PASS) {
    requestConfig.auth = {
      username: NZBDAV_WEBDAV_USER,
      password: NZBDAV_WEBDAV_PASS
    };
  }

  console.log(`[NZBDAV] Proxying ${proxiedMethod}${emulateHead ? ' (HEAD emulation)' : ''} ${targetUrl}`);

  const nzbdavResponse = await axios.request(requestConfig);

  let responseStatus = nzbdavResponse.status;
  const responseHeadersLower = Object.keys(nzbdavResponse.headers || {}).reduce((map, key) => {
    map[key.toLowerCase()] = nzbdavResponse.headers[key];
    return map;
  }, {});

  const incomingContentRange = responseHeadersLower['content-range'];
  if (incomingContentRange && responseStatus === 200) {
    responseStatus = 206;
  }

  res.status(responseStatus);

  const headerBlocklist = new Set(['transfer-encoding', 'www-authenticate', 'set-cookie', 'cookie', 'authorization']);

  Object.entries(nzbdavResponse.headers || {}).forEach(([key, value]) => {
    const lowerKey = key.toLowerCase();
    if (headerBlocklist.has(lowerKey)) {
      return;
    }
    if (value !== undefined) {
      res.setHeader(key, value);
    }
  });

  const incomingDisposition = nzbdavResponse.headers?.['content-disposition'];
  const hasFilenameInDisposition = typeof incomingDisposition === 'string' && /filename=/i.test(incomingDisposition);
  if (!hasFilenameInDisposition) {
    res.setHeader('Content-Disposition', `inline; filename="${sanitizedFileName}"`);
  }

  const inferredMime = inferMimeType(sanitizedFileName);
  if (!res.getHeader('Content-Type') || res.getHeader('Content-Type') === 'application/octet-stream') {
    res.setHeader('Content-Type', inferredMime);
  }

  const acceptRangesHeader = res.getHeader('Accept-Ranges');
  if (!acceptRangesHeader) {
    res.setHeader('Accept-Ranges', 'bytes');
  }

  const contentLengthHeader = res.getHeader('Content-Length');
  if (incomingContentRange) {
    const match = incomingContentRange.match(/bytes\s+(\d+)-(\d+)\s*\/\s*(\d+|\*)/i);
    if (match) {
      const start = Number(match[1]);
      const end = Number(match[2]);
      const totalSize = match[3] !== '*' ? Number(match[3]) : null;
      const chunkLength = Number.isFinite(start) && Number.isFinite(end) ? end - start + 1 : null;
      console.log('[NZBDAV] Calculated chunk length:', { start, end, chunkLength, totalSize });
      if (Number.isFinite(chunkLength) && chunkLength > 0) {
        res.setHeader('Content-Length', String(chunkLength));
        console.log(`[NZBDAV] ✅ Set Content-Length: ${chunkLength} (from Content-Range: bytes ${start}-${end}/${totalSize || '*'})`);
      } else {
        console.error('[NZBDAV] ❌ Failed to calculate valid chunk length!');
      }
      if (Number.isFinite(totalSize)) {
        res.setHeader('X-Total-Length', String(totalSize));
      }
    } else {
      console.error('[NZBDAV] ❌ Failed to parse Content-Range header!');
    }
  } else if ((!contentLengthHeader || Number(contentLengthHeader) === 0) && Number.isFinite(totalFileSize)) {
    res.setHeader('Content-Length', String(totalFileSize));
    console.log(`[NZBDAV] Set Content-Length: ${totalFileSize} (from HEAD request)`);
  } else if (!contentLengthHeader || Number(contentLengthHeader) === 0) {
    console.warn('[NZBDAV] Warning: No Content-Length or Content-Range header available');
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Content-Type,Accept-Ranges');

  if (emulateHead || !nzbdavResponse.data || typeof nzbdavResponse.data.pipe !== 'function') {
    if (nzbdavResponse.data && typeof nzbdavResponse.data.destroy === 'function') {
      nzbdavResponse.data.destroy();
    }
    res.end();
    return;
  }

  try {
    await pipelineAsync(nzbdavResponse.data, res);
  } catch (error) {
    if (error?.code === 'ERR_STREAM_PREMATURE_CLOSE') {
      console.warn('[NZBDAV] Stream closed early by client');
      return;
    }
    console.error('[NZBDAV] Error while piping stream:', error.message);
    throw error;
  }
}

// Manifest endpoint
function manifestHandler(req, res) {
  ensureAddonConfigured();

  res.json({
    id: 'com.usenet.streamer',
    version: ADDON_VERSION,
    name: 'UsenetStreamer',
    description: 'Usenet-powered instant streams for Stremio via Prowlarr/NZBHydra and NZBDav',
    logo: `${ADDON_BASE_URL.replace(/\/$/, '')}/assets/icon.png`,
    resources: ['stream'],
    types: ['movie', 'series', 'channel', 'tv'],
    catalogs: [],
    idPrefixes: ['tt', 'tvdb', 'pt', SPECIAL_ID_PREFIX]
  });
}

if (ADDON_SHARED_SECRET) {
  app.get('/:token/manifest.json', manifestHandler);
} else {
  app.get('/manifest.json', manifestHandler);
  app.get('/:token/manifest.json', manifestHandler);
}

async function streamHandler(req, res) {
  const { type, id } = req.params;
  console.log(`[REQUEST] Received request for ${type} ID: ${id}`);

  let baseIdentifier = id;
  if (type === 'series' && typeof id === 'string') {
    const parts = id.split(':');
    if (parts.length >= 3) {
      const potentialEpisode = Number.parseInt(parts[parts.length - 1], 10);
      const potentialSeason = Number.parseInt(parts[parts.length - 2], 10);
      if (Number.isFinite(potentialSeason) && Number.isFinite(potentialEpisode)) {
        baseIdentifier = parts.slice(0, parts.length - 2).join(':');
      }
    }
  }

  let incomingImdbId = null;
  let incomingTvdbId = null;
  let incomingSpecialId = null;

  if (/^tt\d+$/i.test(baseIdentifier)) {
    incomingImdbId = baseIdentifier.startsWith('tt') ? baseIdentifier : `tt${baseIdentifier}`;
    baseIdentifier = incomingImdbId;
  } else if (/^tvdb:/i.test(baseIdentifier)) {
    const tvdbMatch = baseIdentifier.match(/^tvdb:([0-9]+)(?::.*)?$/i);
    if (tvdbMatch) {
      incomingTvdbId = tvdbMatch[1];
      baseIdentifier = `tvdb:${incomingTvdbId}`;
    }
  } else {
    const lowerIdentifier = baseIdentifier.toLowerCase();
    for (const prefix of specialCatalogPrefixes) {
      const normalizedPrefix = prefix.toLowerCase();
      if (lowerIdentifier.startsWith(`${normalizedPrefix}:`)) {
        const remainder = baseIdentifier.slice(prefix.length + 1);
        if (remainder) {
          incomingSpecialId = remainder;
          baseIdentifier = `${prefix}:${remainder}`;
        }
        break;
      }
    }
  }

  const isSpecialRequest = Boolean(incomingSpecialId);

  if (!incomingImdbId && !incomingTvdbId && !isSpecialRequest) {
    res.status(400).json({ error: `Unsupported ID prefix for indexer manager search: ${baseIdentifier}` });
    return;
  }

  try {
    ensureAddonConfigured();
    ensureIndexerManagerConfigured();
    ensureNzbdavConfigured();

    const requestedEpisode = parseRequestedEpisode(type, id, req.query || {});

    const pickFirstDefined = (...values) => values.find((value) => value !== undefined && value !== null && String(value).trim() !== '') || null;
    const meta = req.query || {};

    console.log('[REQUEST] Raw query payload from Stremio', meta);

    const hasTvdbInQuery = Boolean(
      pickFirstDefined(
        meta.tvdbId,
        meta.tvdb_id,
        meta.tvdb,
        meta.tvdbSlug,
        meta.tvdbid
      )
    );

    const hasTmdbInQuery = Boolean(
      pickFirstDefined(
        meta.tmdbId,
        meta.tmdb_id,
        meta.tmdb,
        meta.tmdbSlug,
        meta.tmdbid
      )
    );

    const hasTitleInQuery = Boolean(
      pickFirstDefined(
        meta.title,
        meta.name,
        meta.originalTitle,
        meta.original_title
      )
    );

    const metaSources = [meta];
    if (incomingImdbId) {
      metaSources.push({ ids: { imdb: incomingImdbId }, imdb_id: incomingImdbId });
    }
    if (incomingTvdbId) {
      metaSources.push({ ids: { tvdb: incomingTvdbId }, tvdb_id: incomingTvdbId });
    }
    let specialMetadata = null;
    if (isSpecialRequest) {
      try {
        specialMetadata = await fetchSpecialMetadata(baseIdentifier);
        if (specialMetadata?.title) {
          metaSources.push({ title: specialMetadata.title, name: specialMetadata.title });
          console.log('[SPECIAL META] Resolved title for external catalog request', { title: specialMetadata.title });
        }
      } catch (error) {
        console.error('[SPECIAL META] Failed to resolve metadata:', error.message);
        res.status(502).json({ error: 'Failed to resolve external metadata' });
        return;
      }
    }
    let cinemetaMeta = null;

    const needsCinemeta = !INDEXER_MANAGER_STRICT_ID_MATCH && !incomingTvdbId && !isSpecialRequest && (
      (!hasTitleInQuery) ||
      (type === 'series' && !hasTvdbInQuery) ||
      (type === 'movie' && !hasTmdbInQuery)
    );
    if (needsCinemeta) {
      const cinemetaPath = type === 'series' ? `series/${baseIdentifier}.json` : `${type}/${baseIdentifier}.json`;
      const cinemetaUrl = `${CINEMETA_URL}/${cinemetaPath}`;
      try {
        console.log(`[CINEMETA] Fetching metadata from ${cinemetaUrl}`);
        const cinemetaResponse = await axios.get(cinemetaUrl, { timeout: 10000 });
        cinemetaMeta = cinemetaResponse.data?.meta || null;
        if (cinemetaMeta) {
          metaSources.push(cinemetaMeta);
          console.log('[CINEMETA] Received metadata identifiers', {
            imdb: cinemetaMeta?.ids?.imdb || cinemetaMeta?.imdb_id,
            tvdb: cinemetaMeta?.ids?.tvdb || cinemetaMeta?.tvdb_id,
            tmdb: cinemetaMeta?.ids?.tmdb || cinemetaMeta?.tmdb_id
          });
        } else {
          console.warn(`[CINEMETA] No metadata payload returned for ${cinemetaUrl}`);
        }
      } catch (error) {
        console.warn(`[CINEMETA] Failed to fetch metadata for ${baseIdentifier}: ${error.message}`);
      }
    }

    const collectValues = (...extractors) => {
      const collected = [];
      for (const source of metaSources) {
        if (!source) continue;
        for (const extractor of extractors) {
          try {
            const value = extractor(source);
            if (value !== undefined && value !== null) {
              collected.push(value);
            }
          } catch (error) {
            // ignore extractor errors on unexpected shapes
          }
        }
      }
      return collected;
    };

    const seasonNum = requestedEpisode?.season ?? null;
    const episodeNum = requestedEpisode?.episode ?? null;

    const normalizeImdb = (value) => {
      if (value === null || value === undefined) return null;
      const trimmed = String(value).trim();
      if (!trimmed) return null;
      const withPrefix = trimmed.startsWith('tt') ? trimmed : `tt${trimmed}`;
      return /^tt\d+$/.test(withPrefix) ? withPrefix : null;
    };

    const normalizeNumericId = (value) => {
      if (value === null || value === undefined) return null;
      const trimmed = String(value).trim();
      if (!/^\d+$/.test(trimmed)) return null;
      return trimmed;
    };

    const metaIds = {
      imdb: normalizeImdb(
        pickFirstDefined(
          ...collectValues(
            (src) => src?.imdb_id,
            (src) => src?.imdb,
            (src) => src?.imdbId,
            (src) => src?.imdbid,
            (src) => src?.ids?.imdb,
            (src) => src?.externals?.imdb
          ),
          incomingImdbId
        )
      ),
      tmdb: normalizeNumericId(
        pickFirstDefined(
          ...collectValues(
            (src) => src?.tmdb_id,
            (src) => src?.tmdb,
            (src) => src?.tmdbId,
            (src) => src?.ids?.tmdb,
            (src) => src?.ids?.themoviedb,
            (src) => src?.externals?.tmdb,
            (src) => src?.tmdbSlug,
            (src) => src?.tmdbid
          )
        )
      ),
      tvdb: normalizeNumericId(
        pickFirstDefined(
          ...collectValues(
            (src) => src?.tvdb_id,
            (src) => src?.tvdb,
            (src) => src?.tvdbId,
            (src) => src?.ids?.tvdb,
            (src) => src?.externals?.tvdb,
            (src) => src?.tvdbSlug,
            (src) => src?.tvdbid
          ),
          incomingTvdbId
        )
      )
    };

    console.log('[REQUEST] Normalized identifier set', metaIds);

    const extractYear = (value) => {
      if (value === null || value === undefined) return null;
      const match = String(value).match(/\d{4}/);
      if (!match) return null;
      const parsed = Number.parseInt(match[0], 10);
      return Number.isFinite(parsed) ? parsed : null;
    };

    let movieTitle = pickFirstDefined(
      ...collectValues(
        (src) => src?.title,
        (src) => src?.name,
        (src) => src?.originalTitle,
        (src) => src?.original_title
      )
    );

    let releaseYear = extractYear(
      pickFirstDefined(
        ...collectValues(
          (src) => src?.year,
          (src) => src?.releaseYear,
          (src) => src?.released,
          (src) => src?.releaseInfo?.year
        )
      )
    );

    if (!movieTitle && specialMetadata?.title) {
      movieTitle = specialMetadata.title;
    }

    if (!releaseYear && specialMetadata?.year) {
      const specialYear = extractYear(specialMetadata.year);
      if (specialYear) {
        releaseYear = specialYear;
      }
    }

    console.log('[REQUEST] Resolved title/year', { movieTitle, releaseYear });

    let searchType;
    if (type === 'series') {
      searchType = 'tvsearch';
    } else if (type === 'movie') {
      searchType = 'movie';
    } else {
      searchType = 'search';
    }

    const seasonToken = Number.isFinite(seasonNum) ? `{Season:${seasonNum}}` : null;
    const episodeToken = Number.isFinite(episodeNum) ? `{Episode:${episodeNum}}` : null;

    const searchPlans = [];
    const seenPlans = new Set();
    const addPlan = (planType, { tokens = [], rawQuery = null } = {}) => {
      const tokenList = [...tokens];
      if (planType === 'tvsearch') {
        if (seasonToken) tokenList.push(seasonToken);
        if (episodeToken) tokenList.push(episodeToken);
      }
      const normalizedTokens = tokenList.filter(Boolean);
      const query = rawQuery ? rawQuery : normalizedTokens.join(' ');
      if (!query) {
        return false;
      }
      const planKey = `${planType}|${query}`;
      if (seenPlans.has(planKey)) {
        return false;
      }
      seenPlans.add(planKey);
      searchPlans.push({ type: planType, query, rawQuery: rawQuery ? rawQuery : null, tokens: normalizedTokens });
      return true;
    };

    if (metaIds.imdb) {
      addPlan(searchType, { tokens: [`{ImdbId:${metaIds.imdb}}`] });
    }

    if (type === 'series' && metaIds.tvdb) {
      addPlan('tvsearch', { tokens: [`{TvdbId:${metaIds.tvdb}}`] });
    }

    if (type === 'movie' && metaIds.tmdb) {
      addPlan('movie', { tokens: [`{TmdbId:${metaIds.tmdb}}`] });
    }

    if (searchPlans.length === 0 && metaIds.imdb) {
      addPlan(searchType, { tokens: [`{ImdbId:${metaIds.imdb}}`] });
    }

    const textQueryParts = [];
    if (movieTitle) {
      textQueryParts.push(movieTitle);
    }
    if (type === 'movie' && Number.isFinite(releaseYear)) {
      textQueryParts.push(String(releaseYear));
    } else if (type === 'series' && Number.isFinite(seasonNum) && Number.isFinite(episodeNum)) {
      textQueryParts.push(`S${String(seasonNum).padStart(2, '0')}E${String(episodeNum).padStart(2, '0')}`);
    }

  const shouldForceTextSearch = isSpecialRequest;
    const shouldAddTextSearch = shouldForceTextSearch || (!INDEXER_MANAGER_STRICT_ID_MATCH && !incomingTvdbId);

    if (shouldAddTextSearch) {
      const fallbackIdentifier = incomingImdbId || baseIdentifier;
      const textQueryCandidate = textQueryParts.join(' ').trim();
      const textQueryFallback = (textQueryCandidate || fallbackIdentifier).trim();
      if (textQueryFallback) {
        const addedTextPlan = addPlan('search', { rawQuery: textQueryFallback });
        if (addedTextPlan) {
          console.log(`${INDEXER_LOG_PREFIX} Added text search plan`, { query: textQueryFallback });
        } else {
          console.log(`${INDEXER_LOG_PREFIX} Text search plan already present`, { query: textQueryFallback });
        }
      } else {
        console.log(`${INDEXER_LOG_PREFIX} Skipping text search plan; insufficient metadata`);
      }
    } else {
      const reason = INDEXER_MANAGER_STRICT_ID_MATCH ? 'strict ID matching enabled' : 'tvdb identifier provided';
      console.log(`${INDEXER_LOG_PREFIX} ${reason}; skipping text-based search`);
    }

    if (INDEXER_MANAGER_INDEXERS) {
      console.log(`${INDEXER_LOG_PREFIX} Using configured indexers`, INDEXER_MANAGER_INDEXERS);
    } else {
      console.log(`${INDEXER_LOG_PREFIX} Using manager default indexer selection`);
    }

    const deriveResultKey = (result) => {
      if (!result) return null;
      const indexerId = result.indexerId || result.IndexerId || 'unknown';
      const indexer = result.indexer || result.Indexer || '';
      const title = (result.title || result.Title || '').trim();
      const size = result.size || result.Size || 0;
      
      // Use title + indexer info + size as unique key for better deduplication
      return `${indexerId}|${indexer}|${title}|${size}`;
    };

    const usingStrictIdMatching = INDEXER_MANAGER_STRICT_ID_MATCH;
    const resultsByKey = usingStrictIdMatching ? null : new Map();
    const aggregatedResults = usingStrictIdMatching ? [] : null;
    const planSummaries = [];

    const planExecutions = searchPlans.map((plan) => {
      console.log(`${INDEXER_LOG_PREFIX} Dispatching plan`, plan);
      return executeIndexerPlan(plan)
        .then((data) => ({ plan, status: 'fulfilled', data }))
        .catch((error) => ({ plan, status: 'rejected', error }));
    });

    const planResultsSettled = await Promise.all(planExecutions);

    for (const result of planResultsSettled) {
      const { plan } = result;
      if (result.status === 'rejected') {
        console.error(`${INDEXER_LOG_PREFIX} ❌ Search plan failed`, {
          message: result.error.message,
          type: plan.type,
          query: plan.query
        });
        planSummaries.push({
          planType: plan.type,
          query: plan.query,
          total: 0,
          filtered: 0,
          uniqueAdded: 0,
          error: result.error.message
        });
        continue;
      }

      const planResults = Array.isArray(result.data) ? result.data : [];
  console.log(`${INDEXER_LOG_PREFIX} ✅ ${plan.type} returned ${planResults.length} total results for query "${plan.query}"`);

      const filteredResults = planResults.filter((item) => {
        if (!item || typeof item !== 'object') {
          return false;
        }
        if (!item.downloadUrl) {
          return false;
        }
        return true;
      });

      let addedCount = 0;
      if (usingStrictIdMatching) {
        aggregatedResults.push(...filteredResults.map((item) => ({ result: item, planType: plan.type })));
        addedCount = filteredResults.length;
      } else {
        const beforeSize = resultsByKey.size;
        for (const item of filteredResults) {
          const key = deriveResultKey(item);
          if (!key) continue;
          if (!resultsByKey.has(key)) {
            resultsByKey.set(key, { result: item, planType: plan.type });
          }
        }
        addedCount = resultsByKey.size - beforeSize;
      }

      planSummaries.push({
        planType: plan.type,
        query: plan.query,
        total: planResults.length,
        filtered: filteredResults.length,
        uniqueAdded: addedCount
      });
      console.log(`${INDEXER_LOG_PREFIX} ✅ Plan summary`, planSummaries[planSummaries.length - 1]);
    }

    const aggregationCount = usingStrictIdMatching ? aggregatedResults.length : resultsByKey.size;
    if (aggregationCount === 0) {
      console.warn(`${INDEXER_LOG_PREFIX} ⚠ All ${searchPlans.length} search plans returned no NZB results`);
    } else if (usingStrictIdMatching) {
      console.log(`${INDEXER_LOG_PREFIX} ✅ Aggregated NZB results with strict ID matching`, {
        plansRun: searchPlans.length,
        totalResults: aggregationCount
      });
    } else {
      console.log(`${INDEXER_LOG_PREFIX} ✅ Aggregated unique NZB results`, {
        plansRun: searchPlans.length,
        uniqueResults: aggregationCount
      });
    }

    const dedupedNzbResults = usingStrictIdMatching
      ? aggregatedResults.map((entry) => entry.result)
      : Array.from(resultsByKey.values()).map((entry) => entry.result);

    const finalNzbResults = dedupedNzbResults
      .filter((result, index) => {
        if (!result.downloadUrl || !result.indexerId) {
          console.warn(`${INDEXER_LOG_PREFIX} Skipping NZB result ${index} missing required fields`, {
            hasDownloadUrl: !!result.downloadUrl,
            hasIndexerId: !!result.indexerId,
            title: result.title
          });
          return false;
        }
        return true;
      })
      .map((result) => ({ ...result, _sourceType: 'nzb' }));

  console.log(`${INDEXER_LOG_PREFIX} Final NZB selection: ${finalNzbResults.length} results`);

    const triageOverrides = extractTriageOverrides(req.query || {});
    const requestedDisable = triageOverrides.disabled === true;
    const requestedEnable = triageOverrides.enabled === true;
    const shouldAttemptTriage = finalNzbResults.length > 0 && !requestedDisable && (requestedEnable || TRIAGE_ENABLED);
    let triageOutcome = null;
    let triageDecisions = new Map();
  let triageTitleMap = new Map();

    if (shouldAttemptTriage) {
      if (!TRIAGE_NNTP_CONFIG) {
        console.warn('[NZB TRIAGE] Skipping health checks because NNTP configuration is missing');
      } else {
        const preferredSizeBytes = triageOverrides.sizeBytes ?? TRIAGE_PREFERRED_SIZE_BYTES;
        const preferredIndexerTokens = (triageOverrides.indexers && triageOverrides.indexers.length > 0)
          ? triageOverrides.indexers
          : TRIAGE_PRIORITY_INDEXERS;
        const triageLogger = (level, message, context) => {
          const logFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
          if (context) logFn(`[NZB TRIAGE] ${message}`, context);
          else logFn(`[NZB TRIAGE] ${message}`);
        };
        const triageOptions = {
          preferredSizeBytes,
          preferredIndexerIds: preferredIndexerTokens,
          timeBudgetMs: TRIAGE_TIME_BUDGET_MS,
          maxCandidates: TRIAGE_MAX_CANDIDATES,
          downloadConcurrency: Math.max(1, TRIAGE_MAX_CANDIDATES),
          triageOptions: {
            ...TRIAGE_BASE_OPTIONS,
            nntpConfig: { ...TRIAGE_NNTP_CONFIG },
          },
          logger: triageLogger,
        };
        try {
          triageOutcome = await triageAndRank(finalNzbResults, triageOptions);
          triageDecisions = triageOutcome?.decisions instanceof Map ? triageOutcome.decisions : new Map(triageOutcome?.decisions || []);
          triageTitleMap = buildTriageTitleMap(triageDecisions);
          console.log(`[NZB TRIAGE] Evaluated ${triageOutcome.evaluatedCount}/${triageOutcome.candidatesConsidered} candidate NZBs in ${triageOutcome.elapsedMs} ms (timedOut=${triageOutcome.timedOut})`);
          if (triageDecisions.size > 0) {
            const statusCounts = {};
            let loggedSamples = 0;
            const sampleLimit = 5;
            triageDecisions.forEach((decision, downloadUrl) => {
              const status = decision?.status || 'unknown';
              statusCounts[status] = (statusCounts[status] || 0) + 1;
              if (loggedSamples < sampleLimit) {
                console.log('[NZB TRIAGE] Decision sample', {
                  status,
                  blockers: decision?.blockers || [],
                  warnings: decision?.warnings || [],
                  fileCount: decision?.fileCount ?? null,
                  nzbIndex: decision?.nzbIndex ?? null,
                  downloadUrl
                });
                loggedSamples += 1;
              }
            });
            if (triageDecisions.size > sampleLimit) {
              console.log(`[NZB TRIAGE] (${triageDecisions.size - sampleLimit}) additional decisions omitted from sample log`);
            }
            console.log('[NZB TRIAGE] Decision status breakdown', statusCounts);
          } else {
            console.log('[NZB TRIAGE] No decisions were produced by the triage runner');
          }
        } catch (triageError) {
          console.warn(`[NZB TRIAGE] Health check failed: ${triageError.message}`);
        }
      }
    }

    cleanupNzbdavCache();

    const categoryForType = getNzbdavCategory(type);
    let historyByTitle = new Map();
    try {
      historyByTitle = await fetchCompletedNzbdavHistory([categoryForType]);
      if (historyByTitle.size > 0) {
        console.log(`[NZBDAV] Loaded ${historyByTitle.size} completed NZBs for instant playback detection (category=${categoryForType})`);
      }
    } catch (historyError) {
      console.warn(`[NZBDAV] Unable to load NZBDav history for instant detection: ${historyError.message}`);
    }

    const addonBaseUrl = ADDON_BASE_URL.replace(/\/$/, '');

    let triageLogCount = 0;
    let triageLogSuppressed = false;

    const decoratedStreams = finalNzbResults
      .map((result) => {
        const sizeInGB = result.size ? (result.size / 1073741824).toFixed(2) : null;
        const sizeString = sizeInGB ? `${sizeInGB} GB` : 'Size Unknown';

        const qualityMatch = result.title?.match(/(2160p|4K|UHD|1080p|720p|480p)/i);
        const quality = qualityMatch ? qualityMatch[0] : '';

        const baseParams = new URLSearchParams({
          indexerId: String(result.indexerId),
          type,
          id
        });

        baseParams.set('downloadUrl', result.downloadUrl);
        if (result.guid) baseParams.set('guid', result.guid);
        if (result.size) baseParams.set('size', String(result.size));
        if (result.title) baseParams.set('title', result.title);

        const cacheKey = buildNzbdavCacheKey(result.downloadUrl, categoryForType, requestedEpisode);
        const cacheEntry = nzbdavStreamCache.get(cacheKey);
        const normalizedTitle = normalizeReleaseTitle(result.title);
        const historySlot = normalizedTitle ? historyByTitle.get(normalizedTitle) : null;
        const isInstant = cacheEntry?.status === 'ready' || Boolean(historySlot);

  const directTriageInfo = triageDecisions.get(result.downloadUrl);
  const fallbackTitleKey = normalizedTitle;
  const fallbackTriageInfo = !directTriageInfo && fallbackTitleKey ? triageTitleMap.get(fallbackTitleKey) : null;
  const triageInfo = directTriageInfo || fallbackTriageInfo || null;
  const triageApplied = Boolean(directTriageInfo);
  const triageDerivedFromTitle = Boolean(!directTriageInfo && fallbackTriageInfo);
  const triageStatus = triageInfo?.status || (triageApplied ? 'unknown' : 'not-run');
        let triagePriority = 1;
        let triageTag = null;

        if (triageStatus === 'verified') {
          triagePriority = 0;
          triageTag = '✅ Verified';
        } else if (triageStatus === 'unverified') {
          triageTag = '⚠️ Not Verified';
        } else if (triageStatus === 'blocked') {
          triagePriority = 2;
          triageTag = '🚫 Not Playable';
        } else if (triageStatus === 'fetch-error') {
          triagePriority = 2;
          triageTag = '⚠️ NZB Fetch Failed';
        } else if (triageStatus === 'error') {
          triagePriority = 2;
          triageTag = '⚠️ Health Check Error';
        } else if (triageStatus === 'pending' || triageStatus === 'skipped') {
          if (triageOutcome?.timedOut) triageTag = '⏱️ Health Check Pending';
        }

  const archiveFindings = triageInfo?.archiveFindings || [];
        const archiveStatuses = archiveFindings.map((finding) => String(finding?.status || '').toLowerCase());
        const archiveFailureTokens = new Set([
          'rar-compressed',
          'rar-encrypted',
          'rar-solid',
          'rar5-unsupported',
          'sevenzip-unsupported',
          'archive-not-found',
          'archive-no-segments',
          'rar-insufficient-data',
          'rar-header-not-found',
        ]);
        const passedArchiveCheck = archiveStatuses.some((status) => status === 'rar-stored' || status === 'sevenzip-stored');
        const failedArchiveCheck = (triageInfo?.blockers || []).some((blocker) => archiveFailureTokens.has(blocker))
          || archiveStatuses.some((status) => archiveFailureTokens.has(status));
        let archiveCheckStatus = 'not-run';
        if (triageInfo) {
          if (failedArchiveCheck) archiveCheckStatus = 'failed';
          else if (passedArchiveCheck) archiveCheckStatus = 'passed';
          else if (archiveFindings.length > 0) archiveCheckStatus = 'inconclusive';
        }

        const missingArticlesFailure = (triageInfo?.blockers || []).includes('missing-articles')
          || archiveStatuses.includes('segment-missing');
        const missingArticlesSuccess = archiveStatuses.includes('segment-ok');
        let missingArticlesStatus = 'not-run';
        if (triageInfo) {
          if (missingArticlesFailure) missingArticlesStatus = 'failed';
          else if (missingArticlesSuccess) missingArticlesStatus = 'passed';
          else if (archiveFindings.length > 0) missingArticlesStatus = 'inconclusive';
        }

        if (historySlot?.nzoId) {
          baseParams.set('historyNzoId', historySlot.nzoId);
          if (historySlot.jobName) {
            baseParams.set('historyJobName', historySlot.jobName);
          }
          if (historySlot.category) {
            baseParams.set('historyCategory', historySlot.category);
          }
        }

        const tokenSegment = ADDON_SHARED_SECRET ? `/${ADDON_SHARED_SECRET}` : '';
        const streamUrl = `${addonBaseUrl}${tokenSegment}/nzb/stream?${baseParams.toString()}`;
        const tags = [];
        if (triageTag) tags.push(triageTag);
        if (isInstant) tags.push('⚡ Instant');
        tags.push('📰 NZB');
        if (quality) tags.push(quality);
        if (sizeString) tags.push(sizeString);
        const name = 'UsenetStreamer';
        const behaviorHints = {
          notWebReady: true,
          externalPlayer: {
            isRequired: false,
            name: 'NZBDav Instant Stream'
          }
        };

        if (isInstant) {
          behaviorHints.cached = true;
          if (historySlot) {
            behaviorHints.cachedFromHistory = true;
          }
        }

        if (triageApplied && triageLogCount < 10) {
          console.log('[NZB TRIAGE] Stream candidate status', {
            title: result.title,
            downloadUrl: result.downloadUrl,
            status: triageStatus,
            triageApplied,
            triagePriority,
            blockers: triageInfo?.blockers || [],
            warnings: triageInfo?.warnings || [],
            archiveFindings: triageInfo?.archiveFindings || [],
            archiveCheckStatus,
            missingArticlesStatus,
            timedOut: Boolean(triageOutcome?.timedOut)
          });
          triageLogCount += 1;
        } else if (!triageApplied) {
          // Skip logging for streams that were never part of the triage batch
        } else if (!triageLogSuppressed) {
          console.log('[NZB TRIAGE] Additional stream triage logs suppressed');
          triageLogSuppressed = true;
        }

        const stream = {
          title: `${result.title}\n${tags.filter(Boolean).join(' • ')}\n${result.indexer}`,
          name,
          url: streamUrl,
          behaviorHints,
          meta: {
            originalTitle: result.title,
            indexer: result.indexer,
            size: result.size,
            quality,
            age: result.age,
            type: 'nzb',
            cached: Boolean(isInstant),
            cachedFromHistory: Boolean(historySlot),
            cachedFromSession: cacheEntry?.status === 'ready'
          }
        };
        if (triageTag || triageInfo || triageOutcome?.timedOut || !triageApplied) {
          if (triageInfo) {
            stream.meta.healthCheck = {
              status: triageStatus,
              blockers: triageInfo.blockers || [],
              warnings: triageInfo.warnings || [],
              fileCount: triageInfo.fileCount,
              archiveCheck: archiveCheckStatus,
              missingArticlesCheck: missingArticlesStatus,
              applied: triageApplied,
              inheritedFromTitle: triageDerivedFromTitle,
            };
            stream.meta.healthCheck.archiveFindings = archiveFindings;
            if (triageInfo.sourceDownloadUrl) {
              stream.meta.healthCheck.sourceDownloadUrl = triageInfo.sourceDownloadUrl;
            }
          } else {
            stream.meta.healthCheck = {
              status: triageOutcome?.timedOut ? 'pending' : 'not-run',
              applied: false,
            };
          }
        }

        return {
          stream,
          triagePriority,
          size: result.size || 0,
        };
      })
      .filter(Boolean);

    const streams = decoratedStreams
      .sort((a, b) => (b.size || 0) - (a.size || 0))
      .map((entry) => entry.stream);

    const instantCount = streams.filter((stream) => stream?.meta?.cached).length;
    if (instantCount > 0) {
      console.log(`[STREMIO] ${instantCount}/${streams.length} streams already cached in NZBDav`);
    }

    console.log(`[STREMIO] Returning ${streams.length} NZB streams`);

    res.json({ streams });
  } catch (error) {
    console.error('[ERROR] Processing failed:', error.message);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || error.message,
      details: {
        type,
        id,
        indexerManager: INDEXER_MANAGER_LABEL,
        indexerManagerUrl: INDEXER_MANAGER_URL,
        timestamp: new Date().toISOString()
      }
    });
  }
}

if (ADDON_SHARED_SECRET) {
  app.get('/:token/stream/:type/:id.json', streamHandler);
} else {
  app.get('/stream/:type/:id.json', streamHandler);
  app.get('/:token/stream/:type/:id.json', streamHandler);
}

async function handleNzbdavStream(req, res) {
  const { downloadUrl, type = 'movie', id = '', title = 'NZB Stream' } = req.query;

  if (!downloadUrl) {
    res.status(400).json({ error: 'downloadUrl query parameter is required' });
    return;
  }

  try {
    const category = getNzbdavCategory(type);
    const requestedEpisode = parseRequestedEpisode(type, id, req.query || {});
    const cacheKey = buildNzbdavCacheKey(downloadUrl, category, requestedEpisode);
    const existingSlotHint = req.query.historyNzoId
      ? {
          nzoId: req.query.historyNzoId,
          jobName: req.query.historyJobName,
          category: req.query.historyCategory
        }
      : null;

    const streamData = await getOrCreateNzbdavStream(cacheKey, () =>
      buildNzbdavStream({ downloadUrl, category, title, requestedEpisode, existingSlot: existingSlotHint })
    );

    if ((req.method || 'GET').toUpperCase() === 'HEAD') {
      const inferredMime = inferMimeType(streamData.fileName || title || 'stream');
      const totalSize = Number.isFinite(streamData.size) ? streamData.size : undefined;
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', inferredMime);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Content-Type,Accept-Ranges');
      res.setHeader('Content-Disposition', `inline; filename="${(streamData.fileName || 'stream').replace(/[\\/:*?"<>|]+/g, '_')}"`);
      if (Number.isFinite(totalSize)) {
        res.setHeader('Content-Length', String(totalSize));
        res.setHeader('X-Total-Length', String(totalSize));
      }
      res.status(200).end();
      return;
    }

    await proxyNzbdavStream(req, res, streamData.viewPath, streamData.fileName || '');
  } catch (error) {
    if (error?.isNzbdavFailure) {
      console.warn('[NZBDAV] Stream failure detected:', error.failureMessage || error.message);
      const served = await streamFailureVideo(req, res, error);
      if (!served && !res.headersSent) {
        res.status(502).json({ error: error.failureMessage || error.message });
      } else if (!served) {
        res.end();
      }
      return;
    }

    const statusCode = error.response?.status || 502;
    console.error('[NZBDAV] Stream proxy error:', error.message);
    if (!res.headersSent) {
      res.status(statusCode).json({ error: error.message });
    } else {
      res.end();
    }
  }
}

if (ADDON_SHARED_SECRET) {
  app.get('/:token/nzb/stream', handleNzbdavStream);
  app.head('/:token/nzb/stream', handleNzbdavStream);
} else {
  app.get('/:token/nzb/stream', handleNzbdavStream);
  app.head('/:token/nzb/stream', handleNzbdavStream);
  app.get('/nzb/stream', handleNzbdavStream);
  app.head('/nzb/stream', handleNzbdavStream);
}

app.listen(port, '0.0.0.0', () => {
  console.log(`Addon running at http://0.0.0.0:${port}`);
});

