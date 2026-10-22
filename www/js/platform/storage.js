/*
 * Local document store with the same shape the planner used inside the Claude artifact:
 *   db.doc("plans/abc").get() / .set(data) / .onSnapshot(cb, err)
 *   db.collection("fights").onSnapshot(cb, err)
 * Everything lives in IndexedDB on this device. Cloud sync (step 2) replaces this module with
 * Firestore, whose API this mirrors, so app.js does not need to change.
 */
(() => {
  const DB_NAME = "raid-mitigation-planner", STORE = "docs";
  const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));

  function openIdb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  const tx = (idb, mode, fn) => new Promise((resolve, reject) => {
    const t = idb.transaction(STORE, mode), out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out?.result);
    t.onerror = () => reject(t.error);
  });

  async function createLocalDb({ seedUrl } = {}) {
    let idb = null;
    try { idb = await openIdb(); } catch { /* private mode etc.: fall back to memory only */ }
    const docs = new Map(); // "collection/id" -> data
    if (idb) {
      const [keys, vals] = await Promise.all([tx(idb, "readonly", s => s.getAllKeys()), tx(idb, "readonly", s => s.getAll())]);
      keys.forEach((k, i) => docs.set(k, vals[i]));
    }
    if (!docs.size && seedUrl) {
      // First run: load the data exported from the original artifact.
      try {
        const seed = await (await fetch(seedUrl)).json();
        for (const [col, byId] of Object.entries(seed)) for (const [id, d] of Object.entries(byId)) docs.set(`${col}/${id}`, d);
        if (idb) await tx(idb, "readwrite", s => { for (const [k, v] of docs) s.put(v, k); });
      } catch { /* no seed file: start empty */ }
    }

    const docListeners = new Map(), colListeners = new Map();
    const colOf = path => path.split("/")[0];
    const docSnap = path => ({ id: path.split("/").pop(), exists: docs.has(path), data: () => clone(docs.get(path)), metadata: { hasPendingWrites: false } });
    const colSnap = col => ({
      docs: [...docs.keys()].filter(k => colOf(k) === col).map(k => ({ id: k.slice(col.length + 1), exists: true, data: () => clone(docs.get(k)) })),
    });
    const listen = (map, key, cb) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(cb); return () => map.get(key).delete(cb); };
    const notify = path => {
      docListeners.get(path)?.forEach(cb => cb(docSnap(path)));
      const col = colOf(path); colListeners.get(col)?.forEach(cb => cb(colSnap(col)));
    };
    const write = async (path, data) => {
      if (data === undefined) docs.delete(path); else docs.set(path, clone(data));
      if (idb) await tx(idb, "readwrite", s => data === undefined ? s.delete(path) : s.put(clone(data), path));
      notify(path);
    };

    return {
      doc: path => ({
        get: async () => docSnap(path),
        set: data => write(path, data),
        update: data => write(path, { ...(docs.get(path) || {}), ...data }),
        delete: () => write(path, undefined),
        onSnapshot(cb) { const off = listen(docListeners, path, cb); queueMicrotask(() => cb(docSnap(path))); return off; },
      }),
      collection: col => ({
        onSnapshot(cb) { const off = listen(colListeners, col, cb); queueMicrotask(() => cb(colSnap(col))); return off; },
      }),
      // Used by backup export/import.
      dump: () => { const out = {}; for (const [k, v] of docs) { const c = colOf(k); (out[c] ||= {})[k.slice(c.length + 1)] = clone(v); } return out; },
    };
  }

  window.RMP = { ...(window.RMP || {}), createLocalDb };
})();
