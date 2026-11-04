import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, symlink, realpath, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import vm from 'node:vm';

const source = await readFile(new URL('../src/main/main.js', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('function isInsidePath('), source.indexOf('async function resolveWorkspaceRelativePath('));

async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'botlogik-terminal-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const workspace = join(temporary, 'workspace');
  await mkdir(workspace);
  const calls = [];
  const context = vm.createContext({
    resolve, relative, isAbsolute, dirname, realpath, stat, existsSync,
    process: { platform: 'darwin' },
    execFileAsync: async (...args) => { calls.push(args); }
  });
  vm.runInContext(functions, context);
  return { temporary, workspace, calls, context };
}

test('opens root and nested folders as literal paths without shell interpolation', async t => {
  const { workspace, calls, context } = await fixture(t);
  const nested = join(workspace, 'Bob\'s "app" $(touch nope); `echo nope`');
  await mkdir(nested);
  await context.openWorkspaceTerminal(workspace);
  await context.openWorkspaceTerminal(workspace, nested);
  assert.equal(calls.length, 2);
  for (const [index, directory] of [workspace, nested].entries()) {
    assert.equal(calls[index][0], '/usr/bin/open');
    assert.deepEqual(Array.from(calls[index][1]), ['-b', 'com.apple.Terminal', await realpath(directory)]);
    assert.equal(calls[index][2].shell, undefined);
  }
});

test('rejects files, missing folders, outside paths and escaping symlinks', async t => {
  const { temporary, workspace, calls, context } = await fixture(t);
  const file = join(workspace, 'file.txt');
  await writeFile(file, 'test');
  const link = join(workspace, 'outside');
  await symlink(temporary, link);
  await assert.rejects(context.openWorkspaceTerminal(workspace, file), /only.*folder/);
  await assert.rejects(context.openWorkspaceTerminal(workspace, join(workspace, 'missing')), /no longer exists/);
  await assert.rejects(context.openWorkspaceTerminal(workspace, temporary), /outside/);
  await assert.rejects(context.openWorkspaceTerminal(workspace, link), /outside/);
  assert.equal(calls.length, 0);
});

test('reports launcher failures and unsupported platforms', async t => {
  const { workspace, context } = await fixture(t);
  context.execFileAsync = async () => { throw new Error('Terminal unavailable'); };
  await assert.rejects(context.openWorkspaceTerminal(workspace), /Terminal unavailable/);
  context.process.platform = 'linux';
  await assert.rejects(context.openWorkspaceTerminal(workspace), /macOS/);
});
