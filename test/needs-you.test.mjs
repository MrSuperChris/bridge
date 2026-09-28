/* ============================================================================
   Unit test for the "Needs you" list at the top of Bridge (design part C).

   Card 6ab723a68f08ffc311e2f735, part of the APPROVED design "One daily place to
   see what needs me". The list has two halves and this exercises both against the
   REAL app.js (loaded into a vm sandbox, no copy of the logic):

     1. HEALTH (item 1) — parseStatus() reads the watchdog's status card ("🩺
        System status", design part A): verdict + the "updated <local>" stamp that
        doubles as a dead-man's switch. Absent card ⇒ quiet "none", never an alarm.
        Fresh ⇒ ok/problem/needs. Stale (>15m) ⇒ offline.
     2. THE LIST (item 2) — renderNeedsYou() shows one row per open card whose
        LATEST NEEDS band asks for something (answer/approve/tick), in that order,
        and leaves out "nothing", band-less cards, parked cards, and — for free,
        because it builds from app.cards — anything in Hold or Done.

   Run:  node test/needs-you.test.mjs
   ========================================================================= */

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_JS = join(HERE, '..', 'app.js');

/* Real column ids off the live board (worker-playbook Columns section). */
const COL = {
  queued:  '6a8e3dc38f086ae6e266333d',
  working: '6a8e3dc58f086ae6e2663358',
  review:  '6a8e3dc68f0800ee150f8fe1',
  blocked: '6a8e3dc88f08b397ec1c1f09',
  done:    '6a8e3dca8f0800ee150f902a',
  hold:    '6aa609568f084b1907fe4872',
};
const STATUS_TITLE = '\u{1FA7A} System status';

/* A local "YYYY-MM-DD HH:MM" stamp N minutes ago — exactly watchdog.py fmt_local. */
function stampAgo(min) {
  const d = new Date(Date.now() - min * 60000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}`;
}
const statusCard = (verdict, min, extra = '') => ({
  id: 'status', title: STATUS_TITLE, priority: 1, columnId: null,
  createdTime: '2026-09-01T00:00:00.000+0000', modifiedTime: '2026-09-01T00:00:00.000+0000',
  content: `${verdict}\n${extra}Heartbeat: 40s. Last logged run: overnight-build.\nupdated ${stampAgo(min)}\n`,
});

/* Work cards, each in a real state column, with a NEEDS band (or not). */
const band = v => `\n--- NEEDS: ${v} ---`;
const WORK = [
  { id: 'w-approve', title: '👀 [build] Ship the thing', priority: 3, columnId: COL.review,
    createdTime: '2026-09-10T00:00:00.000+0000', modifiedTime: '2026-09-10T00:00:00.000+0000',
    content: 'body' + band('approve & merge branch claude/foo in automation (commit abc1234)') },
  /* Two bands: an old "nothing yet", then a real "answer". Proves last-wins AND
     that the card is included on the strength of its CURRENT ask. */
  { id: 'w-answer', title: '⛔ [build] Which repo?', priority: 3, columnId: COL.blocked,
    createdTime: '2026-09-09T00:00:00.000+0000', modifiedTime: '2026-09-09T00:00:00.000+0000',
    content: 'body' + band('nothing yet — this is queued work') + '\n⚙recheck' + band('answer — which repo is the Eco controller app?') },
  { id: 'w-tick', title: '👀 [build] Done, tick it', priority: 3, columnId: COL.review,
    createdTime: '2026-09-11T00:00:00.000+0000', modifiedTime: '2026-09-11T00:00:00.000+0000',
    content: 'body' + band('tick — finished; ticking it closes the card') },
  /* Excluded: verb nothing. */
  { id: 'w-nothing', title: '👀 [build] FYI only', priority: 3, columnId: COL.review,
    createdTime: '2026-09-12T00:00:00.000+0000', modifiedTime: '2026-09-12T00:00:00.000+0000',
    content: 'body' + band('nothing — FYI only, not even a tick') },
  /* Excluded: no band at all. */
  { id: 'w-noband', title: '⬜ [build] Queued, no ask', priority: 3, columnId: COL.queued,
    createdTime: '2026-09-13T00:00:00.000+0000', modifiedTime: '2026-09-13T00:00:00.000+0000',
    content: 'body with no needs band' },
  /* Excluded: parked, even though it carries an answer band. */
  { id: 'w-parked', title: '⛔ [build] Parked question', priority: 3, columnId: COL.blocked,
    createdTime: '2026-09-08T00:00:00.000+0000', modifiedTime: '2026-09-08T00:00:00.000+0000',
    content: '--- PARKED 2026-09-01 (Chris\'s call) ---' + band('answer — should not appear, it is parked') },
  /* Excluded: in Done — state null, not in app.cards, even with an approve band. */
  { id: 'w-done', title: '👀 [build] Filed to Done', priority: 3, columnId: COL.done,
    createdTime: '2026-09-07T00:00:00.000+0000', modifiedTime: '2026-09-07T00:00:00.000+0000',
    content: 'body' + band('approve & merge branch claude/bar in bridge (commit def5678)') },
  /* Excluded: in Hold — state null, not in app.cards. */
  { id: 'w-hold', title: '⬜ [build] Parked in Hold', priority: 3, columnId: COL.hold,
    createdTime: '2026-09-06T00:00:00.000+0000', modifiedTime: '2026-09-06T00:00:00.000+0000',
    content: 'body' + band('approve & merge branch claude/baz in bridge (commit 0123abc)') },
];

/* ── a permissive DOM/env stub (same shape as state-buttons.test.mjs) ──────── */
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

/* ── load app.js with a fresh-status board and render it once ──────────────── */
const board = { tasks: [statusCard('OK: last run overnight-build 00:31, exit 0.', 2), ...WORK] };
const sandbox = vm.createContext(makeSandbox(board));
vm.runInContext(readFileSync(APP_JS, 'utf8'), sandbox, { filename: 'app.js' });

const { parseStatus, renderNeedsYou } = sandbox;
assert.equal(typeof parseStatus, 'function', 'parseStatus() should be reachable from app.js');
assert.equal(typeof renderNeedsYou, 'function', 'renderNeedsYou() should be reachable from app.js');

let passed = 0;
const ok = m => { console.log('  ✓ ' + m); passed++; };

await sandbox.refresh(true);   // populates app.tasks/app.cards and runs render()

/* ── 1. the list: exactly the cards that want something, in verb order ─────── */
console.log('renderNeedsYou(): only answer/approve/tick cards, in that order');
const rows = docQuery('#nyList')._kids;
const verbs = rows.map(r => r.dataset.verb);
assert.deepEqual(verbs, ['answer', 'approve', 'tick'],
  `list verbs must be [answer, approve, tick], got [${verbs}]`);
ok(`three rows, ordered ${verbs.join(' → ')}`);

const titles = rows.map(r => r.innerHTML);
assert.ok(titles[0].includes('Which repo'), 'first row is the blocked answer card');
assert.ok(!titles.some(h => h.includes('FYI only')),  'the "nothing" card is excluded');
assert.ok(!titles.some(h => h.includes('no ask')),    'the band-less card is excluded');
assert.ok(!titles.some(h => h.includes('Parked question')), 'the parked card is excluded');
assert.ok(!titles.some(h => h.includes('Filed to Done')),   'the Done card is excluded');
assert.ok(!titles.some(h => h.includes('Parked in Hold')),  'the Hold card is excluded');
ok('nothing/band-less/parked/Done/Hold cards all excluded');

assert.equal(docQuery('#nyCount').textContent, '3 WAITING', 'count tag reads "3 WAITING"');
ok('count tag reads "3 WAITING"');

/* the "answer" card proves last-wins: its first band is "nothing yet" */
const nb = sandbox.needsBand(WORK[1].content);
assert.equal(nb.verb, 'answer', 'last band wins over the earlier "nothing yet"');
ok('needsBand: last band wins (nothing yet → answer)');

/* ── 2. health: fresh OK verdict ──────────────────────────────────────────── */
console.log('health line: fresh OK status card');
assert.equal(docQuery('#nyHealth').dataset.level, 'ok', 'fresh OK ⇒ level ok');
assert.ok(docQuery('#nyHealth').innerHTML.includes('overnight-build'), 'shows the verdict text');
ok('fresh OK ⇒ level=ok, verdict shown');

/* re-render health against a different board. `app` is a module-scope const, so it
   is not reachable from the sandbox; drive it the way the live app does instead —
   swap the board the fetch stub serves and refresh. */
async function healthLevel(tasks) {
  board.tasks = tasks;
  await sandbox.refresh(true);
  return docQuery('#nyHealth');
}

console.log('health line: absent status card is a quiet "none", never an alarm');
{
  const h = await healthLevel([...WORK]);   // no status card at all
  assert.equal(h.dataset.level, 'none', 'absent ⇒ level none');
  assert.ok(h.innerHTML.includes('not reported yet'), 'absent ⇒ honest placeholder');
  ok('absent status card ⇒ level=none, "not reported yet"');
}

console.log('health line: a stale "updated" stamp reads offline (dead-man\'s switch)');
{
  const h = await healthLevel([statusCard('OK: last run overnight-build 00:31, exit 0.', 30), ...WORK]);
  assert.equal(h.dataset.level, 'offline', '>15m stale ⇒ offline');
  assert.ok(/offline/i.test(h.innerHTML), 'says the machine is offline');
  ok('stale 30m ⇒ level=offline');
}

console.log('health line: a PROBLEM needing Chris reads "needs" and shows the fix');
{
  const h = await healthLevel([
    statusCard('PROBLEM since 2026-09-20 02:00: NEEDS CHRIS — Claude login expired.', 2,
               'Fix: run claude and log in\n'),
    ...WORK,
  ]);
  assert.equal(h.dataset.level, 'needs', 'PROBLEM + NEEDS CHRIS ⇒ level needs');
  assert.ok(h.innerHTML.includes('run claude and log in'), 'the fix is shown inline');
  ok('PROBLEM/NEEDS CHRIS ⇒ level=needs, fix shown inline');
}

console.log('parseStatus(): parses verdict, needs_chris and the local updated stamp');
{
  const s = parseStatus([statusCard('PROBLEM since 2026-09-20 02:00: NEEDS CHRIS — login expired.', 5, 'Fix: log in\n')]);
  assert.equal(s.level, 'problem');
  assert.equal(s.needsChris, true);
  assert.equal(s.fix, 'log in');
  assert.ok(s.updated instanceof Date && !isNaN(s.updated), 'updated parsed as a real Date');
  assert.ok(Math.abs(Date.now() - s.updated.getTime() - 5 * 60000) < 90000, 'updated ≈ 5m ago');
  ok('verdict/needs_chris/fix/updated all parsed');
}

console.log(`\nALL ${passed} ASSERTIONS PASSED`);
