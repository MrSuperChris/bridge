/* ============================================================================
   Unit test for the remote-work pause control (index.html #pauseCtl, app.js
   renderPause/sendPause/pauseMarkerLine).

   The card's Verify asks for a Bridge test rather than a tap on the live board —
   a real tap would write a real pause marker to the telemetry card and actually
   suppress Chris's builds. So this loads the REAL app.js into a vm sandbox (no
   copy of the logic) and checks, against captured telemetry-card JSON:

     1. pauseMarkerLine() emits exactly the one-line contract heartbeat.py parses:
        `@@REMOTE-PAUSE@@ {json}`, json on ONE line, action set(hours,note)/clear,
        a fresh nonce each call. (The Python side — SleeperService/tests.py — tests
        the PARSE end of the same contract; this tests the WRITE end.)
     2. renderPause() reflects the dispatcher's own reported pause: amber ON with a
        RESUME button when the payload says paused, quiet "off" with PAUSE buttons
        when it does not.
     3. sendPause() writes the marker to the TELEMETRY card via a read-then-append
        /task/ POST, and reports success without strict-verifying the content back
        (heartbeat may already have consumed the marker — that is the design).
     4. sendPause() with no telemetry card on the board refuses, with no write.

   Note: the localStorage stub returns NO token, exactly as state-buttons.test.mjs
   does, so boot does not call showConsole()→refresh() and leave app.inflight set —
   which would make the awaited refresh below a silent no-op.

   Run:  node test/pause.test.mjs
   ========================================================================= */

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_JS = join(HERE, '..', 'app.js');
const TELE_GLYPH = '\u{1F4E1}';              // 📡 — must match app.js TELEMETRY_GLYPH
const TELE_ID = 'telemetry-card';

/* The exact matcher heartbeat.parse_pause_marker uses, mirrored here so a drift in
   the written format fails THIS test, not just a 3am dispatcher tick. */
const PY_RE = /@@REMOTE-PAUSE@@\s*(\{[^\n]*\})/;

function teleCard(pause) {
  const payload = {
    schema: 1, written_epoch: Math.floor(Date.now() / 1000),
    present: false, routines: [], pause,
  };
  return {
    id: TELE_ID,
    title: TELE_GLYPH + ' Sleeper Service telemetry — machine-written, do not edit',
    priority: 0, columnId: null,
    createdTime: '2026-09-02T00:42:59.279+0000',
    modifiedTime: '2026-09-02T00:42:59.279+0000',
    content: 'Written automatically …\n\n```json\n' + JSON.stringify(payload, null, 1) + '\n```\n',
  };
}

/* ── a permissive DOM/env stub (same shape as state-buttons.test.mjs) ──────── */
let fetchLog = [];

function makeEl() {
  return {
    _kids: [],
    style: { setProperty() {}, removeProperty() {} },
    dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, removeAttribute() {}, addEventListener() {}, removeEventListener() {},
    appendChild(c) { this._kids.push(c); return c; },
    removeChild() {}, remove() {},
    querySelector() { return makeEl(); }, querySelectorAll() { return []; },
    focus() {}, click() {},
    hidden: false, textContent: '', innerHTML: '', value: '', href: '', title: '',
    type: 'text', onclick: null,
  };
}

function jsonResponse(obj) {
  const body = JSON.stringify(obj);
  return { status: 200, ok: true, text: async () => body };
}

function load(board) {
  const elCache = new Map();
  const docQuery = (sel) => { if (!elCache.has(sel)) elCache.set(sel, makeEl()); return elCache.get(sel); };
  const document = {
    querySelector: docQuery, querySelectorAll: () => [],
    createElement: () => makeEl(), addEventListener() {}, removeEventListener() {}, hidden: false,
  };
  async function fetchStub(url, opts = {}) {
    const method = opts.method || 'GET';
    const path = String(url).replace('https://api.ticktick.com/open/v1', '');
    fetchLog.push({ method, path, body: opts.body ? JSON.parse(opts.body) : null });
    if (path.endsWith('/data')) return jsonResponse(board);
    const m = path.match(/\/task\/([^/]+)/);
    if (m) {
      const found = (board.tasks || []).find(t => t.id === m[1]) || { id: m[1], title: 'stub', priority: 0, content: '' };
      return jsonResponse(found);
    }
    return jsonResponse(null);
  }
  const sandbox = {
    document, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: fetchStub, navigator: {}, location: { hash: '', pathname: '/', search: '' },
    history: { replaceState() {} },
    setInterval: () => 0, clearInterval() {}, setTimeout: (f) => 0, clearTimeout() {},
    confirm: () => true, alert() {},
    console, Intl, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(readFileSync(APP_JS, 'utf8'), ctx, { filename: 'app.js' });
  return { sandbox, docQuery };
}

let passed = 0;
const ok = (msg) => { console.log('  ✓ ' + msg); passed++; };

/* ── 1. the write-side contract ────────────────────────────────────────────── */
console.log('pauseMarkerLine(): emits the one-line contract heartbeat.py parses');
{
  const { sandbox } = load({ tasks: [teleCard(null)] });
  const { pauseMarkerLine } = sandbox;
  assert.equal(typeof pauseMarkerLine, 'function', 'pauseMarkerLine must be reachable');

  const setLine = pauseMarkerLine('set', 2);
  assert.ok(!setLine.includes('\n'), 'the marker must be a single line');
  const m = setLine.match(PY_RE);
  assert.ok(m, 'the marker must match the Python parser regex');
  const setObj = JSON.parse(m[1]);
  assert.equal(setObj.action, 'set');
  assert.equal(setObj.hours, 2);
  assert.equal(setObj.note, 'via Bridge');
  assert.ok(typeof setObj.nonce === 'string' && setObj.nonce.length > 0, 'set carries a nonce');
  ok('set → ' + setLine);

  const clrObj = JSON.parse(pauseMarkerLine('clear').match(PY_RE)[1]);
  assert.equal(clrObj.action, 'clear');
  assert.ok(typeof clrObj.nonce === 'string' && clrObj.nonce.length > 0, 'clear carries a nonce');
  assert.equal(clrObj.hours, undefined, 'clear carries no hours');
  ok('clear → action=clear, nonce, no hours');

  assert.notEqual(JSON.parse(pauseMarkerLine('set', 1).match(PY_RE)[1]).nonce,
                  JSON.parse(pauseMarkerLine('set', 1).match(PY_RE)[1]).nonce,
                  'each tap gets a fresh nonce');
  ok('two set calls produce different nonces');
}

/* ── 2. renderPause reflects the dispatcher's reported pause ───────────────── */
console.log('renderPause(): ON when the payload says paused');
{
  const { sandbox, docQuery } = load({ tasks: [teleCard({ until_epoch: 1, until: 'x', note: 'ipad', seconds_left: 3000 })] });
  await sandbox.refresh(true);
  const state = docQuery('#pauseState'), btns = docQuery('#pauseBtns');
  assert.equal(state.dataset.on, 'yes', 'pause tag must be marked ON');
  assert.ok(/ON/.test(state.textContent), 'state text names it ON, got: ' + state.textContent);
  assert.ok(btns._kids.some(b => /RESUME/.test(b.textContent)), 'a RESUME button must be offered');
  ok('paused payload → ON + RESUME (' + state.textContent + ')');
}
console.log('renderPause(): off when the payload says not paused');
{
  const { sandbox, docQuery } = load({ tasks: [teleCard(null)] });
  await sandbox.refresh(true);
  const state = docQuery('#pauseState'), btns = docQuery('#pauseBtns');
  assert.equal(state.dataset.on, 'no', 'pause tag must be marked off');
  assert.equal(state.textContent, 'off');
  assert.ok(btns._kids.some(b => /PAUSE 1h/.test(b.textContent)), 'the PAUSE buttons must be offered');
  ok('no pause → off + PAUSE buttons');
}

/* ── 3. sendPause writes the marker to the telemetry card ──────────────────── */
console.log('sendPause(): appends the marker to the telemetry card, reports success');
{
  const { sandbox } = load({ tasks: [teleCard(null)] });
  await sandbox.refresh(true);
  fetchLog = [];
  await sandbox.sendPause('set', 1);
  const writes = fetchLog.filter(f => f.method === 'POST' && f.path === '/task/' + TELE_ID && f.body);
  assert.ok(writes.length >= 1, 'a POST to the telemetry card must be issued, saw ' + writes.length);
  const wrote = writes[writes.length - 1].body.content || '';
  assert.ok(wrote.includes('@@REMOTE-PAUSE@@'), 'the written content must carry the marker');
  assert.ok(wrote.includes('```json'), 'read-then-append: the prior content must be preserved');
  ok('set → one marker POST to the telemetry card, prior content intact');
}

/* ── 4. sendPause refuses when there is no telemetry card ──────────────────── */
console.log('sendPause(): no telemetry card → no write');
{
  const { sandbox } = load({ tasks: [] });
  await sandbox.refresh(true);
  fetchLog = [];
  await sandbox.sendPause('set', 1);
  const writes = fetchLog.filter(f => /\/task\//.test(f.path) && f.method === 'POST');
  assert.equal(writes.length, 0, 'no card → no /task/ POST, saw ' + writes.length);
  ok('no telemetry card → refused, 0 writes');
}

console.log(`\nALL ${passed} ASSERTIONS PASSED`);
