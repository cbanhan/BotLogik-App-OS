const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
app.setPath('userData', mkdtempSync(join(tmpdir(), 'botlogik-errors-smoke-')));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']}, (_, cb) => cb({cancel:true}));
  const win = new BrowserWindow({ show:false, webPreferences:{preload:join(__dirname,'fixtures/workspace-preload.cjs')} });
  const run = code => win.webContents.executeJavaScript(code);
  const wait = async code => { for(let i=0;i<100;i++) { if(await run(code)) return; await new Promise(r=>setTimeout(r,50)); } throw Error(code); };
  try {
    await win.loadFile(join(__dirname,'../out/renderer/index.html'));
    await wait(`!!document.querySelector('[data-agent-id="one"]')`);
    await run(`document.querySelector('[data-agent-id="one"]').click(); workspaceTest.launchFailure('CLI_NOT_FOUND: synthetic /private/path sk-or-sensitive'); document.getElementById('launch-claude').click()`);
    await wait(`document.getElementById('provider-errors').textContent.includes('could not be found')`);
    assert.equal(await run(`document.getElementById('provider-errors').hidden`),false);
    assert.equal(await run(`localStorage.getItem('botlogik.providerErrors.v1').includes('/private/path')`),false);
    assert.equal(await run(`document.getElementById('provider-errors').textContent.includes('sk-or-sensitive')`),false);
    await run(`workspaceTest.launchFailure('');workspaceTest.earlyExit(true);document.getElementById('launch-codex').click()`);
    await wait(`document.getElementById('provider-errors').textContent.includes('could not keep running')`);
    assert.equal(await run(`document.getElementById('agent-launch-overlay').classList.contains('hidden')`),false);
    await run(`Array.from(document.querySelectorAll('#provider-errors button')).find(b=>b.textContent==='View current terminal output').click()`);
    assert.equal(await run(`document.getElementById('agent-launch-overlay').classList.contains('hidden')`),true);
    await win.reload();
    await wait(`!!document.querySelector('[data-agent-id="one"]')`);
    await run(`document.querySelector('[data-agent-id="one"]').click()`);
    await wait(`!document.getElementById('provider-errors').hidden`);
    assert.equal(await run(`JSON.parse(localStorage.getItem('botlogik.providerErrors.v1')).length`),2);
    await run(`document.getElementById('launch-openrouter').click()`);
    await wait(`!document.getElementById('openrouter-chat').hidden`);
    await run(`Array.from(document.querySelectorAll('#provider-errors button')).find(b=>b.textContent==='Clear workspace error history').click()`);
    assert.equal(await run(`document.getElementById('provider-errors').hidden`),true);
    console.log('Provider error smoke passed');
  } catch(e) { console.error(e); process.exitCode=1; }
  finally { win.destroy(); app.exit(process.exitCode || 0); }
});
