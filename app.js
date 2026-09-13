/* ============================================================================
   BRIDGE — live console for the Claude Queue board.

   Talks straight to the TickTick Open API from the browser. That works because
   the API answers `Access-Control-Allow-Origin: *` and its preflight allows the
   `authorization` header on GET and POST alike (verified, not assumed) — so this
   needs no server, no proxy, and runs identically on desktop, Android and iPad.

   WRITE DISCIPLINE — copied deliberately from automation/ticktick_api.py, which
   encodes hazards that already cost something once:
     · POST a PARTIAL task ({id, projectId, ...changed}). TickTick merges fields,
       but REPLACES list fields wholesale — so `tags` is never sent from here.
       Sending a whole task object back would be the naive move that eats tags.
     · Content is read-then-appended. Never POST bare new content over a card, or
       prior "⚙claude:" / OUTCOME lines are gone.
     · A 200 proves nothing. Every write GETs the task back and confirms the value
       actually stored, and reports a real failure when it did not.
     · State is the kanban COLUMN. While the board stays dual-encoded, the column
       and the legacy emoji prefix travel in ONE POST — two writes could half-
       apply and recreate exactly the desync this replaced.
   ========================================================================= */

'use strict';

const API      = 'https://api.ticktick.com/open/v1';
const QUEUE_ID = '6a5061b78f0822486929571e';
const TT_WEB   = 'https://ticktick.com/webapp/#p/' + QUEUE_ID + '/tasks/';

const LS = { token: 'bridge.token', poll: 'bridge.poll', red: 'bridge.redline', log: 'bridge.log' };

/* Workflow state is the kanban COLUMN a card sits in.

   ECOSYSTEM.md constraint F4 says the Open API "can't write tags or kanban
   columns". For columns that is FALSE in both directions — probed 2026-08-25
   against api.ticktick.com/open/v1, the same surface this app uses:
     · a partial POST CAN set columnId, and TickTick resolves columnName from it
     · a partial POST CAN move a card between columns
     · a title-only POST leaves an existing columnId untouched
   That last one is why the old design was worse than it looked. Writing only the
   title prefix never ejected a card from its column — it left the column STALE,
   so the two encodings drifted apart silently with nothing on screen to say so.
   (F4 may still hold for tags. Nothing here sends tags either way.)

   `col` is an id, never a name: renaming a column in the TickTick UI must not
   silently re-bucket the board. Ids confirmed against the project's own column
   listing, not copied from a doc. */
const COLUMNS = {
  queued:  '6a8e3dc38f086ae6e266333d',   // "Queued"
  active:  '6a8e3dc58f086ae6e2663358',   // "Working"
  review:  '6a8e3dc68f0800ee150f8fe1',   // "Needs Review"
  blocked: '6a8e3dc88f08b397ec1c1f09',   // "Blocked"
  done:    '6a8e3dca8f0800ee150f902a',   // "Done"
};
/* TickTick's own default bucket. A card here is UNFILED — it has a column but
   that column carries no state. NOT the same as a card with no columnId at all
   (run output, never filed); see classify() for why the difference matters. */
const UNFILED_COL = '6a665dfdad29ee62acac4bac';   // "Not Sectioned"

const STATES = [
  { key: 'queued',  glyph: '⬜', label: 'INTAKE',  color: 'var(--intake)',  cap: 8,  col: COLUMNS.queued  },
  { key: 'active',  glyph: '🔄', label: 'ACTIVE',  color: 'var(--active)',  cap: 1,  col: COLUMNS.active  },
  { key: 'review',  glyph: '👀', label: 'REVIEW',  color: 'var(--review)',  cap: 12, col: COLUMNS.review  },
  { key: 'blocked', glyph: '⛔', label: 'BLOCKED', color: 'var(--blocked)', cap: 3,  col: COLUMNS.blocked },
];
/* Reverse lookup, derived from STATES so the two cannot drift apart. */
const COL_STATE = Object.fromEntries(STATES.map(s => [s.col, s.key]));

/* The board is DUAL-ENCODED on purpose: state lives in the column (the real
   channel) and, redundantly, in the emoji title prefix (the old one). The
   dispatcher, triage and expire_reports still read the prefix, so bridge keeps
   writing both — one POST, both fields, land-or-fail together.

   Do not flip this to false until nothing else reads the prefix. The read side
   needs no change when that day comes: classify() already ignores the prefix
   whenever a column is present. */
const DUAL_ENCODE = true;

/* Not work — the system talking about itself. These belong in the log, not the
   manifest, or 16 daily digests bury the one card that needs a decision.
   🚨 was missing here and is in no STATE either, so the five "Sleeper Service is
   DOWN" cards matched nothing and were filtered out of BOTH lanes: the one alarm
   that says the automation stopped was the one thing the console could not show. */
const LOG_GLYPHS = { '☀': 'REPORT', '📋': 'TRIAGE', '✅': 'ALERT', '✔': 'DONE', '🚨': 'ALARM' };

const PRIORITIES = [ { v: 5, label: 'FIRST · 5' }, { v: 3, label: 'MID · 3' }, { v: 1, label: 'LAST · 1' }, { v: 0, label: 'NONE' } ];

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ───────────────────────────── state ───────────────────────────── */

const app = {
  token: localStorage.getItem(LS.token) || '',
  poll:  +localStorage.getItem(LS.poll) || 60,
  red:   +localStorage.getItem(LS.red)  || 12,
  tasks: [], cards: [], logs: [], telemetry: null,
  filter: 'all', open: null,
  timer: null, lastSync: null, inflight: false,
};

/* ───────────────────────────── api ───────────────────────────── */

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      'Authorization': 'Bearer ' + app.token,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401) throw new Error('401 — token rejected. Re-enter it in settings.');
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 160));
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const getBoard = ()    => call('GET', `/project/${QUEUE_ID}/data`);
const getTask  = (id)  => call('GET', `/project/${QUEUE_ID}/task/${id}`);

/* Partial POST — merges. Never include list fields (tags/items) here. */
const patch = (id, fields) => call('POST', `/task/${id}`, { id, projectId: QUEUE_ID, ...fields });

/* A 200 is not evidence. Read the value back and prove it stored. */
async function verify(id, checks) {
  const after = await getTask(id);
  const bad = Object.entries(checks)
    .filter(([f, want]) => after[f] !== want)
    .map(([f, want]) => `${f}: wanted ${JSON.stringify(want)}, stored ${JSON.stringify(after[f])}`);
  if (bad.length) throw new Error('Write did not stick (silent-drop):\n' + bad.join('\n'));
  return after;
}

async function writeField(id, fields) {
  await patch(id, fields);
  return verify(id, fields);
}

/* ───────────────────────────── parsing ───────────────────────────── */

/* These prefixes are written inconsistently: ☀️ and ✔️ carry a trailing U+FE0F
   variation selector, 👀 ⛔ 📋 🚨 do not. Slicing one code point off the front
   therefore leaves a stray U+FE0F behind on 30 of the live cards, and .trim()
   does not remove it — U+FE0F is a nonspacing mark, not whitespace. So it rode
   into every title the console printed and into every title it rewrote. */
const VS16 = '\uFE0F';   // spelled as an escape; the literal character is invisible

function firstGlyph(title) {
  const c = Array.from((title || '').trim())[0] || '';
  return c;
}

/* -> { glyph, rest }: the leading code point, and everything after it with any
   variation selector and surrounding whitespace stripped. */
function splitGlyph(title) {
  const t = (title || '').trim();
  let rest = Array.from(t).slice(1).join('');
  if (rest.startsWith(VS16)) rest = rest.slice(VS16.length);
  return { glyph: firstGlyph(t), rest: rest.trim() };
}

function classify(t) {
  const title = (t.title || '').trim();
  const { glyph: g, rest: afterGlyph } = splitGlyph(title);
  const glyphState = STATES.find(s => s.glyph === g) || null;
  const glyphLog = LOG_GLYPHS[g] || null;

  /* COLUMN FIRST — the column is the state. The prefix is the legacy mirror and
     only gets a vote when there is no column to ask. Three distinct cases:
       · a state column        -> that state, whatever the prefix claims
       · the Done column       -> finished work; belongs in the log, not the
                                  manifest, or the board never appears to drain
       · UNFILED_COL, or no columnId at all -> fall back to the prefix
     Unfiled and absent are NOT interchangeable. "Not Sectioned" is a real column
     a card can be dragged into; absent means never filed, which is every one of
     the run-output cards the workers post. The trap is treating "has a columnId"
     as "is filed" — that maps a Not-Sectioned card to no state AND skips the
     prefix fallback, and a real work card silently vanishes off the console. */
  const col = t.columnId || '';
  const stateKey = COL_STATE[col] || null;
  const inDone = col === COLUMNS.done;
  const columnSpoke = Boolean(stateKey) || inDone;

  const st = stateKey ? STATES.find(s => s.key === stateKey)
           : columnSpoke ? null
           : glyphState;
  /* A Done card is finished work rather than a run report, but it shares the log
     lane, so it carries a logKind instead of a state. */
  const logKind = inDone ? (glyphLog || 'DONE')
                : st ? null
                : columnSpoke ? null
                : glyphLog;

  /* Strip the prefix only when the leading code point is a glyph we recognise —
     that is what makes it a prefix rather than the first letter of the title. */
  const rest = (glyphState || glyphLog) ? afterGlyph : title;
  const kindMatch = rest.match(/^\[([a-z]+)\]/i);
  const created = t.createdTime ? new Date(t.createdTime) : null;
  const modified = t.modifiedTime ? new Date(t.modifiedTime) : created;
  const content = t.content || '';
  return {
    raw: t, id: t.id, title,
    /* Show the glyph for the lane the card is actually rendered in. While the
       board stays dual-encoded these are the same character anyway; if a column
       and a prefix ever disagree, the row still reads consistently. */
    glyph: st ? st.glyph : g,
    state: st ? st.key : null,
    stateDef: st || null,
    logKind: logKind || null,
    clean: kindMatch ? rest.slice(kindMatch[0].length).trim() : rest,
    kind: kindMatch ? kindMatch[1].toLowerCase() : null,
    priority: t.priority || 0,
    created, modified, content,
    /* The playbook parks cards on purpose and says explicitly not to keep
       surfacing them. A parked card is blocked by choice — it gets no beacon. */
    parked: /---\s*PARKED/i.test(content),
  };
}

/* Local time with the zone spelled out. Everything else that writes to these
   cards stamps local ("CLAIMED 2026-08-18 ~21:05 CDT"), so a UTC stamp from here
   would silently misorder the trail a later run reads back. */
function localStamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  let zone = '';
  try {
    zone = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
      .formatToParts(d).find(x => x.type === 'timeZoneName').value;
  } catch { /* fall back to no zone label rather than failing the write */ }
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}${zone ? ' ' + zone : ''}`;
}

const HOUR = 3600e3;
function ageMs(d) { return d ? Date.now() - d.getTime() : 0; }
function rel(d) {
  if (!d) return '—';
  const m = ageMs(d) / 60000;
  if (m < 1) return 'just now';
  if (m < 60) return Math.round(m) + 'm ago';
  const h = m / 60;
  if (h < 48) return Math.round(h) + 'h ago';
  return Math.round(h / 24) + 'd ago';
}

/* ───────────────────────────── render ───────────────────────────── */

function render() {
  app.cards = app.tasks.map(classify).filter(c => c.state);
  app.logs  = app.tasks.map(classify).filter(c => c.logKind);
  /* The heartbeat card wears a glyph in neither STATES nor LOG_GLYPHS, so the two
     filters above drop it on their own — it can never reach the manifest, the
     counts, or the ship's log. It is read here and nowhere else. */
  app.telemetry = parseTelemetry(app.tasks);
  renderCore();
  renderGauges();
  renderSys();
  renderFilters();
  renderList();
  renderLog();
}

function renderCore() {
  const panel = $('#corePanel');
  const active = app.cards.filter(c => c.state === 'active')
    .sort((a, b) => ageMs(b.modified) - ageMs(a.modified));
  const c = active[0];

  if (!c) {
    panel.dataset.core = 'idle';
    $('#coreState').textContent = 'BANKED';
    $('#coreTitle').textContent = 'Nothing claimed';
    $('#coreMeta').innerHTML = 'No run holds a card right now.';
    $('#coreOpen').hidden = true;
    return;
  }

  /* Held-for is the load-bearing number: a 🔄 card that nobody released is the
     system's classic silent failure — it looks busy and is actually stuck. */
  const hrs = ageMs(c.modified) / HOUR;
  const level = hrs > 12 ? 'stuck' : hrs > 6 ? 'warm' : 'run';
  panel.dataset.core = level;
  /* Slower pulse = staler claim. The console visibly loses urgency as it hangs. */
  panel.style.setProperty('--pulse', Math.min(9, 2.2 + hrs * 0.35).toFixed(2) + 's');

  $('#coreState').textContent = level === 'stuck' ? 'HELD LONG' : level === 'warm' ? 'RUNNING LONG' : 'RUNNING';
  $('#coreTitle').textContent = c.clean;
  $('#coreMeta').innerHTML =
    `${c.kind ? c.kind.toUpperCase() + ' · ' : ''}held <b>${hrs < 1 ? Math.round(hrs * 60) + 'm' : Math.round(hrs) + 'h'}</b>` +
    (active.length > 1 ? ` · <b>${active.length}</b> cards claimed at once` : '') +
    (level === 'stuck' ? '<br>Past 12h — check whether that run actually finished.' : '');
  const btn = $('#coreOpen');
  btn.hidden = false;
  btn.onclick = () => openCard(c.id);
}

function renderGauges() {
  const el = $('#gauges');
  el.innerHTML = '';
  const counts = {};
  STATES.forEach(s => counts[s.key] = app.cards.filter(c => c.state === s.key).length);
  $('#totalTag').textContent = app.cards.length + ' OPEN';

  STATES.forEach(s => {
    const n = counts[s.key];
    const cap = s.key === 'review' ? app.red : s.cap;
    const over = n > cap;
    const d = document.createElement('div');
    d.className = 'gauge' + (over ? ' redline' : '');
    d.style.setProperty('--c', s.color);
    d.style.setProperty('--fill', Math.min(100, cap ? (n / cap) * 100 : 0) + '%');
    d.innerHTML =
      `<div class="gauge-top"><span>${s.label}</span><span class="gauge-n">${n}</span></div>` +
      `<div class="gauge-track"><div class="gauge-fill"></div></div>` +
      `<div class="gauge-note">${over ? 'OVER' : 'OF'} ${cap}${over ? ' — BACK-PRESSURE' : ''}</div>`;
    d.onclick = () => { app.filter = app.filter === s.key ? 'all' : s.key; renderFilters(); renderList(); };
    el.appendChild(d);
  });
}

/* ─────────────────────────── telemetry (the G4 half-close) ───────────────────────────

   Sleeper Service cannot be reached from here — no port, no tunnel, G4 stands. But it
   can SPEAK, outbound, into the one place both ends already share: a card on this
   board (SleeperService/heartbeat.py, ~once a minute). So the system panel stops
   guessing "a run must have happened, there's a report card" and reads the machine's
   own words instead.

   Freshness comes from the payload's `written` field, NOT the task's modifiedTime:
   VERIFIED 2026-09-01 that TickTick's Open API does NOT bump modifiedTime on a
   content-only update — the content changes and modifiedTime stays frozen at
   creation. Trusting modifiedTime here would peg the age at "hours" forever and
   report a healthy dispatcher as dead. (A pleasant side effect: the card does not
   churn in TickTick's own UI, and TRIAGE's modified-since checks ignore it.)

   Silence must read as silence. No card, unparseable card, or a stale one all fall
   back to the old inferred rows with the panel honestly labelled — never to a
   cheerful default. That is the failure the System Console had. */

const TELEMETRY_GLYPH = '\u{1F4E1}';
const TELEM_OK_MS = 3 * 60e3;    // written within 3 min: the writer is alive
const TELEM_WARN_MS = 15 * 60e3; // the watchdog relaunches within ~5, so 15 is real trouble

function parseTelemetry(tasks) {
  const t = (tasks || []).find(x => (x.title || '').trim().startsWith(TELEMETRY_GLYPH));
  if (!t) return null;
  const m = (t.content || '').match(/```json\s*([\s\S]*?)```/);
  if (!m) return null;
  let p;
  try { p = JSON.parse(m[1]); } catch { return null; }
  if (!p || typeof p.written_epoch !== 'number') return null;
  return { id: t.id, payload: p, age: Date.now() - p.written_epoch * 1000 };
}

/* Next time an armed rule's window opens. Days are the rule's own short names, and
   the window's left half is the start — same shape presence.py gates on. */
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
function nextFire(rule, from = new Date()) {
  const start = (rule.window || '').split('-')[0];
  const hm = /^(\d{1,2}):(\d{2})$/.exec(start || '');
  if (!hm || !(rule.days || []).length) return null;
  for (let i = 0; i < 8; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    d.setHours(+hm[1], +hm[2], 0, 0);
    if (d > from && rule.days.includes(DAYS[d.getDay()])) return d;
  }
  return null;
}

function renderSys() {
  const el = $('#sysStrip');
  const tag = $('#sysTag');
  const needAnswer = app.cards.filter(c => c.state === 'blocked' && !c.parked).length;
  const needRow = ['NEEDS YOU', needAnswer ? needAnswer + ' blocked' : 'nothing blocked',
                   needAnswer ? 'warn' : 'ok'];
  const syncRow = ['SYNCED', app.lastSync ? rel(app.lastSync) : '—', 'ok'];

  const t = app.telemetry;
  if (t && t.age < TELEM_WARN_MS) {
    const p = t.payload;
    const live = t.age < TELEM_OK_MS;
    tag.textContent = live ? 'LIVE' : 'LATE';
    tag.title = live
      ? 'Read from the dispatcher’s own heartbeat card, written on the machine'
      : 'The dispatcher’s heartbeat is late — it may have stopped';

    const armed = (p.routines || []).filter(r => r.enabled);
    const next = armed.map(r => ({ r, at: nextFire(r) })).filter(x => x.at)
      .sort((a, b) => a.at - b.at)[0];
    /* Real last-fired from the machine, not "a report card exists, so probably". */
    const fired = (p.routines || []).map(r => r.last_fired && new Date(r.last_fired))
      .filter(d => d && !isNaN(d)).sort((a, b) => b - a)[0];

    const idleMin = Math.round((p.idle_seconds || 0) / 60);
    const where = p.present
      ? 'at the machine' + (p.presence_source === 'manual' ? ' (manual)' : '')
      : 'away ' + idleMin + 'm' + (p.presence_source === 'manual' ? ' (manual)' : '');

    el.innerHTML = [
      ['DISPATCHER', live ? 'UP · heard ' + relMs(t.age) : 'LATE · ' + relMs(t.age),
       live ? 'ok' : 'warn'],
      ['CHRIS', where + ' — as this PC sees it', 'ok'],
      ['LAST RUN', fired ? rel(fired) : 'never', fired && ageMs(fired) > 30 * HOUR ? 'warn' : 'ok'],
      ['NEXT RUN', next ? next.r.name + ' ' + whenShort(next.at) : 'nothing armed',
       next ? 'ok' : 'warn'],
      needRow, syncRow,
    ].map(([k, v, ok]) =>
      `<div class="sys-row" data-ok="${ok}"><span>${k}</span><b>${esc(v)}</b></div>`).join('');
    return;
  }

  /* No usable telemetry. Fall back to the original board-derived inference, and say
     so — including WHY, when a heartbeat card exists but has gone quiet. */
  const runs = app.logs
    .filter(c => c.logKind === 'REPORT' || c.logKind === 'TRIAGE')
    .sort((a, b) => (b.created || 0) - (a.created || 0));
  const last = runs[0];
  const hrs = last ? ageMs(last.created) / HOUR : Infinity;
  const runOk = hrs > 30 ? 'bad' : hrs > 18 ? 'warn' : 'ok';

  tag.textContent = t ? 'NO SIGNAL' : 'INFERRED';
  tag.title = t
    ? 'The dispatcher stopped writing its heartbeat — these rows are guesses from the board'
    : 'Derived from cards on the board, not from the machine';

  const rows = [];
  if (t) rows.push(['DISPATCHER', 'SILENT ' + relMs(t.age), 'bad']);
  rows.push(
    ['LAST RUN', last ? rel(last.created) : 'none on board', runOk],
    ['DISPATCH', hrs > 30 ? 'NO RUN 30h+' : hrs > 18 ? 'QUIET' : 'NOMINAL', runOk],
    needRow, syncRow);
  el.innerHTML = rows.map(([k, v, ok]) =>
    `<div class="sys-row" data-ok="${ok}"><span>${k}</span><b>${esc(v)}</b></div>`).join('');
}

/* Ages here are seconds-to-minutes, where rel()'s "just now" hides exactly the
   detail that matters — whether the last write was 40s or 4 minutes ago. */
function relMs(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return s + 's ago';
  const m = Math.round(s / 60);
  return m < 60 ? m + 'm ago' : Math.round(m / 60) + 'h ago';
}

function whenShort(d) {
  const p = n => String(n).padStart(2, '0');
  const days = Math.floor((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 864e5);
  const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : DAYS[d.getDay()];
  return `${when} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderFilters() {
  const el = $('#filters');
  const mk = (key, label, color) => {
    const b = document.createElement('button');
    b.className = 'filter';
    b.textContent = label;
    b.setAttribute('aria-pressed', app.filter === key);
    if (color) b.style.setProperty('--c', color);
    b.onclick = () => { app.filter = key; renderFilters(); renderList(); };
    return b;
  };
  el.innerHTML = '';
  el.appendChild(mk('all', 'ALL ' + app.cards.length));
  STATES.forEach(s => {
    const n = app.cards.filter(c => c.state === s.key).length;
    if (n) el.appendChild(mk(s.key, `${s.glyph} ${s.label} ${n}`, s.color));
  });
  $('#filterTag').textContent = app.filter === 'all' ? 'ALL'
    : (STATES.find(s => s.key === app.filter) || {}).label || 'ALL';
}

/* Pick order first (priority 5 goes first — it is order, not urgency), then
   oldest first inside a band, because the oldest is what is actually rotting. */
function sortCards(a, b) {
  if (b.priority !== a.priority) return b.priority - a.priority;
  return (a.created || 0) - (b.created || 0);
}

function rowFor(c) {
  const b = document.createElement('button');
  b.className = 'row';
  const def = c.stateDef;
  b.style.setProperty('--c', def ? def.color : 'var(--log)');
  /* Edge thickness carries pick order: the card a run takes next is the fattest. */
  b.style.setProperty('--edge', c.priority >= 5 ? '4px' : c.priority >= 3 ? '2px' : '1px');

  if (c.state === 'blocked' && !c.parked) {
    b.classList.add('beacon');
    const days = ageMs(c.modified) / (24 * HOUR);
    /* More insistent the longer it has sat unanswered. */
    b.style.setProperty('--beat', Math.max(1.4, 6 - days * 0.5).toFixed(1) + 's');
  }

  const bits = [];
  if (c.kind) bits.push(`<span class="kind">${esc(c.kind.toUpperCase())}</span>`);
  bits.push(esc(rel(c.created)));
  if (c.parked) bits.push('PARKED');
  /* The verb alone, so a lane can be triaged without opening anything. "nothing"
     is styled quiet rather than loud: the whole value is that those cards stop
     competing for attention with the ones that actually want something. */
  const need = needsBand(c.content);
  if (need && need.verb) {
    bits.push(`<span class="needs-chip" data-verb="${need.verb}">${esc(need.verb)}</span>`);
  }
  const pri = PRIORITIES.find(p => p.v === c.priority);

  b.innerHTML =
    `<span class="row-glyph">${c.glyph}</span>` +
    `<span class="row-main"><span class="row-title">${esc(c.clean || c.title)}</span>` +
    `<span class="row-sub">${bits.join('<span></span>')}</span></span>` +
    `<span class="row-pri">${c.priority ? 'P' + c.priority : '—'}</span>`;
  b.title = pri ? pri.label : '';
  b.onclick = () => openCard(c.id);
  return b;
}

function renderList() {
  const el = $('#cardList');
  el.innerHTML = '';
  let cards = app.cards.slice();
  if (app.filter !== 'all') cards = cards.filter(c => c.state === app.filter);

  if (!cards.length) { el.innerHTML = '<p class="empty">NOTHING IN THIS LANE</p>'; return; }

  if (app.filter === 'all') {
    STATES.forEach(s => {
      const grp = cards.filter(c => c.state === s.key).sort(sortCards);
      grp.forEach(c => el.appendChild(rowFor(c)));
    });
  } else {
    cards.sort(sortCards).forEach(c => el.appendChild(rowFor(c)));
  }
}

function renderLog() {
  const el = $('#logList');
  $('#logCount').textContent = app.logs.length;
  el.innerHTML = '';
  app.logs
    .sort((a, b) => (b.created || 0) - (a.created || 0))
    .slice(0, 40)
    .forEach(c => {
      const r = rowFor(c);
      r.querySelector('.row-pri').textContent = c.logKind;
      el.appendChild(r);
    });
}

/* ───────────────────────────── detail ───────────────────────────── */

/* Quotes MUST be escaped, not just angle brackets. renderBody() interpolates
   matched URLs into href="…", so an unescaped " in card text closes the
   attribute and injects a live event handler — verified exploitable before this
   was added. Escaping quotes leaves them as &quot; inside the attribute, which
   decodes harmlessly and cannot break out. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* Card bodies follow the worker's own conventions — "--- OUTCOME ---" bands,
   Repo:/Source: lines, absolute Windows paths, URLs. Rendering those as
   structure is the difference between a wall of text and something readable on
   a phone at 6am. */
/* The last `--- NEEDS: <verb> — <ask> ---` band in a card body, or null.
   LAST one wins, matching the worker rule and TRIAGE 7b's positional convention:
   runs append a fresh band rather than editing the old one, so the newest is the
   current ask and everything above it is history. Returns the verb separately
   because the list row shows only that — the whole point is that a card needing
   nothing can be recognised without opening it. */
function needsBand(text) {
  const all = [...(text || '').matchAll(/^---\s*NEEDS:\s*(.+?)\s*---\s*$/gm)];
  if (!all.length) return null;
  const ask = all[all.length - 1][1].trim();
  const verb = (ask.match(/^(approve|answer|nothing)\b/i) || [])[1];
  return { ask, verb: verb ? verb.toLowerCase() : null };
}

function renderBody(text) {
  let h = esc(text || '(no body)');
  h = h.replace(/^---\s*(.+?)\s*---\s*$/gm, (_, t) => `<span class="sec">${t}</span>`);
  h = h.replace(/(https?:\/\/[^\s<)]+)/g, u => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  h = h.replace(/([A-Z]:\\[^\s<]+|(?:^|\s)[\w.-]+\/[\w./-]+\.(?:md|py|ts|tsx|js|json|html))/g,
    m => `<span class="path">${m}</span>`);
  return h;
}

function segButtons(host, opts, current, onPick) {
  host.innerHTML = '';
  opts.forEach(o => {
    const b = document.createElement('button');
    b.textContent = o.label;
    b.setAttribute('aria-pressed', o.value === current);
    if (o.color) b.style.setProperty('--c', o.color);
    b.onclick = () => onPick(o.value);
    host.appendChild(b);
  });
}

function openCard(id) {
  const c = app.cards.concat(app.logs).find(x => x.id === id);
  if (!c) return;
  app.open = c;

  const def = c.stateDef;
  const sheet = $('#detail');
  sheet.hidden = false;
  status('#dStatus', null);

  const dState = $('#dState');
  dState.textContent = def ? def.glyph + ' ' + def.label : (c.logKind || 'CARD');
  dState.style.setProperty('--c', def ? def.color : 'var(--log)');
  const dPri = $('#dPri');
  dPri.textContent = c.priority ? 'PICK ' + c.priority : 'NO PRIORITY';
  dPri.style.setProperty('--c', def ? def.color : 'var(--log)');
  $('#dAge').textContent = 'created ' + rel(c.created) + ' · changed ' + rel(c.modified);
  $('#dTitle').textContent = c.clean || c.title;
  /* Hoist the ask to the top. It stays in the body too — the body is the source
     of truth several consumers read, and stripping it there would break them. */
  const needs = needsBand(c.content);
  const dNeeds = $('#dNeeds');
  dNeeds.hidden = !needs;
  if (needs) {
    dNeeds.dataset.verb = needs.verb || 'other';
    dNeeds.innerHTML = `<span class="needs-verb">${esc(needs.verb || 'needs')}</span>` +
                       `<span class="needs-ask">${esc(needs.ask)}</span>`;
  }
  $('#dBody').innerHTML = renderBody(c.content);
  $('#dEdit').value = c.content || '';
  $('#dAppend').value = '';
  $('#dTickTick').href = TT_WEB + c.id;

  /* State controls belong only to work cards. A run-output card (☀️/📋/✅/✔️,
     classified with state === null) has no workflow state, and offering it the
     buttons is exactly how a report gets promoted into the work manifest — the
     detail view opens cards and logs alike, so the guard has to live here. Hide
     the buttons and show a note for anything with no state. */
  const isWork = Boolean(c.state);
  const stateBtns = $('#dStateBtns');
  stateBtns.hidden = !isWork;
  $('#dStateNote').hidden = isWork;
  if (isWork) {
    segButtons(stateBtns,
      STATES.map(s => ({ value: s.key, label: s.glyph + ' ' + s.label, color: s.color })),
      c.state, v => setState(c, v));
  } else {
    stateBtns.innerHTML = '';
  }

  segButtons($('#dPriBtns'),
    PRIORITIES.map(p => ({ value: p.v, label: p.label, color: def ? def.color : null })),
    c.priority, v => setPriority(c, v));

  $('#dAppendBtn').onclick = () => appendNote(c);
  $('#dEditBtn').onclick   = () => saveBody(c);
  $('#dComplete').onclick  = () => completeCard(c);
}

function closeDetail() { $('#detail').hidden = true; app.open = null; }

function status(sel, msg, kind) {
  const el = $(sel);
  if (!msg) { el.hidden = true; return; }
  el.hidden = false; el.textContent = msg; el.dataset.kind = kind || 'busy';
}

function toast(msg, kind) {
  const t = $('#toast');
  t.hidden = false; t.textContent = msg; t.dataset.kind = kind || '';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3400);
}

/* ───────────────────────────── writes ───────────────────────────── */

/* The legacy prefix half of the dual encoding. Strip whatever prefix is there,
   put the new one on — never blind-prepend, or a card ends up "👀 ⬜ [build] …".
   splitGlyph eats the variation selector too; without that, restating ☀️ as ⬜
   produced "⬜ ️ Workday report" with an orphaned U+FE0F wedged in the middle. */
function retitle(title, glyph) {
  const { glyph: g, rest } = splitGlyph(title);
  const known = STATES.some(s => s.glyph === g) || Object.hasOwn(LOG_GLYPHS, g);
  return glyph + ' ' + (known ? rest : (title || '').trim());
}

async function guarded(fn, statusSel) {
  try {
    status(statusSel, 'Writing…', 'busy');
    const msg = await fn();
    status(statusSel, msg, 'ok');
    toast(msg, 'ok');
    await refresh(true);
    return true;
  } catch (e) {
    status(statusSel, e.message, 'err');
    toast('Write failed', 'err');
    return false;
  }
}

/* Column and prefix go out in ONE partial POST, so they land together or fail
   together and cannot end up disagreeing. Two sequential writes could half-apply
   and leave exactly the desync this replaces.

   writeField() then re-reads and strict-compares every field it sent, which
   quietly turns each state tap into a live probe of the columnId write path: if
   TickTick ever starts dropping columnId the way it drops tags, this raises a
   red "Write did not stick" on screen instead of silently rotting the board. */
async function setState(c, key) {
  const s = STATES.find(x => x.key === key);
  /* Refuse outright for a card with no workflow state (run output). The old
     guard only caught `key === c.state`; a log card's state is null, so that
     comparison was never true and the write went ahead, stamping a work glyph
     onto a report. Post-columns that got worse, not better: the same write now
     also files the report into a work COLUMN, where anything reading columns
     treats it as real work. The buttons are hidden for these cards — this is the
     matching refusal, so setState cannot be reached by any other path either. */
  if (!s || !c.state || key === c.state) return;
  const fields = { columnId: s.col };
  if (DUAL_ENCODE) {
    /* Re-read first: the title being restated may have changed under us. */
    const fresh = await getTask(c.id).catch(() => c.raw);
    fields.title = retitle(fresh.title || c.title, s.glyph);
  }
  const ok = await guarded(async () => {
    await writeField(c.id, fields);
    return `State → ${s.glyph} ${s.label}, ` +
           `${DUAL_ENCODE ? 'column and prefix both' : 'column'} confirmed on read-back.`;
  }, '#dStatus');
  /* Only re-open on success. openCard() clears #dStatus, so re-opening after a
     failure wiped the one message saying WHICH field did not stick, leaving a
     3-second "Write failed" toast as the entire report. That guts the probe
     above: a silently dropped columnId would read as a shrug. Verified by
     forcing a drop client-side — the sheet now holds and keeps
     "columnId: wanted X, stored Y".
     setPriority/appendNote/saveBody guard the same way, for the same reason. */
  if (ok && app.open) openCard(c.id);
}

async function setPriority(c, v) {
  if (v === c.priority) return;
  const ok = await guarded(async () => {
    await writeField(c.id, { priority: v });
    return `Pick order → ${v || 'none'}, confirmed on read-back.`;
  }, '#dStatus');
  /* Success only — see setState: openCard() would wipe the failure message. */
  if (ok && app.open) openCard(c.id);
}

/* Read-then-append. The card body is shared memory between Chris and every
   worker run; overwriting it loses the OUTCOME trail. */
async function appendNote(c) {
  const text = $('#dAppend').value.trim();
  if (!text) { status('#dStatus', 'Nothing to append.', 'err'); return; }
  const ok = await guarded(async () => {
    const fresh = await getTask(c.id);
    const block = `\n\n--- CHRIS ${localStamp()} (via Bridge) ---\n${text}`;
    const next = (fresh.content || '') + block;
    await writeField(c.id, { content: next });
    return 'Appended and verified — earlier content intact.';
  }, '#dStatus');
  /* Success only — see setState: openCard() would wipe the failure message. */
  if (ok && app.open) openCard(c.id);
}

async function saveBody(c) {
  const next = $('#dEdit').value;
  if (next === (c.content || '')) { status('#dStatus', 'No change.', 'err'); return; }
  if (!confirm('Replace the entire card body? Anything removed here is gone from the card.')) return;
  const ok = await guarded(async () => {
    await writeField(c.id, { content: next });
    return 'Body replaced and verified.';
  }, '#dStatus');
  /* Success only — see setState: openCard() would wipe the failure message. */
  if (ok && app.open) openCard(c.id);
}

async function completeCard(c) {
  if (!confirm(`Complete "${c.clean || c.title}"?\n\nIt disappears from the API and its content is not retrievable afterwards.`)) return;
  try {
    status('#dStatus', 'Completing…', 'busy');
    await call('POST', `/project/${QUEUE_ID}/task/${c.id}/complete`);
    /* Verify by absence: a completed card drops out of the open-task list. */
    const board = await getBoard();
    const still = (board.tasks || []).some(t => t.id === c.id);
    if (still) throw new Error('Card still shows as open after completing — nothing was changed.');
    app.tasks = board.tasks || [];
    app.lastSync = new Date();
    render();
    closeDetail();
    toast('Card completed.', 'ok');
  } catch (e) {
    status('#dStatus', e.message, 'err');
    toast('Complete failed', 'err');
  }
}

async function createCard() {
  const title = $('#nTitle').value.trim();
  if (!title) { status('#nStatus', 'A card needs a title.', 'err'); return; }
  const s = STATES.find(x => x.key === app.newState);
  /* Everything that carries state, in one object, so the same values are asked
     for and checked. A new card unfiled into no column would land nowhere on the
     kanban and, once DUAL_ENCODE goes false, nowhere in this console either. */
  const want = {
    columnId: s.col,
    title: DUAL_ENCODE ? retitle(title, s.glyph) : title,
    priority: app.newPri,
  };
  try {
    status('#nStatus', 'Creating…', 'busy');
    const made = await call('POST', '/task', {
      projectId: QUEUE_ID,
      content: $('#nBody').value,
      ...want,
    });
    if (!made || !made.id) throw new Error('No card id came back — nothing was created.');
    /* This used to GET the card and throw the response away, which proved only
       that an id resolved — not that the card landed where it was sent. */
    await verify(made.id, want);
    toast(`Card created in ${s.label}, confirmed on read-back.`, 'ok');
    status('#nStatus', null);
    $('#newCard').hidden = true;
    $('#nTitle').value = ''; $('#nBody').value = '';
    await refresh(true);
  } catch (e) {
    status('#nStatus', e.message, 'err');
  }
}

/* ───────────────────────────── polling ───────────────────────────── */

function setLink(kind, label) {
  const el = $('#linkState');
  el.dataset.link = kind;
  $('#linkLabel').textContent = label;
}

/* The sweep bar runs the length of one poll interval, so the next refresh is
   visible arriving rather than surprising you mid-read. */
function armSweep() {
  const bar = $('#sweepBar');
  bar.style.transition = 'none';
  bar.style.width = '0%';
  void bar.offsetWidth;
  bar.style.transition = `width ${app.poll}s linear`;
  bar.style.width = '100%';
}

async function refresh(quiet) {
  if (app.inflight) return;
  app.inflight = true;
  if (!quiet) setLink('sync', 'SYNC');
  try {
    const board = await getBoard();
    app.tasks = board.tasks || [];
    app.lastSync = new Date();
    render();
    setLink('ok', 'LIVE');
  } catch (e) {
    setLink('down', 'DOWN');
    toast(e.message.slice(0, 90), 'err');
  } finally {
    app.inflight = false;
    armSweep();
  }
}

function startPolling() {
  clearInterval(app.timer);
  app.timer = setInterval(() => refresh(true), app.poll * 1000);
  armSweep();
}

/* ───────────────────────────── boot ───────────────────────────── */

function showConsole() {
  $('#setup').hidden = true;
  $('#console').hidden = false;
  refresh();
  startPolling();
}

function initSettings() {
  segButtons($('#sPoll'),
    [15, 30, 60, 300].map(v => ({ value: v, label: v < 60 ? v + 's' : (v / 60) + 'm' })),
    app.poll, v => { app.poll = v; localStorage.setItem(LS.poll, v); startPolling(); initSettings(); });
  segButtons($('#sRed'),
    [6, 9, 12, 20].map(v => ({ value: v, label: String(v) })),
    app.red, v => { app.red = v; localStorage.setItem(LS.red, v); render(); initSettings(); });
  $('#sTokenState').textContent = app.token
    ? 'Token stored on this device (' + app.token.length + ' chars, never displayed).'
    : 'No token stored.';
}

/* One-scan setup: qr-setup.py renders a QR of <site>#t=<token>, you scan it with the
   device camera, and the app configures itself. Typing 35 characters on a tablet
   keyboard is miserable enough that people give up, which is its own security problem.

   The token rides in the URL *fragment*, which browsers never transmit — GitHub Pages
   never sees it. It is consumed and stripped from the address bar immediately via
   replaceState so it does not sit on screen or survive a share-sheet. */
function takeTokenFromUrl() {
  const m = (location.hash || '').match(/[#&]t=([^&]+)/);
  if (!m) return null;
  const tok = decodeURIComponent(m[1]).trim();
  history.replaceState(null, '', location.pathname + location.search);
  return tok || null;
}

function init() {
  app.newState = 'queued';
  app.newPri = 3;

  $('#setupSave').onclick = async () => {
    const v = $('#tokenInput').value.trim();
    if (!v) return;
    app.token = v;
    $('#setupErr').hidden = true;
    try {
      await getBoard();                       // prove it works before storing it
      localStorage.setItem(LS.token, v);
      showConsole();
    } catch (e) {
      app.token = '';
      $('#setupErr').hidden = false;
      $('#setupErr').textContent = e.message;
    }
  };
  $('#tokenInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('#setupSave').click(); });
  $('#tokenReveal').onclick = () => {
    const i = $('#tokenInput');
    const show = i.type === 'password';
    i.type = show ? 'text' : 'password';
    $('#tokenReveal').textContent = show ? 'HIDE' : 'SHOW';
  };

  $('#btnRefresh').onclick  = () => refresh();
  $('#btnSettings').onclick = () => { initSettings(); $('#settings').hidden = false; };
  $('#btnNew').onclick = () => {
    status('#nStatus', null);
    segButtons($('#nStateBtns'), STATES.map(s => ({ value: s.key, label: s.glyph + ' ' + s.label, color: s.color })),
      app.newState, v => { app.newState = v; $('#btnNew').onclick(); });
    segButtons($('#nPriBtns'), PRIORITIES.map(p => ({ value: p.v, label: p.label })),
      app.newPri, v => { app.newPri = v; $('#btnNew').onclick(); });
    $('#newCard').hidden = false;
  };
  $('#nCreate').onclick = createCard;

  $$('[data-close]').forEach(el => el.onclick = closeDetail);
  $$('[data-close-new]').forEach(el => el.onclick = () => $('#newCard').hidden = true);
  $$('[data-close-set]').forEach(el => el.onclick = () => $('#settings').hidden = true);
  $('#sForget').onclick = () => {
    if (!confirm('Forget the token on this device? The board is untouched.')) return;
    localStorage.removeItem(LS.token);
    location.reload();
  };
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    closeDetail(); $('#newCard').hidden = true; $('#settings').hidden = true;
  });

  $('#logToggle').onclick = () => {
    const l = $('#logList');
    l.hidden = !l.hidden;
    $('#logToggle').innerHTML = `SHIP&rsquo;S LOG <span id="logCount">${app.logs.length}</span> ` + (l.hidden ? '▾' : '▴');
  };

  /* Coming back to the tab after it slept should not show a stale board. */
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true); });

  const fromUrl = takeTokenFromUrl();
  if (fromUrl) {
    app.token = fromUrl;
    $('#setup').hidden = false;
    $('#setupErr').hidden = true;
    getBoard()
      .then(() => { localStorage.setItem(LS.token, fromUrl); showConsole(); })
      .catch(e => {
        app.token = localStorage.getItem(LS.token) || '';
        $('#setupErr').hidden = false;
        $('#setupErr').textContent = 'Scanned token rejected: ' + e.message;
        if (app.token) showConsole();
      });
    return;
  }

  if (app.token) showConsole(); else $('#setup').hidden = false;

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
