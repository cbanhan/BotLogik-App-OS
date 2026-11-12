const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
app.setPath('userData', mkdtempSync(join(tmpdir(), 'botlogik-traces-smoke-')));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']}, (_, cb) => cb({cancel:true}));
  const win = new BrowserWindow({width:1440,height:950,show:false,webPreferences:{backgroundThrottling:false,preload:join(__dirname,'fixtures/workspace-preload.cjs')}});
  const errors=[]; win.webContents.on('console-message',(_,level,message)=>{if(level===3)errors.push(message);});
  const run = code => win.webContents.executeJavaScript(code);
  const wait = async code => {for(let i=0;i<100;i++){if(await run(code))return;await new Promise(r=>setTimeout(r,50));}throw Error(code);};
  const click = id => run(`document.getElementById(${JSON.stringify(id)}).click()`);
  const tools = [
    {id:'read',name:'Read',turn:1,status:'succeeded',observedAt:1000,startedAt:1000,finishedAt:1200,input:'{"path":"src/main.js"}',output:'Example source content'},
    {id:'test',name:'Bash',turn:1,status:'failed',observedAt:2000,startedAt:2000,finishedAt:3500,input:'{"command":"npm test"}',output:'One synthetic test failed'},
    {id:'pending',name:'Search',turn:2,status:'unknown',observedAt:4000,startedAt:4000,input:'{"pattern":"startup"}',output:''}
  ];
  try {
    await win.loadFile(join(__dirname,'../out/renderer/index.html'));
    await wait(`!!document.querySelector('[data-agent-id="one"]')`);
    await run(`document.querySelector('[data-agent-id="one"]').click()`);
    await click('launch-claude');
    await run(`workspaceTest.traces('one',${JSON.stringify([{id:'conversation',conversationId:'conversation',provider:'claude',startedAt:Date.now(),availability:'Receiving tool activity',tools}])})`);
    await click('tool-traces-toggle');
    await wait(`document.querySelectorAll('#tool-traces details').length===3`);
    await run(`document.querySelector('#tool-traces details[data-status="failed"]').open=true`);
    const bounds = await run(`({surface:document.getElementById('conversation-surface').getBoundingClientRect().toJSON(),panel:document.getElementById('tool-traces').getBoundingClientRect().toJSON()})`);
    assert.ok(bounds.surface.height>0); assert.ok(bounds.panel.top>=bounds.surface.bottom-1);
    await new Promise(resolve => setTimeout(resolve, 350));
    writeFileSync('/tmp/botlogik-tool-traces.png',(await win.webContents.capturePage()).toPNG());
    await run(`const f=document.querySelector('#tool-traces [data-field="filter"]');f.value='failed';f.dispatchEvent(new Event('change'))`);
    assert.equal(await run(`document.querySelectorAll('#tool-traces details').length`),1);
    await run(`document.querySelector('[data-agent-id="two"]').click()`);
    await wait(`document.querySelectorAll('#tool-traces details').length===0`);
    await run(`document.querySelector('[data-agent-id="one"]').click()`);
    await wait(`document.querySelectorAll('#tool-traces details').length===1`);
    await run(`document.querySelector('#tool-traces [data-action="clear"]').click()`);
    await wait(`document.querySelectorAll('#tool-traces details').length===0`);
    await click('terminal-end-session');
    await click('launch-terminal');
    await wait(`document.querySelector('#tool-traces .trace-status').textContent.includes('Regular shells')`);
    assert.deepEqual(errors,[]);
    console.log('Tool traces smoke passed: drawer layout, details, filter, workspace isolation, clearing, regular-shell state.');
  } catch(error) { console.error(error); process.exitCode=1; }
  finally {win.destroy();app.exit(process.exitCode||0);}
});
