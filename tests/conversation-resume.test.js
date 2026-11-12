import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { applyClaudeFocus } from '../src/main/claude-presentation.js';
import { resumeCommand, validConversationId } from '../src/main/conversation-history.js';

const id = '11111111-1111-4111-8111-111111111111';
const source = await readFile(new URL('../src/main/main.js', import.meta.url), 'utf8');
const start = source.indexOf("ipcMain.handle('terminal:start-managed'");
const end = source.indexOf("ipcMain.on('terminal:input'", start);
function harness({ existing, saved = { agentId: 'a' }, response = 0, installing = false, reduceToolClutter = false, version = '2.1.311' } = {}) {
  let handler;
  const launches = [];
  const stopped = [];
  const sessions = new Map(existing ? [['terminal', existing]] : []);
  const context = {
    appUpdates: { installing }, applyClaudeFocus,
    assertClaudeModelSupported: async () => {}, scheduleModelOptions: () => ({}),
    openRouter: { isRunning: () => false }, realpath: async path => path,
    ipcMain: { handle(name, callback) { if (name === 'terminal:start-managed') handler = callback; } },
    assertAgentPathMatches: () => '/workspace', existsSync: () => true,
    terminalKey: () => 'terminal', historyAgents: [{ id: 'a' }],
    conversationHistory: { list: async () => [], get: () => saved },
    resumeCommand, validConversationId, terminalSessions: sessions, pendingManagedLaunches: new Set(),
    getActivityBridge: () => ({ prepare: async () => ({ version, args: [], env: {}, activity: { snapshot: () => ({ state: 'session-open' }) }, dispose() {} }) }),
    stopTerminalSession: key => { stopped.push(key); sessions.delete(key); },
    dialog: { showMessageBox: async () => ({ response }) }, BrowserWindow: { fromWebContents: () => ({}) },
    pty: { spawn: (command, args) => { launches.push({ command, args }); return { onData() {}, onExit() {} }; } },
    resolveCli: async command => command, augmentedEnv: () => ({}), randomUUID: () => id,
    managedAgentCommand: () => ({ command: 'claude', args: ['-p', 'Task'] }),
    readConfig: async () => ({ reduceToolClutter, scheduledRuns: [{ id: 'run', agentId: 'a', conversationId: id }] })
  };
  vm.runInNewContext(source.slice(start, end), context);
  return { call: options => handler({ sender: { id: 1 } }, { agentId: 'a', cwd: '/workspace', provider: 'claude', mode: 'resume', conversationId: id, ...options }), launches, stopped };
}

test('update restart rejects new agent launches without stopping existing work', async () => {
  const h = harness({ installing: true, existing: { managed: true } });
  await assert.rejects(h.call(), /restarting to update/);
  assert.deepEqual(h.launches, []);
  assert.deepEqual(h.stopped, []);
});

test('resumes a saved conversation and rejects missing or cross-workspace history before stopping a terminal', async () => {
  const h = harness();
  const result = await h.call();
  assert.equal(result.conversationId, id);
  assert.deepEqual(h.launches, [{ command: 'claude', args: ['--resume', id] }]);
  for (const saved of [null, { agentId: 'another-workspace' }]) {
    const invalid = harness({ saved, existing: { managed: true } });
    await assert.rejects(invalid.call(), /no longer available/);
    assert.equal(invalid.stopped.length, 0);
    assert.equal(invalid.launches.length, 0);
  }
});

test('reuses the active matching session, respects cancel, and protects scheduled runs', async () => {
  const active = { managed: true, provider: 'claude', conversationId: id };
  const reuse = harness({ existing: active });
  assert.equal((await reuse.call()).reused, true);
  assert.equal(reuse.launches.length, 0);
  const cancel = harness({ existing: { ...active, conversationId: 'different' } });
  assert.equal((await cancel.call()).cancelled, true);
  assert.equal(cancel.stopped.length, 0);
  const replace = harness({ existing: { ...active, conversationId: 'different' }, response: 1 });
  await replace.call();
  assert.equal(replace.stopped.length, 1);
  assert.equal(replace.launches.length, 1);
  const scheduled = harness({ existing: { ...active, runId: 'run' } });
  await assert.rejects(scheduled.call(), /Stop the scheduled run/);
  assert.equal(scheduled.stopped.length, 0);
});

test('automated Claude launch uses the saved run conversation ID', async () => {
  const h = harness();
  const result = await h.call({ mode: 'prompt', prompt: 'Task', runId: 'run', conversationId: undefined });
  assert.equal(result.conversationId, id);
  assert.deepEqual(h.launches[0].args, ['-p', 'Task', '--session-id', id]);
});


test('Claude clutter preference applies on resume without changing Codex or unattended launches', async () => {
  const claude = harness({ reduceToolClutter: true });
  await claude.call();
  const args = claude.launches[0].args;
  assert.equal(JSON.parse(args[args.indexOf('--settings') + 1]).viewMode, 'focus');
  const codex = harness({ reduceToolClutter: true });
  await codex.call({provider:'codex'});
  assert.ok(!codex.launches[0].args.includes('--settings'));
  const scheduled = harness({ reduceToolClutter: true });
  await scheduled.call({mode:'prompt',runId:'run',prompt:'Task'});
  assert.ok(!scheduled.launches[0].args.includes('--settings'));
  const older = harness({ reduceToolClutter: true, version:'2.1.200' });
  assert.match((await older.call()).presentationNotice, /normal view/);
  assert.ok(!older.launches[0].args.includes('--settings'));
});
