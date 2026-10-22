const JOB_IMG = {};
for (const [j, src] of Object.entries(JOB_ICONS)) { const im = new Image(); im.onload = () => { if (S.view === "sheet") redrawSheetImg(); }; im.src = src; JOB_IMG[j] = im; }
const jobIcon = (j, px = 18) => JOB_ICONS[j] ? `<img class="jic" src="${JOB_ICONS[j]}" width="${px}" height="${px}" alt="${j}" title="${j}">` : `<span class="job ${role(j)}">${j}</span>`;
const ICON_IMG = {};
for (const [k, src] of Object.entries(ICONS)) { const im = new Image(); im.onload = () => { if (S.view === "sheet") redrawSheetImg(); }; im.src = src; ICON_IMG[k] = im; }
const TANKS = new Set(["PLD","WAR","DRK","GNB"]), HEALS = new Set(["WHM","SCH","AST","SGE"]);
const ALL_JOBS = ["PLD","WAR","DRK","GNB","WHM","SCH","AST","SGE","MNK","DRG","NIN","SAM","RPR","VPR","BRD","MCH","DNC","BLM","SMN","RDM","PCT"];
const role = j => TANKS.has(j) ? "tank" : HEALS.has(j) ? "heal" : "dps";
const mitRole = m => role(m.jobs[0]);
const KIND_LABEL = { raidwide: "Raidwide", tankbuster: "Tankbuster", hit: "Hit", mechanic: "Mechanic" };
const TARGET = { raidwide: 0.6, hit: 0.6, tankbuster: 0.75 };

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const pct = x => `${Math.round(x * 100)}%`;
const uid = () => Math.random().toString(36).slice(2, 9);
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

/* ---------- Example fight (shown only until a real log is imported) ---------- */
function demoFight() {
  const ev = [], add = (t, name, kind, ratio, extra = {}) => ev.push({ t: t * 1000, name, kind, school: extra.school ?? "magical", castStart: extra.cast ? (t - extra.cast) * 1000 : undefined, castDur: extra.cast ? extra.cast * 1000 : undefined, dmg: ratio == null ? null : { avg: Math.round(ratio * 90000), max: Math.round(ratio * 95000), ratio, targets: kind === "tankbuster" ? 1 : 4, hits: 4 } });
  add(12, "Example Raidwide", "raidwide", 0.55, { cast: 5 });
  add(31, "Example Tankbuster", "tankbuster", 0.95, { cast: 5, school: "physical" });
  add(48, "Example Line AoE", "mechanic", null, { cast: 4 });
  add(66, "Example Raidwide", "raidwide", 0.62, { cast: 5 });
  add(84, "Example Stack", "hit", 0.7, { cast: 5, school: "physical" });
  add(103, "Example Big Raidwide", "raidwide", 0.92, { cast: 7 });
  add(126, "Example Tankbuster", "tankbuster", 1.05, { cast: 5, school: "physical" });
  add(150, "Example Raidwide", "raidwide", 0.58, { cast: 5 });
  add(171, "Example Line AoE", "mechanic", null, { cast: 4 });
  add(190, "Example Big Raidwide", "raidwide", 0.95, { cast: 7 });
  add(214, "Example Tankbuster", "tankbuster", 0.98, { cast: 5, school: "physical" });
  add(236, "Example Raidwide", "raidwide", 0.65, { cast: 5 });
  const seen = {};
  ev.forEach((e, i) => { e.id = "e" + (i + 1); seen[e.name] = (seen[e.name] || 0) + 1; e.key = `${e.name}#${seen[e.name]}`; });
  return { format: "mit-planner/1", id: "demo", demo: true, name: "Example fight", zone: "Example data, not from FF Logs", durationMs: 250000, kill: true, party: ["WAR","WHM","SAM","BRD"], hp: { tank: 120000, other: 90000 }, events: ev, used: [],
    popular: [{ mit: "reprisal", event: "Example Raidwide#1", share: 0.8, lead: 2000 }, { mit: "shake_it_off", event: "Example Big Raidwide#1", share: 0.7, lead: 3000 }, { mit: "troubadour", event: "Example Big Raidwide#1", share: 0.6, lead: 2000 }, { mit: "damnation", event: "Example Tankbuster#1", share: 0.9, lead: 3000 }, { mit: "temperance", event: "Example Big Raidwide#2", share: 0.6, lead: 3000 }], sampleSize: 0 };
}

/* ---------- State ---------- */
const S = { fights: {}, fightId: null, plans: {}, focus: null, seg: store.get("seg") || {}, job: null, db: null, dbReady: false, dirty: false, unsubPlan: null, armedClear: false, patterns: {}, requests: {} };
const F = () => S.fights[S.fightId] || null;
function P() {
  const f = F(); if (!f) return null;
  if (!S.plans[f.id]) S.plans[f.id] = { party: [...(f.party || [])], placements: [], thr: 0.4 };
  return S.plans[f.id];
}
const evById = id => F()?.events.find(e => e.id === id);
// Placements remember the event they were made for. Re-imports can renumber events,
// so match by event key first, then by id if that event still fits the timing.
function evOf(p) {
  const f = F(), m = MIT[p.k], win = Math.max(m?.dur || 10, 10) * 1000;
  // Heals go in after the hit they answer, so they belong to the latest hit before them.
  const fitsT = m?.kind === "heal" ? e => e && e.t <= p.t + 1000 && e.t >= p.t - 15000 : e => e && e.t >= p.t - 1000 && e.t <= p.t + win;
  const byKey = p.key && f.events.find(e => e.key === p.key);
  if (fitsT(byKey)) return byKey.id;
  const byId = evById(p.ev);
  if (fitsT(byId)) return byId.id;
  const near = m?.kind === "heal" ? f.events.filter(fitsT).pop() : f.events.find(fitsT);
  return (near || byId || f.events.find(e => e.t >= p.t))?.id;
}

/* ---------- Boss segments (Criterion dungeons log all bosses as one fight) ---------- */
const segCache = new WeakMap();
function segmentsOf(f) {
  if (segCache.has(f)) return segCache.get(f);
  let list = [], of = {};
  if (Array.isArray(f.segments) && f.segments.length > 1) {
    list = f.segments; f.events.forEach(e => of[e.id] = e.seg ?? 0);
  }
  const out = { list, of };
  segCache.set(f, out);
  return out;
}
function segIdx() { const f = F(); if (!f) return -1; const n = segmentsOf(f).list.length; if (!n) return -1; const v = S.seg[f.id]; return v == null ? 0 : v >= n ? n - 1 : v; }
function range() {
  const f = F(), sg = segmentsOf(f).list[segIdx()];
  return sg ? { start: sg.start, end: sg.end } : { start: 0, end: f.durationMs };
}
const fmtT = t => fmt(t - range().start);
function visibleEvents() {
  const f = F(), i = segIdx(); if (i < 0) return f.events;
  const of = segmentsOf(f).of; return f.events.filter(e => of[e.id] === i);
}

/* ---------- Job filter ---------- */
const ownersOf = k => P().party.filter(j => MIT[k].jobs.includes(j));
const showMit = m => !S.job || m.jobs.includes(S.job);
const showP = p => inParty(p) && (!S.job || ownersOf(p.k)[p.slot] === S.job);

/* ---------- Cooldown math ---------- */
const slotsFor = (k, party = P().party) => party.filter(j => MIT[k].jobs.includes(j)).length;
// A placement only counts while the party still has its owner (after a party change, a removed SCH's Expedient doesn't).
const inParty = p => MIT[p.k] && p.slot < slotsFor(p.k);
// Index in plan.party of the player who owns a placement.
const ownerIdx = p => P().party.map((j, i) => MIT[p.k].jobs.includes(j) ? i : -1).filter(i => i >= 0)[p.slot];
const partyMits = () => MITS.filter(m => slotsFor(m.k) > 0);
function fits(k, t, slot, ignoreId) {
  const m = MIT[k], ch = m.ch || 1, cd = m.cd * 1000;
  const ts = P().placements.filter(p => p.k === k && p.slot === slot && p.id !== ignoreId).map(p => p.t).concat([t]).sort((a, b) => a - b);
  for (let i = ch; i < ts.length; i++) if (ts[i] - ts[i - ch] < cd) return false;
  return true;
}
function freeSlot(k, t, ignoreId) {
  const own = ownersOf(k), order = own.map((_, i) => i).sort((a, b) => (own[b] === S.job) - (own[a] === S.job));
  for (const s of order) if (fits(k, t, s, ignoreId)) return s;
  return -1;
}
function conflicts() {
  const bad = new Set(), groups = {};
  for (const p of P().placements) (groups[p.k + "|" + p.slot] ||= []).push(p);
  for (const list of Object.values(groups)) {
    const m = MIT[list[0].k], ch = m.ch || 1; list.sort((a, b) => a.t - b.t);
    for (let i = ch; i < list.length; i++) if (list[i].t - list[i - ch].t < m.cd * 1000) bad.add(list[i].id);
    if (list[0].slot >= slotsFor(m.k)) list.forEach(p => bad.add(p.id));
  }
  return bad;
}
function statusSlot(k, t, slot) {
  if (fits(k, t, slot)) return { ok: true, label: "Ready" };
  const m = MIT[k]; let best = Infinity;
  for (const p of P().placements) if (p.k === k && p.slot === slot && p.t <= t) best = Math.min(best, p.t + m.cd * 1000 - t);
  return { ok: false, label: best !== Infinity && best > 0 ? `CD ${Math.ceil(best / 1000)}s` : "Used later" };
}
const ownerLabel = p => slotsFor(p.k) > 1 ? ` (${ownersOf(p.k)[p.slot] || p.slot + 1})` : "";
function status(k, t) {
  if (freeSlot(k, t) >= 0) return { ok: true, label: "Ready" };
  const m = MIT[k]; let best = Infinity;
  for (const p of P().placements) if (p.k === k && p.t <= t) best = Math.min(best, p.t + m.cd * 1000 - t);
  return { ok: false, label: best !== Infinity && best > 0 ? `CD ${Math.ceil(best / 1000)}s` : "Used later" };
}

/* ---------- Damage + recommendations ---------- */
function schoolOf(ev) { return ev.school || (ev.kind === "tankbuster" ? "physical" : "magical"); }
function applies(m, ev) { return m.kind !== "heal" && (m.kind === "party" || ev.kind === "tankbuster" || (ev.kind === "hit" && ev.dmg && ev.dmg.targets <= 2)); }
function value(m, ev) {
  if (m.inv) return 1;
  if (m.all != null) return m.all / 100;
  const s = schoolOf(ev);
  return ((s === "physical" ? m.phys : s === "magical" ? m.mag : Math.min(m.phys || 0, m.mag || 0)) || 0) / 100;
}
const leadFor = m => m.kind === "heal" ? -2000 : Math.min(3000, m.dur * 1000 - 1000);
function activeOn(ev) {
  return P().placements.filter(p => { const m = MIT[p.k]; return m && m.kind !== "heal" && inParty(p) && p.t <= ev.t + 250 && ev.t <= p.t + m.dur * 1000; });
}
// A shield breaks on the first hit that reaches its holder, so it only counts on that hit: the first one
// that hits player i, or (no player given) the first damaging moment the shield applies to.
function shieldFor(p, ev, i = null) {
  const m = MIT[p.k]; if (!m.shield) return 0;
  // Party shields with per-player data: still counts if anyone this hit lands on hasn't broken theirs yet.
  if (i == null && m.kind === "party" && ev.dmg?.per) return Math.max(0, ...ev.dmg.per.map((v, j) => v > 0 ? shieldFor(p, ev, j) : 0));
  const end = p.t + m.dur * 1000;
  const first = F().events.filter(e => e.dmg && e.t >= p.t - 250 && e.t <= end && (i == null ? applies(m, e) : !e.dmg.per || (e.dmg.per[i] || 0) > 0))
    .reduce((a, e) => !a || e.t < a.t ? e : a, null);
  return first && first.id === ev.id ? m.shield / 100 : 0;
}
function evaluate(ev, extra = []) {
  const r = ev.dmg?.ratio;
  // The same action never stacks with itself in game (two Reprisals = one debuff), so count each action once,
  // keeping the copy whose shield is still up.
  const best = new Map();
  for (const it of activeOn(ev).filter(p => applies(MIT[p.k], ev)).map(p => ({ m: MIT[p.k], sh: shieldFor(p, ev) }))
    .concat(extra.filter(m => applies(m, ev)).map(m => ({ m, sh: (m.shield || 0) / 100 })))) {
    if (!best.has(it.m.k) || it.sh > best.get(it.m.k).sh) best.set(it.m.k, it);
  }
  let keep = 1, shield = 0, inv = false;
  const parts = [];
  for (const { m, sh } of best.values()) {
    const v = value(m, ev);
    if (!m.inv && !v && !sh) continue; // a shield-only action whose shield already broke
    if (m.inv) inv = true; keep *= 1 - v; shield += sh; parts.push({ m, v, sh });
  }
  const mit = 1 - keep;
  const eff = r == null ? null : inv ? 0 : Math.max(0, r * keep - shield);
  return { r, mit, shield, eff, inv, parts, target: TARGET[ev.kind] ?? 0.6 };
}
// Each player's hit as a share of their own max HP (importer dmg.per, same order as f.party),
// after the mits that reach them: party mits reach everyone, tank mits their owner, single-target mits the tanks hit.
function partyHp(ev) {
  const f = F(), per = ev.dmg?.per;
  if (!per || !f.party || per.length !== f.party.length) return null;
  const act = activeOn(ev), tanks = f.party.map((j, i) => TANKS.has(j) && per[i] > 0 ? i : -1).filter(i => i >= 0);
  const singleTo = tanks.length ? tanks : [per.indexOf(Math.max(...per))];
  return f.party.map((job, i) => {
    const seen = new Set(); let keep = 1, shield = 0, inv = false;
    for (const p of act) {
      const m = MIT[p.k]; if (!m || seen.has(m.k)) continue;
      const reach = m.kind === "party" || (m.kind === "tank" ? ownersOf(p.k)[p.slot] === job : singleTo.includes(i));
      if (!reach) continue;
      seen.add(m.k); if (m.inv) inv = true; keep *= 1 - value(m, ev); shield += shieldFor(p, ev, i);
    }
    const r = per[i] || 0, after = inv ? 0 : r * keep, sh = Math.min(after, shield);
    return { job, r, after, sh, eff: after - sh };
  });
}
// Stacked bars, bottom up: damage still taken, absorbed by shields, removed by mitigation. Scaled so the
// biggest hit fits; the dashed line marks 100% HP when a hit goes over it.
function partyBars(ev) {
  const hp = partyHp(ev); if (!hp || !hp.some(x => x.r > 0)) return "";
  const top = Math.max(1, ...hp.map(x => x.r)), h = v => `${(v / top * 100).toFixed(1)}%`;
  return `<div class="pbars">${hp.map(x => {
    const cls = x.eff > 1 ? "over" : x.eff > 0.8 ? "warn" : "";
    const tip = x.r ? `${x.job}: hit for ${pct(x.r)} of max HP. Mitigation removes ${pct(x.r - x.after)}, shields absorb ${pct(x.sh)}, takes ${pct(x.eff)}.` : `${x.job}: not hit`;
    return `<div class="pb ${x.r ? "" : "miss"}" title="${tip}"><div class="pcol"><span class="eff ${cls}" style="height:${h(x.eff)}"></span><span class="sh" style="bottom:${h(x.eff)};height:${h(x.sh)}"></span><span class="mt" style="bottom:${h(x.after)};height:${h(x.r - x.after)}"></span>${top > 1 ? `<span class="ko" style="bottom:${h(1)}"></span>` : ""}</div>${jobIcon(x.job, 12)}</div>`;
  }).join("")}</div>`;
}
function recommend(ev) {
  if (!ev.dmg || ev.dmg.ratio == null) return [];
  const e0 = evaluate(ev);
  if (e0.eff <= e0.target) return [];
  const have = new Set(activeOn(ev).map(p => p.k));
  const pool = partyMits().filter(m => showMit(m) && applies(m, ev) && !have.has(m.k) && !m.inv && (value(m, ev) > 0 || m.shield) && freeSlot(m.k, Math.max(0, ev.t - leadFor(m))) >= 0);
  const big = e0.eff - e0.target > 0.25;
  pool.sort((a, b) => big ? (value(b, ev) + (b.shield || 0) / 100) - (value(a, ev) + (a.shield || 0) / 100) || a.cd - b.cd
                          : a.cd - b.cd || value(b, ev) - value(a, ev));
  const pick = [];
  for (const m of pool) {
    if (evaluate(ev, pick).eff <= e0.target || pick.length >= 4) break;
    if (ev.kind === "tankbuster" && m.kind === "tank" && m.all >= 40 && pick.some(x => x.kind === "tank" && x.all >= 40)) continue;
    pick.push(m);
  }
  if (ev.kind === "tankbuster" && evaluate(ev, pick).eff > 1) {
    const inv = partyMits().find(m => showMit(m) && m.inv && freeSlot(m.k, ev.t - 1000) >= 0);
    if (inv) return [inv];
  }
  return pick;
}

/* ---------- Plan edits ---------- */
function place(k, ev, t, slot) {
  const m = MIT[k]; if (!m) return;
  t = Math.max(0, Math.round(t ?? (ev.t - leadFor(m))));
  if (slot == null || slot >= slotsFor(k)) { slot = freeSlot(k, t); if (slot < 0) slot = 0; }
  const pl = { id: uid(), k, t, ev: ev.id, key: ev.key, slot };
  P().placements.push(pl);
  changed(); toast(`${m.n}${ownerLabel(pl)} at ${fmtT(t)} for ${ev.name}${fits(k, t, slot, pl.id) ? "" : " (still on cooldown)"}`);
}
function changed() { S.dirty = true; renderAll(); saveSoon(); }
let saveTimer;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const f = F(); if (!f) return;
    const plan = JSON.parse(JSON.stringify(P()));
    store.set("plan:" + f.id, plan);
    if (S.db && !f.local) { try { await S.db.doc("plans/" + safeId(f.id)).set(plan); } catch (e) { toast("Couldn't save the plan: " + (e.message || e.code)); } }
    S.dirty = false;
  }, 700);
}
const safeId = id => String(id).replace(/[^A-Za-z0-9_\-.~:@+]/g, "_");

// Log patterns can come from top logs of any comp (the fight doc) or from logs with a chosen comp (patterns/ docs).
const patternsFor = f => Object.values(S.patterns).filter(p => p.fight === f.id && Array.isArray(p.popular)).sort((a, b) => a.comp.join(" ").localeCompare(b.comp.join(" ")));
function popSrc() {
  const f = F(), pat = S.patterns[P()?.pat];
  return pat && pat.fight === f.id ? { popular: pat.popular, n: pat.sampleSize, comp: pat.comp } : { popular: f.popular || [], n: f.sampleSize, comp: null };
}
const compSlug = comp => [...comp].sort((a, b) => ALL_JOBS.indexOf(a) - ALL_JOBS.indexOf(b)).join(".");
function fillFromLogs(thr) {
  const f = F(), plan = P();
  plan.placements = []; plan.thr = thr;
  const byKey = Object.fromEntries(f.events.map(e => [e.key, e]));
  let n = 0;
  for (const p of [...popSrc().popular].sort((a, b) => b.share - a.share)) {
    const ev = byKey[p.event], m = MIT[p.mit];
    if (!ev || !m || p.share < thr || slotsFor(m.k) === 0) continue;
    const t = Math.max(0, ev.t - p.lead), slot = freeSlot(m.k, t);
    if (slot < 0) continue;
    plan.placements.push({ id: uid(), k: m.k, t, ev: ev.id, key: ev.key, slot }); n++;
  }
  const short = fillTankShort();
  changed(); toast(n || short ? `Placed ${n} mitigations used in at least ${pct(thr)} of logs${short ? `, plus ${short} short tank cooldowns` : ""}` : "No log patterns at that threshold");
}
// Tanks press short cooldowns (Sheltron, Bloodwhetting, TBN, Heart of Corundum, Intervention, Oblation...) almost on cooldown,
// mostly into auto-attacks that aren't key moments, so log popularity spreads thin. Put them on the moments that hit a tank:
// tankbusters first, then other hits that land on a tank.
const isTankShort = m => m.jobs.every(j => TANKS.has(j)) && (m.kind === "tank" || m.kind === "single") && !m.inv && m.cd <= 60 && (m.all || 0) < 40 && (m.all || m.phys || m.mag || m.shield);
function hitsTank(ev) {
  if (!ev.dmg) return false;
  if (ev.kind === "tankbuster") return true;
  const f = F(), per = ev.dmg.per;
  if (per && f.party && per.length === f.party.length) return f.party.some((j, i) => TANKS.has(j) && per[i] >= 0.1);
  return ev.kind === "raidwide";
}
function fillTankShort() {
  const f = F(), plan = P();
  // Intervention and Nascent Flash can't target their caster, so they only help with a second tank.
  const mits = partyMits().filter(m => isTankShort(m) && (m.kind !== "single" || plan.party.filter(j => TANKS.has(j)).length > 1));
  const evs = f.events.filter(hitsTank).sort((a, b) => (b.kind === "tankbuster") - (a.kind === "tankbuster") || a.t - b.t);
  let n = 0;
  for (const ev of evs) for (const m of mits) {
    const t = Math.max(0, ev.t - leadFor(m));
    for (let slot = 0; slot < slotsFor(m.k); slot++) {
      if (activeOn(ev).some(p => p.k === m.k && p.slot === slot) || !fits(m.k, t, slot)) continue;
      plan.placements.push({ id: uid(), k: m.k, t, ev: ev.id, key: ev.key, slot }); n++;
      if (m.kind === "single") break;
    }
  }
  return n;
}
function loadAsPlayed() {
  const f = F(), plan = P(); plan.placements = []; let n = 0;
  for (const u of f.used || []) {
    const m = MIT[u.mit]; if (!m || slotsFor(m.k) === 0) continue;
    const ev = f.events.find(e => e.t >= u.t - 1000 && e.t <= u.t + m.dur * 1000) || f.events.find(e => e.t >= u.t) || f.events[f.events.length - 1];
    const slot = freeSlot(m.k, u.t); if (slot < 0) continue;
    plan.placements.push({ id: uid(), k: m.k, t: u.t, ev: ev.id, key: ev.key, slot }); n++;
  }
  changed(); toast(`Loaded ${n} mitigations as used in this log`);
}
function suggestAll() {
  let n = 0;
  for (const ev of visibleEvents()) for (const m of recommend(ev)) {
    const t = Math.max(0, ev.t - leadFor(m)), slot = freeSlot(m.k, t); if (slot < 0) continue;
    P().placements.push({ id: uid(), k: m.k, t, ev: ev.id, key: ev.key, slot }); n++;
  }
  changed(); toast(n ? `Added ${n} suggested mitigations` : "Every hit already meets its target");
}

/* ---------- Rendering ---------- */
const icon = (m, extraCls = "") => ICONS[m.k]
  ? `<span class="ic has-img ${extraCls}" aria-hidden="true"><img src="${ICONS[m.k]}" alt="" draggable="false"></span>`
  : `<span class="ic ${mitRole(m)} ${extraCls}" aria-hidden="true">${esc(m.ab)}</span>`;
function renderAll() {
  const sheet = S.view === "sheet";
  $("#sheetView").hidden = !sheet; $("#mainView").hidden = sheet; $("#overview").hidden = sheet; $("#bosses").hidden = sheet; $("#fab").hidden = sheet;
  $("#sheetBtn").textContent = sheet ? "Back to planner" : "Cheat sheet";
  renderHeader();
  if (sheet) { renderSheet(); return; }
  renderOverview(); renderList(); renderPalette();
}

function renderHeader() {
  const sel = $("#fightSel"), ids = sortedFightIds();
  const label = f => f.demo ? "Example fight" : `${f.name}${f.kill ? "" : " (wipe)"}${f.zone ? " · " + f.zone : ""}`;
  if (S.prefs.sort === "zone") {
    const zones = [...new Set(ids.map(id => S.fights[id].zone || "Other"))];
    sel.innerHTML = zones.map(z => `<optgroup label="${esc(z)}">${ids.filter(id => (S.fights[id].zone || "Other") === z).map(id => `<option value="${esc(id)}">${esc(label(S.fights[id]).replace(" · " + z, ""))}</option>`).join("")}</optgroup>`).join("");
  } else sel.innerHTML = ids.map(id => `<option value="${esc(id)}">${esc(label(S.fights[id]))}</option>`).join("");
  $("#sortSel").value = S.prefs.sort || "opened";
  sel.value = S.fightId || "";
  const f = F(); if (!f) return;
  $("#fightname").textContent = f.demo ? "Example data" : [f.zone, f.name].filter(Boolean).join(" · ");
  const ban = [];
  if (f.demo) ban.push(`<div class="banner"><span><b>This is example data.</b> Import an FF Logs fight to build a real plan. Tap Import fight and paste an FF Logs link.</span><button class="btn" data-act="import">Import fight</button></div>`);
  else if (!P().party.length) ban.push(`<div class="banner"><span><b>Your party is empty,</b> so no mitigations show. To see one job's mits, keep the full party and tap that job's icon next to "Show".</span><button class="btn" data-act="logparty">Use log party</button></div>`);
  else if (!S.db) ban.push(`<div class="banner"><span>Plans are saved in this browser only, because shared saving is not available in this view.</span></div>`);
  $("#banner").innerHTML = ban.join("");
  const plan = P(), bad = conflicts(), segs = segmentsOf(f).list, si = segIdx(), rg = range();
  const jobs = [...new Set(plan.party)];
  if (S.job && !jobs.includes(S.job)) S.job = null;
  $("#jobSel").innerHTML = `<option value="">All jobs</option>` + jobs.map(j => `<option value="${j}">${j} only</option>`).join("");
  $("#jobSel").value = S.job || "";
  $("#bosses").innerHTML = segs.length ? segs.map((sg, i) => `<button data-seg="${i}" aria-pressed="${i === si}">${esc(sg.name)}<small>${fmt(sg.end - sg.start)}</small></button>`).join("") : "";
  const kinds = {}; visibleEvents().forEach(e => kinds[e.kind] = (kinds[e.kind] || 0) + 1);
  $("#summary").innerHTML = `
    <span class="party" title="Tap a job to show only its abilities"><span class="muted" style="font-size:12px">Show</span><button class="jbtn all" data-jf="" aria-pressed="${!S.job}">All</button>${jobs.map(j => `<button class="jbtn" data-jf="${j}" aria-pressed="${S.job === j}" aria-label="Show ${j} only">${jobIcon(j, 24)}</button>`).join("")}</span>
    <span class="mono">${fmt(rg.end - rg.start)}</span>
    <span class="dlegend" title="How the HP bars split each hit"><span><i style="background:var(--good)"></i>HP taken</span><span><i style="background:var(--shieldc)"></i>shielded</span><span><i style="background:var(--mitc)"></i>mitigated</span></span>
    <span class="legend">${Object.entries(KIND_LABEL).filter(([k]) => kinds[k]).map(([k, l]) => `<span><i style="background:var(--${k === "raidwide" ? "raid" : k === "tankbuster" ? "tb" : k === "hit" ? "hit" : "mech"})"></i>${kinds[k]} ${l.toLowerCase()}${kinds[k] > 1 ? "s" : ""}</span>`).join("")}</span>
    <span>${plan.placements.filter(showP).length} planned${S.job ? ` for ${S.job}` : ""}${bad.size ? ` · <b style="color:var(--bad)">${bad.size} on cooldown</b>` : ""}</span>
    ${popSrc().n ? `<span class="muted">Log patterns from ${popSrc().n} log${popSrc().n > 1 ? "s" : ""}${popSrc().comp ? ` with ${popSrc().comp.join(" ")}` : ""}</span>` : ""}
    ${f.source?.url ? `<a href="${esc(f.source.url)}" target="_blank" rel="noopener" style="color:var(--accent)">Open on FF Logs</a>` : ""}`;
}

function renderOverview() {
  const f = F(), plan = P(), el = $("#overview"); if (!f) { el.innerHTML = ""; return; }
  const bad = conflicts();
  const lanes = [];
  const rg = range(), dur = rg.end - rg.start, evs = visibleEvents();
  for (const p of [...plan.placements].filter(showP).filter(p => p.t + MIT[p.k].cd * 1000 >= rg.start && p.t <= rg.end).sort((a, b) => a.t - b.t)) {
    const key = p.k + "|" + p.slot; if (!lanes.find(l => l.key === key)) lanes.push({ key, k: p.k, slot: p.slot });
  }
  lanes.sort((a, b) => MITS.indexOf(MIT[a.k]) - MITS.indexOf(MIT[b.k]) || a.slot - b.slot);
  const wrapW = Math.max(320, (el.clientWidth || 900) - 94);
  const W = Math.max(wrapW, Math.round(dur / 1000 * 6)), H = 58 + lanes.length * 18 + 6;
  const x = t => 6 + (Math.max(0, Math.min(dur, t - rg.start)) / dur) * (W - 12);
  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Fight timeline"><defs><pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2" height="5" fill="var(--muted)" opacity=".35"/></pattern></defs>`;
  for (let s = 0; s * 1000 <= dur; s += 30) {
    svg += `<line x1="${x(rg.start + s * 1000)}" x2="${x(rg.start + s * 1000)}" y1="12" y2="${H}" stroke="var(--line)"/><text x="${x(rg.start + s * 1000) + 3}" y="10">${fmt(s * 1000)}</text>`;
  }
  const maxR = Math.max(1, ...evs.map(e => e.dmg?.ratio || 0));
  for (const e of evs) {
    const col = `var(--${e.kind === "raidwide" ? "raid" : e.kind === "tankbuster" ? "tb" : e.kind === "hit" ? "hit" : "mech"})`;
    const h = e.dmg?.ratio != null ? 8 + 30 * Math.min(1, e.dmg.ratio / maxR) : 10;
    if (e.castStart != null) svg += `<rect x="${x(e.castStart)}" y="${52 - 3}" width="${Math.max(1, x(e.t) - x(e.castStart))}" height="3" fill="${col}" opacity=".35"/>`;
    svg += `<rect data-ev="${e.id}" x="${x(e.t) - 2}" y="${52 - h}" width="4" height="${h}" rx="1.5" fill="${col}" style="cursor:pointer"><title>${esc(fmtT(e.t) + " " + e.name)}</title></rect>`;
  }
  const fe = evById(S.focus);
  if (fe) svg += `<line x1="${x(fe.t)}" x2="${x(fe.t)}" y1="14" y2="${H}" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="3 2"/>`;
  lanes.forEach((l, i) => {
    const m = MIT[l.k], y = 58 + i * 18, col = `var(--${mitRole(m)})`;
    for (const p of plan.placements.filter(p => p.k === l.k && p.slot === l.slot)) {
      if (p.t + m.cd * 1000 < rg.start || p.t > rg.end) continue;
      const a = x(p.t), b = x(p.t + m.dur * 1000), c = x(p.t + m.cd * 1000);
      svg += `<rect x="${b}" y="${y + 4}" width="${Math.max(0, c - b)}" height="10" fill="url(#hatch)"/>`;
      svg += `<rect x="${a}" y="${y + 3}" width="${Math.max(3, b - a)}" height="12" rx="2" fill="${col}" ${bad.has(p.id) ? 'stroke="var(--bad)" stroke-width="2"' : ""}><title>${esc(m.n + " " + fmtT(p.t))}</title></rect>`;
    }
  });
  svg += "</svg>";
  const prevScroll = el.querySelector(".ov-scroll")?.scrollLeft || 0;
  el.innerHTML = `<div class="ov-labels"><div class="ov-head">Timeline<br><span class="muted" style="font-weight:400">${lanes.length ? "cooldowns" : "add mits to see cooldowns"}</span></div>${lanes.map(l => `<div title="${esc(MIT[l.k].n)}">${esc(MIT[l.k].n)}${slotsFor(l.k) > 1 ? " (" + esc(ownersOf(l.k)[l.slot] || l.slot + 1) + ")" : ""}</div>`).join("")}</div><div class="ov-scroll">${svg}</div>`;
  el.querySelector(".ov-scroll").scrollLeft = prevScroll;
}

const pct1 = x => `${(Math.round(x * 1000) / 10).toFixed(1).replace(/\.0$/, "")}%`;
function mitBadge(ev) {
  const e = evaluate(ev);
  if (S.job) {
    // Job filter on: name only that job's mits; the party total stays as a number so coverage still reads right.
    const mineP = activeOn(ev).filter(p => showP(p) && applies(MIT[p.k], ev) && (value(MIT[p.k], ev) || MIT[p.k].inv || shieldFor(p, ev)));
    const mine = [...new Set(mineP.map(p => p.k))].map(k => MIT[k]);
    if (!mine.length) return e.parts.length || ev.dmg ? `<div class="mitsum none">No ${S.job} mitigation${e.parts.length ? ` · total ${pct1(e.mit)}` : ""}</div>` : "";
    const keep = mine.reduce((x, m) => x * (1 - (m.inv ? 1 : value(m, ev))), 1), sh = mine.reduce((x, m) => x + Math.max(0, ...mineP.filter(p => p.k === m.k).map(p => shieldFor(p, ev))), 0);
    return `<div class="mitsum" title="${esc(mine.map(m => `${m.n} ${m.inv ? "invuln" : pct1(value(m, ev))}${m.shield ? ` + ${m.shield}% shield` : ""}`).join(" × "))}">${S.job} <b class="mono">${pct1(1 - keep)}</b>${sh ? ` <span class="muted">+ ${pct1(sh)} shield</span>` : ""}<span class="muted"> · total ${e.inv ? "invuln" : pct1(e.mit)}</span></div>`;
  }
  if (!e.parts.length) return ev.dmg ? `<div class="mitsum none">No mitigation</div>` : "";
  const mult = e.parts.filter(p => p.v > 0 && !p.m.inv);
  const how = mult.map(p => `${p.m.n} ${pct1(p.v)}`).join(" × ") + (mult.length > 1 ? ` → 1 − ${mult.map(p => (1 - p.v).toFixed(2)).join(" × ")} = ${pct1(e.mit)}` : "")
    + (e.shield ? `; shields ${e.parts.filter(p => p.sh).map(p => `${p.m.n} ${pct1(p.sh)}`).join(", ")} of max HP` : "");
  const sch = ev.school ? "" : " (assumed " + schoolOf(ev) + ")";
  return `<div class="mitsum" title="${esc(how + sch)}">${e.inv ? `<b>Invuln</b>` : `Mit <b class="mono">${pct1(e.mit)}</b>`}${e.shield ? ` <span class="muted">+ ${pct1(e.shield)} shield</span>` : ""}<span class="muted"> · ${e.parts.length} active</span></div>`;
}
function dmgCell(ev) {
  if (!ev.dmg) return `<div class="dmg muted">${ev.castDur ? `${(ev.castDur / 1000).toFixed(1)}s cast` : ""}<br>No damage taken${mitBadge(ev)}</div>`;
  const e = evaluate(ev);
  if (e.r == null) return `<div class="dmg"><span class="mono">${Math.round(ev.dmg.avg / 1000)}k</span> avg<br><span class="muted">${ev.dmg.targets} hit</span>${partyBars(ev)}${mitBadge(ev)}</div>`;
  const cls = e.eff > 1 ? "over" : e.eff > e.target ? "warn" : "";
  return `<div class="dmg"><span class="mono">${pct(e.r)}</span> ${ev.kind === "tankbuster" ? "tank HP" : "HP"}${e.mit || e.shield || e.inv ? ` → <b class="mono">${e.inv ? "0%" : pct(e.eff)}</b>` : ""}
    <div class="bar" title="${esc(`Typical hit as a share of the target's max HP (${ev.kind === "tankbuster" ? "the tank" : ev.dmg.targets > 2 ? "the players hit, mostly non-tanks" : "the players hit"}). Color: damage taken. Yellow: absorbed by shields. Blue: removed by mitigation.`)}">${(() => {
      const w = v => `${Math.max(0, Math.min(100, v * 100)).toFixed(1)}%`, after = e.inv ? 0 : e.r * (1 - e.mit), sh = Math.min(after, e.shield);
      return `<span class="eff ${cls}" style="width:${w(e.eff)}"></span><span class="sh" style="left:${w(e.eff)};width:${w(Math.min(sh, 1 - e.eff))}"></span><span class="mt" style="left:${w(after)};width:${w(Math.min(e.r, 1) - Math.min(after, 1))}"></span>`;
    })()}</div>
    <span class="muted" style="font-size:11px">${Math.round(ev.dmg.avg / 1000)}k · ${ev.dmg.targets} hit</span>${partyBars(ev)}${mitBadge(ev)}</div>`;
}

function renderList() {
  const f = F(), el = $("#list"); if (!f) { el.innerHTML = `<div class="empty">No fight loaded.</div>`; return; }
  const plan = P(), bad = conflicts(), byKey = {};
  popSrc().popular.forEach(p => (byKey[p.event] ||= []).push(p));
  const rows = visibleEvents().map(ev => {
    const own = plan.placements.filter(p => evOf(p) === ev.id && showP(p)).sort((a, b) => a.t - b.t);
    // Shield-only actions drop off once their shield has broken on an earlier hit.
    const inherited = activeOn(ev).filter(p => evOf(p) !== ev.id && showP(p) && (MIT[p.k].inv || value(MIT[p.k], ev) || !MIT[p.k].shield || shieldFor(p, ev)));
    const e = evaluate(ev), recs = recommend(ev);
    const pops = (byKey[ev.key] || []).filter(p => MIT[p.mit] && showMit(MIT[p.mit]) && slotsFor(p.mit) > 0 && freeSlot(p.mit, Math.max(0, ev.t - p.lead)) >= 0 && !own.some(o => o.k === p.mit) && !inherited.some(o => o.k === p.mit)).slice(0, 3);
    let need = "";
    if (e.r != null) {
      if (e.inv) need = `<span class="ok">Invulnerable</span>`;
      else if (e.eff <= e.target) need = (e.mit || e.shield) ? `<span class="ok">Covered</span> · ${pct(e.mit)} mit${e.shield ? ` + ${pct(e.shield)} shield` : ""}` : "";
      else need = `<span class="bad">Needs more</span> · aim for under ${pct(e.target)} HP${e.mit ? ` · has ${pct(e.mit)}` : ""}`;
    }
    const chips = own.map(p => { const m = MIT[p.k]; return `<button class="chip ${bad.has(p.id) ? "conflict" : ""}" data-pl="${p.id}" title="${esc(m.n + ownerLabel(p))} at ${fmtT(p.t)}${bad.has(p.id) ? " (still on cooldown)" : ""}">${icon(m)}<span class="t">${fmtT(p.t)}</span></button>`; }).join("")
      + inherited.map(p => { const m = MIT[p.k]; return `<button class="chip inherit" data-pl="${p.id}" title="${esc(m.n + ownerLabel(p))} still active from ${fmtT(p.t)}">${icon(m)}<span class="t">${fmtT(p.t)}</span></button>`; }).join("");
    const ghosts = pops.map(p => `<button class="ghost logpick" data-add="${p.mit}" data-ev="${ev.id}" data-t="${ev.t - p.lead}" title="Used in ${pct(p.share)} of logs, ${Math.abs(Math.round(p.lead / 1000))}s ${p.lead < 0 ? "after" : "before"} the hit">${icon(MIT[p.mit])}${esc(MIT[p.mit].n)} · ${pct(p.share)} of logs</button>`).join("")
      + recs.filter(m => !pops.some(p => p.mit === m.k)).map(m => `<button class="ghost" data-add="${m.k}" data-ev="${ev.id}" title="Suggested: ${esc(m.n)}">${icon(m)}${esc(m.n)}</button>`).join("");
    return `<div class="row ${S.focus === ev.id ? "focus" : ""}" data-ev="${ev.id}" tabindex="0">
      <div class="time">${fmtT(ev.t)}${ev.castStart != null ? `<small>cast ${fmtT(ev.castStart)}</small>` : ""}</div>
      <div class="mech"><div class="nm">${esc(ev.name)}</div><span class="pill ${ev.kind}">${KIND_LABEL[ev.kind] || ev.kind}</span>${ev.dmg ? `<span class="school">${esc(ev.school || "")}</span>` : ""}</div>
      ${dmgCell(ev)}
      <div class="slot">${chips}<button class="add" data-plus="${ev.id}" aria-label="Add mitigation to ${esc(ev.name)}">+</button>${ghosts}${need ? `<div class="need">${need}</div>` : ""}</div>
    </div>`;
  }).join("");
  el.innerHTML = `<div class="list-head"><span>Time</span><span>Boss mechanic</span><span class="h-dmg">Damage</span><span>Mitigation</span></div>${rows || `<div class="empty">This fight has no key moments.</div>`}`;
}

function renderPalette() {
  const f = F(), el = $("#palette"); if (!f) { el.innerHTML = ""; return; }
  const vis = visibleEvents();
  if (!vis.some(e => e.id === S.focus)) S.focus = vis[0]?.id || null;
  const ev = evById(S.focus);
  const groups = [["party", "Party mitigation"], ["tank", "Tank"], ["single", "Single target"], ["heal", "Healing"]];
  const mits = partyMits().filter(showMit);
  const e = ev ? evaluate(ev) : null;
  el.innerHTML = `<div class="pal-head" style="position:relative">
      <div class="eyebrow">Adding to</div>
      <div class="target">${ev ? esc(ev.name) : "Pick a mechanic"}</div>
      <div class="sub">${ev ? `${fmtT(ev.t)} · ${KIND_LABEL[ev.kind]}${e?.r != null ? ` · ${pct(e.r)} HP unmitigated` : ""}` : ""}</div>
      ${ev ? mitBadge(ev) : ""}
      <div class="sub" style="margin-top:4px">Tap to add, or drag onto any mechanic.</div>
      <button class="btn pal-close" id="palClose">Done</button>
    </div>
    <div class="pal-body">${mits.length ? groups.map(([g, label]) => {
      const list = mits.filter(m => m.kind === g); if (!list.length) return "";
      // Role actions (Reprisal, Feint, Addle, Rampart) get one entry per player who has them, each with its own cooldown.
      return `<div class="pal-group">${label}</div>` + list.flatMap(m => {
        const owners = ownersOf(m.k);
        return owners.map((job, slot) => ({ m, job, slot, multi: owners.length > 1 })).filter(x => !S.job || x.job === S.job);
      }).map(({ m, job, slot, multi }) => {
        const st = !ev ? { ok: true, label: "" } : activeOn(ev).some(p => p.k === m.k && p.slot === slot) ? { ok: true, label: "Active" } : statusSlot(m.k, Math.max(0, ev.t - leadFor(m)), slot);
        return `<button class="mit ${st.ok ? "" : "cd"}" data-mit="${m.k}" data-slot="${slot}" title="${esc(m.n)} (${job}): ${m.cd}s cooldown, lasts ${m.dur}s">${icon(m)}
          <span><span class="nm">${esc(m.n)} ${jobIcon(job, 16)}</span><br><span class="meta">${describe(m)}</span></span>
          <span class="st ${st.ok ? "ready" : "cd"}">${st.label}</span></button>`;
      }).join("");
    }).join("") : `<div class="empty">Set the party to see its mitigations.</div>`}</div>`;
}
function describe(m) {
  if (m.kind === "heal") return [m.tgt === "single" ? "single-target heal" : "party heal", m.note || "", m.dur > 3 ? `${m.dur}s` : "", `cd ${m.cd}s`].filter(Boolean).join(" · ");
  const v = m.inv ? "invuln" : m.all ? `${m.all}%` : m.phys || m.mag ? `${m.phys || 0}/${m.mag || 0}% phys/mag` : "";
  return [v, m.shield ? `${m.shield}% shield` : "", m.heal ? `+${m.heal}% healing` : "", m.note || "", `${m.dur}s`, `cd ${m.cd}s`].filter(Boolean).join(" · ");
}

/* ---------- Cheat sheet ---------- */
const CATS = { raid: "Raid Damage", tank: "Tank Damage", pos: "Positioning Required", avoid: "Avoidable AoE", target: "Targeted AoE", mech: "Mechanics" };
function catOf(ev) {
  const c = P().cats?.[ev.name]; if (c && CATS[c]) return c;
  return ev.kind === "raidwide" ? "raid" : ev.kind === "tankbuster" ? "tank" : ev.kind === "mechanic" ? "avoid" : "target";
}
function autoDesc(name) {
  const evs = F().events.filter(e => e.name === name), ev = evs.find(e => e.dmg) || evs[0];
  const rs = evs.map(e => e.dmg?.ratio).filter(x => x > 0).sort((a, b) => a - b), r = rs.length ? rs[Math.floor(rs.length / 2)] : 0;
  const hp = r ? ` (~${pct(r)} HP)` : "";
  const sch = ev.school ? `${ev.school} ` : "";
  if (ev.kind === "raidwide") return `Hits the whole party, ${sch}damage${hp}`;
  if (ev.kind === "tankbuster") return `Tankbuster on ${ev.dmg?.targets > 1 ? "both tanks" : "the main tank"}, ${sch}damage${hp}`;
  if (ev.kind === "hit") return `Hits ${ev.dmg?.targets || "some"} player${ev.dmg?.targets === 1 ? "" : "s"}, ${sch}damage${hp}`;
  return ev.castDur ? `${(ev.castDur / 1000).toFixed(1)}s cast; nobody was hit in this log` : "Nobody was hit in this log";
}
// Sheet rows = imported events with the player's edits (plan.rows, keyed by event key) plus rows they added (plan.extra).
const parseT = v => { const m = String(v ?? "").trim().match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/); if (m) return Math.round((+m[1] * 60 + +m[2]) * 1000); const n = String(v ?? "").trim(); return n !== "" && !isNaN(n) ? Math.round(+n * 1000) : null; };
function sheetData(all = false) {
  const f = F(), plan = P(), segs = segmentsOf(f).list, ov = plan.rows || {}, extra = plan.extra || [];
  const groups = segs.length ? segs.map((sg, i) => ({ name: sg.name, start: sg.start, evs: f.events.filter(e => segmentsOf(f).of[e.id] === i) })) : [{ name: f.name, start: 0, evs: f.events }];
  groups.forEach((g, gi) => {
    const items = g.evs.map(e => {
      const o = ov[e.key] || {};
      const nm = o.name || e.name;
      return { id: e.key, ev: e, name: nm, cat: CATS[o.cat] ? o.cat : CATS[plan.cats?.[nm]] ? plan.cats[nm] : catOf(e),
        cast: "cast" in o ? o.cast : (e.castStart != null ? e.castStart - g.start : null), eff: o.eff ?? e.t - g.start, hide: !!o.hide };
    }).concat(extra.filter(x => (x.seg || 0) === gi).map(x => ({ id: x.id, extra: true, name: x.name || "New row", cat: CATS[x.cat] ? x.cat : "mech", cast: x.cast ?? null, eff: x.eff ?? 0, hide: !!x.hide })));
    items.sort((a, b) => a.eff - b.eff);
    const total = {}, seen = {};
    g.all = items;
    g.rows = items.filter(r => all || !r.hide);
    g.rows.forEach(r => total[r.name] = (total[r.name] || 0) + 1);
    g.rows.forEach(r => { seen[r.name] = (seen[r.name] || 0) + 1; r.n = total[r.name] > 1 ? seen[r.name] : 0; });
  });
  return groups;
}
function glossOf(groups) {
  const out = new Map();
  for (const g of groups) for (const r of g.rows) if (!out.has(r.name)) out.set(r.name, { cat: r.cat, desc: P().notes?.[r.name] || (r.ev ? autoDesc(r.ev.name) : ""), auto: !P().notes?.[r.name] });
  return out;
}
function mitsOfRow(r) { return r.ev ? P().placements.filter(p => evOf(p) === r.ev.id && showP(p)).sort((a, b) => a.t - b.t).map(p => ({ ...MIT[p.k], label: MIT[p.k].n + ownerLabel(p) })) : []; }

function renderSheet() {
  const f = F(), plan = P(), el = $("#sheetView");
  const groups = sheetData(), gloss = glossOf(groups);
  el.innerHTML = `<div class="sheet-tools">
      <label><input type="checkbox" id="sheetMits" ${S.sheetMits ? "checked" : ""}> Show planned mitigations${S.job ? ` (${S.job})` : ""}</label>
      <button class="btn primary" id="saveImg">Download image</button>
      <button class="btn" id="saveCsv">Download CSV</button>
      <button class="btn" id="loadCsv">Import CSV</button><input type="file" id="csvIn" accept=".csv,text/csv" hidden>
      <button class="btn" id="copyText">Copy as text</button>
      <button class="btn" id="fitImg">${S.sheetFull ? "Fit to screen" : "Actual size"}</button>
    </div>
    <div class="sheet-preview ${S.sheetFull ? "full" : ""}"><img id="sheetImg" alt="Cheat sheet preview"></div>
    <div class="sheet" style="margin-top:14px">
      <div class="sh-title"><h3>Edit the sheet</h3><div class="sub">Tap the title or a mechanic to change its text or color. Changes show up in the image.</div></div>
      <p style="margin:6px 0 12px"><button class="nm btn" data-title="1">Title: ${esc(plan.title || f.name)}${(plan.sub ?? f.zone) ? ` · ${esc(plan.sub ?? f.zone)}` : ""}</button></p>
      <div class="sh-gloss">${[...gloss].map(([n, g]) => `<button class="nm cat-${g.cat}" data-gloss="${esc(n)}">${esc(n)}</button><span class="desc ${g.auto ? "auto" : ""}">${esc(g.desc)}</span>`).join("")}</div>
    </div>
    <div class="sheet" style="margin-top:14px">
      <div class="sh-title"><h3>Timeline rows</h3><div class="sub">Edit times as m:ss. Untick a row to leave it off the sheet. Changes save as you go.</div></div>
      <div class="rowtable">${sheetData(true).map((g, gi) => `<table><thead><tr><th colspan="6">${esc(g.name)} <button class="btn mini" data-addrow="${gi}">Add row</button></th></tr>
        <tr><th>Show</th><th>Cast</th><th>Effect</th><th>Mechanic</th><th>Color</th><th></th></tr></thead><tbody>
        ${g.all.map(r => `<tr data-row="${esc(r.id)}" class="${r.hide ? "off" : ""}">
          <td><input type="checkbox" data-f="show" ${r.hide ? "" : "checked"} aria-label="Show on sheet"></td>
          <td><input class="tm" data-f="cast" value="${r.cast != null ? fmt(r.cast) : ""}" inputmode="numeric" aria-label="Cast time"></td>
          <td><input class="tm" data-f="eff" value="${fmt(r.eff)}" inputmode="numeric" aria-label="Effect time"></td>
          <td><input data-f="name" value="${esc(r.name)}" aria-label="Mechanic"></td>
          <td><select data-f="cat" class="cat-${r.cat}" aria-label="Color">${Object.entries(CATS).map(([k, l]) => `<option value="${k}" ${r.cat === k ? "selected" : ""}>${l}</option>`).join("")}</select></td>
          <td>${r.extra ? `<button class="btn mini" data-delrow="${esc(r.id)}" aria-label="Delete row">✕</button>` : r.ev && (plan.rows?.[r.id]) ? `<button class="btn mini" data-resetrow="${esc(r.id)}" title="Undo my edits to this row">Reset</button>` : ""}</td>
        </tr>`).join("")}</tbody></table>`).join("")}</div>
    </div>`;
  redrawSheetImg();
}
function redrawSheetImg() {
  const img = $("#sheetImg"); if (!img) return;
  const c = drawSheet(1.5);
  img.src = c.toDataURL("image/png");
  img.style.width = S.sheetFull ? c.width / 1.5 + "px" : "";
}
function editRow(id, field, value) {
  const plan = P(), x = (plan.extra || []).find(r => r.id === id);
  if (x) {
    if (field === "show") x.hide = !value; else if (field === "cast") x.cast = parseT(value); else if (field === "eff") x.eff = parseT(value) ?? 0; else x[field] = value;
  } else {
    const ev = F().events.find(e => e.key === id); if (!ev) return;
    const o = { ...((plan.rows || {})[id] || {}) };
    if (field === "show") { if (value) delete o.hide; else o.hide = true; }
    else if (field === "cast" || field === "eff") {
      const g = sheetData(true).find(g => g.evs.includes(ev)), t = parseT(value);
      const def = field === "cast" ? (ev.castStart != null ? ev.castStart - g.start : null) : ev.t - g.start;
      if ((t == null && def == null) || (t != null && def != null && fmt(t) === fmt(def)) || (field === "eff" && t == null)) delete o[field]; else o[field] = t;
    }
    else if (field === "name") { if (value.trim() && value.trim() !== ev.name) o.name = value.trim(); else delete o.name; }
    else if (field === "cat") o.cat = value;
    plan.rows = { ...(plan.rows || {}), [id]: o };
    if (!Object.keys(o).length) delete plan.rows[id];
  }
  S.dirty = true; saveSoon(); redrawSheetImg();
}

/* The exported sheet: black background, title block, glossary, boxed Cast/Effect columns, color legend. */
const EXPORT_COL = { raid: "#ff2a2a", tank: "#ff9c1a", pos: "#ffff33", avoid: "#33ff33", target: "#29b6ff", mech: "#7d7dff" };
const ROLE_COL = { tank: "#3c74e0", heal: "#2fa35c", dps: "#d04545" };
function drawSheet(scale = 2) {
  const f = F(), plan = P(), groups = sheetData(), showMits = S.sheetMits;
  const FONT = 'Arial, "Helvetica Neue", Helvetica, sans-serif';
  const RH = 19, BOXW = showMits ? 380 : 288, GAP = 18, LW = 820, PAD = 8;
  const meas = document.createElement("canvas").getContext("2d");
  const setF = (ctx, px, w = "", it = "") => ctx.font = `${it} ${w} ${px}px ${FONT}`.trim();

  // Glossary lines (wrapped)
  setF(meas, 12);
  const NAME_R = 182, DESC_X = 188, DESC_W = LW - DESC_X - 10;
  const wrap = (txt, w) => { const words = txt.split(/\s+/), lines = []; let cur = ""; for (const wd of words) { const t = cur ? cur + " " + wd : wd; if (meas.measureText(t).width > w && cur) { lines.push(cur); cur = wd; } else cur = t; } if (cur) lines.push(cur); return lines; };
  const gloss = [...glossOf(groups)].map(([n, g]) => ({ name: n, cat: g.cat, lines: wrap("- " + (g.desc || ""), DESC_W) }));
  const glossTop = 122, glossH = gloss.reduce((a, g) => a + g.lines.length * RH, 0);
  const leftBottom = glossTop + glossH + 10;

  // Boxes, packed into columns
  const colH = Math.max(leftBottom, 26 * RH + 60);
  const HEAD = 40, perBox = Math.floor((colH - HEAD - 8) / RH);
  const boxes = [];
  for (const g of groups) {
    const size = Math.ceil(g.rows.length / Math.max(1, Math.ceil(g.rows.length / perBox))) || 1;
    for (let i = 0; i < Math.max(1, g.rows.length); i += size) boxes.push({ title: g.name + (i ? " (cont.)" : ""), rows: g.rows.slice(i, i + size) });
  }
  const legendH = 18 + 6 * RH + 6;
  const cols = [[]]; let y = 0;
  for (const b of boxes) {
    b.h = HEAD + b.rows.length * RH + 6;
    if (y && y + b.h > colH) { cols.push([]); y = 0; }
    b.y = y; cols[cols.length - 1].push(b); y += b.h + 14;
  }
  // Legend goes under the column with the most room, else in a column of its own.
  let lcol = -1, best = -1;
  cols.forEach((c, i) => { const used = c.reduce((a, b) => Math.max(a, b.y + b.h), 0), free = colH - used - 14; if (free >= legendH && free > best) { best = free; lcol = i; } });
  if (lcol < 0) { cols.push([]); lcol = cols.length - 1; }
  const legendY = Math.max(cols[lcol].reduce((a, b) => Math.max(a, b.y + b.h + 50), 0), 0);
  const W = LW + PAD + cols.length * (BOXW + GAP), H = Math.max(leftBottom, colH, legendY + legendH) + PAD * 2;

  const cv = document.createElement("canvas"); cv.width = Math.ceil(W * scale); cv.height = Math.ceil(H * scale);
  const ctx = cv.getContext("2d"); ctx.scale(scale, scale);
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H); ctx.textBaseline = "alphabetic";
  const text = (t, x, yy, col = "#fff", px = 12, w = "", it = "", align = "left") => { setF(ctx, px, w, it); ctx.fillStyle = col; ctx.textAlign = align; ctx.fillText(t, x, yy); return ctx.measureText(t).width; };
  const fit = (t, maxW, px = 12) => { setF(meas, px); if (meas.measureText(t).width <= maxW) return t; while (t.length > 1 && meas.measureText(t + "…").width > maxW) t = t.slice(0, -1); return t + "…"; };

  // Title block
  const title = plan.title || (f.demo ? "Example fight" : f.name), sub = plan.sub ?? f.zone ?? "";
  setF(meas, 24, "bold"); const tw = Math.min(380, meas.measureText(title).width), cx = Math.max(160, tw / 2 + 14);
  text(fit(title, 380, 24), cx, 30, "#fff", 24, "bold", "", "center");
  text(fit(sub, 380, 13), cx, 52, "#fff", 13, "bold", "", "center");
  text("Rotation & Timeline", cx, 86, "#fff", 24, "bold", "", "center");
  const d = new Date(), date = `(${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()})`;
  const rx = cx * 2 + 110;
  text(date, rx, 34, "#aaa", 12, "", "italic", "center");
  const pj = P().party, JS = 18, ready = pj.length && pj.every(j => JOB_IMG[j]?.complete && JOB_IMG[j].naturalWidth);
  if (ready) pj.forEach((j, i) => ctx.drawImage(JOB_IMG[j], rx - (pj.length * (JS + 3) - 3) / 2 + i * (JS + 3), 40, JS, JS));
  else text(pj.join(" "), rx, 50, "#aaa", 12, "", "italic", "center");

  // Glossary
  let gy = glossTop;
  for (const g of gloss) {
    text(fit(g.name, NAME_R - 6), NAME_R, gy, EXPORT_COL[g.cat], 12, "", "", "right");
    g.lines.forEach((ln, i) => text(ln, DESC_X + (i ? 8 : 0), gy + i * RH, "#fff"));
    gy += g.lines.length * RH;
  }

  // Boxes
  const dash = (x1, yy, x2) => { ctx.save(); ctx.strokeStyle = "#bbb"; ctx.setLineDash([2, 2]); ctx.beginPath(); ctx.moveTo(x1, yy + .5); ctx.lineTo(x2, yy + .5); ctx.stroke(); ctx.restore(); };
  const frame = (x, yy, w, h) => { ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.strokeRect(x + .5, yy + .5, w - 1, h - 1); ctx.strokeRect(x + 2.5, yy + 2.5, w - 5, h - 5); };
  cols.forEach((col, ci) => {
    const x = LW + PAD + ci * (BOXW + GAP);
    for (const b of col) {
      const top = PAD + b.y;
      frame(x, top, BOXW, b.h);
      text("Cast:", x + 6, top + 15, "#fff"); text("Effect:", x + 52, top + 15, "#fff");
      dash(x + 3, top + 19, x + BOXW - 3);
      text(fit(b.title, BOXW - 14), x + 6, top + 33, "#aaa");
      dash(x + 3, top + 37, x + BOXW - 3);
      b.rows.forEach((r, i) => {
        const yy = top + HEAD + 12 + i * RH, col = EXPORT_COL[r.cat];
        if (r.cast != null) text(fmt(r.cast), x + 6, yy, "#fff");
        text(fmt(r.eff), x + 52, yy, "#fff");
        const mits = showMits ? mitsOfRow(r) : [];
        const mitW = showMits ? 92 : 0, suffix = r.n ? ` #${r.n}` : "";
        setF(meas, 12, "", "italic"); const sw = r.n ? meas.measureText(suffix).width : 0;
        const nm = fit(r.name, BOXW - 104 - 6 - mitW - sw);
        const w = text(nm, x + 100, yy, col);
        if (r.n) text(suffix, x + 100 + w, yy, col, 12, "", "italic");
        let mx = x + BOXW - 6;
        for (const m of mits.slice(0, 5).reverse()) {
          const im = ICON_IMG[m.k];
          if (im?.complete && im.naturalWidth) { mx -= 16; ctx.drawImage(im, mx, yy - 12, 16, 16); mx -= 2; continue; }
          setF(ctx, 9, "bold"); const bw = ctx.measureText(m.ab).width + 6; mx -= bw;
          ctx.fillStyle = ROLE_COL[mitRole(m)]; ctx.fillRect(mx, yy - 10, bw, 13);
          text(m.ab, mx + 3, yy, "#fff", 9, "bold"); mx -= 2;
        }
      });
    }
  });

  // Legend
  const lx = LW + PAD + lcol * (BOXW + GAP), ly = PAD + legendY;
  ctx.strokeStyle = "#fff"; ctx.strokeRect(lx + .5, ly + .5, BOXW - 1, legendH - 1); ctx.strokeRect(lx + 1.5, ly + 1.5, BOXW - 3, legendH - 3);
  text("Color Codes", lx + BOXW / 2, ly + 14, "#fff", 12, "", "", "center");
  ctx.strokeStyle = "#fff"; ctx.beginPath(); ctx.moveTo(lx + 2, ly + 19.5); ctx.lineTo(lx + BOXW - 2, ly + 19.5); ctx.stroke();
  Object.entries(CATS).forEach(([k, l], i) => text(l, lx + BOXW / 2, ly + 34 + i * RH, EXPORT_COL[k], 12, "", "", "center"));
  return cv;
}
function sheetText() {
  const plan = P(), out = [];
  for (const g of sheetData()) {
    out.push(`== ${g.name} ==`, "Cast   Effect  Mechanic");
    for (const r of g.rows) {
      const mits = S.sheetMits ? mitsOfRow(r).map(m => m.label).join(", ") : "";
      out.push(`${(r.cast != null ? fmt(r.cast) : "").padEnd(6)} ${fmt(r.eff).padEnd(7)} ${r.name}${r.n ? " #" + r.n : ""}${mits ? "  [" + mits + "]" : ""}`);
    }
    out.push("");
  }
  return out.join("\n");
}
const CSV_HEAD = ["Phase", "Cast", "Effect", "Mechanic", "Color", "Description", "Mitigations", "Show", "Row ID"];
function sheetCsv() {
  const q = v => { v = String(v ?? ""); return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  const groups = sheetData(true), gloss = glossOf(sheetData()), lines = [CSV_HEAD.join(",")];
  for (const g of groups) for (const r of g.all) {
    const desc = P().notes?.[r.name] || gloss.get(r.name)?.desc || (r.ev ? autoDesc(r.ev.name) : "");
    lines.push([g.name, r.cast != null ? fmt(r.cast) : "", fmt(r.eff), r.name, CATS[r.cat], desc, mitsOfRow(r).map(m => m.label).join(" + "), r.hide ? "no" : "yes", r.id].map(q).join(","));
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}
function parseCsv(text) {
  const rows = []; let row = [], cur = "", inq = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inq) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inq = false; } else cur += c; }
    else if (c === '"') inq = true;
    else if (c === "," || c === ";" && !text.slice(0, 200).includes(",")) { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ""));
}
function importCsv(text) {
  const rows = parseCsv(text); if (rows.length < 2) throw new Error("That CSV has no rows.");
  const head = rows[0].map(h => h.trim().toLowerCase()), col = n => head.indexOf(n.toLowerCase());
  const need = ["Effect", "Mechanic"]; for (const n of need) if (col(n) < 0) throw new Error(`The CSV needs a "${n}" column. Download one from here to see the layout.`);
  const plan = P(), f = F(), groups = sheetData(true), catKey = v => { v = String(v || "").trim().toLowerCase(); return Object.keys(CATS).find(k => k === v || CATS[k].toLowerCase() === v) || null; };
  const get = (r, n) => col(n) >= 0 ? (r[col(n)] ?? "").trim() : undefined;
  const keys = new Set(f.events.map(e => e.key)), extraIds = new Set((plan.extra || []).map(x => x.id));
  const newRows = { ...(plan.rows || {}) }, newExtra = [], notes = { ...(plan.notes || {}) }; let n = 0, added = 0;
  for (const r of rows.slice(1)) {
    const id = get(r, "Row ID") || "", name = get(r, "Mechanic") || "", cat = catKey(get(r, "Color")), show = get(r, "Show"), desc = get(r, "Description");
    const cast = get(r, "Cast"), eff = parseT(get(r, "Effect"));
    const hide = show !== undefined && /^(no|n|false|0|hide|hidden)$/i.test(show);
    if (keys.has(id)) {
      const ev = f.events.find(e => e.key === id), g = groups.find(g => g.all.some(x => x.id === id)), o = {};
      if (name && name !== ev.name) o.name = name;
      if (cat && cat !== catOf(ev)) o.cat = cat;
      const dc = ev.castStart != null ? ev.castStart - g.start : null, pc = parseT(cast);
      const same = (x, y) => x == null || y == null ? x == y : fmt(x) === fmt(y);
      if (cast !== undefined && !same(pc, dc)) o.cast = pc;
      if (eff != null && !same(eff, ev.t - g.start)) o.eff = eff;
      if (hide) o.hide = true;
      if (Object.keys(o).length) newRows[id] = o; else delete newRows[id];
    } else if (name || eff != null) {
      const phase = get(r, "Phase"), gi = Math.max(0, groups.findIndex(g => g.name === phase));
      newExtra.push({ id: extraIds.has(id) ? id : "x" + uid(), seg: gi, name: name || "New row", cast: parseT(cast), eff: eff ?? 0, cat: cat || "mech", hide });
      added++;
    } else continue;
    n++;
    if (name && desc && desc !== (f.events.find(e => e.name === name) ? autoDesc(name) : "")) notes[name] = desc;
  }
  plan.rows = newRows; plan.extra = newExtra; plan.notes = notes;
  changed();
  toast(`Imported ${n} rows${added ? `, ${added} of them new` : ""}. Mitigations in the CSV aren't imported; place those in the planner.`);
}
// The plan as plain text: what the planner shows (current boss tab and job filter) for the current party.
// "mech" lists each mechanic with its mits; "player" gives every party member their own button list.
function planText(all = false, mode = "mech") {
  const f = F(), plan = P(), segs = segmentsOf(f).list, si = segIdx(), out = [];
  const vis = visibleEvents(), visIds = new Set(vis.map(e => e.id));
  const placed = plan.placements.filter(p => MIT[p.k] && visIds.has(evOf(p)));
  const dropped = placed.filter(p => !inParty(p)), keep = placed.filter(p => inParty(p) && showP(p));
  const who = p => plan.party[ownerIdx(p)];
  const lbl = p => `${MIT[p.k].n} (${who(p)})`;
  out.push([plan.title || f.name, plan.sub ?? f.zone].filter(Boolean).join(" - "));
  out.push(`Party: ${plan.party.join(" ")}${S.job ? ` (showing ${S.job} only)` : ""}`);
  if (segs.length && segs[si]) out.push(`Section: ${segs[si].name}`);
  out.push("");
  if (mode === "player") {
    plan.party.forEach((job, i) => {
      if (S.job && job !== S.job) return;
      const mine = keep.filter(p => ownerIdx(p) === i).sort((a, b) => a.t - b.t);
      const dup = plan.party.filter(j => j === job).length > 1 ? ` #${plan.party.slice(0, i + 1).filter(j => j === job).length}` : "";
      out.push(`${job}${dup} (${role(job)})`);
      if (!mine.length) out.push("       (nothing planned)");
      for (const p of mine) { const ev = evById(evOf(p)); out.push(`${fmtT(p.t).padStart(5)}  ${MIT[p.k].n}${MIT[p.k].kind === "heal" ? " [heal]" : ""}  -> ${ev ? ev.name + " @ " + fmtT(ev.t) : ""}`); }
      out.push("");
    });
  } else {
    for (const ev of vis) {
      const own = keep.filter(p => evOf(p) === ev.id).sort((a, b) => a.t - b.t);
      if (!own.length && !all) continue;
      const e = evaluate(ev);
      const dmg = e.r == null ? "" : ` (${pct(e.r)} HP${e.mit || e.shield || e.inv ? ` -> ${e.inv ? "0%" : pct(e.eff)}` : ""})`;
      out.push(`${fmtT(ev.t).padStart(5)}  ${ev.name} [${KIND_LABEL[ev.kind] || ev.kind}]${dmg}`);
      const mits = own.filter(p => MIT[p.k].kind !== "heal"), heals = own.filter(p => MIT[p.k].kind === "heal");
      const line = list => list.map(p => `${fmtT(p.t)} ${lbl(p)}`).join(", ");
      if (mits.length) out.push(`       Mit: ${line(mits)}`);
      if (heals.length) out.push(`       Heal: ${line(heals)}`);
      if (!own.length) out.push("       (nothing planned)");
      if (e.parts.length) out.push(`       Total: ${e.inv ? "invuln" : pct1(e.mit) + " mit"}${e.shield ? ` + ${pct1(e.shield)} shield` : ""}`);
    }
  }
  if (dropped.length) {
    const names = [...new Set(dropped.map(p => `${MIT[p.k].n} (${MIT[p.k].jobs.join("/")})`))];
    out.push("", `Left out ${dropped.length} planned use${dropped.length > 1 ? "s" : ""} from jobs not in this party: ${names.join(", ")}`);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
function openPlanText() {
  let all = false, mode = "mech";
  const s = modal(`<h2>Export plan</h2>
    <p>Your plan as plain text for your current party, boss tab and job filter.</p>
    <div class="seg" style="display:flex;gap:6px;margin:6px 0"><button class="btn" data-ptmode="mech" aria-pressed="true">By mechanic</button><button class="btn" data-ptmode="player" aria-pressed="false">By player</button></div>
    <label id="ptAllL"><input type="checkbox" id="ptAll"> Include mechanics with nothing planned</label>
    <textarea id="ptOut" readonly style="width:100%;height:46vh;margin-top:8px;font-family:var(--f-mono);font-size:12px;white-space:pre;overflow:auto"></textarea>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap"><button class="btn primary" data-ptcopy>Copy</button><button class="btn" data-ptsave>Download .txt</button><button class="btn" data-close>Close</button></div>`,
    async (e, s) => {
      const mb = e.target.closest("[data-ptmode]");
      if (mb) { mode = mb.dataset.ptmode; s.querySelectorAll("[data-ptmode]").forEach(x => x.setAttribute("aria-pressed", x === mb)); s.querySelector("#ptAllL").hidden = mode !== "mech"; fill(); return; }
      const txt = s.querySelector("#ptOut").value;
      if (e.target.closest("[data-ptcopy]")) {
        try { await navigator.clipboard.writeText(txt); toast("Plan copied"); } catch { s.querySelector("#ptOut").select(); toast("Select all and copy"); }
      }
      if (e.target.closest("[data-ptsave]")) {
        const dl = await window.claude?.use?.("downloads").catch(() => null);
        const name = (P().title || F().name).replace(/[^\w ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "plan";
        if (!dl) { toast("Downloads aren't available here. Use Copy instead."); return; }
        try { const res = await dl.save({ filename: `${name} mit plan.txt`, data: txt }); if (res?.status === "saved") toast("Plan saved"); }
        catch (err) { if (!["cancelled", "declined", "denied"].includes(err?.code)) toast("Couldn't save: " + (err?.message || err?.code || err)); }
      }
    });
  const fill = () => { s.querySelector("#ptOut").value = planText(all, mode); };
  s.querySelector("#ptAll").addEventListener("change", e => { all = e.target.checked; fill(); });
  fill();
}
async function saveCsv() {
  const csv = sheetCsv(), name = (P().title || F().name).replace(/[^\w ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "timeline";
  const dl = await window.claude?.use?.("downloads").catch(() => null);
  if (!dl) { (navigator.clipboard ? navigator.clipboard.writeText(csv) : Promise.reject()).then(() => toast("Downloads aren't available here, so the CSV was copied instead"), () => modal(`<h2>Cheat sheet CSV</h2><pre>${esc(csv)}</pre><div style="display:flex;justify-content:flex-end"><button class="btn" data-close>Close</button></div>`)); return; }
  try { const res = await dl.save({ filename: `${name} cheat sheet.csv`, data: csv }); if (res?.status === "saved") toast("CSV saved"); }
  catch (e) { if (!["cancelled", "declined", "denied"].includes(e?.code)) toast("Couldn't save the CSV: " + (e?.message || e?.code || e)); }
}
function openGloss(name, anchor) {
  closePop();
  const plan = P(), ev = F().events.find(e => e.name === name) || { name, kind: "mechanic" };
  popEl = document.createElement("div"); popEl.className = "pop";
  popEl.innerHTML = `<h3>${esc(name)}</h3>
    <label class="muted" style="font-size:12px;display:block;margin-top:6px" for="glossCat">Color</label>
    <select id="glossCat">${Object.entries(CATS).map(([k, l]) => `<option value="${k}" ${catOf(ev) === k ? "selected" : ""}>${l}</option>`).join("")}</select>
    <label class="muted" style="font-size:12px;display:block;margin-top:8px" for="glossDesc">Description</label>
    <textarea id="glossDesc" placeholder="${esc(autoDesc(name))}">${esc(plan.notes?.[name] || "")}</textarea>
    <div class="row2"><button class="btn primary" data-gsave="1">Save</button><button class="btn" data-closepop="1">Cancel</button></div>`;
  document.body.appendChild(popEl);
  const r = anchor.getBoundingClientRect(), w = popEl.offsetWidth, h = popEl.offsetHeight;
  popEl.style.left = Math.max(16, Math.min(window.innerWidth - w - 16, r.left)) + "px";
  popEl.style.top = (r.bottom + h + 12 < window.innerHeight ? r.bottom + 6 : Math.max(12, r.top - h - 6)) + "px";
  popEl.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.gsave) {
      plan.cats = { ...(plan.cats || {}), [name]: popEl.querySelector("#glossCat").value };
      const d = popEl.querySelector("#glossDesc").value.trim();
      plan.notes = { ...(plan.notes || {}) }; if (d) plan.notes[name] = d; else delete plan.notes[name];
      closePop(); changed();
    } else closePop();
  });
}
async function saveImage() {
  try {
    const dl = await window.claude?.use?.("downloads").catch(() => null);
    if (!dl) { toast("Downloads aren't available here. Long-press the preview to save it, or take a screenshot."); return; }
    const blob = await new Promise(r => drawSheet(2).toBlob(r, "image/png"));
    const name = (P().title || F().name).replace(/[^\w ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "timeline";
    const res = await dl.save({ filename: `${name} timeline.png`, data: blob });
    if (res?.status === "saved") toast("Image saved");
  } catch (e) { if (!["cancelled", "declined", "denied"].includes(e?.code)) toast("Couldn't save the image: " + (e?.message || e?.code || e)); }
}

/* ---------- Popovers, modals, toasts ---------- */
let popEl = null;
function closePop() { popEl?.remove(); popEl = null; }
function openChipPop(pid, anchor) {
  closePop();
  const p = P().placements.find(x => x.id === pid); if (!p) return;
  const m = MIT[p.k], ev = evById(evOf(p)), bad = conflicts().has(p.id), n = slotsFor(p.k);
  popEl = document.createElement("div"); popEl.className = "pop";
  popEl.innerHTML = `<h3>${esc(m.n)}</h3><div class="muted" style="font-size:13px">${describe(m)}<br>Used at <b class="mono" style="color:var(--ink)">${fmtT(p.t)}</b> for ${esc(ev?.name || "")}${bad ? `<br><b style="color:var(--bad)">Still on cooldown here.</b>` : ""}</div>
    <div class="row2"><span class="muted" style="font-size:12px">Move</span><button class="btn" data-nudge="-5000">−5s</button><button class="btn" data-nudge="-1000">−1s</button><button class="btn" data-nudge="1000">+1s</button><button class="btn" data-nudge="5000">+5s</button></div>
    ${n > 1 ? `<div class="row2"><span class="muted" style="font-size:12px">Who</span>${Array.from({ length: n }, (_, i) => `<button class="btn ${p.slot === i ? "primary" : ""}" data-slot="${i}">${esc(P().party.filter(j => m.jobs.includes(j))[i])} ${i + 1}</button>`).join("")}</div>` : ""}
    <div class="row2"><button class="btn danger-armed" data-remove="1">Remove</button><button class="btn" data-closepop="1">Close</button></div>`;
  document.body.appendChild(popEl);
  const r = anchor.getBoundingClientRect(), w = popEl.offsetWidth, h = popEl.offsetHeight;
  popEl.style.left = Math.max(16, Math.min(window.innerWidth - w - 16, r.left - w / 2 + r.width / 2)) + "px";
  popEl.style.top = (r.bottom + h + 12 < window.innerHeight ? r.bottom + 8 : Math.max(12, r.top - h - 8)) + "px";
  popEl.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.nudge) { p.t = Math.max(0, p.t + Number(b.dataset.nudge)); changed(); openChipPop(pid, document.querySelector(`[data-pl="${pid}"]`) || anchor); }
    else if (b.dataset.slot) { p.slot = Number(b.dataset.slot); changed(); openChipPop(pid, document.querySelector(`[data-pl="${pid}"]`) || anchor); }
    else if (b.dataset.remove) { P().placements = P().placements.filter(x => x.id !== pid); closePop(); changed(); }
    else closePop();
  });
}
function modal(html, onClick) {
  const s = document.createElement("div"); s.className = "scrim";
  s.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(s);
  s.addEventListener("click", e => { if (e.target === s || e.target.closest("[data-close]")) s.remove(); else onClick?.(e, s); });
  return s;
}
let toastT;
function toast(msg) { document.querySelector(".toast")?.remove(); const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.appendChild(t); clearTimeout(toastT); toastT = setTimeout(() => t.remove(), 2600); }

function openImport() {
  const ff = window.RMP?.fflogs, keys = ff?.getKeys() || {};
  const s = modal(`<h2>Import a fight</h2>
    <p>Paste an FF Logs report link. The planner turns the fight into a timeline of boss casts and damage, and learns which mitigations the fastest groups used for each hit.</p>
    <form id="linkForm" style="display:flex;gap:8px;margin-top:10px">
      <input class="btn" id="linkIn" type="url" inputmode="url" autocomplete="off" placeholder="https://www.fflogs.com/reports/…?fight=last" style="flex:1;min-width:0;font-weight:400" aria-label="FF Logs link">
      <button class="btn primary" id="linkGo" type="submit">Import</button>
    </form>
    <p class="muted" id="linkMsg" style="min-height:1.4em;margin-top:6px">No <span class="mono">fight=</span> in the link imports the last kill.</p>
    <details id="keyBox" style="margin-top:6px" ${ff?.hasKeys() ? "" : "open"}><summary><b>FF Logs API key</b> <span class="muted" id="keyState">${ff?.hasKeys() ? "saved on this device" : "needed once"}</span></summary>
      <p>FF Logs only answers apps with a key. Making one takes a minute and is free:</p>
      <ol class="muted" style="margin:4px 0 8px 18px;padding:0;font-size:14px">
        <li>Open <a href="https://www.fflogs.com/api/clients/" target="_blank" rel="noopener">fflogs.com/api/clients</a> and sign in.</li>
        <li>Choose <b>Create client</b>. Any name works; use <span class="mono">http://localhost</span> as the redirect URL and leave "Public client" off.</li>
        <li>Copy the client ID and secret here.</li>
      </ol>
      <input class="btn" id="keyId" placeholder="Client ID" autocomplete="off" value="${esc(keys.id || "")}" style="width:100%;font-weight:400;margin-bottom:6px">
      <input class="btn" id="keySecret" type="password" placeholder="Client secret" autocomplete="off" value="${esc(keys.secret || "")}" style="width:100%;font-weight:400">
      <div style="display:flex;gap:8px;margin-top:8px"><button class="btn" data-keysave>Save key</button>${ff?.hasKeys() ? `<button class="btn" data-keyclear>Remove</button>` : ""}</div>
    </details>
    <h4>Or import a file</h4>
    <label class="drop-zone" id="dz"><input type="file" id="fileIn" accept=".json,application/json" hidden>Drop a fight file here, or <u>choose one</u></label>
    <div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn" data-close>Close</button></div>`,
    (e, s) => {
      if (e.target.closest("[data-keysave]")) {
        const id = s.querySelector("#keyId").value.trim(), secret = s.querySelector("#keySecret").value.trim();
        if (!id || !secret) { toast("Enter both the client ID and the secret."); return; }
        ff.setKeys({ id, secret }); s.querySelector("#linkMsg").textContent = ""; s.querySelector("#keyState").textContent = "saved on this device"; s.querySelector("#keyBox").open = false; toast("API key saved");
      }
      if (e.target.closest("[data-keyclear]")) { ff.setKeys(null); s.querySelector("#keyId").value = s.querySelector("#keySecret").value = ""; s.querySelector("#keyState").textContent = "needed once"; toast("API key removed"); }
    });
  const msg = s.querySelector("#linkMsg"), go = s.querySelector("#linkGo");
  s.querySelector("#linkForm").addEventListener("submit", async e => {
    e.preventDefault();
    if (!ff) { msg.textContent = "FF Logs import isn't available here."; return; }
    const link = s.querySelector("#linkIn").value;
    try { ff.parseLink(link); } catch (err) { msg.textContent = err.message; return; }
    if (!ff.hasKeys()) { msg.textContent = "Add your FF Logs API key below first."; s.querySelector("#keyBox").open = true; return; }
    go.disabled = true;
    try { const f = await ff.importLink(link, { onProgress: t => msg.textContent = t }); await importFight(f); s.remove(); }
    catch (err) { msg.textContent = err.message || String(err); if (err.code === "badkey") s.querySelector("#keyBox").open = true; }
    finally { go.disabled = false; }
  });
  const dz = s.querySelector("#dz");
  const take = async file => { try { await importFight(JSON.parse(await file.text())); s.remove(); } catch (e) { toast(e.message || "That file isn't a fight file from the import script."); } };
  s.querySelector("#fileIn").addEventListener("change", e => e.target.files[0] && take(e.target.files[0]));
  dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("over"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("over"));
  dz.addEventListener("drop", e => { e.preventDefault(); dz.classList.remove("over"); e.dataTransfer.files[0] && take(e.dataTransfer.files[0]); });
}
async function importFight(f) {
  if (f?.format !== "mit-planner/1" || !Array.isArray(f.events) || !f.id) throw new Error("That file isn't a fight file from the import script.");
  if (S.db) {
    try { await S.db.doc("fights/" + safeId(f.id)).set(f); }
    catch (e) { f.local = true; toast("Saved in this browser only: " + (e.message || e.code)); }
  } else f.local = true;
  if (f.local) { const loc = store.get("fights") || {}; loc[f.id] = f; store.set("fights", loc); }
  S.fights[f.id] = f; delete S.fights.demo;
  selectFight(f.id); toast(`Imported ${f.name}: ${f.events.length} key moments`);
}

function openParty() {
  const plan = P();
  const draw = () => ALL_JOBS.map(j => `<button class="${role(j)} ${plan.party.includes(j) ? "on" : ""}" data-job="${j}">${JOB_ICONS[j] ? jobIcon(j, 20) + " " : ""}${j}</button>`).join("");
  const s = modal(`<h2>Party</h2><p>Pick the jobs in your party. The palette and suggestions only use their mitigations. Pick a job twice by tapping it while holding Shift.</p><p class="muted">Just want to see one job's mits? Keep the full party and tap that job's icon next to "Show" above the timeline.</p>
    <div class="jobgrid" id="jg">${draw()}</div><p class="mono" id="pl" style="margin-top:10px">${plan.party.join(" ")}</p>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px"><button class="btn" data-reset>Use log party</button><button class="btn primary" data-close>Done</button></div>`,
    (e, s) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.job) { const j = b.dataset.job, i = plan.party.indexOf(j); if (i >= 0 && !e.shiftKey) plan.party.splice(i, 1); else if (plan.party.length < 8) plan.party.push(j); }
      if (b.hasAttribute("data-reset")) plan.party = [...(F().party || [])];
      plan.party.sort((a, b) => ALL_JOBS.indexOf(a) - ALL_JOBS.indexOf(b));
      s.querySelector("#jg").innerHTML = draw(); s.querySelector("#pl").textContent = plan.party.join(" "); changed();
    });
}
function openFill() {
  const f = F(), plan = P();
  if (f.demo) { toast("Import a fight first."); return; }
  let comp = [...plan.party];
  const pats = patternsFor(f), cur = popSrc();
  const srcOpts = `<option value="">Top logs, any comp (${f.sampleSize || 1} log${f.sampleSize > 1 ? "s" : ""})</option>` + pats.map(p => `<option value="${esc(p.id)}" ${plan.pat === p.id ? "selected" : ""}>Logs with ${esc(p.comp.join(" "))} (${p.sampleSize})</option>`).join("");
  const pend = () => Object.values(S.requests).filter(r => r.fight === f.id && r.status !== "done" && !pats.some(p => compSlug(p.comp) === compSlug(r.comp)));
  const drawComp = () => ALL_JOBS.map(j => { const n = comp.filter(x => x === j).length; return `<button class="${role(j)} ${n ? "on" : ""}" data-cj="${j}">${JOB_ICONS[j] ? jobIcon(j, 18) + " " : ""}${j}${n > 1 ? "×" + n : ""}</button>`; }).join("");
  const drawPend = () => pend().map(r => `<li>${esc(r.comp.join(" "))}, asked ${new Date(r.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</li>`).join("");
  const s = modal(`<h2>Fill from logs</h2>
    <p>Places the mitigations other players used for each hit, at the timing they used. This replaces the current plan.</p>
    <h4>Learn from</h4>
    <select class="btn" id="src" style="width:100%">${srcOpts}</select>
    <p style="margin-top:8px">Only place a mitigation used in at least <b class="mono" id="thrv">${pct(plan.thr ?? 0.4)}</b> of those logs.</p>
    <input type="range" id="thr" min="0.1" max="1" step="0.05" value="${plan.thr ?? 0.4}" aria-label="Minimum share of logs">
    <div style="margin-top:8px"><button class="btn primary" data-fill ${cur.popular.length || pats.length ? "" : "disabled"}>Fill popular mitigations</button></div>
    ${f.used?.length ? `<h4>This log only</h4><p>Copy exactly what this group pressed in the imported pull.</p><button class="btn" data-played>Use this log's mitigations</button>` : ""}
    <details style="margin-top:14px" ${pats.length ? "" : "open"}><summary><b>Find logs with a composition</b></summary>
      <p>Pick the jobs the logs must have. Your party is filled in; a partial comp (say, just SCH and WHM) finds more logs. On a keyboard, Shift-click a job to need two of it.</p>
      <div class="jobgrid" id="cg">${drawComp()}</div>
      <p class="mono" id="cl" style="margin-top:8px">${comp.join(" ") || "Any comp"}</p>
      <button class="btn" data-req>Find these logs</button>
      <div id="reqmsg" class="muted" style="margin-top:8px"></div>
      <ul id="pend" class="muted" style="margin:6px 0 0 18px">${drawPend()}</ul>
    </details>
    <div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn" data-close>Cancel</button></div>`,
    async (e, s) => {
      const b = e.target.closest("button");
      if (b?.dataset.cj) {
        const j = b.dataset.cj, i = comp.indexOf(j);
        if (i >= 0 && !e.shiftKey) comp = comp.filter(x => x !== j); else if (comp.length < 8) comp.push(j);
        comp.sort((a, c) => ALL_JOBS.indexOf(a) - ALL_JOBS.indexOf(c));
        s.querySelector("#cg").innerHTML = drawComp(); s.querySelector("#cl").textContent = comp.join(" ") || "Any comp";
      }
      if (e.target.closest("[data-fill]")) { const v = s.querySelector("#src").value; if (v) plan.pat = v; else delete plan.pat; fillFromLogs(Number(s.querySelector("#thr").value)); s.remove(); }
      if (e.target.closest("[data-played]")) { loadAsPlayed(); s.remove(); }
      if (e.target.closest("[data-req]")) {
        const msg = s.querySelector("#reqmsg");
        if (!comp.length) { msg.textContent = "Pick at least one job."; return; }
        const have = pats.find(p => compSlug(p.comp) === compSlug(comp));
        if (have) { s.querySelector("#src").value = have.id; msg.textContent = "Already fetched. It's selected under Learn from."; return; }
        const id = safeId(f.id + "~" + compSlug(comp)), btn = e.target.closest("[data-req]");
        if (!window.RMP?.fflogs?.hasKeys()) { msg.textContent = "Add your FF Logs API key first: Import fight, then FF Logs API key."; return; }
        btn.disabled = true;
        try {
          const pat = { id, ...(await window.RMP.fflogs.compPatterns(f, comp, { onProgress: t => msg.textContent = t })) };
          if (S.db) await S.db.doc("patterns/" + id).set(pat);
          S.patterns[id] = pat; pats.push(pat);
          const sel = s.querySelector("#src");
          sel.insertAdjacentHTML("beforeend", `<option value="${esc(id)}">Logs with ${esc(pat.comp.join(" "))} (${pat.sampleSize})</option>`);
          sel.value = id; s.querySelector("[data-fill]").disabled = false;
          msg.textContent = `Found ${pat.sampleSize} log${pat.sampleSize > 1 ? "s" : ""}. They're selected under Learn from.`;
        } catch (err) { msg.textContent = err.message || String(err); }
        finally { btn.disabled = false; }
      }
    });
  s.addEventListener("input", e => { if (e.target.id === "thr") s.querySelector("#thrv").textContent = pct(Number(e.target.value)); });
}

/* ---------- Drag and tap ---------- */
let drag = null;
function rowAt(x, y) { const el = document.elementFromPoint(x, y); return el?.closest?.(".row[data-ev]") || null; }
function startDrag(k, e) {
  const g = document.createElement("div"); g.className = "drag-ghost"; g.innerHTML = icon(MIT[k]);
  document.body.appendChild(g); drag.ghost = g; drag.active = true; moveDrag(e);
  if (window.innerWidth <= 860) $("#palette").classList.remove("open");
}
function moveDrag(e) {
  drag.ghost.style.left = e.clientX + "px"; drag.ghost.style.top = e.clientY + "px";
  const r = rowAt(e.clientX, e.clientY);
  if (r !== drag.over) { drag.over?.classList.remove("drop"); r?.classList.add("drop"); drag.over = r; }
}
document.addEventListener("pointerdown", e => {
  const b = e.target.closest(".mit[data-mit]"); if (!b || e.button > 0) return;
  drag = { k: b.dataset.mit, slot: b.dataset.slot != null ? +b.dataset.slot : undefined, x: e.clientX, y: e.clientY, active: false, touch: e.pointerType !== "mouse", timer: null, btn: b };
  if (drag.touch) drag.timer = setTimeout(() => { if (drag && !drag.active) startDrag(drag.k, { clientX: drag.x, clientY: drag.y }); }, 260);
});
document.addEventListener("pointermove", e => {
  if (!drag) return;
  const d = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
  if (!drag.active) {
    if (drag.touch) { if (d > 8) { clearTimeout(drag.timer); drag = null; } return; }
    if (d > 6) startDrag(drag.k, e); else return;
  }
  moveDrag(e);
});
document.addEventListener("touchmove", e => { if (drag?.active) e.preventDefault(); }, { passive: false });
function endDrag(e, cancelled) {
  if (!drag) return;
  clearTimeout(drag.timer);
  const d = drag; drag = null;
  if (d.active) {
    d.ghost.remove(); d.over?.classList.remove("drop");
    const ev = !cancelled && d.over ? evById(d.over.dataset.ev) : null;
    if (ev) { S.focus = ev.id; place(d.k, ev, undefined, d.slot); }
    suppressClick = true; setTimeout(() => suppressClick = false, 50);
  }
}
let suppressClick = false;
document.addEventListener("pointerup", e => endDrag(e, false));
document.addEventListener("pointercancel", e => endDrag(e, true));

document.addEventListener("click", e => {
  if (suppressClick) { e.preventDefault(); return; }
  const t = e.target;
  if (popEl && !popEl.contains(t) && !t.closest("[data-pl]")) closePop();
  const mitB = t.closest(".mit[data-mit]");
  if (mitB) { const ev = evById(S.focus); if (ev) place(mitB.dataset.mit, ev, undefined, mitB.dataset.slot != null ? +mitB.dataset.slot : undefined); return; }
  const add = t.closest("[data-add]");
  if (add) { const ev = evById(add.dataset.ev); S.focus = ev.id; place(add.dataset.add, ev, add.dataset.t != null ? Number(add.dataset.t) : undefined); return; }
  const chip = t.closest("[data-pl]"); if (chip) { openChipPop(chip.dataset.pl, chip); return; }
  const plus = t.closest("[data-plus]");
  if (plus) { S.focus = plus.dataset.plus; renderAll(); $("#palette").classList.add("open"); return; }
  const ti = t.closest("[data-title]");
  if (ti) {
    closePop(); popEl = document.createElement("div"); popEl.className = "pop";
    popEl.innerHTML = `<h3>Sheet title</h3><input id="titleIn" class="btn" style="width:100%;margin-top:6px;font-weight:400" value="${esc(P().title || F().name)}"><h3 style="margin-top:10px">Subtitle</h3><input id="subIn" class="btn" style="width:100%;margin-top:6px;font-weight:400" value="${esc(P().sub ?? F().zone ?? "")}"><div class="row2"><button class="btn primary" data-tsave="1">Save</button><button class="btn" data-closepop="1">Cancel</button></div>`;
    document.body.appendChild(popEl); const r = ti.getBoundingClientRect();
    popEl.style.left = Math.max(16, Math.min(window.innerWidth - popEl.offsetWidth - 16, r.left)) + "px"; popEl.style.top = (r.bottom + 6) + "px";
    popEl.addEventListener("click", ev2 => { const b = ev2.target.closest("button"); if (!b) return; if (b.dataset.tsave) { const v = popEl.querySelector("#titleIn").value.trim(); P().title = v || undefined; if (!v) delete P().title; const sv = popEl.querySelector("#subIn").value.trim(); if (sv === (F().zone || "")) delete P().sub; else P().sub = sv; } closePop(); if (b.dataset.tsave) changed(); });
    return;
  }
  const gl = t.closest("[data-gloss]"); if (gl) { openGloss(gl.dataset.gloss, gl); return; }
  if (t.closest("#copyText")) { const txt = sheetText(); (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => toast("Timeline copied"), () => modal(`<h2>Copy timeline</h2><pre>${esc(txt)}</pre><div style="display:flex;justify-content:flex-end"><button class="btn" data-close>Close</button></div>`)); return; }
  if (t.closest("#saveImg")) { saveImage(); return; }
  if (t.closest("#saveCsv")) { saveCsv(); return; }
  if (t.closest("#loadCsv")) { $("#csvIn").click(); return; }
  const addR = t.closest("[data-addrow]");
  if (addR) { const plan = P(), g = sheetData(true)[+addR.dataset.addrow], last = g.all[g.all.length - 1]; plan.extra = [...(plan.extra || []), { id: "x" + uid(), seg: +addR.dataset.addrow, name: "New row", cast: null, eff: last ? last.eff + 5000 : 0, cat: "mech" }]; changed(); return; }
  const delR = t.closest("[data-delrow]");
  if (delR) { P().extra = (P().extra || []).filter(x => x.id !== delR.dataset.delrow); changed(); return; }
  const resR = t.closest("[data-resetrow]");
  if (resR) { const r = { ...(P().rows || {}) }; delete r[resR.dataset.resetrow]; P().rows = r; changed(); return; }
  if (t.closest("#fitImg")) { S.sheetFull = !S.sheetFull; renderSheet(); return; }
  const segB = t.closest("[data-seg]");
  if (segB) { S.seg[S.fightId] = Number(segB.dataset.seg); store.set("seg", S.seg); S.focus = null; renderAll(); return; }
  const svgEv = t.closest("svg [data-ev]");
  if (svgEv) { S.focus = svgEv.dataset.ev; renderAll(); document.querySelector(`.row[data-ev="${S.focus}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }); return; }
  const row = t.closest(".row[data-ev]");
  if (row && S.focus !== row.dataset.ev) { S.focus = row.dataset.ev; renderAll(); return; }
  if (t.closest("#palClose")) { $("#palette").classList.remove("open"); return; }
  if (t.closest("[data-act=import]")) openImport();
  if (t.closest("[data-act=logparty]")) { P().party = [...(F().party || [])]; changed(); }
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") { closePop(); $("#palette").classList.remove("open"); document.querySelector(".scrim")?.remove(); }
  const row = e.target.closest?.(".row[data-ev]");
  if (row && (e.key === "Enter" || e.key === " ") && e.target === row) { e.preventDefault(); S.focus = row.dataset.ev; renderAll(); document.querySelector(`.row[data-ev="${S.focus}"]`)?.focus(); }
});
$("#fab").addEventListener("click", () => $("#palette").classList.toggle("open"));
$("#importBtn").addEventListener("click", openImport);
$("#partyBtn").addEventListener("click", openParty);
$("#fillBtn").addEventListener("click", openFill);
$("#autoBtn").addEventListener("click", suggestAll);
$("#clearBtn").addEventListener("click", e => {
  const b = e.currentTarget;
  if (!S.armedClear) { S.armedClear = true; b.textContent = "Clear all?"; b.classList.add("danger-armed"); setTimeout(() => { S.armedClear = false; b.textContent = "Clear"; b.classList.remove("danger-armed"); }, 3000); return; }
  S.armedClear = false; b.textContent = "Clear"; b.classList.remove("danger-armed"); P().placements = []; changed();
});
$("#fightSel").addEventListener("change", e => openFight(e.target.value));
$("#sortSel").addEventListener("change", e => { S.prefs = { ...S.prefs, sort: e.target.value }; savePrefs(); renderHeader(); });
$("#jobSel").addEventListener("change", e => { S.job = e.target.value || null; store.set("job:" + S.fightId, S.job); renderAll(); });
$("#summary").addEventListener("click", e => { const b = e.target.closest("[data-jf]"); if (b) { S.job = b.dataset.jf || null; store.set("job:" + S.fightId, S.job); renderAll(); } });
$("#planTxtBtn").addEventListener("click", () => { if (F()) openPlanText(); });
$("#sheetBtn").addEventListener("click", () => { closePop(); S.view = S.view === "sheet" ? "plan" : "sheet"; renderAll(); window.scrollTo(0, 0); });
document.addEventListener("change", async e => {
  if (e.target.id === "sheetMits") { S.sheetMits = e.target.checked; renderSheet(); return; }
  if (e.target.id === "csvIn") { const file = e.target.files[0]; e.target.value = ""; if (!file) return; try { importCsv(await file.text()); } catch (err) { toast(err.message || "Couldn't read that CSV."); } return; }
  const tr = e.target.closest?.("tr[data-row]"), fld = e.target.dataset?.f;
  if (tr && fld) {
    editRow(tr.dataset.row, fld, fld === "show" ? e.target.checked : e.target.value);
    if (fld === "show") tr.classList.toggle("off", !e.target.checked);
    if (fld === "cat") e.target.className = "cat-" + e.target.value;
    if (fld === "cast" || fld === "eff") { const v = parseT(e.target.value); if (v != null) e.target.value = fmt(v); }
  }
});
window.addEventListener("resize", () => { clearTimeout(window._rz); window._rz = setTimeout(renderOverview, 150); });

/* ---------- Data loading ---------- */
// Which fight to reopen and how to sort the menu live in prefs/main, so they follow Bike across devices.
S.prefs = store.get("prefs") || { sort: "opened", opened: {} };
function sortedFightIds() {
  const fs = Object.values(S.fights), op = S.prefs.opened || {};
  const by = { name: (a, b) => a.name.localeCompare(b.name), imported: (a, b) => (b.importedAt || 0) - (a.importedAt || 0),
    zone: (a, b) => (a.zone || "").localeCompare(b.zone || "") || a.name.localeCompare(b.name),
    opened: (a, b) => (op[b.id] || 0) - (op[a.id] || 0) || (b.importedAt || 0) - (a.importedAt || 0) };
  return fs.sort(by[S.prefs.sort] || by.opened).map(f => f.id);
}
let prefsTimer;
function savePrefs() {
  store.set("prefs", S.prefs);
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => { S.db?.doc("prefs/main").set(JSON.parse(JSON.stringify(S.prefs))).catch(() => {}); }, 800);
}
function openFight(id) {
  S.prefs = { ...S.prefs, last: id, opened: { ...(S.prefs.opened || {}), [id]: Date.now() } };
  savePrefs(); selectFight(id);
}
function selectFight(id) {
  S.fightId = id; S.focus = null; store.set("lastFight", id); S.job = store.get("job:" + id) || null;
  const f = F();
  if (f && !S.plans[id]) { const local = store.get("plan:" + id); if (local) S.plans[id] = local; }
  S.unsubPlan?.(); S.unsubPlan = null;
  if (S.db && f && !f.demo && !f.local) {
    S.unsubPlan = S.db.doc("plans/" + safeId(id)).onSnapshot(snap => {
      if (!snap.exists || snap.metadata.hasPendingWrites || S.dirty) return;
      const d = snap.data();
      if (JSON.stringify(d) !== JSON.stringify(S.plans[id])) { S.plans[id] = JSON.parse(JSON.stringify(d)); if (S.fightId === id) renderAll(); }
    }, () => {});
  }
  renderAll();
}
function setFights(list) {
  const prev = S.fightId;
  S.fights = {};
  for (const f of list) if (f?.format === "mit-planner/1" && Array.isArray(f.events)) S.fights[f.id] = f;
  const loc = store.get("fights") || {};
  for (const [id, f] of Object.entries(loc)) if (!S.fights[id]) S.fights[id] = { ...f, local: true };
  if (!Object.keys(S.fights).length) S.fights.demo = demoFight();
  const want = S.fights[prev] ? prev : S.fights[S.prefs.last] ? S.prefs.last : S.fights[store.get("lastFight")] ? store.get("lastFight") : sortedFightIds()[0];
  if (want !== prev) selectFight(want); else renderAll();
}

setFights([]);
(async () => {
  const db = await window.claude?.use?.("db").catch(() => null);
  if (!db) { renderAll(); return; }
  S.db = db;
  try { const pr = await db.doc("prefs/main").get(); if (pr.exists) { S.prefs = { sort: "opened", opened: {}, ...pr.data() }; store.set("prefs", S.prefs); if (S.fights[S.prefs.last]) S.fightId = S.prefs.last; } } catch {}
  db.collection("fights").onSnapshot(snap => setFights(snap.docs.map(d => d.data())), () => { S.db = null; renderAll(); });
  db.collection("patterns").onSnapshot(snap => { S.patterns = {}; for (const d of snap.docs) { const p = d.data(); if (p?.format === "mit-planner/patterns") S.patterns[p.id || d.id] = p; } renderAll(); }, () => {});
  db.collection("requests").onSnapshot(snap => { S.requests = {}; for (const d of snap.docs) S.requests[d.id] = d.data(); }, () => {});
  selectFight(S.fightId);
})();
