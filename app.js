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
   ========================================================================= */

'use strict';

const API      = 'https://api.ticktick.com/open/v1';
const QUEUE_ID = '6a5061b78f0822486929571e';
const TT_WEB   = 'https://ticktick.com/webapp/#p/' + QUEUE_ID + '/tasks/';

const LS = { token: 'bridge.token', poll: 'bridge.poll', red: 'bridge.redline', log: 'bridge.log' };

/* Workflow states live as an emoji prefix on the card title — TickTick's Open API
   cannot write tags or kanban columns, so the prefix is the only state channel
   there is (see ECOSYSTEM.md F4). Everything here reads and writes that prefix. */
const STATES = [
  { key: 'queued',  glyph: '⬜', label: 'INTAKE',  color: 'var(--intake)',  cap: 8 },
  { key: 'active',  glyph: '🔄', label: 'ACTIVE',  color: 'var(--active)',  cap: 1 },
  { key: 'review',  glyph: '👀', label: 'REVIEW',  color: 'var(--review)',  cap: 12 },
  { key: 'blocked', glyph: '⛔', label: 'BLOCKED', color: 'var(--blocked)', cap: 3 },
];
/* Not work — the system talking about itself. These belong in the log, not the
   manifest, or 16 daily digests bury the one card that needs a decision. */
const LOG_GLYPHS = { '☀': 'REPORT', '📋': 'TRIAGE', '✅': 'ALERT', '✔': 'DONE' };

const PRIORITIES = [ { v: 5, label: 'FIRST · 5' }, { v: 3, label: 'MID · 3' }, { v: 1, label: 'LAST · 1' }, { v: 0, label: 'NONE' } ];

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ───────────────────────────── state ───────────────────────────── */

const app = {
  token: localStorage.getItem(LS.token) || '',
  poll:  +localStorage.getItem(LS.poll) || 60,
  red:   +localStorage.getItem(LS.red)  || 12,
  tasks: [], cards: [], logs: [],
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

function firstGlyph(title) {
  const c = Array.from((title || '').trim())[0] || '';
  return c;
}

function classify(t) {
  const title = (t.title || '').trim();
  const g = firstGlyph(title);
  const st = STATES.find(s => s.glyph === g);
  const logKind = LOG_GLYPHS[g];
  const rest = st || logKind ? Array.from(title).slice(1).join('').trim() : title;
  const kindMatch = rest.match(/^\[([a-z]+)\]/i);
  const created = t.createdTime ? new Date(t.createdTime) : null;
  const modified = t.modifiedTime ? new Date(t.modifiedTime) : created;
  const content = t.content || '';
  return {
    raw: t, id: t.id, title, glyph: g,
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

function renderSys() {
  /* Everything here is derived from cards on the board, because the board is the
     only part of this system reachable from off-machine (ECOSYSTEM.md G4). The
     dispatcher's own state.json is a local file this app can never see — so
     "did a run happen" is inferred from the age of the newest report/triage
     card, which is exactly check (b) the watchdog uses. Labelled INFERRED for
     that reason: a health light that lies is worse than no light. */
  const el = $('#sysStrip');
  const runs = app.logs
    .filter(c => c.logKind === 'REPORT' || c.logKind === 'TRIAGE')
    .sort((a, b) => (b.created || 0) - (a.created || 0));
  const last = runs[0];
  const hrs = last ? ageMs(last.created) / HOUR : Infinity;
  const runOk = hrs > 30 ? 'bad' : hrs > 18 ? 'warn' : 'ok';

  const needAnswer = app.cards.filter(c => c.state === 'blocked' && !c.parked).length;

  const rows = [
    ['LAST RUN', last ? rel(last.created) : 'none on board', runOk],
    ['DISPATCH', hrs > 30 ? 'NO RUN 30h+' : hrs > 18 ? 'QUIET' : 'NOMINAL', runOk],
    ['NEEDS YOU', needAnswer ? needAnswer + ' blocked' : 'nothing blocked', needAnswer ? 'warn' : 'ok'],
    ['SYNCED', app.lastSync ? rel(app.lastSync) : '—', 'ok'],
  ];
  el.innerHTML = rows.map(([k, v, ok]) =>
    `<div class="sys-row" data-ok="${ok}"><span>${k}</span><b>${esc(v)}</b></div>`).join('');
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
  $('#dBody').innerHTML = renderBody(c.content);
  $('#dEdit').value = c.content || '';
  $('#dAppend').value = '';
  $('#dTickTick').href = TT_WEB + c.id;

  segButtons($('#dStateBtns'),
    STATES.map(s => ({ value: s.key, label: s.glyph + ' ' + s.label, color: s.color })),
    c.state, v => setState(c, v));

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

/* State lives in the title prefix, so a state change is a title rewrite. Strip
   whatever prefix is there, put the new one on — never blind-prepend, or a card
   ends up "👀 ⬜ [build] …". */
function retitle(title, glyph) {
  const chars = Array.from(title.trim());
  const known = STATES.map(s => s.glyph).concat(Object.keys(LOG_GLYPHS));
  let rest = title.trim();
  if (known.includes(chars[0])) rest = chars.slice(1).join('').trim();
  return glyph + ' ' + rest;
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

async function setState(c, key) {
  const s = STATES.find(x => x.key === key);
  if (!s || key === c.state) return;
  const fresh = await getTask(c.id).catch(() => c.raw);
  const title = retitle(fresh.title || c.title, s.glyph);
  await guarded(async () => {
    await writeField(c.id, { title });
    return `State → ${s.glyph} ${s.label}, confirmed on read-back.`;
  }, '#dStatus');
  if (app.open) openCard(c.id);
}

async function setPriority(c, v) {
  if (v === c.priority) return;
  await guarded(async () => {
    await writeField(c.id, { priority: v });
    return `Pick order → ${v || 'none'}, confirmed on read-back.`;
  }, '#dStatus');
  if (app.open) openCard(c.id);
}

/* Read-then-append. The card body is shared memory between Chris and every
   worker run; overwriting it loses the OUTCOME trail. */
async function appendNote(c) {
  const text = $('#dAppend').value.trim();
  if (!text) { status('#dStatus', 'Nothing to append.', 'err'); return; }
  await guarded(async () => {
    const fresh = await getTask(c.id);
    const block = `\n\n--- CHRIS ${localStamp()} (via Bridge) ---\n${text}`;
    const next = (fresh.content || '') + block;
    await writeField(c.id, { content: next });
    return 'Appended and verified — earlier content intact.';
  }, '#dStatus');
  if (app.open) openCard(c.id);
}

async function saveBody(c) {
  const next = $('#dEdit').value;
  if (next === (c.content || '')) { status('#dStatus', 'No change.', 'err'); return; }
  if (!confirm('Replace the entire card body? Anything removed here is gone from the card.')) return;
  await guarded(async () => {
    await writeField(c.id, { content: next });
    return 'Body replaced and verified.';
  }, '#dStatus');
  if (app.open) openCard(c.id);
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
  const glyph = STATES.find(s => s.key === app.newState).glyph;
  try {
    status('#nStatus', 'Creating…', 'busy');
    const made = await call('POST', '/task', {
      projectId: QUEUE_ID,
      title: retitle(title, glyph),
      content: $('#nBody').value,
      priority: app.newPri,
    });
    if (!made || !made.id) throw new Error('No card id came back — nothing was created.');
    await getTask(made.id);           // read back through a fresh GET
    toast('Card created.', 'ok');
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

  if (app.token) showConsole(); else $('#setup').hidden = false;

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
