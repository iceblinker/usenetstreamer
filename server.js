require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const container = require('./src/container');
const runtimeEnv = require('./config/runtimeEnv');
// We can now access services via container.services if needed, or keep imports for routers if they are not yet fully DI'd.
// Routers currently import services directly. We'll improve that later.
// For now, server.js initialization is the focus.

const configService = container.services.config || require('./src/services/config/configService'); // Fallback if not init yet
const { ensureSharedSecret } = require('./src/middleware/auth');
const indexerService = require('./src/services/indexer');
const nzbdavService = require('./src/services/nzbdav');
const tmdbService = require('./src/services/tmdb');
const easynewsService = require('./src/services/easynews');
const cache = require('./src/cache');

// Initialize Container
const services = container.init();


// Routers
const adminRouter = require('./src/routes/admin');
const addonRouter = require('./src/routes/addon');
const streamRouter = require('./src/routes/streams');

// Apply runtime environment
runtimeEnv.applyRuntimeEnv();

const app = express();
// Port is managed by ConfigService, but we need to listen on it.
// Initially read from env or default
let currentPort = Number(process.env.PORT || 7000);
const SERVER_HOST = '0.0.0.0';

app.use(cors());
app.use('/assets', express.static(path.join(__dirname, 'assets')));

const adminStatic = express.static(path.join(__dirname, 'admin'));

// Mount Admin API
// Protected by ensureSharedSecret
console.log('Mounting /admin/api...');
app.use('/admin/api', (req, res, next) => {
  console.log('[SERVER] Request to /admin/api', req.method, req.path);
  ensureSharedSecret(req, res, next);
}, adminRouter);

// Mount Admin UI
app.use('/admin', adminStatic);
app.use('/:token/admin', (req, res, next) => {
  ensureSharedSecret(req, res, (err) => {
    if (err) return;
    adminStatic(req, res, next);
  });
});

// Redirect root to admin
app.get('/', (req, res) => {
  res.redirect('/admin');
});

// Addon Routes (Manifest, Configure if it existed)
app.use('/', addonRouter);

// Stream Routes
app.use('/', streamRouter);

// Global Config Refresh & Service Init
// Container already refreshed config during init()
const cfg = configService.getState();
const resolvedAddonBase = cfg.addonBaseUrl || `http://${SERVER_HOST}:${currentPort}`;

// Initialize Services
easynewsService.reloadConfig({ addonBaseUrl: resolvedAddonBase, sharedSecret: cfg.addonSharedSecret });
indexerService.reloadConfig();
nzbdavService.reloadConfig();
tmdbService.reloadConfig();

// Start Server
let serverInstance = null;

function startHttpServer() {
  if (serverInstance) return serverInstance;
  serverInstance = app.listen(currentPort, SERVER_HOST, () => {
    console.log(`Addon running at http://${SERVER_HOST}:${currentPort}`);
  });
  serverInstance.on('close', () => {
    serverInstance = null;
  });
  return serverInstance;
}

startHttpServer();

// Handle uncaught errors to prevent crash loop?
// For now, let it crash/restart as managed by Docker/systemd
