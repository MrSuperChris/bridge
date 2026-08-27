/* ============================================================================
   Unit test for the "state buttons on run-output cards" fix.

   The card's Verify says: do NOT tap state on a real run-output card on the live
   board — that IS the bug firing. Instead, unit-test the classification and the
   button-rendering condition against captured task JSON. That is what this does.

   It loads the REAL app.js (no copy of the logic) into a vm sandbox with a
   permissive DOM/localStorage/fetch stub, feeds it task objects captured from the
   live Claude Queue on 2026-08-27, and checks three things:

     1. classify() gives run-output cards (☀️/📋/✅/✔️) state === null and work
        cards (⬜/🔄/👀/⛔) a real state — the input the button gate reads.
     2. openCard() HIDES #dStateBtns and shows #dStateNote for a null-state card,
        and shows the buttons for a work card. (the rendering condition)
     3. setState() REFUSES a null-state card outright — no network write at all —
        while still proceeding for a work card moved to a different state.

   Run:  node test/state-buttons.test.mjs
   ========================================================================= */

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_JS = join(HERE, '..', 'app.js');

/* ── captured live tasks (2026-08-27) ──────────────────────────────────────
   columnId is included as it came off the board, precisely to prove the fix
   holds on `main`, where classify() reads only the title glyph and ignores the
   column. */
const REPORTS = [
  { id: 'r-sun',    title: '☀️ Workday report — 2026-08-26',       priority: 3, columnId: null, createdTime: '2026-08-26T14:24:56.563+0000', modifiedTime: '2026-08-26T14:24:56.563+0000', content: 'run report' },
  { id: 'r-alert',  title: '✅ Sleeper Service recovered',          priority: 5, columnId: null, createdTime: '2026-08-25T14:13:04.149+0000', modifiedTime: '2026-08-25T14:13:04.149+0000', content: 'recovered' },
  { id: 'r-triage', title: '📋 Triage — 2026-08-25 PM',            priority: 0, columnId: null, createdTime: '2026-08-25T23:03:06.361+0000', modifiedTime: '2026-08-25T23:03:06.361+0000', content: 'triage' },
  { id: 'r-done',   title: '✔️ [design] Journal — design complete', priority: 3, columnId: '6a8e3dca8f0800ee150f902a', createdTime: '2026-08-18T01:51:35.936+0000', modifiedTime: '2026-08-18T01:51:35.936+0000', content: 'design done' },
];
/* 🚨 is NOT in main's LOG_GLYPHS or STATES, so on `main` it classifies as
   neither card nor log (that invisibility is the separate columns-branch fix).
   It still must have state === null, which is all the guard needs. */
const ALARM = { id: 'r-alarm', title: '🚨 Sleeper Service is DOWN', priority: 5, columnId: null, createdTime: '2026-08-25T14:08:02.383+0000', modifiedTime: '2026-08-25T14:08:02.383+0000', content: 'down' };

const WORK = [
  { id: 'w-review',  state: 'review',  title: '👀 [research] AGI 2027 — brief',    priority: 1, columnId: '6a8e3dc68f0800ee150f8fe1', createdTime: '2026-07-10T03:08:21.759+0000', modifiedTime: '2026-07-10T03:08:21.759+0000', content: 'brief' },
  { id: 'w-blocked', state: 'blocked', title: '⛔ [research] Intentionality thread', priority: 3, columnId: '6a8e3dc88f08b397ec1c1f09', createdTime: '2026-07-16T00:48:06.913+0000', modifiedTime: '2026-07-16T00:48:06.913+0000', content: 'need source' },
  { id: 'w-queued',  state: 'queued',  title: '⬜ LATER — Habit data',              priority: 1, columnId: '6a8e3dc38f086ae6e266333d', createdTime: '2026-08-22T01:00:51.066+0000', modifiedTime: '2026-08-22T01:00:51.066+0000', content: 'deferred' },
];

/* ── a permissive DOM/env stub ──────────────────────────────────────────── */
const fetchLog = [];        // {method, path} for every fetch app.js makes

function makeEl() {
  const t = {
    _kids: [],
    style: { setProperty() {}, removeProperty() {}, get transition() { return ''; }, set transition(v) {}, get width() { return ''; }, set width(v) {} },
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setProperty() {},
    setAttribute() {}, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { this._kids.push(c); return c; },
    removeChild() {}, remove() {},
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    focus() {}, click() {},
    offsetWidth: 0,
    hidden: false, textContent: '', innerHTML: '', value: '', href: '', title: '', type: 'text', onclick: null,
  };
  return t;
}

/* Document-level querySelector must be memoized so a value openCard() writes to
   #dStateBtns is the same object the test reads back. */
const elCache = new Map();
function docQuery(sel) {
  if (!elCache.has(sel)) elCache.set(sel, makeEl());
  return elCache.get(sel);
}

function jsonResponse(obj) {
  const body = JSON.stringify(obj);
  return { status: 200, ok: true, text: async () => body };
}

function makeSandbox(board) {
  const document = {
    querySelector: docQuery,
    querySelectorAll: () => [],
    createElement: () => makeEl(),
    addEventListener() {}, removeEventListener() {},
    hidden: false,
  };
  const localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

  async function fetchStub(url, opts = {}) {
    const method = opts.method || 'GET';
    const path = String(url).replace('https://api.ticktick.com/open/v1', '');
    fetchLog.push({ method, path });
    if (path.endsWith('/data')) return jsonResponse(board);
    const m = path.match(/\/task\/([^/]+)/);
    if (m) {
      const id = m[1];
      const all = [...board.tasks];
      const found = all.find(t => t.id === id) || { id, title: 'stub', priority: 0 };
      return jsonResponse(found);
    }
    return jsonResponse(null);
  }

  const sandbox = {
    document, localStorage, fetch: fetchStub,
    navigator: {}, location: { hash: '', pathname: '/', search: '' },
    history: { replaceState() {} },
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    confirm: () => true, alert() {},
    console, Intl, JSON, Math, Date, Object, Array, String, Number, Boolean,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}

/* ── load app.js into the sandbox ───────────────────────────────────────── */
const board = { tasks: [...REPORTS, ALARM, ...WORK] };
const sandbox = vm.createContext(makeSandbox(board));
const src = readFileSync(APP_JS, 'utf8');
vm.runInContext(src, sandbox, { filename: 'app.js' });

const { classify, openCard, setState } = sandbox;
assert.equal(typeof classify, 'function', 'classify() should be reachable from app.js');
assert.equal(typeof openCard, 'function', 'openCard() should be reachable from app.js');
assert.equal(typeof setState, 'function', 'setState() should be reachable from app.js');

let passed = 0;
const ok = (msg) => { console.log('  ✓ ' + msg); passed++; };

/* ── 1. classification ──────────────────────────────────────────────────── */
console.log('classify(): run-output cards carry no workflow state');
for (const t of [...REPORTS, ALARM]) {
  const c = classify(t);
  assert.equal(c.state, null, `${t.title} → state must be null, got ${c.state}`);
  ok(`${t.title.slice(0, 32)} → state=null`);
}
console.log('classify(): work cards carry a real workflow state');
for (const t of WORK) {
  const c = classify(t);
  assert.equal(c.state, t.state, `${t.title} → state must be ${t.state}, got ${c.state}`);
  ok(`${t.title.slice(0, 28)} → state=${c.state}`);
}

/* ── 2. openCard() button-rendering condition ───────────────────────────── */
/* Populate app.cards/app.logs the way the live app does: through refresh(),
   whose fetch we have stubbed to serve the captured board. */
await sandbox.refresh(true);

console.log('openCard(): a run-output card hides the state buttons');
for (const id of ['r-sun', 'r-triage', 'r-done']) {  // openable log cards on main
  openCard(id);
  assert.equal(docQuery('#dStateBtns').hidden, true, `${id}: #dStateBtns must be hidden`);
  assert.equal(docQuery('#dStateNote').hidden, false, `${id}: #dStateNote must be shown`);
  ok(`${id}: buttons hidden, note shown`);
}
console.log('openCard(): a work card shows the state buttons');
for (const id of ['w-review', 'w-blocked', 'w-queued']) {
  openCard(id);
  assert.equal(docQuery('#dStateBtns').hidden, false, `${id}: #dStateBtns must be visible`);
  assert.equal(docQuery('#dStateNote').hidden, true, `${id}: #dStateNote must be hidden`);
  ok(`${id}: buttons shown, note hidden`);
}

/* ── 3. setState() refusal ──────────────────────────────────────────────── */
const taskWrites = () => fetchLog.filter(f => /\/task\//.test(f.path));

console.log('setState(): refuses a run-output card with NO network write');
for (const t of [...REPORTS, ALARM]) {
  const c = classify(t);
  fetchLog.length = 0;
  await setState(c, 'queued');
  assert.equal(taskWrites().length, 0, `${t.title}: setState must issue no /task/ call, saw ${taskWrites().length}`);
  ok(`${t.title.slice(0, 32)} → refused (0 writes)`);
}

console.log('setState(): still proceeds for a work card changed to a new state');
{
  const c = classify(WORK[2]);           // ⬜ queued …
  fetchLog.length = 0;
  await setState(c, 'review');           // queued → review, a real transition
  assert.ok(taskWrites().length >= 1, `work card: setState should reach the write path, saw ${taskWrites().length}`);
  ok(`${WORK[2].title.slice(0, 24)} queued→review → proceeds (${taskWrites().length} write call(s))`);
}

console.log(`\nALL ${passed} ASSERTIONS PASSED`);
