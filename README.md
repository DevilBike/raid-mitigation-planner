# Raid Mitigation Planner

A FFXIV raid mitigation planner: import an FF Logs fight, place party and tank mitigations on the
timeline, and export a plan or cheat sheet. It started as a Claude artifact and is now a standalone
app that will ship as an Android APK and a Windows .exe, with cloud sync between them.

## Run it

```sh
npm start   # http://localhost:5173
```

No install step: the app is plain HTML, CSS and JavaScript in `www/`.

## Layout

```
www/
  index.html            page markup
  css/                  styles (base.css = page reset, app.css = planner)
  js/data.js            mitigation table and icon images
  js/app.js             the planner
  js/platform/          everything device- or host-specific
    index.js            window.claude.use("db" | "downloads") entry point the planner calls
    storage.js          local document store (IndexedDB); swapped for cloud sync later
    downloads.js        saving files (plans, CSV, cheat-sheet PNG)
  data/seed.json        fights and plans exported from the original artifact, loaded on first run
scripts/                dev server and smoke test
```

`app.js` only talks to the outside world through `window.claude.use(...)`, so the packaging and
sync steps change files in `www/js/platform/` and leave the planner alone.

## Roadmap

1. ~~Standalone web app~~ (this)
2. Cloud sync with sign-in, so phone and PC share fights and plans
3. Android APK (Capacitor) and Windows .exe (Electron or Tauri), built by GitHub Actions
4. Install and test on both devices
