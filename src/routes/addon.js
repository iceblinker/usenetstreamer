const express = require('express');
const configService = require('../services/config/configService');

const router = express.Router();

function ensureAddonConfigured() {
    if (!configService.getState().addonBaseUrl) {
        throw new Error('configService.getState().addonBaseUrl is not configured');
    }
}

function manifestHandler(req, res) {
    ensureAddonConfigured();

    const cfg = configService.getState();
    const STREAMING_MODE = cfg.streamingMode || 'nzbdav';
    // Fallback version/name if not in config. 
    // Ideally these should be constants or from package.json
    const ADDON_VERSION = '1.6.0';
    const ADDON_NAME = 'UsenetStreamer';

    const description = STREAMING_MODE === 'native'
        ? 'Native Usenet streaming for Stremio v5 (Windows) - NZB sources via direct Newznab indexers'
        : 'Usenet-powered instant streams for Stremio via Prowlarr/NZBHydra and NZBDav';

    // Removed specialMetadata usage as the file was deleted
    const idPrefixes = ['tt', 'tvdb', 'pt'];

    res.json({
        id: STREAMING_MODE === 'native' ? 'com.usenet.streamer.native' : 'com.usenet.streamer',
        version: ADDON_VERSION,
        name: ADDON_NAME,
        description,
        logo: `${cfg.addonBaseUrl.replace(/\/$/, '')}/assets/icon.png`,
        resources: ['stream'],
        types: ['movie', 'series', 'channel', 'tv'],
        catalogs: [],
        idPrefixes
    });
}

['/manifest.json', '/:token/manifest.json'].forEach((route) => {
    router.get(route, manifestHandler);
});

module.exports = router;
