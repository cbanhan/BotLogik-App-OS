import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpenRouter } from '../src/main/openrouter.js';
import { executeLocalTool, workspacePath, runCommand } from '../src/main/openrouter-tools.js';

const MODEL = { id: 'test/coder', name: 'Coder', supported_parameters: ['tools'], architecture: { output_modalities: ['text'] }, context_length: 64000, pricing: { prompt: '0.000001', completion: '0.000002' } };
// Synthetic key for the injected mock transport; never sent to a provider.
const token = 'sk-or-' + 'x'.repeat(20);
const safeStorage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s.split('').reverse().join('')), decryptString: b => b.toString().split('').reverse().join('') };
const response = data => ({ ok: true, json: async () => data });
const completion = (content, tool_calls) => response({ choices: [{ message: { content, ...(tool_calls ? { tool_calls } : {}) }, finish_reason: tool_calls ? 'tool_calls' : 'stop' }], usage: { total_tokens: 30, cost: 0.001 } });
const tool = (name, args, id = 'call1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
async function fixture(t, options = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'botlogik-router-'))); t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'workspace'); await mkdir(root);
  const requests = [], events = [], replies = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith('/models')) return response({ data: [MODEL, { ...MODEL, id: 'no/tools', supported_parameters: [] }] });
    if (url.endsWith('/key')) return response({ data: {} });
    const next = replies.shift(); return typeof next === 'function' ? next(init) : next || completion('Done');
  };
  const router = createOpenRouter({ directory: join(dir, 'store'), safeStorage, fetchImpl, onChange: (_, c) => events.push(c), ...options });
  await router.saveKey(token);
  return { dir, root, router, requests, events, replies };
}
const waitFor = async check => { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('Timed out'); };

test('keys are encrypted, never returned, validated before replacement; models require tools', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.router.status(), { configured: true, secureStorage: true });
  assert.equal((await readFile(join(f.dir, 'store/key.json'), 'utf8')).includes(token), false);
  assert.deepEqual((await f.router.models()).map(m => m.id), ['test/coder']);
  await assert.rejects(f.router.saveKey('invalid'), /valid OpenRouter/);
  assert.equal((await f.router.status()).configured, true);
  await f.router.removeKey(); assert.equal((await f.router.status()).configured, false);
});

test('unavailable secure storage fails closed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'router-secure-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const router = createOpenRouter({ directory: dir, safeStorage: { isEncryptionAvailable: () => false } });
  await assert.rejects(router.saveKey(token), /unavailable/);
});

test('agent loop returns tool results and reasoning details, persists conversation and usage', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'note.txt'), 'Hello');
  const first = completion(null, [tool('read_file', { path: 'note.txt' })]);
  const data = await first.json(); data.choices[0].message.reasoning_details = [{ type: 'reasoning.encrypted', data: 'opaque' }];
  f.replies.push(response(data), completion('Read it.'));
  const chat = await f.router.create(f.root, MODEL.id);
  await f.router.send(f.root, 1, { id: chat.id, text: 'Read note' });
  const result = await f.router.get(f.root, chat.id);
  assert.equal(result.busy, false); assert.equal(result.messages.at(-1).content, 'Read it.');
  assert.equal(result.usage.requests, 2); assert.equal(result.usage.cost, 0.002);
  const sent = JSON.parse(f.requests.at(-1).init.body);
  assert.equal(sent.messages.at(-1).role, 'tool');
  assert.match(sent.messages.at(-1).content, /Hello/);
  assert.deepEqual(sent.messages.find(m => m.role === 'assistant').reasoning_details, data.choices[0].message.reasoning_details);
  assert.equal(result.messages.find(m => m.role === 'assistant').reasoning_details, undefined);
  assert.equal((await f.router.list(f.root))[0].title, 'Read note');
  assert.equal(JSON.stringify(f.events).includes(token), false);
});

test('write approval is owned by its window, denial makes no change, cancellation balances tool history', async t => {
  const f = await fixture(t);
  const chat = await f.router.create(f.root, MODEL.id);
  f.replies.push(completion(null, [tool('write_file', { path: 'new.txt', content: 'Hi', expected_sha256: 'new' })]));
  const run = f.router.send(f.root, 7, { id: chat.id, text: 'Create file' });
  await waitFor(() => f.events.at(-1)?.pending);
  const pending = f.events.at(-1).pending;
  assert.throws(() => f.router.decide(f.root, 8, pending.id, true), /no longer active/);
  f.router.decide(f.root, 7, pending.id, false);
  await run;
  await assert.rejects(readFile(join(f.root, 'new.txt')), { code: 'ENOENT' });
  f.replies.push(completion(null, [tool('write_file', { path: 'new.txt', content: 'Hi', expected_sha256: 'new' }, 'call2')]));
  const stopped = f.router.send(f.root, 7, { id: chat.id, text: 'Try another' });
  await waitFor(() => f.events.at(-1)?.pending);
  f.router.stop(f.root, 7); await stopped;
  const saved = await f.router.get(f.root, chat.id);
  assert.match(saved.notice, /Stopped/); assert.equal(saved.pending, null);
  assert.equal(saved.messages.at(-1).role, 'tool');
  await assert.rejects(readFile(join(f.root, 'new.txt')), { code: 'ENOENT' });
});

test('concurrent sends are rejected and request limits stop the loop', async t => {
  const f = await fixture(t);
  const chat = await f.router.create(f.root, MODEL.id);
  f.replies.push(completion(null, [tool('list_files', { path: '.' })]));
  const first = f.router.send(f.root, 1, { id: chat.id, text: 'List', maxRequests: 1 });
  await assert.rejects(f.router.send(f.root, 1, { id: chat.id, text: 'Concurrent' }), /already active/);
  await first;
  assert.match((await f.router.get(f.root, chat.id)).notice, /1-request limit/);
  assert.equal(f.router.busy, false);
});

test('aborting network requests leaves a reusable conversation; HTTP errors do not leak provider bodies', async t => {
  const f = await fixture(t);
  const chat = await f.router.create(f.root, MODEL.id);
  f.replies.push(init => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
  const run = f.router.send(f.root, 1, { id: chat.id, text: 'Wait' });
  await waitFor(() => f.requests.at(-1)?.url.endsWith('/chat/completions'));
  f.router.stop(f.root, 1); await run;
  assert.equal(f.router.busy, false);
  f.replies.push({ ok: false, status: 402, json: async () => ({ error: token }) });
  await f.router.send(f.root, 1, { id: chat.id, text: 'Retry' });
  assert.match((await f.router.get(f.root, chat.id)).notice, /credits/);
  assert.equal(JSON.stringify(f.events).includes(token), false);
});

test('workspace tools reject traversal, symlinks, secrets, stale writes; approved edits and search work', async t => {
  const f = await fixture(t); const signal = new AbortController().signal;
  const yes = { signal, approve: async () => true };
  await writeFile(join(f.root, 'a.txt'), 'hello');
  await symlink(f.dir, join(f.root, 'outside'));
  for (const path of ['../escape', '/tmp/escape', 'outside/file', '.env', '.agent-logik/openrouter/key.json']) await assert.rejects(workspacePath(f.root, path, { missing: true }));
  const read = await executeLocalTool(f.root, 'read_file', { path: 'a.txt' }, yes);
  await assert.rejects(executeLocalTool(f.root, 'write_file', { path: 'a.txt', content: 'wrong', expected_sha256: 'wrong' }, yes), /changed/);
  await executeLocalTool(f.root, 'write_file', { path: 'nested/b.txt', content: 'hello again', expected_sha256: 'new' }, yes);
  assert.equal(await readFile(join(f.root, 'nested/b.txt'), 'utf8'), 'hello again');
  const args = { path: 'a.txt', content: 'updated', expected_sha256: read.sha256 };
  await assert.rejects(executeLocalTool(f.root, 'write_file', args, { signal, approve: async () => { await writeFile(join(f.root, 'a.txt'), 'external change'); return true; } }), /changed/);
  assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'external change');
  const found = await executeLocalTool(f.root, 'search_files', { query: 'hello' }, yes);
  assert.equal(found.matches[0].path, 'nested/b.txt');
});

test('commands require approval, return output, and terminate on timeout or stop', async t => {
  const f = await fixture(t); const controller = new AbortController();
  const result = await executeLocalTool(f.root, 'run_command', { command: 'touch denied' }, { signal: controller.signal, approve: async () => false });
  assert.equal(result.denied, true); await assert.rejects(readFile(join(f.root, 'denied')), { code: 'ENOENT' });
  const output = await runCommand('printf hello', f.root, controller.signal);
  assert.equal(output.output, 'hello'); assert.equal(output.exitCode, 0);
  const timeout = await runCommand('sleep 10', f.root, controller.signal, { timeout: 30 }); assert.equal(timeout.timedOut, true);
  const waiting = runCommand('sleep 10', f.root, controller.signal); controller.abort(); await assert.rejects(waiting, /Stopped/);
});

test('saved chats survive a new runtime and cannot be loaded from another workspace', async t => {
  const f = await fixture(t);
  const chat = await f.router.create(f.root, MODEL.id);
  await f.router.send(f.root, 1, { id: chat.id, text: 'Remember this' });
  const restarted = createOpenRouter({ directory: join(f.dir, 'store'), safeStorage });
  assert.equal((await restarted.get(f.root, chat.id)).messages.at(-1).content, 'Done');
  assert.equal((await restarted.status()).configured, true);
  await assert.rejects(restarted.get(join(f.dir, 'another-workspace'), chat.id), { code: 'ENOENT' });
  await assert.rejects(restarted.get(f.root, '../key'), /Invalid conversation/);
});

test('interrupted tool histories are repaired without assuming that an action failed', async t => {
  const f = await fixture(t);
  const chat = await f.router.create(f.root, MODEL.id);
  const { createHash } = await import('node:crypto');
  const path = join(f.dir, 'store', createHash('sha256').update(f.root).digest('hex'), `${chat.id}.json`);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.messages.push({ role: 'assistant', content: null, tool_calls: [tool('run_command', { command: 'touch file' })] });
  await writeFile(path, JSON.stringify(saved));
  const restored = await f.router.get(f.root, chat.id);
  assert.equal(restored.messages.at(-1).tool_call_id, 'call1');
  assert.match(restored.messages.at(-1).content, /may have completed/);
});

test('malformed tool responses do not execute tools', async t => {
  let calls = 0;
  const f = await fixture(t, { executeTool: async () => { calls++; } });
  const chat = await f.router.create(f.root, MODEL.id);
  f.replies.push(completion(null, [{ id: 'bad', type: 'function', function: { name: 'run_command' } }]));
  await f.router.send(f.root, 1, { id: chat.id, text: 'Do something' });
  assert.equal(calls, 0);
  assert.match((await f.router.get(f.root, chat.id)).notice, /invalid tool calls/);
});

test('model preferences persist per workspace, validate choices, and do not alter existing chats', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.router.modelPreference(f.root), { model: '' });
  const chat = await f.router.create(f.root, MODEL.id);
  await f.router.modelPreference(f.root, MODEL.id);
  const restarted = createOpenRouter({ directory: join(f.dir, 'store'), safeStorage });
  assert.deepEqual(await restarted.modelPreference(f.root), { model: MODEL.id });
  assert.deepEqual(await restarted.modelPreference(join(f.dir, 'another')), { model: '' });
  await assert.rejects(f.router.modelPreference(f.root, 'not/a-model'), /available tool-capable/);
  assert.equal((await f.router.get(f.root, chat.id)).model, MODEL.id);
  assert.equal((await f.router.list(f.root)).length, 1);
});

test('file mentions reach the provider as saved content and history keeps the original snapshot', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'note.md'), 'Saved instructions');
  const chat = await f.router.create(f.root, MODEL.id);
  await f.router.send(f.root, 1, { id: chat.id, text: 'Explain @note.md' });
  const payload = JSON.parse(f.requests.at(-1).init.body);
  const message = payload.messages.find(m => m.role === 'user');
  assert.match(message.content, /Saved instructions/);
  assert.match(message.content, /note.md/);
  assert.equal(message.attachments, undefined); assert.equal(message.displayText, undefined);
  await writeFile(join(f.root, 'note.md'), 'Newer disk contents');
  const saved = await f.router.get(f.root, chat.id);
  assert.equal(saved.messages[0].displayText, 'Explain @note.md');
  assert.equal(saved.messages[0].attachments[0].content, 'Saved instructions');
});

test('invalid attachments reject before a provider call or chat mutation, allowing correction', async t => {
  const f = await fixture(t, { getIgnoredNames: async () => ['ignored.md'] });
  const chat = await f.router.create(f.root, MODEL.id);
  const requestCount = f.requests.length;
  await assert.rejects(f.router.send(f.root, 1, { id: chat.id, text: 'Read @missing.md' }), /no longer exists/);
  await writeFile(join(f.root, 'ignored.md'), 'Secret');
  await assert.rejects(f.router.send(f.root, 1, { id: chat.id, text: 'Read @ignored.md' }), /ignored/);
  assert.equal(f.requests.length, requestCount);
  assert.equal((await f.router.get(f.root, chat.id)).messages.length, 0);
  assert.equal(f.router.busy, false);
  await f.router.send(f.root, 1, { id: chat.id, text: 'Try without files' });
  assert.equal((await f.router.get(f.root, chat.id)).messages.at(-1).content, 'Done');
});

test('retention removes only stale unpinned chats across workspaces; pins persist and deletion is scoped', async t => {
  const f = await fixture(t);
  const old = await f.router.create(f.root, MODEL.id);
  const pinned = await f.router.create(f.root, MODEL.id);
  await f.router.pin(f.root, pinned.id, true);
  const otherRoot = join(f.dir, 'second');
  await mkdir(otherRoot);
  const other = await f.router.create(otherRoot, MODEL.id);
  await f.router.purgeStale(Date.now() + 29 * 86400000);
  assert.equal((await f.router.list(f.root)).length, 2);
  const future = Date.now() + 31 * 86400000;
  await f.router.purgeStale(future);
  await assert.rejects(f.router.get(otherRoot, other.id), /ENOENT/);
  await assert.rejects(f.router.get(f.root, old.id), /ENOENT/);
  assert.equal((await f.router.get(f.root, pinned.id)).pinned, true);
  await assert.rejects(f.router.remove(f.root + '-other', pinned.id), /ENOENT/);
  assert.equal((await f.router.list(f.root))[0].pinned, true);
  await f.router.pin(f.root, pinned.id, false);
  await f.router.purgeStale();
  assert.equal((await f.router.list(f.root)).length, 1);
  await f.router.purgeStale(future);
  assert.equal((await f.router.list(f.root)).length, 0);
  const fresh = await f.router.create(f.root, MODEL.id);
  await f.router.pin(f.root, fresh.id, true);
  await f.router.remove(f.root, fresh.id);
  await assert.rejects(f.router.get(f.root, fresh.id), /ENOENT/);
  assert.equal((await f.router.status()).configured, true);
});

test('active runs cannot be purged, deleted, or pinned during a save', async t => {
  const f = await fixture(t);
  const chat = await f.router.create(f.root, MODEL.id);
  f.replies.push(completion(null, [tool('write_file', { path: 'new.txt', content: 'Hi', expected_sha256: 'new' })]));
  const running = f.router.send(f.root, 1, { id: chat.id, text: 'Write' });
  await waitFor(() => f.events.some(c => c.pending));
  await assert.rejects(f.router.remove(f.root, chat.id), /Stop/);
  await assert.rejects(f.router.pin(f.root, chat.id, true), /Stop/);
  await f.router.purgeStale(Date.now() + 31 * 86400000);
  assert.equal((await f.router.get(f.root, chat.id)).busy, true);
  await f.router.stop(f.root, 1); await running;
  assert.equal((await f.router.list(f.root)).length, 1);
});
