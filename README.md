# Raid Mitigation Planner

A FFXIV raid mitigation planner: import an FF Logs fight, place party and tank mitigations on the
timeline, and export a plan or cheat sheet. It started as a Claude artifact and is now a standalone
app that will ship as an Android APK and a Windows .exe, with cloud sync between them.

## Run it

```sh
npm start   # http://localhost:5173
```

No install step: the app is plain HTML, CSS and JavaScript in `www/`.

## Importing from FF Logs

Tap **Import fight** and paste a report link (`https://www.fflogs.com/reports/CODE?fight=N`, or
`fight=last`; no fight imports the last kill). The first time, add an FF Logs API key: create a
client at <https://www.fflogs.com/api/clients/> (any name, redirect URL `http://localhost`, not a
public client) and paste its ID and secret. The key stays on that device.

An import reads the fight's boss casts and damage taken, the mitigations your group pressed, and
the same for the 10 fastest kills of that encounter, which feed **Fill from logs**. **Find logs
with a composition** fetches top kills that include the jobs you pick.

FF Logs doesn't accept calls from web pages, so in a browser `npm start` relays them through the
dev server. The Android and Windows builds call FF Logs directly.

## Layout

```
www/
  index.html            page markup
  css/                  styles (base.css = page reset, app.css = planner)
  js/data.js            mitigation table and icon images
  js/app.js             the planner
  js/fflogs.js          FF Logs importer (report link -> fight file)
  js/platform/          everything device- or host-specific
    index.js            window.claude.use("db" | "downloads") entry point the planner calls
    env.js              per-host settings (the dev server swaps this to route FF Logs calls)
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
