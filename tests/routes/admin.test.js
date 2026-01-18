const request = require('supertest');
const express = require('express');
const bodyParser = require('body-parser');

// Mock dependencies
jest.mock('../../src/services/config/configService', () => ({
    getState: jest.fn(),
    refreshConfig: jest.fn(() => ({ portChanged: false })),
    ADMIN_CONFIG_KEYS: ['PORT', 'TMDB_API_KEY'],
    DEFAULT_ADDON_NAME: 'TestAddon',
    ADDON_VERSION: '1.0.0',
}));
jest.mock('../../config/runtimeEnv', () => ({
    updateRuntimeEnv: jest.fn(),
    applyRuntimeEnv: jest.fn(),
    RUNTIME_ENV_FILE: '.env.test',
}));
jest.mock('../../src/services/newznab', () => ({
    NEWZNAB_NUMBERED_KEYS: [],
    getAvailableNewznabPresets: jest.fn(() => []),
    testNewznabConnection: jest.fn(),
    testNewznabSearch: jest.fn(),
}));
jest.mock('../../src/services/indexer', () => ({
    reloadConfig: jest.fn(),
    testIndexerConnection: jest.fn(),
}));
jest.mock('../../src/services/nzbdav', () => ({
    reloadConfig: jest.fn(),
    testNzbdavConnection: jest.fn(),
}));
jest.mock('../../src/services/tmdb', () => ({
    reloadConfig: jest.fn(),
    testTmdbConnection: jest.fn(),
}));
jest.mock('../../src/services/easynews', () => ({
    reloadConfig: jest.fn(),
    testEasynewsCredentials: jest.fn(),
}));
jest.mock('../../src/cache', () => ({
    reloadNzbdavCacheConfig: jest.fn(),
    clearAllCaches: jest.fn(),
}));
jest.mock('../../src/utils/config', () => ({
    collectConfigValues: jest.fn(() => ({})),
    computeManifestUrl: jest.fn(() => 'http://test/manifest.json'),
    toBoolean: jest.fn((v) => v === 'true' || v === true),
}));
jest.mock('../../src/utils/connectionTests', () => ({
    testIndexerConnection: jest.fn(),
    testNzbdavConnection: jest.fn(),
    testUsenetConnection: jest.fn(),
    testNewznabConnection: jest.fn(),
    testNewznabSearch: jest.fn(),
    testTmdbConnection: jest.fn(),
}));

const adminRouter = require('../../src/routes/admin');
const configService = require('../../src/services/config/configService');
const runtimeEnv = require('../../config/runtimeEnv');

describe('Admin Router', () => {
    let app;

    beforeEach(() => {
        app = express();
        app.use(bodyParser.json());
        app.use('/admin/api', adminRouter);
        jest.clearAllMocks();

        // Default state mock
        configService.getState.mockReturnValue({
            newznabDebug: false,
            port: 7000
        });
    });

    describe('GET /admin/api/config', () => {
        it('should return configuration', async () => {
            const res = await request(app).get('/admin/api/config');
            expect(res.status).toBe(200);
            expect(res.body).toHaveProperty('values');
            expect(res.body).toHaveProperty('manifestUrl');
        });
    });

    describe('POST /admin/api/config', () => {
        it('should update configuration', async () => {
            const payload = {
                values: {
                    PORT: '7001',
                    TMDB_API_KEY: 'test_key'
                }
            };

            const res = await request(app)
                .post('/admin/api/config')
                .send(payload);

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(runtimeEnv.updateRuntimeEnv).toHaveBeenCalledWith(expect.objectContaining({
                PORT: '7001',
                TMDB_API_KEY: 'test_key'
            }));
            expect(configService.refreshConfig).toHaveBeenCalled();
        });

        it('should handle invalid payload', async () => {
            const res = await request(app)
                .post('/admin/api/config')
                .send({}); // Missing 'values'

            expect(res.status).toBe(400);
        });
    });
});
