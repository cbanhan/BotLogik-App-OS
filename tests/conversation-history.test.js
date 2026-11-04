import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConversationHistory, parseConversation, resumeCommand } from '../src/main/conversation-history.js';

const claudeId = '11111111-1111-4111-8111-111111111111';
const codexId = '22222222-2222-4222-8222-222222222222';
const jsonl = rows => rows.map(JSON.stringify).join('\n') + '\n';

test('Claude parser handles metadata, tool results, partial writes, titles and child sessions', () => {
  const rows = [
    { type: 'user', cwd: '/workspace', sessionId: claudeId, message: { content: [{ type: 'tool_result', content: 'not a title' }] } },
    { type: 'user', message: { content: [{ type: 'text', text: 'Fix the sidebar layout' }] } },
    { type: 'custom-title', customTitle: 'Sidebar fixes' }
  ];
  const parsed = parseConversation('claude', [...jsonl(rows).split('\n'), '{broken'], claudeId, 1000);
  assert.equal(parsed.title, 'Sidebar fixes');
  assert.equal(parsed.conversationId, claudeId);
  assert.equal(parseConversation('claude', jsonl([...rows, { isSidechain: true }]).split('\n'), claudeId, 1000), null);
});

test('Codex parser ignores injected context and uses the user message', () => {
  const rows = [
    { type: 'session_meta', payload: { id: codexId, cwd: '/workspace', source: 'cli' } },
    { type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions' }] } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Resume my work' } }
  ];
  assert.equal(parseConversation('codex', jsonl(rows).split('\n'), null, 1000).title, 'Resume my work');
  rows[0].payload.source = { subagent: { parent_thread_id: codexId } };
  assert.equal(parseConversation('codex', jsonl(rows).split('\n'), null, 1000), null);
});

test('history filters workspaces, updates cached transcripts, excludes symlinks, and removes deleted sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'botlogik-history-'));
  try {
    const workspace = join(root, 'workspace');
    const claudeRoot = join(root, 'claude');
    const codexRoot = join(root, 'codex');
    const project = join(claudeRoot, 'project');
    const day = join(codexRoot, '2026', '09', '30');
    await Promise.all([mkdir(workspace), mkdir(project, { recursive: true }), mkdir(day, { recursive: true })]);
    const claudePath = join(project, `${claudeId}.jsonl`);
    await writeFile(claudePath, jsonl([{ type: 'user', cwd: workspace, sessionId: claudeId, message: { content: 'First chat' } }]));
    await writeFile(join(day, 'rollout.jsonl'), jsonl([
      { type: 'session_meta', payload: { id: codexId, cwd: workspace } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Second chat' } }
    ]));
    await symlink(claudePath, join(project, 'linked.jsonl'));
    await writeFile(join(project, 'malformed.jsonl'), '{bad json');
    const history = createConversationHistory({ claudeRoot, codexRoot });
    const agents = [{ id: 'a', name: 'Workspace', path: workspace }];
    let entries = await history.list(agents);
    assert.equal(entries.length, 2);
    assert.deepEqual(new Set(entries.map(entry => entry.provider)), new Set(['claude', 'codex']));
    assert.ok(entries.every(entry => entry.agentId === 'a'));
    await appendFile(claudePath, jsonl([{ type: 'custom-title', customTitle: 'Renamed chat' }]));
    entries = await history.list(agents);
    assert.equal(entries.find(entry => entry.provider === 'claude').title, 'Renamed chat');
    await rm(claudePath);
    assert.equal((await history.list(agents)).length, 1);
    assert.equal(history.get('claude', claudeId), undefined);
    assert.equal((await history.list([])).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('resume uses exact provider IDs as arguments without bypass flags or prompts', () => {
  assert.deepEqual(resumeCommand('claude', claudeId), { command: 'claude', args: ['--resume', claudeId] });
  assert.deepEqual(resumeCommand('codex', codexId), { command: 'codex', args: ['resume', codexId] });
  assert.throws(() => resumeCommand('claude', '--dangerously-skip-permissions'));
  assert.throws(() => resumeCommand('other', claudeId));
});
