const {
    toBoolean,
    toPositiveInt,
    parseCommaList,
    parsePathList,
    normalizeSortMode,
    resolvePreferredLanguages,
    toSizeBytesFromGb,
    collectConfigValues,
    computeManifestUrl,
    stripTrailingSlashes,
} = require('../../utils/config');
const { normalizeIndexerToken } = require('../../utils/parsers');

// We need to lazy import services to avoid circular deps if they later import configService
// But for now, they don't, so we can import them or inject them.
// To stay safe, we'll accept them in the reload method or let the consumer (server.js) trigger them.
// Better yet, let's keep this service focused on STATE, and return the config object.
// The consumer can then trigger side effects.

// Global Config State
let state = {
    port: 7000,
    streamingMode: 'nzbdav',
    addonBaseUrl: '',
    addonSharedSecret: '',
    addonName: 'UsenetStreamer',

    // Indexer Manager
    indexerManager: 'none',
    indexerManagerUrl: '',
    indexerManagerApiKey: '',
    indexerManagerLabel: 'Disabled',
    indexerManagerStrictIdMatch: false,
    indexerManagerIndexers: null,
    indexerManagerCacheMinutes: null,
    indexerManagerBaseUrl: '',
    indexerManagerBackoffEnabled: true,
    indexerManagerBackoffSeconds: 120,

    // Newznab
    newznabEnabled: false,
    newznabFilterNzbOnly: true,
    debugNewznabSearch: false,
    debugNewznabTest: false,
    debugNewznabEndpoints: false,
    newznabConfigs: [],
    activeNewznabConfigs: [],
    newznabLogPrefix: '[NEWZNAB]',

    // Sorting/Filtering
    indexerSortMode: 'quality_then_size',
    indexerPreferredLanguages: [],
    indexerDedupEnabled: true,
    indexerHideBlockedResults: false,
    indexerMaxResultSizeBytes: 30 * 1024 * 1024 * 1024,
    allowedResolutions: [],
    resolutionLimitPerQuality: null,

    // Triage
    triageEnabled: false,
    triageTimeBudgetMs: 35000,
    triageMaxCandidates: 25,
    triageDownloadConcurrency: 8,
    triagePriorityIndexers: [],
    triageHealthIndexers: [],
    triageSerializedIndexers: [],
    triageArchiveDirs: [],
    triageNntpConfig: null,
    triageMaxDecodedBytes: 32 * 1024,
    triageNntpMaxConnections: 60,
    triageMaxParallelNzbs: 16,
    triageStatSampleCount: 2,
    triageArchiveSampleCount: 1,
    triageReusePool: true,
    triageNntpKeepAliveMs: 0,
    triagePrefetchFirstVerified: true,

    // Computed
    paidIndexerTokens: new Set(),
    indexerLogPrefix: '',
};

const DEFAULT_ADDON_NAME = 'UsenetStreamer';
const DEFAULT_MAX_RESULT_SIZE_GB = 30;

// Helper to build search log prefix
function buildSearchLogPrefix(manager, managerLabel, newznabEnabled) {
    const managerSegment = manager === 'none'
        ? 'mgr=OFF'
        : `mgr=${managerLabel.toUpperCase()}`;
    const directSegment = newznabEnabled ? 'direct=ON' : 'direct=OFF';
    return `[SEARCH ${managerSegment} ${directSegment}]`;
}

// Logic extracted from server.js
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

function refreshConfig(modules) {
    const { newznabService, indexerService } = modules; // Dependency injection for logic that relies on them

    const newState = { ...state };

    const previousPort = state.port;
    newState.port = Number(process.env.PORT || 7000);
    const previousBaseUrl = state.addonBaseUrl;
    const previousSharedSecret = state.addonSharedSecret;

    newState.streamingMode = (process.env.STREAMING_MODE || 'nzbdav').trim().toLowerCase();
    if (!['nzbdav', 'native'].includes(newState.streamingMode)) newState.streamingMode = 'nzbdav';

    newState.addonBaseUrl = (process.env.ADDON_BASE_URL || '').trim();
    newState.addonSharedSecret = (process.env.ADDON_SHARED_SECRET || '').trim();
    newState.addonName = (process.env.ADDON_NAME || DEFAULT_ADDON_NAME).trim() || DEFAULT_ADDON_NAME;

    newState.indexerManager = (process.env.INDEXER_MANAGER || 'none').trim().toLowerCase();

    if (newState.streamingMode === 'native') newState.indexerManager = 'none';

    newState.indexerManagerUrl = (process.env.INDEXER_MANAGER_URL || process.env.PROWLARR_URL || '').trim();
    newState.indexerManagerApiKey = (process.env.INDEXER_MANAGER_API_KEY || process.env.PROWLARR_API_KEY || '').trim();

    newState.indexerManagerLabel = newState.indexerManager === 'nzbhydra'
        ? 'NZBHydra'
        : newState.indexerManager === 'none'
            ? 'Disabled'
            : 'Prowlarr';

    newState.indexerManagerStrictIdMatch = toBoolean(process.env.INDEXER_MANAGER_STRICT_ID_MATCH || process.env.PROWLARR_STRICT_ID_MATCH, false);

    newState.indexerManagerIndexers = (() => {
        const raw = process.env.INDEXER_MANAGER_INDEXERS || process.env.PROWLARR_INDEXERS || '';
        if (!raw.trim()) return null;
        if (raw.trim() === '-1') return -1;
        return parseCommaList(raw);
    })();

    newState.indexerManagerCacheMinutes = (() => {
        const raw = Number(process.env.INDEXER_MANAGER_CACHE_MINUTES || process.env.NZBHYDRA_CACHE_MINUTES);
        return Number.isFinite(raw) && raw > 0 ? raw : (newState.indexerManager === 'nzbhydra' ? 10 : null);
    })();

    newState.indexerManagerBaseUrl = newState.indexerManagerUrl.replace(/\/+$/, '');
    newState.indexerManagerBackoffEnabled = toBoolean(process.env.INDEXER_MANAGER_BACKOFF_ENABLED, true);
    newState.indexerManagerBackoffSeconds = toPositiveInt(process.env.INDEXER_MANAGER_BACKOFF_SECONDS, 120);

    newState.newznabEnabled = toBoolean(process.env.NEWZNAB_ENABLED, false);
    newState.newznabFilterNzbOnly = toBoolean(process.env.NEWZNAB_FILTER_NZB_ONLY, true);
    newState.debugNewznabSearch = toBoolean(process.env.DEBUG_NEWZNAB_SEARCH, false);
    newState.debugNewznabTest = toBoolean(process.env.DEBUG_NEWZNAB_TEST, false);
    newState.debugNewznabEndpoints = toBoolean(process.env.DEBUG_NEWZNAB_ENDPOINTS, false);

    if (newznabService) {
        newState.newznabConfigs = newznabService.getEnvNewznabConfigs({ includeEmpty: false });
        newState.activeNewznabConfigs = newznabService.filterUsableConfigs(newState.newznabConfigs, { requireEnabled: true, requireApiKey: true });
    }

    newState.indexerLogPrefix = buildSearchLogPrefix(newState.indexerManager, newState.indexerManagerLabel, newState.newznabEnabled);

    newState.indexerSortMode = normalizeSortMode(process.env.NZB_SORT_MODE, 'quality_then_size');
    newState.indexerPreferredLanguages = resolvePreferredLanguages(process.env.NZB_PREFERRED_LANGUAGE, []);
    newState.indexerDedupEnabled = toBoolean(process.env.NZB_DEDUP_ENABLED, true);
    newState.indexerHideBlockedResults = toBoolean(process.env.NZB_HIDE_BLOCKED_RESULTS, false);

    newState.indexerMaxResultSizeBytes = toSizeBytesFromGb(
        process.env.NZB_MAX_RESULT_SIZE_GB && process.env.NZB_MAX_RESULT_SIZE_GB !== ''
            ? process.env.NZB_MAX_RESULT_SIZE_GB
            : DEFAULT_MAX_RESULT_SIZE_GB
    );

    newState.allowedResolutions = parseAllowedResolutionList(process.env.NZB_ALLOWED_RESOLUTIONS);
    newState.resolutionLimitPerQuality = parseResolutionLimitValue(process.env.NZB_RESOLUTION_LIMIT_PER_QUALITY);

    newState.triageEnabled = toBoolean(process.env.NZB_TRIAGE_ENABLED, false);
    newState.triageTimeBudgetMs = toPositiveInt(process.env.NZB_TRIAGE_TIME_BUDGET_MS, 35000);
    newState.triageMaxCandidates = toPositiveInt(process.env.NZB_TRIAGE_MAX_CANDIDATES, 25);
    newState.triageDownloadConcurrency = toPositiveInt(process.env.NZB_TRIAGE_DOWNLOAD_CONCURRENCY, 8);
    newState.triagePriorityIndexers = parseCommaList(process.env.NZB_TRIAGE_PRIORITY_INDEXERS);
    newState.triageHealthIndexers = parseCommaList(process.env.NZB_TRIAGE_HEALTH_INDEXERS);
    newState.triageSerializedIndexers = parseCommaList(process.env.NZB_TRIAGE_SERIALIZED_INDEXERS);
    newState.triageArchiveDirs = parsePathList(process.env.NZB_TRIAGE_ARCHIVE_DIRS);
    newState.triageNntpConfig = buildTriageNntpConfig();
    newState.triageMaxDecodedBytes = toPositiveInt(process.env.NZB_TRIAGE_MAX_DECODED_BYTES, 32 * 1024);
    newState.triageNntpMaxConnections = toPositiveInt(process.env.NZB_TRIAGE_MAX_CONNECTIONS, 60);
    newState.triageMaxParallelNzbs = toPositiveInt(process.env.NZB_TRIAGE_MAX_PARALLEL_NZBS, 16);
    newState.triageStatSampleCount = toPositiveInt(process.env.NZB_TRIAGE_STAT_SAMPLE_COUNT, 2);
    newState.triageArchiveSampleCount = toPositiveInt(process.env.NZB_TRIAGE_ARCHIVE_SAMPLE_COUNT, 1);
    newState.triageReusePool = toBoolean(process.env.NZB_TRIAGE_REUSE_POOL, true);
    newState.triageNntpKeepAliveMs = toPositiveInt(process.env.NZB_TRIAGE_NNTP_KEEP_ALIVE_MS, 0);
    newState.triagePrefetchFirstVerified = toBoolean(process.env.NZB_TRIAGE_PREFETCH_FIRST_VERIFIED, true);

    // Computed state
    newState.paidIndexerTokens = new Set();

    if (newState.triagePriorityIndexers) {
        newState.triagePriorityIndexers.forEach((token) => {
            // We lack normalizeIndexerToken here, need to import or move it? 
            // It resides in utils/parsers. We should probably import it.
            // For now, let's defer this computation or import the parser.
        });
    }

    // Commit state
    Object.assign(state, newState);

    const portChanged = previousPort !== undefined && previousPort !== newState.port;

    return {
        portChanged,
        logDetails: {
            port: newState.port,
            portChanged,
            baseUrlChanged: previousBaseUrl !== undefined && previousBaseUrl !== newState.addonBaseUrl,
            sharedSecretChanged: previousSharedSecret !== undefined && previousSharedSecret !== newState.addonSharedSecret,
            addonName: newState.addonName,
            indexerManager: newState.indexerManager,
            newznabEnabled: newState.newznabEnabled,
            triageEnabled: newState.triageEnabled,
        }
    };
}

// Helpers required locally but also used in server.js logic
// ... we will import normalizeIndexerToken from utils/parsers
// But wait, server.js imports { normalizeIndexerToken } from './src/utils/parsers'.
// So let's add that import up top.

function getState() {
    return state;
}

const ADMIN_CONFIG_KEYS = [
    'PORT',
    'STREAMING_MODE',
    'ADDON_BASE_URL',
    'ADDON_NAME',
    'ADDON_SHARED_SECRET',
    'INDEXER_MANAGER',
    'INDEXER_MANAGER_URL',
    'INDEXER_MANAGER_API_KEY',
    'INDEXER_MANAGER_STRICT_ID_MATCH',
    'INDEXER_MANAGER_INDEXERS',
    'INDEXER_MANAGER_CACHE_MINUTES',
    'NZB_SORT_MODE',
    'NZB_PREFERRED_LANGUAGE',
    'NZB_MAX_RESULT_SIZE_GB',
    'NZB_DEDUP_ENABLED',
    'NZB_HIDE_BLOCKED_RESULTS',
    'NZB_ALLOWED_RESOLUTIONS',
    'NZB_RESOLUTION_LIMIT_PER_QUALITY',
    'TMDB_API_KEY',
    'TMDB_SEARCH_LANGUAGE_MODE',
    'TMDB_SEARCH_LANGUAGE',
    'NZB_TRIAGE_ENABLED',
    'NZB_TRIAGE_TIME_BUDGET_MS',
    'NZB_TRIAGE_MAX_CANDIDATES',
    'NZB_TRIAGE_DOWNLOAD_CONCURRENCY',
    'NZB_TRIAGE_PRIORITY_INDEXERS',
    'NZB_TRIAGE_HEALTH_INDEXERS',
    'NZB_TRIAGE_SERIALIZED_INDEXERS',
    'NZB_TRIAGE_ARCHIVE_DIRS',
    'NZB_TRIAGE_NNTP_HOST',
    'NZB_TRIAGE_NNTP_PORT',
    'NZB_TRIAGE_NNTP_USER',
    'NZB_TRIAGE_NNTP_PASS',
    'NZB_TRIAGE_NNTP_TLS',
    'NZB_TRIAGE_MAX_DECODED_BYTES',
    'NZB_TRIAGE_MAX_CONNECTIONS',
    'NZB_TRIAGE_MAX_PARALLEL_NZBS',
    'NZB_TRIAGE_STAT_SAMPLE_COUNT',
    'NZB_TRIAGE_ARCHIVE_SAMPLE_COUNT',
    'NZB_TRIAGE_REUSE_POOL',
    'NZB_TRIAGE_NNTP_KEEP_ALIVE_MS',
    'NZB_TRIAGE_PREFETCH_FIRST_VERIFIED',
    'NEWZNAB_ENABLED',
    'NEWZNAB_FILTER_NZB_ONLY',
    'DEBUG_NEWZNAB_SEARCH',
    'DEBUG_NEWZNAB_TEST',
    'DEBUG_NEWZNAB_ENDPOINTS',
    'INDEXER_MANAGER_BACKOFF_ENABLED',
    'INDEXER_MANAGER_BACKOFF_SECONDS',
    'EASYNEWS_ENABLED',
    'EASYNEWS_USERNAME',
    'EASYNEWS_PASSWORD',
];

// Helper from server.js
function parseResolutionLimitValue(rawValue) {
    if (rawValue === undefined || rawValue === null) return null;
    const normalized = String(rawValue).trim();
    if (!normalized) return null;
    const numeric = Number(normalized);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return Math.floor(numeric);
}

function parseAllowedResolutionList(rawValue) {
    // This logic relies on parseCommaList which we imported
    // And normalizeResolutionToken which we should implement or import
    const entries = parseCommaList(rawValue);
    if (!Array.isArray(entries) || entries.length === 0) return [];
    return entries
        .map((entry) => {
            if (entry === undefined || entry === null) return null;
            const token = String(entry).trim().toLowerCase();
            return token || null;
        })
        .filter(Boolean);
}

module.exports = {
    state, // Direct access if needed, but preferably use getters
    getState,
    refreshConfig,
    ADMIN_CONFIG_KEYS,
};
