// Stub for specialMetadata - telemetry removed for privacy
// This provides minimal exports to satisfy server.js imports

module.exports = {
    SPECIAL_ID_PREFIX: 'us_special', // Dummy value to prevent undefined errors
    specialCatalogPrefixes: [],
    getSpecialMetadata: () => null,
    isSpecialId: () => false,
    resolveSpecialId: async () => null,
    fetchSpecialMetadata: async () => null,
};
