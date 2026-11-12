import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
const source = await readFile(new URL('../src/main/main.js', import.meta.url), 'utf8');
test('multi-megabyte Markdown reads, edits, saves and creates without truncation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'botlogik-large-text-'));
  try {
    const limit = Number(source.match(/const MAX_EDITOR_FILE_BYTES = (\d+) \* 1024 \* 1024/)[1]) * 1024 * 1024;
    const c = vm.createContext({ Buffer, readFile, writeFile, stat, lstat, mkdir, basename, dirname,
      MAX_EDITOR_FILE_BYTES: limit, formatBytes: bytes => String(bytes), formatModified: () => 'just now',
      resolveWorkspacePath: async (_, path) => ({target:path}),
      resolveWorkspaceRelativePath: async (_, path) => ({target:join(root,path)}),
      isSecretEnvName: name => name === '.env', isPreviewableTextName: name => name.endsWith('.md'),
      assertEditableTextName() {} });
    vm.runInContext(source.slice(source.indexOf('async function readWorkspaceFile('), source.indexOf('async function createWorkspaceFolder(')),c);
    const start = source.indexOf('async function createWorkspaceFile(');
    vm.runInContext(source.slice(start, source.indexOf('\nasync function ',start+1)),c);
    const content = '# Large Markdown\n' + 'Synthetic documentation — café ☕\n'.repeat(70000) + '\nLAST LINE\n';
    assert.ok(Buffer.byteLength(content) > 2 * 1024 * 1024);
    const path = join(root,'large.md'); await writeFile(path,content);
    const read = await c.readWorkspaceFile(root,path);
    assert.equal(read.ok,true); assert.equal(read.content,content);
    const edited = content + 'Saved edit\n';
    assert.equal((await c.saveWorkspaceFile(root,path,edited,{size:read.size,modifiedMs:read.modifiedMs})).ok,true);
    assert.equal(await readFile(path,'utf8'),edited);
    assert.equal((await c.createWorkspaceFile(root,'created.md',content)).ok,true);
    assert.equal(await readFile(join(root,'created.md'),'utf8'),content);
    await writeFile(path,'Changed externally');
    assert.equal((await c.saveWorkspaceFile(root,path,edited,{size:read.size,modifiedMs:read.modifiedMs})).reason,'modified');
    await writeFile(path,Buffer.from([65,0,66]));assert.equal((await c.readWorkspaceFile(root,path)).reason,'binary');
    const actualStat = c.stat;
    c.stat = async path => { const info = await actualStat(path); info.size = limit + 1; return info; };
    const oversized = await c.readWorkspaceFile(root,path);
    assert.equal(oversized.reason,'too-large'); assert.match(oversized.content,/50 MB/);
  } finally { await rm(root,{recursive:true,force:true}); }
});
