// DI Container
const configService = require('./services/config/configService');
// Import other services
const indexerService = require('./services/indexer');
const newznabService = require('./services/newznab');
const nzbdavService = require('./services/nzbdav');
const tmdbService = require('./services/tmdb');
const easynewsService = require('./services/easynews');
// const cache = require('./cache'); // Cache is currently a singleton module, might remain so for now

class Container {
    constructor() {
        this.services = {};
    }

    init() {
        // 1. Initialize Config Service
        this.services.config = configService;

        // 2. Initialize Core Services with dependencies
        // Currently most services are singletons that export functions.
        // Ideally we would rewrite them as Classes.
        // For now, we will create a 'context' object that mimics injection.

        this.services.indexer = indexerService;
        this.services.newznab = newznabService;
        this.services.nzbdav = nzbdavService;
        this.services.tmdb = tmdbService;
        this.services.easynews = easynewsService;

        // Refresh Config first to ensure state is ready
        this.refreshConfig();

        return this.services;
    }

    refreshConfig() {
        // Inject dependencies into ConfigService.refreshConfig
        // Use the services we have gathered
        const modules = {
            newznabService: this.services.newznab,
            indexerService: this.services.indexer,
            // Add others if needed by future config logic
        };

        return this.services.config.refreshConfig(modules);
    }
}

module.exports = new Container();
