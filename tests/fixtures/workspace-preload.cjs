const { contextBridge, webFrame } = require('electron');
let schedules = [];
const traceSessions = new Map();
let traceChanged;
let globalIgnoredNames = [];
let claudeCatalogError = '';
let claudeCatalog = [{id:'',label:'Claude default',efforts:['low','medium','high']},{id:'sonnet',label:'Sonnet current',efforts:['low','medium','high']},{id:'opus',label:'Opus current',efforts:['low','medium','high']}];
const openrouterMock = (() => {
const chats = new Map();
const modelPreferences = new Map();
let listener, counter = 0;
const pending = new Map();
const copy = value => JSON.parse(JSON.stringify(value));
const emit = chat => listener?.(copy(chat));
return {
 presentation: mode => {
  const c=[...chats.values()].at(-1); if(!c)return;
  const name=mode==='reading'?'read_file':'run_command';
  c.messages=[{role:'user',content:'Synthetic request'},{role:'assistant',content:'You can also run `npm test` yourself.',tool_calls:[{id:'compact-call',function:{name,arguments:JSON.stringify(name==='read_file'?{path:'hello.js'}:{command:'echo synthetic-command'})}}]}];
  c.busy=['running','reading','approval'].includes(mode); c.activeTool=c.busy?name:null;c.pending=mode==='approval'?{id:'synthetic-approval',name:'run_command',command:'echo approval-command',warning:'Synthetic approval'}:null;
  if(!c.busy)c.messages.push({role:'tool',tool_call_id:'compact-call',content:JSON.stringify({exitCode:mode==='failed'?1:0,output:mode==='failed'?'Synthetic failure':'synthetic-output'})});
  emit(c);
 },
 fail: () => { for (const chat of chats.values()) { chat.error = 'Insufficient OpenRouter credits.'; emit(chat); } },
 mentionFiles: async r => ({ files: [...contents.keys()].filter(p => p.startsWith(r.path + '/')).map(p => p.slice(r.path.length + 1)).filter(p => p.toLowerCase().includes((r.query || '').toLowerCase())).sort(), limited: false }),
 modelPreference: async r => { if (r.model !== undefined) modelPreferences.set(r.path, r.model); return { model: modelPreferences.get(r.path) || '' }; },
 status: async () => ({configured:true, secureStorage:true}),
 models: async () => [{id:'test/coder',name:'Test Coder',inputPrice:'0.000001',outputPrice:'0.000002'}, {id:'other/fast',name:'Fast Model',inputPrice:'0',outputPrice:'0'}],
 saveKey: async () => ({configured:true,secureStorage:true}), removeKey: async () => ({configured:false,secureStorage:true}), openKeys:async()=>{},
 pin: async r => { const c=chats.get(r.id); c.pinned=r.pinned; return copy(c); },
 remove: async r => { chats.delete(r.id); },
 list: async r => [...chats.values()].filter(c=>c.root===r.path).map(copy),
 create: async r => {
  const chat = {id:`chat-${++counter}`,root:r.path,title:'New conversation',model:r.model,messages:[],usage:{tokens:0,requests:0,cost:0},busy:false,pending:null};
  chats.set(chat.id,chat); return copy(chat);
 },
 get: async r => copy(chats.get(r.id)),
 send: async r => {
  const paths = [...new Set([...r.text.matchAll(/(?:^|\s)@([\w./-]+)/g)].map(m=>m[1]))];
  const attachments = paths.map(path => {
    const content=contents.get(`${r.path}/${path}`);
    if(content===undefined) throw new Error(`Cannot attach @${path}: File no longer exists.`);
    return {path,content};
  });
  const c=chats.get(r.id); c.title=r.text; c.messages.push({role:'user',content:r.text,displayText:r.text,attachments}); c.busy=true;
  c.pending={id:'approval',name:'write_file',path:'hello.js',before:null,after:'console.log("Hello");'}; emit(c);
  const allowed=await new Promise(resolve=>pending.set(r.path,resolve));
  c.pending=null;c.busy=false;c.usage={tokens:50,requests:2,cost:0.002,costReported:true};
  c.messages.push({role:'assistant',content:allowed ? 'Created hello.js.\n\n### Style\n\n* **Opening:** Start here\n  1. *Teach* clearly\n\n```js\nconst x = 1;\n```\n\n<img src=x onerror=alert(1)><script>alert(1)</script>[unsafe](javascript:alert(1))' : 'Stopped without writing the file.'});emit(c);
 },
 decide: async r => {pending.get(r.path)?.(r.allowed);pending.delete(r.path);},
 stop: async r => {pending.get(r.path)?.(false);pending.delete(r.path);},
 onChanged: callback => {listener=callback;return()=>{};}
};

})();
// Enable Monaco's public API only in this isolated test renderer.
webFrame.executeJavaScript('window.MonacoEnvironment = { globalAPI: true }');
const agents = ['one', 'two'].map(id => ({ id, name: `Workspace ${id}`, path: `/workspace/${id}`, status: 'idle', fileCount: 3, isAgentWorkspace: true }));
const contents = new Map(agents.flatMap(a => [[`${a.path}/agent.md`, '# Agent instructions\n'], [`${a.path}/notes.md`, '# Notes\n']]));
const stamps = new Map([...contents.keys()].map(path => [path, 1]));
let shellLaunches = [];
let modelSession = null, modelLaunches = [], modelPrepared = [], modelBusy = false;
const modelDefaults = () => JSON.parse(sessionStorage.getItem('test.modelDefaults') || '{}');
const modelCatalog = () => ({claude:claudeCatalog,claudeError:claudeCatalogError,codex:[{id:'test-codex',label:'GPT Test 5.5',efforts:['low','medium','high','xhigh']}]});
let starts = 0, stops = 0, output, exit, launchFailure = '', earlyExit = false;
let imageId = 0, insertedImages = [];
const info = path => ({ kind: 'file', path, name: path.split('/').at(-1), relativePath: path.split('/').at(-1), depth: 0, ext: 'md', size: contents.get(path).length, sizeLabel: `${contents.get(path).length} B`, modifiedMs: stamps.get(path), modifiedLabel: 'just now', previewable: true });
contextBridge.exposeInMainWorld('botlogik', {
 openrouter: openrouterMock,
 chatModels: {
  get: async r => ({defaults:modelDefaults()[r.cwd] || {},session:modelSession?.agentId===r.agentId?modelSession:null}),
  catalog: async () => modelCatalog(),
  save: async r => { const all=modelDefaults(); const value={model:r.model,reasoningEffort:r.reasoningEffort};all[r.cwd]={...all[r.cwd],[r.provider]:value};sessionStorage.setItem('test.modelDefaults',JSON.stringify(all));return value; },
  prepare: async r => {if(modelBusy)throw Error('Wait until the agent finishes and returns to its prompt.');if(!r.emptyPrompt||r.token!==modelSession?.token)throw Error('The chat changed.');modelPrepared.push(r);return {command:r.provider==='claude'?'/'+r.control:'/model '+r.model};}
 },
 settings: {
  get: async () => ({ chatContrast: sessionStorage.getItem('test.chatContrast'), reduceToolClutter: sessionStorage.getItem('test.reduceToolClutter') === 'true', globalIgnoredNames }),
  saveGlobalIgnoredNames: async names => {globalIgnoredNames=names;return {globalIgnoredNames};},
  saveReduceToolClutter: async value => {sessionStorage.setItem('test.reduceToolClutter',String(value));return {reduceToolClutter:value};},
  saveChatContrast: async value => { sessionStorage.setItem('test.chatContrast', value); return {chatContrast:value}; }
 },
 agents: {
  duplicate: async id => {
   const original = agents.find(agent => agent.id === id);
   const agent = {...original, id:id+'-copy', name:original.name+'-copy', path:original.path+'-copy'};
   agents.push(agent); contents.set(`${agent.path}/agent.md`, '# Copied agent'); stamps.set(`${agent.path}/agent.md`,1);
   return {status:'connected', agent, agents};
  },
  chooseParent: async () => '/workspace',
  create: async name => {
   const path = `/workspace/${name}`;
   if (agents.some(a => a.path === path)) return {status:'exists',path};
   const agent = {id:name,name,path,status:'idle',fileCount:1,isAgentWorkspace:true};
   agents.push(agent); contents.set(`${path}/agent.md`, '# New agent\n'); stamps.set(`${path}/agent.md`,1);
   return {status:'connected',agent,agents};
  },
  connectPath: async path => ({status:'already-connected',agent:agents.find(a=>a.path===path),agents}),
  scan: async () => agents, onChanged: () => {}, watch: async () => {}, unwatch: () => {} },
 images: {
  pick: async () => [{name:'First.png'},{name:'Second.png'}],
  stage: async ({agentId, source, images}) => ({images:(images || (source==='clipboard' ? [{name:'Screenshot.png'}] : [{name:'First.png'},{name:'Second.png'}])).map(file=>({id:String(++imageId),name:file.name||'Dropped.png',path:`/workspace/${agentId}/.botlogik/attachments/${imageId}.png`,thumbnail:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='})),errors:[]}),
  insert: async ({ids}) => {insertedImages=ids;return {inserted:ids.length,text:' Read these local images: "image.png". '};},
  release: async () => {}, pathForFile: () => ''
 },
 clipboard: {writeText:()=>{}},
 sessions: { list: async () => [] }, cron: { models: async () => ({claude:claudeCatalog,claudeError:claudeCatalogError,codex:[{id:'test-codex',label:'GPT Test 5.5',efforts:['low','medium','high','xhigh']}]}), save: async schedule => {schedules=[schedule];return schedules;}, list: async () => schedules, runsList: async () => [] },
 files: {
  list: async root => [...contents.keys()].filter(path => path.startsWith(root+'/') && !path.slice(root.length+1).split('/').some(name => globalIgnoredNames.includes(name))).map(info),
  read: async (_, path) => contents.has(path) ? {ok:true,content:contents.get(path),size:contents.get(path).length,modifiedMs:stamps.get(path)} : {ok:false,content:'Missing'},
  save: async (_, path, content, expected) => {
   if (expected.modifiedMs !== stamps.get(path)) return {ok:false,reason:'modified',content:'Changed on disk'};
   contents.set(path, content); stamps.set(path, stamps.get(path)+1);
   return {ok:true,size:content.length,modifiedMs:stamps.get(path)};
  }
 },
 git: { status: async () => ({isRepo:true,branch:'main',changes:[{file:'agent.md',status:'M'}]}), diff: async () => '@@ -1 +1 @@\n-old\n+new' },
 traces: { list: async r => ({sessions: traceSessions.get(r.agentId) || [], storageError:''}), clear: async r => {traceSessions.set(r.agentId,(traceSessions.get(r.agentId)||[]).filter(s=>s.id!==r.id));traceChanged?.();}, onChanged: callback => {traceChanged=callback;return ()=>{};} },
 terminal: {
  start: async (agentId, cwd) => { shellLaunches.push({agentId,cwd}); output?.({sessionId:'mock-shell',data:'Shell ready\r\n'}); return {sessionId:'mock-shell'}; },
  startManaged: async (agentId,cwd,provider,mode,prompt,conversationId,runId,model,reasoningEffort) => {starts++; const selection=mode==='resume'?null:model===undefined?(modelDefaults()[cwd]?.[provider] || {model:'',reasoningEffort:'default'}):{model,reasoningEffort};modelSession={agentId,provider,token:String(starts),selection};modelLaunches.push({agentId,provider,mode,selection}); if (launchFailure) throw new Error(launchFailure); if (earlyExit) { output?.({sessionId:'mock-session',data:'Synthetic startup failure\r\n'}); exit?.({sessionId:'mock-session',code:1,signal:null}); } return {sessionId:'mock-session'};}, stop: async () => {stops++;modelSession=null;},
  onExit: callback => {exit=callback;return ()=>{};},
  onOutput: callback => {output=callback;return ()=>{};}, resize: () => {}, input: () => {}
 }
});
contextBridge.exposeInMainWorld('workspaceTest', {
 modelState: () => ({launches:modelLaunches,prepared:modelPrepared,defaults:modelDefaults()}),
 modelBusy: value => {modelBusy=value;},
 presentation: mode => openrouterMock.presentation(mode),
 traces: (agentId, sessions) => {traceSessions.set(agentId,sessions);traceChanged?.();},
 openrouterFailure: () => openrouterMock.fail(),
 launchFailure: message => {launchFailure=message;}, earlyExit: value => {earlyExit=value;},
 claudeModels: (models, error = '') => {claudeCatalog=models;claudeCatalogError=error;},
 change: (path, text) => {contents.set(path,text);stamps.set(path,stamps.get(path)+1);},
 remove: path => {contents.delete(path);stamps.delete(path);},
 contents: path => contents.get(path),
 stats: () => ({starts,stops}),
 shellLaunches: () => shellLaunches,
 imageStats: () => insertedImages,
 output: () => output?.({sessionId:'mock-session',data:'Agent is ready.\r\n'})
});
