import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createToolTraces } from '../src/main/tool-traces.js';
import { traceDetails } from '../src/shared/trace-details.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'botlogik-traces-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'traces.json'); let time = 1000;
  return { path, store: createToolTraces({ path, now: () => time }), tick: () => { time += 250; } };
}
const context = { agentId: 'a', provider: 'claude', id: 'conversation', conversationId: 'conversation' };

test('pairs interleaved calls, records approval and failures, isolates workspaces, and redacts saved details', async t => {
  const { store, path, tick } = await fixture(t);
  await store.begin(context, 'Waiting');
  await store.event(context, { hook_event_name: 'UserPromptSubmit', prompt: 'private prompt' });
  await store.event(context, { hook_event_name: 'PreToolUse', tool_use_id: '1', tool_name: 'Read', tool_input: { path: 'app.js', token: 'private-key' } });
  await store.event(context, { hook_event_name: 'PreToolUse', tool_use_id: '2', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  await store.event(context, { hook_event_name: 'PermissionRequest', tool_use_id: '2', tool_name: 'Bash' });
  assert.equal((await store.list('a')).sessions[0].tools[1].status, 'waiting');
  tick();
  await store.event(context, { hook_event_name: 'PostToolUseFailure', tool_use_id: '2', error: 'sk-or-secret-123 failed' });
  await store.event(context, { hook_event_name: 'PostToolUse', tool_use_id: '1', tool_response: { content: 'file text' } });
  const tools = (await store.list('a')).sessions[0].tools;
  assert.deepEqual(tools.map(t => t.status), ['succeeded', 'failed']);
  assert.equal(tools[1].finishedAt - tools[1].startedAt, 250);
  assert.equal(tools[0].turn, 1);
  assert.deepEqual((await store.list('b')).sessions, []);
  const saved = await readFile(path, 'utf8');
  for (const secret of ['private prompt', 'private-key', 'sk-or-secret-123']) assert.ok(!saved.includes(secret));
  await store.clear('b', context.id); assert.equal((await store.list('a')).sessions.length, 1);
  await store.clear('a', context.id); assert.equal((await store.list('a')).sessions.length, 0);
});

test('missing completion remains unknown after restart and never has an invented duration', async t => {
  const { store, path } = await fixture(t);
  await store.event(context, { hook_event_name: 'PreToolUse', tool_use_id: 'unfinished', tool_name: 'Read' });
  const restarted = createToolTraces({ path, now: () => 1000 });
  const tool = (await restarted.list('a')).sessions[0].tools[0];
  assert.equal(tool.status, 'unknown'); assert.equal(tool.finishedAt, undefined);
  await restarted.event(context, { hook_event_name: 'PostToolUse', tool_use_id: 'orphan', tool_name: 'Read' });
  assert.equal((await restarted.list('a')).sessions[0].tools[1].startedAt, null);
});

test('tool data is bounded and reasoning/credentials are removed', () => {
  const text = traceDetails({ authorization: 'private', reasoning: 'hidden', nested: { api_key: 'private' }, output: 'Bearer abc123 sk-secret' });
  for (const secret of ['private', 'hidden', 'abc123', 'sk-secret']) assert.ok(!text.includes(secret));
  assert.ok(traceDetails('x'.repeat(10000)).length < 2100);
});

test('retention bounds conversations and tool calls', async t => {
  const { store } = await fixture(t);
  for (let i = 0; i < 205; i++) await store.event(context, { hook_event_name: 'PreToolUse', tool_use_id: String(i), tool_name: 'Read' });
  assert.equal((await store.list('a')).sessions[0].tools.length, 200);
  for (let i = 0; i < 51; i++) await store.begin({ ...context, id: String(i) }, 'Waiting');
  assert.equal((await store.list('a')).sessions.length, 50);
});


test('completion errors and unavailable storage remain visible without breaking execution', async t => {
  const { path, store } = await fixture(t);
  await store.event(context, { hook_event_name: 'PostToolUse', tool_use_id: 'failed', tool_name: 'Bash', tool_failed: true, tool_response: '[truncated]' });
  assert.equal((await store.list('a')).sessions[0].tools[0].status, 'failed');
  const unavailable = createToolTraces({ path: join(path, 'invalid-child.json'), now: () => 1000 });
  await unavailable.event(context, { hook_event_name: 'PreToolUse', tool_use_id: 'tool', tool_name: 'Read' });
  const result = await unavailable.list('a');
  assert.equal(result.sessions[0].tools.length, 1);
  assert.match(result.storageError, /could not be saved/);
});
