import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/main/main.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('// Capture the owning session'), source.indexOf('// Staged references belong'));
function fixture() {
  const owner = {id:1}, writes = [];
  const session = {managed:true, owner, process:{write:text=>writes.push(text)}};
  const sessions = new Map([['1:a',session]]);
  const state = {result:{canceled:false,filePaths:['/Users/example/My "project"/notes.txt']}, directory:false};
  let handler;
  vm.runInNewContext(code, {
    ipcMain:{handle:(_name,fn)=>{handler=fn;}},
    terminalSessions:sessions, terminalKey:(id,agent)=>`${id}:${agent}`,
    BrowserWindow:{fromWebContents:()=>({})},
    dialog:{showOpenDialog:async (_window, options)=>{state.options=options; state.onPick?.(); return state.result;}},
    stat:async ()=>({isFile:()=>!state.directory,isDirectory:()=>state.directory})
  });
  return {state,session,sessions,writes,run:()=>handler({sender:owner},'a')};
}
test('picker accepts a file or folder and pastes a quoted path without submitting', async () => {
  for (const directory of [false,true]) {
    const f = fixture(); f.state.directory=directory;
    const result = await f.run();
    assert.deepEqual(Array.from(f.state.options.properties),['openFile','openDirectory']);
    assert.equal(result.text, ' '+JSON.stringify(f.state.result.filePaths[0])+' ');
    assert.equal(f.writes[0], '\x1b[200~'+result.text+'\x1b[201~');
    assert.doesNotMatch(f.writes[0],/[\r\n]/);
  }
});
test('cancellation, invalid names, scheduled sessions and replaced sessions never paste', async () => {
  const canceled = fixture(); canceled.state.result.canceled=true;
  assert.equal((await canceled.run()).canceled,true);
  assert.equal(canceled.writes.length,0);
  const invalid=fixture(); invalid.state.result.filePaths=['/tmp/bad\nname'];
  await assert.rejects(invalid.run(),/control characters/);
  assert.equal(invalid.writes.length,0);
  const scheduled=fixture(); scheduled.session.runId='run';
  await assert.rejects(scheduled.run(),/manual/);
  assert.equal(scheduled.writes.length,0);
  const replaced=fixture(); replaced.state.onPick=()=>replaced.sessions.delete('1:a');
  await assert.rejects(replaced.run(),/session changed/);
  assert.equal(replaced.writes.length,0);
});
