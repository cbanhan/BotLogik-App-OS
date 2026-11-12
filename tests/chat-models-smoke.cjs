const {app,BrowserWindow,session} = require('electron');
const assert = require('node:assert/strict');
const {mkdtempSync,writeFileSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
app.setPath('userData',mkdtempSync(join(tmpdir(),'botlogik-models-smoke-')));
app.whenReady().then(async()=>{
 session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,cb)=>cb({cancel:true}));
 const win=new BrowserWindow({width:1440,height:950,show:false,webPreferences:{backgroundThrottling:false,preload:join(__dirname,'fixtures/workspace-preload.cjs')}});
 const errors=[];win.webContents.on('console-message',(_,level,message)=>{if(level===3)errors.push(message);});
 const run=code=>win.webContents.executeJavaScript(code);
 const wait=async code=>{for(let i=0;i<160;i++){if(await run(code))return;await new Promise(r=>setTimeout(r,50));}throw Error(code);};
 const click=s=>run(`document.querySelector(${JSON.stringify(s)}).click()`);
 const set=(s,v)=>run(`document.querySelector(${JSON.stringify(s)}).value=${JSON.stringify(v)};document.querySelector(${JSON.stringify(s)}).dispatchEvent(new Event('change',{bubbles:true}))`);
 const open=async()=>{await click('#chat-model-toggle');await wait(`document.querySelector('#chat-model-picker').open && !document.querySelector('.cm-provider').disabled`);};
 try {
  await win.loadFile(join(__dirname,'../out/renderer/index.html'));await wait(`!!document.querySelector('[data-agent-id="one"]')`);await click('[data-agent-id="one"]');
  await open();await set('.cm-model','opus');await set('.cm-effort','high');await click('.cm-save');await click('.cm-apply');await wait(`!document.querySelector('#chat-model-picker').open`);
  await click('[data-agent-id="two"]');await open();assert.equal(await run(`document.querySelector('.cm-model').value`),'');await click('#chat-model-picker header button');
  await click('[data-agent-id="one"]');await open();assert.equal(await run(`document.querySelector('.cm-model').value`),'opus');
  await set('.cm-provider','codex');await set('.cm-model','test-codex');await set('.cm-effort','medium');await click('.cm-save');await click('.cm-apply');await wait(`!document.querySelector('#chat-model-picker').open`);
  await run(`location.reload()`);await wait(`!!document.querySelector('[data-agent-id="one"]')`);await click('[data-agent-id="one"]');await open();assert.equal(await run(`document.querySelector('.cm-model').value`),'opus');assert.equal(await run(`document.querySelector('.cm-effort').value`),'high');
  writeFileSync('/tmp/botlogik-model-picker.png',(await win.webContents.capturePage()).toPNG());
  await click('#chat-model-picker header button');await click('#launch-claude');await wait(`workspaceTest.modelState().launches.length===1`);
  assert.equal((await run(`workspaceTest.modelState()`)).launches[0].selection.model,'opus');
  await click('#chat-model-toggle');await wait(`document.querySelector('.cm-apply').textContent==='Prepare model picker'`);
  assert.equal(await run(`document.querySelector('.cm-apply').disabled`),true);await click('.cm-ready input');await click('.cm-effort-picker');await wait(`!document.querySelector('#chat-model-picker').open`);
  assert.equal((await run(`workspaceTest.modelState()`)).prepared[0].control,'effort');
  await click('#terminal-end-session');await wait(`!document.querySelector('#launch-codex').disabled`);await click('#launch-codex');await wait(`workspaceTest.modelState().launches.length===2`);
  assert.equal((await run(`workspaceTest.modelState()`)).launches[1].selection.reasoningEffort,'medium');
  await click('#chat-model-toggle');await wait(`document.querySelector('.cm-apply').textContent==='Prepare switch'`);await set('.cm-effort','high');await click('.cm-ready input');
  await run(`workspaceTest.modelBusy(true)`);await click('.cm-apply');await wait(`document.querySelector('.cm-error').textContent.includes('Wait until')`);assert.equal((await run(`workspaceTest.modelState()`)).prepared.length,1);
  await run(`workspaceTest.modelBusy(false)`);await click('.cm-apply');await wait(`!document.querySelector('#chat-model-picker').open`);assert.equal((await run(`workspaceTest.modelState()`)).prepared[1].reasoningEffort,'high');
  assert.equal((await run(`workspaceTest.modelState()`)).defaults['/workspace/one'].codex.reasoningEffort,'medium');
  assert.deepEqual(errors,[]);console.log('Model picker smoke passed: project/provider isolation, reload, launch preferences, Claude pickers, Codex preparation, busy guard.');
 }catch(error){console.error(error);process.exitCode=1;}finally{win.destroy();app.exit(process.exitCode||0);}
});
