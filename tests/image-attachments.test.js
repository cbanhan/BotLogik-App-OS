import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, symlink, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageImage, imagePrompt, imageBytes, MAX_IMAGE_BYTES } from '../src/main/image-attachments.js';
const nativeImage = { createFromBuffer: bytes => ({ isEmpty: () => bytes[0] !== 137, getSize: () => ({width:20,height:10}), toPNG: () => bytes, resize: () => ({toDataURL:()=> 'data:image/png;base64,iVBORw=='}) }) };
test('image references handle multiple paths and quotes without submit or terminal control characters', () => {
 const paths = ['/workspace/a b.png', '/workspace/a"b.png'];
 for (const provider of ['claude','codex']) {
  const prompt = imagePrompt(provider, paths);
  assert.ok(prompt.includes(JSON.stringify(paths[0])));
  assert.ok(prompt.includes(JSON.stringify(paths[1])));
  assert.doesNotMatch(prompt, /[\r\n\x1b]/);
 }
 assert.match(imagePrompt('codex',paths), /view_image/);
 assert.throws(()=>imagePrompt('shell',paths));
 assert.throws(()=>imagePrompt('claude',['bad\npath.png']));
 assert.throws(()=>imagePrompt('claude',Array(11).fill('x')));
});
test('staging preserves originals, saves unique images and rejects invalid or oversized input', async () => {
 const root = await mkdtemp(join(tmpdir(),'images-'));
 try {
  const source = {bytes:new Uint8Array([137,80,78,71]),name:'My image.png'};
  const a = await stageImage(root,source,nativeImage), b = await stageImage(root,source,nativeImage);
  assert.notEqual(a.path,b.path); assert.equal(a.name,'My image.png');
  assert.deepEqual(await readFile(a.path),Buffer.from(source.bytes));
  await assert.rejects(stageImage(root,{bytes:new Uint8Array([0])},nativeImage), /Unsupported/);
  await assert.rejects(stageImage(root,{bytes:new Uint8Array(MAX_IMAGE_BYTES+1)},nativeImage), /20 MB/);
  assert.equal((await readdir(join(root,'.botlogik','attachments'))).length,2);
 } finally {await rm(root,{recursive:true,force:true});}
});
test('attachment directories cannot redirect writes outside the workspace', async () => {
 const root = await mkdtemp(join(tmpdir(),'images-'));
 try {
  await mkdir(join(root,'outside')); await symlink(join(root,'outside'),join(root,'.botlogik'));
  await assert.rejects(stageImage(root,{bytes:new Uint8Array([137])},nativeImage), /symbolic/);
  assert.deepEqual(await readdir(join(root,'outside')),[]);
 } finally {await rm(root,{recursive:true,force:true});}
});

test('image IPC inserts only into the owning manual agent session, bracketed and without Enter', async () => {
 const vm = await import('node:vm');
 const source = await readFile(new URL('../src/main/main.js',import.meta.url),'utf8');
 const handlers = new Map(), writes = [];
 const owner = {id:1,once() {}};
 const root = await mkdtemp(join(tmpdir(),'images-ipc-'));
 const session = {managed:true,provider:'claude',owner,process:{write:text=>writes.push(text)}};
 const sessions = new Map([['1:a',session]]);
 const context = {
  ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},
  terminalSessions:sessions, terminalKey:(sender,agent)=>`${sender}:${agent}`,
  assertAgentPathMatches:()=>root, stageImage, imagePrompt, imageBytes, MAX_IMAGES:10,
  nativeImage, clipboard:{readImage:()=>({isEmpty:()=>false,toPNG:()=>new Uint8Array([137])})},
  lstat
 };
 try {
  vm.runInNewContext(source.slice(source.indexOf('// Staged references belong'),source.indexOf("ipcMain.on('terminal:input'")),context);
  const staged = await handlers.get('images:stage')({sender:owner},{agentId:'a',source:'clipboard'});
  const ids = staged.images.map(image=>image.id);
  await assert.rejects(handlers.get('images:insert')({sender:owner},{agentId:'b',ids}), /manual/);
  session.runId = 'scheduled';
  await assert.rejects(handlers.get('images:insert')({sender:owner},{agentId:'a',ids}), /manual/);
  delete session.runId;
  assert.equal(writes.length,0);
  const result = await handlers.get('images:insert')({sender:owner},{agentId:'a',ids});
  assert.equal(result.inserted,1);
  assert.equal(writes[0],`\x1b[200~${result.text}\x1b[201~`);
  assert.doesNotMatch(writes[0],/[\r\n]/);
  await assert.rejects(handlers.get('images:insert')({sender:owner},{agentId:'a',ids}), /different workspace/);
 } finally {await rm(root,{recursive:true,force:true});}
});
