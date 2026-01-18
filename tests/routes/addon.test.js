const request = require('supertest');
const express = require('express');

// Mock configService
jest.mock('../../src/services/config/configService', () => ({
    getState: jest.fn(),
}));

const addonRouter = require('../../src/routes/addon');
const configService = require('../../src/services/config/configService');

describe('Addon Router', () => {
    let app;

    beforeEach(() => {
        app = express();
        app.use('/', addonRouter);
        jest.clearAllMocks();
    });

    describe('GET /manifest.json', () => {
        it('should return valid manifest', async () => {
            configService.getState.mockReturnValue({
                addonBaseUrl: 'http://test-addon',
                streamingMode: 'nzbdav'
            });

            const res = await request(app).get('/manifest.json');

            expect(res.status).toBe(200);
            expect(res.body).toEqual(expect.objectContaining({
                id: 'com.usenet.streamer',
                version: '1.6.0',
                name: 'UsenetStreamer',
                resources: ['stream'],
                types: ['movie', 'series', 'channel', 'tv'],
            }));
        });

        it('should fail if addonBaseUrl is missing', async () => {
            configService.getState.mockReturnValue({
                addonBaseUrl: null // Missing
            });

            // It throws an error, Express defaults to 500 HTML if not handled, 
            // but let's see how the router behaves.
            // The router calls ensureAddonConfigured which throws Error.
            // Express catches sync errors.

            const res = await request(app).get('/manifest.json');
            expect(res.status).toBe(500);
        });
    });
});
