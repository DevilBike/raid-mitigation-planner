/*
 * The planner was written for a Claude artifact, which hands it services through
 * window.claude.use(name). This provides the same entry point backed by this app's own
 * platform modules, so the planner code runs unchanged in a browser, on Android and on Windows.
 */
(() => {
  let dbPromise;
  const services = {
    db: () => (dbPromise ||= window.RMP.createLocalDb({ seedUrl: "data/seed.json" })),
    downloads: async () => window.RMP.downloads,
  };
  window.claude = {
    use: name => services[name] ? services[name]() : Promise.reject(new Error(`Unknown service: ${name}`)),
  };
})();
