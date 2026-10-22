/*
 * FF Logs importer: turns a report link into the planner's fight file ("mit-planner/1").
 *
 * Talks to the FF Logs v2 GraphQL API with the user's own API client (client credentials).
 * Output per fight:
 *   events   boss casts and damage, one row per hit of an ability (dmg.per = each party
 *            member's damage as a share of their max HP, in party order; dmg.ratio = median hit)
 *   used     mitigations this group pressed
 *   popular  mitigations the fastest kills used for each hit, from sampleSize logs
 * Comp-specific patterns ("Find logs with a composition") use the same pipeline.
 */
(() => {
  const SAMPLE_LOGS = 10;
  const KEY_STORE = "fflogsKeys";

  const JOBS = {
    Paladin: "PLD", Warrior: "WAR", DarkKnight: "DRK", Gunbreaker: "GNB",
    WhiteMage: "WHM", Scholar: "SCH", Astrologian: "AST", Sage: "SGE",
    Monk: "MNK", Dragoon: "DRG", Ninja: "NIN", Samurai: "SAM", Reaper: "RPR", Viper: "VPR",
    Bard: "BRD", Machinist: "MCH", Dancer: "DNC",
    BlackMage: "BLM", Summoner: "SMN", RedMage: "RDM", Pictomancer: "PCT",
  };
  const TANK_JOBS = new Set(["PLD", "WAR", "DRK", "GNB"]);
  const jobOf = subType => JOBS[String(subType || "").replace(/\s+/g, "")] || null;
  const partyOrder = jobs => [...jobs].sort((a, b) => (TANK_JOBS.has(b) - TANK_JOBS.has(a)) || a.localeCompare(b));

  // Mitigation lookup by in-game action name (current name or older aliases).
  const MIT_BY_NAME = new Map();
  for (const m of MITS) for (const n of [m.n, ...(m.a || [])]) MIT_BY_NAME.set(n.toLowerCase(), m);

  /* ---------- Link parsing ---------- */
  function parseLink(text) {
    const s = String(text || "").trim();
    const code = s.match(/reports\/(?:a:)?([A-Za-z0-9]{16})/)?.[1] || (/^[A-Za-z0-9]{16}$/.test(s) ? s : null);
    if (!code) throw new Error("That doesn't look like an FF Logs report link.");
    const fight = s.match(/[?#&]fight=(\d+|last)/)?.[1] || null;
    return { code, fight: fight === "last" ? "last" : fight ? Number(fight) : null };
  }

  /* ---------- API access ---------- */
  const getKeys = () => { try { return JSON.parse(localStorage.getItem(KEY_STORE)) || null; } catch { return null; } };
  const setKeys = keys => { try { keys ? localStorage.setItem(KEY_STORE, JSON.stringify(keys)) : localStorage.removeItem(KEY_STORE); } catch {} token = null; };
  // In the browser the dev server relays requests, since FF Logs doesn't allow calls from web pages.
  const base = () => window.RMP_ENV?.fflogsBase || "https://www.fflogs.com";

  let token = null;
  async function getToken() {
    if (token && token.exp > Date.now() + 60000) return token.value;
    const keys = getKeys();
    if (!keys?.id || !keys?.secret) throw Object.assign(new Error("Add your FF Logs API key first."), { code: "nokey" });
    let res;
    try {
      res = await fetch(base() + "/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Basic " + btoa(`${keys.id}:${keys.secret}`) },
        body: "grant_type=client_credentials",
      });
    } catch { throw new Error("Couldn't reach FF Logs. Check your connection."); }
    if (res.status === 401 || res.status === 400) throw Object.assign(new Error("FF Logs didn't accept that API key. Check the client ID and secret."), { code: "badkey" });
    if (!res.ok) throw new Error(`FF Logs sign-in failed (${res.status}).`);
    const j = await res.json();
    token = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
    return token.value;
  }
  async function gql(query, variables) {
    const res = await fetch(base() + "/api/v2/client", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + await getToken() },
      body: JSON.stringify({ query, variables }),
    }).catch(() => { throw new Error("Couldn't reach FF Logs. Check your connection."); });
    if (res.status === 429) throw new Error("FF Logs says we've made too many requests. Wait a few minutes and try again.");
    if (!res.ok) throw new Error(`FF Logs request failed (${res.status}).`);
    const j = await res.json();
    if (j.errors?.length) throw new Error("FF Logs: " + j.errors.map(e => e.message).join("; "));
    return j.data;
  }

  /* ---------- Report data ---------- */
  const REPORT_Q = `query($code: String!) { reportData { report(code: $code) {
    code title startTime
    zone { name }
    phases { encounterID phases { id name isIntermission } }
    fights { id encounterID name difficulty kill startTime endTime size
      gameZone { name } friendlyPlayers enemyNPCs { id } phaseTransitions { id startTime } }
    masterData { abilities { gameID name type } actors { id name type subType petOwner } }
  } } }`;
  async function loadReport(code) {
    const r = (await gql(REPORT_Q, { code }))?.reportData?.report;
    if (!r) throw new Error("FF Logs couldn't find that report. Is it private?");
    return r;
  }
  function pickFight(report, want) {
    const fights = report.fights || [];
    if (typeof want === "number") {
      const f = fights.find(x => x.id === want);
      if (!f) throw new Error(`That report has no fight ${want}.`);
      return f;
    }
    const enc = fights.filter(x => x.encounterID > 0);
    const f = want === "last" ? (enc.at(-1) || fights.at(-1)) : (enc.filter(x => x.kill).at(-1) || enc.at(-1) || fights.at(-1));
    if (!f) throw new Error("That report has no fights.");
    return f;
  }

  const EVENTS_Q = `query($code: String!, $fight: [Int], $start: Float, $end: Float, $type: EventDataType, $host: HostilityType) {
    reportData { report(code: $code) {
      events(fightIDs: $fight, startTime: $start, endTime: $end, dataType: $type, hostilityType: $host, includeResources: true, limit: 10000) { data nextPageTimestamp }
    } } }`;
  async function loadEvents(code, fight, type, host) {
    const out = [];
    let start = fight.startTime;
    for (let page = 0; page < 50 && start != null; page++) {
      const ev = (await gql(EVENTS_Q, { code, fight: [fight.id], start, end: fight.endTime, type, host }))?.reportData?.report?.events;
      if (!ev) break;
      out.push(...(ev.data || []));
      start = ev.nextPageTimestamp ?? null;
    }
    return out;
  }

  /* ---------- Building the timeline ---------- */
  const SCHOOL = { 128: "physical", 1024: "magical" };
  const median = xs => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };
  const r2 = x => Math.round(x * 100) / 100, r3 = x => Math.round(x * 1000) / 1000;

  // Everything needed from one fight: timeline events, party, HP, and the mits the group used.
  async function analyzeFight(code, report, fight) {
    const [dmgEv, enemyCasts, friendlyCasts] = await Promise.all([
      loadEvents(code, fight, "DamageTaken", "Friendlies"),
      loadEvents(code, fight, "Casts", "Enemies"),
      loadEvents(code, fight, "Casts", "Friendlies"),
    ]);
    const t0 = fight.startTime;
    const abil = new Map((report.masterData?.abilities || []).map(a => [a.gameID, a]));
    const actors = new Map((report.masterData?.actors || []).map(a => [a.id, a]));
    const inFight = new Set(fight.friendlyPlayers || []);

    // Party: players in this fight, ordered tanks first.
    const players = [...inFight].map(id => actors.get(id)).filter(a => a && jobOf(a.subType));
    const ordered = partyOrder(players.map(a => jobOf(a.subType)));
    const slotOf = new Map(); // actor id -> index in party
    const taken = new Set();
    for (const a of players) {
      const j = jobOf(a.subType);
      const i = ordered.findIndex((x, k) => x === j && !taken.has(k));
      taken.add(i); slotOf.set(a.id, i);
    }
    const maxHp = new Array(ordered.length).fill(0);

    // Damage: group each ability's hits into one row per use (hits within 1s of each other).
    const abilityName = id => abil.get(id)?.name || `Ability ${id}`;
    const isBoss = id => actors.get(id)?.subType === "Boss";
    const hits = dmgEv.filter(e => e.type === "damage" && !e.tick && slotOf.has(e.targetID) && !slotOf.has(e.sourceID)
      && !/^attack$/i.test(abilityName(e.abilityGameID)));
    hits.sort((a, b) => a.timestamp - b.timestamp);
    const open = new Map(), clusters = [];
    for (const h of hits) {
      const i = slotOf.get(h.targetID), hp = h.targetResources?.maxHitPoints || 0;
      if (hp > maxHp[i]) maxHp[i] = hp;
      let c = open.get(h.abilityGameID);
      if (!c || h.timestamp - c.last > 1000) { c = { id: h.abilityGameID, t: h.timestamp, last: h.timestamp, hits: [], src: h.sourceID }; open.set(h.abilityGameID, c); clusters.push(c); }
      c.last = h.timestamp; c.hits.push(h);
    }

    // Enemy casts with a cast bar, for timing and for mechanics that hit no one.
    const casts = enemyCasts.filter(e => e.type === "begincast" && !slotOf.has(e.sourceID))
      .map(e => ({ id: e.abilityGameID, name: abilityName(e.abilityGameID), start: e.timestamp, dur: e.duration || 0, src: e.sourceID, used: false }));

    const events = [];
    for (const c of clusters) {
      const per = new Array(ordered.length).fill(0), ratios = [], amounts = [];
      let crits = 0;
      for (const h of c.hits) {
        const i = slotOf.get(h.targetID), hp = h.targetResources?.maxHitPoints || maxHp[i] || 1;
        const raw = h.unmitigatedAmount ?? ((h.amount || 0) + (h.absorbed || 0) + (h.mitigated || 0));
        per[i] += raw / hp; ratios.push(raw / hp); amounts.push(raw);
        if (h.hitType === 2) crits++;
      }
      const targets = new Set(c.hits.map(h => h.targetID)).size, ratio = median(ratios);
      if (ratio < 0.03) continue; // chip damage: not worth a row
      const hitIdx = per.map((v, i) => v > 0 ? i : -1).filter(i => i >= 0);
      const allTanks = hitIdx.every(i => TANK_JOBS.has(ordered[i]));
      const kind = allTanks && targets <= 2 && ratio >= 0.6 ? "tankbuster" : targets >= Math.max(2, Math.ceil(ordered.length * 0.75)) ? "raidwide" : "hit";
      const name = abilityName(c.id);
      // Cast bar: the same action, or one with the same name, that finished just before the hit.
      const cast = casts.filter(k => (k.id === c.id || k.name === name) && k.start <= c.t && c.t - (k.start + k.dur) < 10000)
        .sort((a, b) => (b.id === c.id) - (a.id === c.id) || b.start - a.start)[0];
      if (cast) cast.used = true;
      events.push({
        t: c.t - t0, name, kind, school: SCHOOL[abil.get(c.id)?.type] || "magical", abilityId: c.id,
        boss: isBoss(c.src) ? actors.get(c.src).name : null,
        ...(cast ? { castStart: cast.start - t0, castDur: cast.dur } : {}),
        dmg: { avg: Math.round(amounts.reduce((a, b) => a + b, 0) / amounts.length), max: Math.round(Math.max(...amounts)), hits: c.hits.length, crits, targets, ratio: r3(ratio), per: per.map(r2) },
      });
    }
    for (const k of casts) if (!k.used && k.dur >= 700) events.push({
      t: k.start + k.dur - t0, name: k.name, kind: "mechanic", school: null, abilityId: k.id,
      boss: isBoss(k.src) ? actors.get(k.src).name : null, castStart: k.start - t0, castDur: k.dur, dmg: null,
    });
    events.sort((a, b) => a.t - b.t);
    const seen = {};
    events.forEach((e, i) => { e.id = "e" + (i + 1); seen[e.name] = (seen[e.name] || 0) + 1; e.key = `${e.name}#${seen[e.name]}`; });

    // Mits this group pressed. Pet actions (fairy) count for their owner.
    const used = [];
    for (const e of friendlyCasts) {
      if (e.type !== "cast") continue;
      const m = MIT_BY_NAME.get(abilityName(e.abilityGameID).toLowerCase()); if (!m) continue;
      const src = actors.get(e.sourceID), owner = src?.petOwner ? actors.get(src.petOwner) : src;
      const job = jobOf(owner?.subType); if (!job || !m.jobs.includes(job)) continue;
      used.push({ job, mit: m.k, t: e.timestamp - t0 });
    }

    const hp = {
      tank: Math.max(0, ...maxHp.filter((_, i) => TANK_JOBS.has(ordered[i]))),
      other: Math.max(0, ...maxHp.filter((_, i) => !TANK_JOBS.has(ordered[i]))),
    };
    return { events, used, party: ordered, hp };
  }

  // Phases (ultimates) or bosses (multi-boss dungeons) become the planner's boss tabs.
  function segmentsFor(report, fight, events) {
    const dur = fight.endTime - fight.startTime;
    const names = new Map((report.phases || []).find(p => p.encounterID === fight.encounterID)?.phases?.map(p => [p.id, p.name]) || []);
    const tr = fight.phaseTransitions || [];
    let segs = [];
    if (tr.length > 1) {
      segs = tr.map((p, i) => ({ name: names.get(p.id) || `Phase ${p.id}`, start: Math.max(0, p.startTime - fight.startTime), end: (tr[i + 1]?.startTime ?? fight.endTime) - fight.startTime }));
    } else {
      const firstT = new Map();
      for (const e of events) if (e.boss && !firstT.has(e.boss)) firstT.set(e.boss, e.castStart ?? e.t);
      if (firstT.size > 1) {
        const list = [...firstT].sort((a, b) => a[1] - b[1]);
        segs = list.map(([name, t], i) => ({ name, start: t, end: list[i + 1]?.[1] ?? dur }));
      }
    }
    if (segs.length > 1) for (const e of events) { const i = segs.findIndex((s, k) => e.t < s.end || k === segs.length - 1); e.seg = Math.max(0, i); }
    return segs.length > 1 ? segs : [];
  }

  /* ---------- What other groups did ---------- */
  // For each sample fight, tie every mit to the hit it was for, then count how many logs did the same.
  function attach(events, u) {
    const m = MIT[u.mit]; if (!m) return null;
    const dmg = events.filter(e => e.dmg);
    if (m.kind === "heal") return dmg.filter(e => e.t <= u.t + 1000 && e.t >= u.t - 15000).pop() || null;
    return dmg.find(e => e.t >= u.t - 1000 && e.t <= u.t + m.dur * 1000) || null;
  }
  function popularFrom(samples) {
    const agg = new Map();
    for (const s of samples) {
      const seen = new Set();
      for (const u of s.used) {
        const ev = attach(s.events, u); if (!ev) continue;
        const k = u.mit + "|" + ev.key; if (seen.has(k)) continue; seen.add(k);
        if (!agg.has(k)) agg.set(k, { mit: u.mit, event: ev.key, leads: [] });
        agg.get(k).leads.push(ev.t - u.t);
      }
    }
    const n = samples.length;
    return [...agg.values()].filter(a => a.leads.length >= Math.max(1, Math.ceil(n * 0.1)))
      .map(a => ({ mit: a.mit, event: a.event, count: a.leads.length, share: r2(a.leads.length / n), lead: Math.round(median(a.leads)) }))
      .sort((a, b) => b.share - a.share);
  }

  const RANK_Q = `query($id: Int!, $diff: Int, $page: Int) { worldData { encounter(id: $id) {
    fightRankings(difficulty: $diff, metric: speed, page: $page) } } }`;
  // Yields { code, fightID, comp? } for the fastest kills, page by page.
  async function* rankedFights(encounterId, difficulty, maxPages) {
    for (let page = 1; page <= maxPages; page++) {
      const fr = (await gql(RANK_Q, { id: encounterId, diff: difficulty || null, page }))?.worldData?.encounter?.fightRankings;
      const list = fr?.rankings || [];
      for (const r of list) {
        const code = r.report?.code, fightID = r.report?.fightID ?? r.fightID;
        if (!code || !fightID) continue;
        const comp = Array.isArray(r.composition) ? r.composition.map(p => jobOf(p.type || p.spec || p.specs?.[0]?.spec)).filter(Boolean) : null;
        yield { code, fightID, comp: comp?.length ? comp : null };
      }
      if (!fr?.hasMorePages || !list.length) break;
    }
  }
  const hasComp = (have, need) => { const pool = [...have]; return need.every(j => { const i = pool.indexOf(j); if (i < 0) return false; pool.splice(i, 1); return true; }); };

  async function samplePatterns(f, { comp = null, skip = null, onProgress } = {}) {
    const samples = [];
    let checked = 0;
    for await (const r of rankedFights(f.encounterId, f.difficulty, comp ? 10 : 2)) {
      if (samples.length >= SAMPLE_LOGS || checked >= (comp ? 80 : 20)) break;
      if (skip && r.code === skip.code && r.fightID === skip.fight) continue;
      if (comp && r.comp && !hasComp(r.comp, comp)) continue;
      checked++;
      try {
        const report = await loadReport(r.code), fight = report.fights.find(x => x.id === r.fightID);
        if (!fight) continue;
        const a = await analyzeFight(r.code, report, fight);
        if (comp && !hasComp(a.party, comp)) continue;
        samples.push(a);
        onProgress?.(`Read ${samples.length} of ${SAMPLE_LOGS} top logs…`);
      } catch (e) { if (e.code === "nokey" || e.code === "badkey") throw e; /* skip private or broken logs */ }
    }
    return { popular: popularFrom(samples), sampleSize: samples.length };
  }

  /* ---------- Entry points ---------- */
  async function importLink(link, { onProgress } = {}) {
    const { code, fight: want } = parseLink(link);
    onProgress?.("Reading the report…");
    const report = await loadReport(code);
    const fight = pickFight(report, want);
    onProgress?.(`Reading ${fight.name}…`);
    const a = await analyzeFight(code, report, fight);
    if (!a.events.length) throw new Error("That fight has no boss damage or casts to plan around.");
    const out = {
      format: "mit-planner/1", id: `${code}-${fight.id}`, name: fight.name, zone: report.zone?.name || "", arena: fight.gameZone?.name || "",
      encounterId: fight.encounterID, difficulty: fight.difficulty, kill: !!fight.kill, durationMs: fight.endTime - fight.startTime,
      importedAt: Date.now(), party: a.party, hp: a.hp, events: a.events, used: a.used,
      source: { code, fight: fight.id, title: report.title, url: `https://www.fflogs.com/reports/${code}?fight=${fight.id}` },
      segments: [], popular: [], sampleSize: 0,
    };
    out.segments = segmentsFor(report, fight, out.events);
    if (fight.encounterID > 0) {
      onProgress?.("Learning from the top logs…");
      try { Object.assign(out, await samplePatterns(out, { skip: { code, fight: fight.id }, onProgress })); }
      catch (e) { if (e.code === "nokey" || e.code === "badkey") throw e; console.warn("Top logs skipped:", e); }
    }
    return out;
  }

  // Mit patterns from top logs that include the given jobs, as a "patterns" doc.
  async function compPatterns(f, comp, { onProgress } = {}) {
    if (!(f.encounterId > 0)) throw new Error("This fight isn't a ranked encounter, so there are no top logs to learn from.");
    const p = await samplePatterns(f, { comp, onProgress });
    if (!p.sampleSize) throw new Error("No top logs with that composition. Try fewer jobs.");
    return { format: "mit-planner/patterns", fight: f.id, comp: [...comp], ...p, at: Date.now() };
  }

  window.RMP = { ...(window.RMP || {}), fflogs: { parseLink, importLink, compPatterns, getKeys, setKeys, hasKeys: () => !!getKeys()?.id } };
})();
