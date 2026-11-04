import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerOpenRouter } from '../src/main/openrouter-ipc.js';

test('IPC rejects subframes, unknown workspaces, and launch conflicts before contacting a provider', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'router-ipc-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const handlers = new Map(), mainFrame = {}, sender = Object.assign(new EventEmitter(), { id: 1, mainFrame, send() {}, isDestroyed: () => false });
  const event = { sender, senderFrame: mainFrame };
  const opened = [];
  registerOpenRouter({ directory, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, BrowserWindow: { fromWebContents: s => s === sender }, safeStorage: { isEncryptionAvailable: () => false }, shell: { openExternal: url => opened.push(url) }, getAgents: async () => [{ id: 'a', path: directory }], canStart: async () => { throw new Error('Session conflict'); } });
  await assert.rejects(handlers.get('openrouter:status')({ sender, senderFrame: {} }), /app window/);
  await assert.rejects(handlers.get('openrouter:list')(event, { agentId: 'other', path: directory }), /connected workspace/);
  await assert.rejects(handlers.get('openrouter:create')(event, { agentId: 'a', path: directory, model: 'test/coder' }), /Session conflict/);
  await assert.rejects(handlers.get('openrouter:send')(event, { agentId: 'a', path: directory, id: 'anything', text: 'run' }), /Session conflict/);
  handlers.get('openrouter:openKeys')(event);
  assert.throws(() => handlers.get('openrouter:openLink')(event, 'javascript:alert(1)'), /Unsupported/);
  handlers.get('openrouter:openLink')(event, 'https://example.com/docs');
  assert.deepEqual(opened, ['https://openrouter.ai/settings/keys', 'https://example.com/docs']);
});
