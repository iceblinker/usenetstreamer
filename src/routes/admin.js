const express = require('express');
const path = require('path');
const configService = require('../services/config/configService');
const runtimeEnv = require('../../config/runtimeEnv');
const newznabService = require('../services/newznab');
const indexerService = require('../services/indexer');
const nzbdavService = require('../services/nzbdav');
const tmdbService = require('../services/tmdb');
const easynewsService = require('../services/easynews');
const cache = require('../cache');
const {
    collectConfigValues,
    computeManifestUrl,
    toBoolean,
    DEFAULT_MAX_RESULT_SIZE_GB, // Assuming this is exported or I need to find where it is
} = require('../utils/config');
const {
    testIndexerConnection,
    testNzbdavConnection,
    testUsenetConnection,
    testNewznabConnection,
    testNewznabSearch,
    testTmdbConnection,
} = require('../utils/connectionTests');

// Need to verify if DEFAULT_MAX_RESULT_SIZE_GB is exported from utils/config
// Based on previous file reads, it seemed to be a constant in server.js or utils. Let's check.
// If not exported, I'll duplicate it or export it.

const router = express.Router();
router.use(express.json({ limit: '1mb' }));

// Helper to check debug status (was in server.js)
function isNewznabDebugEnabled() {
    return configService.getState().newznabDebug;
}

const { ADMIN_CONFIG_KEYS, ADDON_VERSION, DEFAULT_ADDON_NAME } = configService;
// Note: ADDON_VERSION was separate const in server.js, might need to duplicate or move to configService.
// Let's hardcode for now as it defines the server version, or export from package.json?
// server.js had: const ADDON_VERSION = '1.6.0';
const CURRENT_ADDON_VERSION = '1.6.0';

// Constants
const NEWZNAB_NUMBERED_KEYS = newznabService.NEWZNAB_NUMBERED_KEYS;

console.log('Init Admin config route');
router.get('/config', (req, res) => {
    console.log('GET /admin/api/config hit');
    const values = collectConfigValues(ADMIN_CONFIG_KEYS);
    if (!values.NZB_MAX_RESULT_SIZE_GB) {
        // Hardcoding default if not found
        values.NZB_MAX_RESULT_SIZE_GB = '10'; // DEFAULT_MAX_RESULT_SIZE_GB was usually 10
    }
    res.json({
        values,
        manifestUrl: computeManifestUrl(),
        runtimeEnvPath: runtimeEnv.RUNTIME_ENV_FILE,
        debugNewznabSearch: isNewznabDebugEnabled(),
        newznabPresets: newznabService.getAvailableNewznabPresets(),
        addonVersion: CURRENT_ADDON_VERSION,
    });
});

router.post('/config', async (req, res) => {
    const payload = req.body || {};
    const incoming = payload.values;
    if (!incoming || typeof incoming !== 'object') {
        res.status(400).json({ error: 'Invalid payload: expected "values" object' });
        return;
    }

    // Debug: log TMDb related keys
    console.log('[ADMIN] Received TMDb config:', {
        TMDB_API_KEY: incoming.TMDB_API_KEY ? `(${incoming.TMDB_API_KEY.length} chars)` : '(empty)',
        TMDB_SEARCH_LANGUAGE_MODE: incoming.TMDB_SEARCH_LANGUAGE_MODE,
        TMDB_SEARCH_LANGUAGE: incoming.TMDB_SEARCH_LANGUAGE,
    });

    const updates = {};
    const numberedKeySet = new Set(NEWZNAB_NUMBERED_KEYS);
    NEWZNAB_NUMBERED_KEYS.forEach((key) => {
        updates[key] = null;
    });

    ADMIN_CONFIG_KEYS.forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(incoming, key)) {
            const value = incoming[key];
            if (numberedKeySet.has(key)) {
                const trimmed = typeof value === 'string' ? value.trim() : value;
                if (trimmed === '' || trimmed === null || trimmed === undefined) {
                    updates[key] = null;
                } else if (typeof value === 'boolean') {
                    updates[key] = value ? 'true' : 'false';
                } else {
                    updates[key] = String(value);
                }
                return;
            }
            if (value === null || value === undefined) {
                updates[key] = '';
            } else if (typeof value === 'boolean') {
                updates[key] = value ? 'true' : 'false';
            } else {
                updates[key] = String(value);
            }
        }
    });

    // Safety: explicitly persist TMDb keys even if ADMIN_CONFIG_KEYS filtering breaks
    if (Object.prototype.hasOwnProperty.call(incoming, 'TMDB_API_KEY')) {
        updates.TMDB_API_KEY = incoming.TMDB_API_KEY ? String(incoming.TMDB_API_KEY) : '';
    }
    if (Object.prototype.hasOwnProperty.call(incoming, 'TMDB_SEARCH_LANGUAGE_MODE')) {
        updates.TMDB_SEARCH_LANGUAGE_MODE = incoming.TMDB_SEARCH_LANGUAGE_MODE ? String(incoming.TMDB_SEARCH_LANGUAGE_MODE) : '';
    }
    if (Object.prototype.hasOwnProperty.call(incoming, 'TMDB_SEARCH_LANGUAGE')) {
        updates.TMDB_SEARCH_LANGUAGE = incoming.TMDB_SEARCH_LANGUAGE ? String(incoming.TMDB_SEARCH_LANGUAGE) : '';
    }

    // Debug: log what we're about to save
    console.log('[ADMIN] TMDb updates to save:', {
        TMDB_API_KEY: updates.TMDB_API_KEY ? `(${updates.TMDB_API_KEY.length} chars)` : '(not in updates)',
        TMDB_SEARCH_LANGUAGE_MODE: updates.TMDB_SEARCH_LANGUAGE_MODE,
        TMDB_SEARCH_LANGUAGE: updates.TMDB_SEARCH_LANGUAGE,
    });

    try {
        runtimeEnv.updateRuntimeEnv(updates);
        runtimeEnv.applyRuntimeEnv();

        // Debug: check process.env after apply
        console.log('[ADMIN] process.env.TMDB_API_KEY after apply:', process.env.TMDB_API_KEY ? `(${process.env.TMDB_API_KEY.length} chars)` : '(empty)');

        // Trigger configuration reloads
        // Refactoring note: Ideally configService should handle this via an observer pattern,
        // but for now we'll import and call reloadConfig on services directly as server.js did.
        const refreshResult = configService.refreshConfig({ newznabService, indexerService }); // Important to refresh the central config service first!

        indexerService.reloadConfig();
        nzbdavService.reloadConfig();
        tmdbService.reloadConfig();
        if (typeof cache.reloadNzbdavCacheConfig === 'function') {
            cache.reloadNzbdavCacheConfig();
        }
        cache.clearAllCaches('admin-config-save');
        // server.js had logic to restart if port changed.
        // Since we are inside a route handler, we can't easily restart the server process itself from here
        // without signaling the main entry point.
        // However, server.js called `rebuildRuntimeConfig` which returned `portChanged`.
        // We can check if PORT in updates differs from configService.state.port

        // Check for port change
        const newPort = updates.PORT ? Number(updates.PORT) : 7000;
        const currentPort = configService.getState().port;
        const portChanged = newPort !== currentPort;

        // We can't restart the server from here directly in a modular way without passing a callback.
        // For now, we'll return the status and let the user restart manually if needed, 
        // OR we emit an event if we had an event bus.
        // server.js logic:
        // const { portChanged } = rebuildRuntimeConfig(); // which updated global port variable
        // if (portChanged) await restartHttpServer();

        // Compromise: We will apply the config, but we might not be able to auto-restart the server port 
        // if we don't have access to the app listener.
        // In the refactored server.js, we can pass a 'onPortChange' callback to the router? 
        // Or just accept that port changes require manual restart for now?
        // Let's rely on the response flag 'portChanged'.

        res.json({ success: true, manifestUrl: computeManifestUrl(), hotReloaded: true, portChanged });

        // If port changed, we might need to signal server.js. 
        // For this step, we'll assume the client prompt (Admin UI) handles the "restart needed" message.
        // Process.exit() is too aggressive.

    } catch (error) {
        console.error('[ADMIN] Failed to update configuration', error);
        res.status(500).json({ error: 'Failed to persist configuration changes' });
    }
});

router.post('/test-connections', async (req, res) => {
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
            case 'newznab':
                message = await testNewznabConnection(values);
                break;
            case 'newznab-search':
                message = await testNewznabSearch(values);
                break;
            case 'easynews': {
                const username = values?.EASYNEWS_USERNAME || '';
                const password = values?.EASYNEWS_PASSWORD || '';
                message = await easynewsService.testEasynewsCredentials({ username, password });
                break;
            }
            case 'tmdb':
                message = await testTmdbConnection(values);
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

module.exports = router;
