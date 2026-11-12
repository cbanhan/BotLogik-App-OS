const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
app.setPath('userData', mkdtempSync(join(tmpdir(), 'botlogik-clutter-smoke-')));
app.whenReady().then(async () => {
 session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']}, (_, cb) => cb({cancel:true}));
 const win = new BrowserWindow({width:1440,height:950,show:false,webPreferences:{backgroundThrottling:false,preload:join(__dirname,'fixtures/workspace-preload.cjs')}});
 const errors=[];win.webContents.on('console-message',(_,level,message)=>{if(level===3)errors.push(message);});
 const run=code=>win.webContents.executeJavaScript(code);
 const wait=async code=>{for(let i=0;i<100;i++){if(await run(code))return;await new Promise(r=>setTimeout(r,50));}throw Error(code);};
 const click=selector=>run(`document.querySelector(${JSON.stringify(selector)}).click()`);
 try {
  await win.loadFile(join(__dirname,'../out/renderer/index.html'));
  await wait(`!!document.querySelector('[data-agent-id="one"]')`);
  await click('[data-agent-id="one"]');await click('#launch-openrouter');
  await wait(`!document.querySelector('.or-model').disabled`);
  await click('.or-model');await wait(`!!document.querySelector('#or-model-results [role=option]')`);await click('#or-model-results [role=option]');
  await wait(`!document.querySelector('.or-send').disabled`);
  await run(`document.querySelector('#or-prompt').value='Synthetic request';document.querySelector('.or-compose').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);
  await wait(`!document.querySelector('.or-approval').hidden`);
  await click('#btn-settings');
  await wait(`document.getElementById('settings-tool-clutter-toggle').getAttribute('aria-checked')==='false'`);
  assert.match(await run(`document.getElementById('settings-tool-clutter-description').textContent`),/Claude Code and OpenRouter.*Codex is not supported yet/);
  await click('#settings-tool-clutter-toggle');
  await wait(`document.getElementById('settings-tool-clutter-toggle').getAttribute('aria-checked')==='true'`);
  await new Promise(r=>setTimeout(r,250));
  writeFileSync('/tmp/botlogik-tool-clutter-settings.png',(await win.webContents.capturePage()).toPNG());
  await click('#settings-modal-close');
  assert.equal(await run(`document.querySelector('.or-approval').hidden`),false);
  await run(`Array.from(document.querySelectorAll('.or-approval button')).find(b=>b.textContent==='Allow once').click()`);
  await wait(`!document.querySelector('.or-send').disabled`);
  await run(`workspaceTest.presentation('approval')`);
  await wait(`document.querySelector('.or-tool-summary').textContent.includes('Waiting for approval')`);
  assert.ok((await run(`document.querySelector('.or-approval').textContent`)).includes('echo approval-command'));
  for(const [mode,label] of [['running','Running commands…'],['reading','Reading files…'],['complete','Completed · 1 tool call'],['failed','Tool failed']]) {
   await run(`workspaceTest.presentation(${JSON.stringify(mode)})`);
   await wait(`document.querySelector('.or-tool-summary').textContent.includes(${JSON.stringify(label)})`);
   assert.ok(!(await run(`document.querySelector('.or-messages').textContent`)).includes('echo synthetic-command'));
   assert.ok((await run(`document.querySelector('.or-markdown').textContent`)).includes('npm test'));
  }
  assert.match(await run(`document.querySelector('.or-messages .or-tool summary').textContent`),/Tool failed/);
  await run(`workspaceTest.presentation('complete')`);
  await click('.or-tool-summary button');
  await wait(`!document.getElementById('tool-traces').hidden`);
  await click('#btn-settings');await click('#settings-tool-clutter-toggle');
  await wait(`document.getElementById('settings-tool-clutter-toggle').getAttribute('aria-checked')==='false'`);
  await click('#settings-modal-close');
  assert.ok((await run(`document.querySelector('.or-messages').textContent`)).includes('echo synthetic-command'));
  await click('#btn-settings');await click('#settings-tool-clutter-toggle');
  await wait(`document.getElementById('settings-tool-clutter-toggle').getAttribute('aria-checked')==='true'`);
  await new Promise(resolve=>{win.webContents.once('did-finish-load',resolve);win.reload();});await wait(`!!document.querySelector('[data-agent-id="one"]')`);await click('#btn-settings');
  await wait(`document.getElementById('settings-tool-clutter-toggle').getAttribute('aria-checked')==='true'`);
  assert.deepEqual(errors,[]);
  console.log('Tool clutter smoke passed: default, support note, immediate rendering, approvals, failures, Tools link, restoring details, reload.');
 } catch(error){console.error(error);process.exitCode=1;}
 finally{win.destroy();app.exit(process.exitCode||0);}
});
