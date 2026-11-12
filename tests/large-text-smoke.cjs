const {app,BrowserWindow,session}=require('electron');
const assert=require('node:assert/strict');
const {mkdtempSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
app.setPath('userData',mkdtempSync(join(tmpdir(),'botlogik-large-text-')));
app.whenReady().then(async()=>{
 session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,cb)=>cb({cancel:true}));
 const win=new BrowserWindow({show:false,width:1440,height:950,webPreferences:{backgroundThrottling:false,preload:join(__dirname,'fixtures/workspace-preload.cjs')}});
 const run=code=>win.webContents.executeJavaScript(code);
 const wait=async code=>{for(let i=0;i<200;i++){if(await run(code))return;await new Promise(r=>setTimeout(r,50));}throw Error(code);};
 try{
  await win.loadFile(join(__dirname,'../out/renderer/index.html'));
  await wait(`!!document.querySelector('[data-agent-id="one"]')`);
  await run(`window.largeText='# Large Markdown\\n'+'Synthetic café documentation line.\\n'.repeat(70000)+'END OF FILE';workspaceTest.change('/workspace/one/notes.md',largeText);document.querySelector('[data-agent-id="one"]').click()`);
  await wait(`!!document.querySelector('[data-path="/workspace/one/notes.md"]')`);
  await run(`document.querySelector('[data-path="/workspace/one/notes.md"]').click()`);
  await wait(`window.monaco?.editor.getModels().some(m=>m.getValue().endsWith('END OF FILE'))`);
  assert.equal(await run(`monaco.editor.getModels().find(m=>m.getValue().endsWith('END OF FILE')).getValue()===largeText`),true);
  await run(`const m=monaco.editor.getModels().find(m=>m.getValue().endsWith('END OF FILE'));m.applyEdits([{range:new monaco.Range(m.getLineCount(),12,m.getLineCount(),12),text:' saved'}])`);
  await wait(`!document.getElementById('file-save-btn').disabled`);
  await run(`document.getElementById('file-save-btn').click()`);
  await wait(`workspaceTest.contents('/workspace/one/notes.md').endsWith('END OF FILE saved')`);
  console.log('Large Markdown smoke passed: full multi-megabyte Monaco model, editing and saving.');
 }catch(e){console.error(e);process.exitCode=1;}finally{win.destroy();app.exit(process.exitCode||0);}
});
