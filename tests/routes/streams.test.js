const request = require('supertest');
const express = require('express');

// Mock dependencies
jest.mock('../../src/services/config/configService', () => ({
    getState: jest.fn(),
    refreshConfig: jest.fn(),
}));
jest.mock('../../src/services/indexer', () => ({
    ensureIndexerManagerConfigured: jest.fn(),
}));
jest.mock('../../src/services/nzbdav', () => ({
    ensureNzbdavConfigured: jest.fn(),
}));
jest.mock('../../src/services/triage', () => ({
    preWarmNntpPool: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/utils/parsers', () => ({
    parseRequestedEpisode: jest.fn((type, id) => null),
    inferMimeType: jest.fn(() => 'application/x-nzb'),
}));
jest.mock('../../src/cache', () => ({
    getStreamCacheEntry: jest.fn(() => null),
}));

const streamRouter = require('../../src/routes/streams');
const configService = require('../../src/services/config/configService');

describe('Stream Router', () => {
    let app;

    beforeEach(() => {
        app = express();
        app.use('/', streamRouter);
        jest.clearAllMocks();
    });

    describe('GET /stream/:type/:id.json', () => {
        it('should return empty streams array (placeholder logic)', async () => {
            configService.getState.mockReturnValue({
                addonBaseUrl: 'http://test-addon',
                streamingMode: 'nzbdav',
                indexerManager: 'none'
            });

            const res = await request(app).get('/stream/movie/tt1234567.json');

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ streams: [] });
        });

        it('should fail if addonBaseUrl is missing', async () => {
            configService.getState.mockReturnValue({
                addonBaseUrl: null
            });

            const res = await request(app).get('/stream/movie/tt1234567.json');
            expect(res.status).toBe(500);
            expect(res.body.error).toMatch(/not configured/);
        });

        it('should handle unsupported ID prefixes', async () => {
            // ...
            // Logic in streams.js checks id prefix
            // tt... is valid
            // invalid... should 400

            const res = await request(app).get('/stream/movie/invalid123.json');
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/Unsupported ID prefix/);
        });
    });
});
