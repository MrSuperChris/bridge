/* ============================================================================
   Unit test for the "tick action beside the ask" fix (card 6ac832dc…).

   The bug: on a phone a card whose latest NEEDS band is a `tick` showed the word
   TICK at the top of the detail sheet, but the only control that fulfils it
   (COMPLETE CARD) sat at the very bottom — several screens of scrolling away, and
   worded differently. The fix hoists a completing control into the top band on
   tick cards, worded to match.

   Loaded against the REAL app.js (no copy of the logic) in a vm sandbox with the
   same permissive DOM stub the other Bridge tests use. It checks:

     1. openCard() on a tick card appends a button INTO #dNeeds (beside the ask),
        and clicking it issues the completing POST — so the action is one tap from
        the ask, not a scroll away.
     2. The bottom COMPLETE CARD control is relabelled to match ("TICK OFF CARD").
     3. A non-tick card (approve) gets NO inline button in #dNeeds — the hoist is
        specific to tick, not a blanket change to every band.

   Run:  node test/tick-action.test.mjs
   ========================================================================= */

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_JS = join(HERE, '..', 'app.js');

const COL = {
  queued:  '6a8e3dc38f086ae6e266333d',
  review:  '6a8e3dc68f0800ee150f8fe1',
  blocked: '6a8e3dc88f08b397ec1c1f09',
};
const band = v => `\n--- NEEDS: ${v} ---`;

const TICK = { id: 'c-tick', title: '👀 [build] Done, tick it', priority: 3, columnId: COL.review,
  createdTime: '2026-10-01T00:00:00.000+0000', modifiedTime: '2026-10-01T00:00:00.000+0000',
  content: 'body' + band('tick — finished; ticking it closes the card') };
const APPROVE = { id: 'c-approve', title: '👀 [build] Ship it', priority: 3, columnId: COL.review,
  createdTime: '2026-10-02T00:00:00.000+0000', modifiedTime: '2026-10-02T00:00:00.000+0000',
  content: 'body' + band('approve & merge branch claude/foo in automation (commit abc1234)') };

/* ── permissive DOM/env stub (same shape as the other test files) ──────────── */
const fetchLog = [];
function makeEl() {
  return {
    _kids: [],
    style: { setProperty() {}, removeProperty() {} },
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { this._kids.push(c); return c; },
    removeChild() {}, remove() {},
    querySelector() { return makeEl(); }, querySelectorAll() { return []; },
    focus() {}, click() {},
    hidden: false, textContent: '', innerHTML: '', value: '', href: '', title: '', onclick: null,
  };
}
const elCache = new Map();
function docQuery(sel) {
  if (!elCache.has(sel)) elCache.set(sel, makeEl());
  return elCache.get(sel);
}
const jsonResponse = obj => ({ status: 200, ok: true, text: async () => JSON.stringify(obj) });

function makeSandbox(board) {
  const document = {
    querySelector: docQuery, querySelectorAll: () => [],
    createElement: () => makeEl(), addEventListener() {}, removeEventListener() {}, hidden: false,
  };
  async function fetchStub(url, opts = {}) {
    const method = opts.method || 'GET';
    const path = String(url).replace('https://api.ticktick.com/open/v1', '');
    fetchLog.push({ method, path });
    if (path.endsWith('/data')) return jsonResponse(board);
    const m = path.match(/\/task\/([^/]+)/);
    if (m) return jsonResponse(board.tasks.find(t => t.id === m[1]) || { id: m[1], title: 'stub', priority: 0 });
    return jsonResponse(null);
  }
  const sandbox = {
    document, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, fetch: fetchStub,
    navigator: {}, location: { hash: '', pathname: '/', search: '' }, history: { replaceState() {} },
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    confirm: () => true, alert() {}, console, Intl, JSON, Math, Date, Object, Array, String, Number, Boolean,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  return sandbox;
}

const board = { tasks: [TICK, APPROVE] };
const sandbox = vm.createContext(makeSandbox(board));
vm.runInContext(readFileSync(APP_JS, 'utf8'), sandbox, { filename: 'app.js' });

const { openCard } = sandbox;
assert.equal(typeof openCard, 'function', 'openCard() should be reachable from app.js');

await sandbox.refresh(true);   // populate app.cards from the stubbed board

let passed = 0;
const ok = m => { console.log('  ✓ ' + m); passed++; };

/* The stub's innerHTML setter does not clear _kids the way a real DOM does, so a
   button appended on one open would linger into the next. Clear it between opens
   to isolate each case — this is a limitation of the stub, not of the app. */
const resetBand = () => { docQuery('#dNeeds')._kids.length = 0; };
const bandButtons = () => docQuery('#dNeeds')._kids.filter(k => typeof k.onclick === 'function');

/* ── 1. a tick card hoists a completing control into the band ──────────────── */
console.log('openCard(): a tick card exposes the tick action beside the ask');
resetBand();
openCard('c-tick');
const btns = bandButtons();
assert.equal(btns.length, 1, `tick card: exactly one action button in #dNeeds, saw ${btns.length}`);
assert.match(btns[0].textContent, /tick/i, `the band button is worded to match "tick", got "${btns[0].textContent}"`);
ok(`tick card: one button in the band, labelled "${btns[0].textContent}"`);

console.log('openCard(): the band button actually completes the card');
fetchLog.length = 0;
await btns[0].onclick();
const completed = fetchLog.some(f => f.method === 'POST' && /\/task\/c-tick\/complete$/.test(f.path));
assert.ok(completed, `clicking the band button must POST the complete, saw ${JSON.stringify(fetchLog)}`);
ok('clicking the band button issues the complete POST');

console.log('openCard(): the bottom control is relabelled to match');
assert.equal(docQuery('#dComplete').textContent, 'TICK OFF CARD',
  `bottom button must read "TICK OFF CARD" on a tick card, got "${docQuery('#dComplete').textContent}"`);
ok('bottom COMPLETE CARD reads "TICK OFF CARD" on a tick card');

/* ── 2. a non-tick card gets no inline button (hoist is tick-specific) ──────── */
console.log('openCard(): an approve card gets NO inline button in the band');
resetBand();
openCard('c-approve');
assert.equal(bandButtons().length, 0, 'approve card: the band carries no inline action button');
assert.equal(docQuery('#dComplete').textContent, 'COMPLETE CARD',
  'bottom button keeps the generic label on a non-tick card');
ok('approve card: no inline button, bottom label stays "COMPLETE CARD"');

console.log(`\nALL ${passed} ASSERTIONS PASSED`);
