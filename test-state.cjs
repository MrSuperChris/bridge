// Offline integration checks of the real state/create functions. No network or DOM.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(__dirname + '/app.js', 'utf8');
const take = (from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
const code = take('const API', '/* ───────────────────────────── state')
  + take('const VS16', 'function localStamp')
  + take('async function setState', 'async function setPriority')
  + take('async function createCard', 'function setLink');
const sandbox = { assert };
// The source defines $ itself; a minimal DOM boundary lets creation use it unchanged.
vm.runInNewContext(code + `
const elements = { '#nTitle': {value:'A title without a prefix'}, '#nBody': {value:'body'}, '#newCard': {} };
const document = {querySelector: key => elements[key]};
const app = {open:null,newState:'queued',newPri:3};
const writes=[];
const writeField = async (id, fields) => writes.push(fields);
const guarded = async fn => {await fn(); return true;};
const status=()=>{}; const toast=()=>{}; const refresh=async()=>{};
const call=async (method,path,body)=>{writes.push(body);return {id:'new'};};
const verify=async()=>{};
(async()=>{
  for (const state of STATES) {
    const before=writes.length;
    await setState({id:'x',state:state.key==='queued'?'review':'queued',title:'👀 Existing title'},state.key);
    assert.equal(writes.length,before+1);
    assert.deepEqual(Object.keys(writes.at(-1)), ['columnId']);
    assert.equal(writes.at(-1).columnId,state.col);
  }
  const before=writes.length;
  await setState({id:'report',state:null},'review');
  await setState({id:'same',state:'review'},'review');
  assert.equal(writes.length,before);
  await createCard();
  assert.equal(writes.at(-1).title,'A title without a prefix');
  assert.equal(writes.at(-1).columnId,COLUMNS.queued);
  return 'PASS: four state transitions preserve titles; no-op/report guards; new-card title preserved';
})()
`, sandbox).then(console.log).catch(e => {console.error(e);process.exitCode=1;});
