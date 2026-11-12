import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createActivityBridge, activityHookArgs, supportsActivityHooks } from '../src/main/activity-bridge.js';

test('hook flags are additive, observational and version gated', () => {
  assert.equal(supportsActivityHooks('codex', 'codex-cli 0.147.0'), true);
  assert.equal(supportsActivityHooks('codex', 'codex-cli 0.100.0'), false);
  assert.equal(supportsActivityHooks('claude', '2.1.236 (Claude Code)'), true);
  assert.equal(supportsActivityHooks('claude', 'unknown'), false);
  const args = activityHookArgs('claude', 'report');
  const settings = JSON.parse(args[1]);
  assert.ok(settings.hooks.PermissionRequest);
  assert.equal(settings.disableAllHooks, undefined);
  assert.ok(activityHookArgs('codex', 'report').some(arg => arg.startsWith('hooks.PermissionRequest=')));
  assert.ok(!activityHookArgs('codex', 'report').join(' ').includes('bypass'));
});

test('real hook helper sends a bounded event; stale credentials and browser requests are rejected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'botlogik-activity-'));
  const updates = [], traces = [];
  const bridge = createActivityBridge({ directory, getVersion: async () => '0.147.0', onChange: state => updates.push(state), onTrace: (state, event) => traces.push({ state, event }) });
  try {
    const session = await bridge.prepare({ provider: 'codex', agentId: 'a', sessionId: 'terminal', env: process.env });
    assert.ok(session.env.BOTLOGIK_ACTIVITY_TOKEN);
    const child = spawn(process.execPath, [join(directory, 'report-activity.cjs')], { env: { ...process.env, ...session.env } });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'saved-session', prompt: 'Must not be relayed', tool_input: { secret: 'not relayed' } }));
    assert.equal(await new Promise(resolve => child.on('exit', resolve)), 0);
    assert.equal(output, '');
    assert.equal(updates.at(-1).state, 'working');
    assert.equal(updates.at(-1).conversationId, 'saved-session');
    assert.ok(!JSON.stringify(updates).includes('Must not be relayed'));
    const url = `http://127.0.0.1:${session.env.BOTLOGIK_ACTIVITY_PORT}/activity`;
    const headers = { authorization: `Bearer ${session.env.BOTLOGIK_ACTIVITY_TOKEN}` };
    assert.equal((await fetch(url, { method: 'POST', body: '{}', headers: { ...headers, origin: 'https://example.com' } })).status, 403);
    await fetch(url, { method: 'POST', headers, body: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'saved-session', tool_use_id: 'read-1', tool_name: 'Read', tool_input: { path: 'app.js' } }) });
    assert.equal(traces.at(-1).event.tool_name, 'Read');
    assert.equal(traces.at(-1).state.conversationId, 'saved-session');
    const toolChild = spawn(process.execPath, [join(directory, 'report-activity.cjs')], { env: { ...process.env, ...session.env } });
    toolChild.stdin.end(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'saved-session', tool_use_id: 'read-1', tool_name: 'Read', tool_response: { password: 'must-be-redacted', stdout: 'x'.repeat(4000), exit_code: 1 } }));
    assert.equal(await new Promise(resolve => toolChild.on('exit', resolve)), 0);
    assert.equal(traces.at(-1).event.tool_failed, true);
    assert.ok(!JSON.stringify(traces).includes('must-be-redacted'));
    session.dispose(0, null, true);
    assert.equal((await fetch(url, { method: 'POST', body: '{"hook_event_name":"Stop"}', headers })).status, 403);
    assert.equal(updates.at(-1).state, 'stopped');
  } finally { await bridge.close(); await rm(directory, { recursive: true, force: true }); }
});

test('unavailable hooks leave a usable session-open fallback without modifying launch args', async () => {
  const bridge = createActivityBridge({ getVersion: async () => '0.100.0' });
  const session = await bridge.prepare({ provider: 'codex', agentId: 'a', sessionId: 'terminal' });
  assert.deepEqual(session.args, []);
  assert.deepEqual(session.env, {});
  assert.equal(session.activity.state, 'session-open');
  assert.match(session.activity.detail, /unavailable/);
  await bridge.close();
});
