import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm, symlink, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentWorkspace } from '../src/main/create-agent.js';
import { agentNameError } from '../src/shared/agent-name.js';

test('agent names cannot escape the chosen parent', () => {
  for (const name of ['', '  ', '.', '..', '../escape', '/absolute', 'one/two', 'one\\two', 'bad\0name', 'bad\nname', 'a'.repeat(201)]) assert.ok(agentNameError(name), name);
  assert.equal(agentNameError('Research Assistant'), '');
});

test('create workspace seeds agent.md and never overwrites an existing folder', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'create-agent-test-'));
  const parent = await realpath(temp);
  try {
    const created = await createAgentWorkspace(parent, ' Research Assistant ');
    assert.deepEqual(created, {status:'created', path:join(parent,'Research Assistant')});
    assert.match(await readFile(join(created.path,'agent.md'),'utf8'), /^# Research Assistant\n/);
    await writeFile(join(created.path,'agent.md'), 'Keep my instructions');
    const existing = await createAgentWorkspace(parent, 'Research Assistant');
    assert.equal(existing.status, 'exists');
    assert.equal(await readFile(join(created.path,'agent.md'),'utf8'), 'Keep my instructions');
    const concurrent = await Promise.all([createAgentWorkspace(parent,'Concurrent'), createAgentWorkspace(parent,'Concurrent')]);
    assert.deepEqual(concurrent.map(result=>result.status).sort(), ['created','exists']);
  } finally { await rm(temp,{recursive:true,force:true}); }
});

test('file and symlink collisions are rejected without modifying their targets', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'create-agent-test-'));
  try {
    await writeFile(join(temp,'Existing'),'leave alone');
    await assert.rejects(createAgentWorkspace(temp,'Existing'), /file or link/);
    await mkdir(join(temp,'Target'));
    await symlink(join(temp,'Target'),join(temp,'Linked'));
    await assert.rejects(createAgentWorkspace(temp,'Linked'), /file or link/);
    assert.equal(await readFile(join(temp,'Existing'),'utf8'), 'leave alone');
  } finally { await rm(temp,{recursive:true,force:true}); }
});

test('Claude selection creates only CLAUDE.md and preserves existing folders', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'create-agent-test-'));
  try {
    const created = await createAgentWorkspace(temp, 'Claude Assistant', 'CLAUDE.md');
    assert.deepEqual(await readdir(created.path), ['CLAUDE.md']);
    assert.match(await readFile(join(created.path, 'CLAUDE.md'), 'utf8'), /^# Claude Assistant\n/);
    await writeFile(join(created.path, 'CLAUDE.md'), 'Keep Claude instructions');
    assert.equal((await createAgentWorkspace(temp, 'Claude Assistant', 'agent.md')).status, 'exists');
    assert.deepEqual(await readdir(created.path), ['CLAUDE.md']);
    assert.equal(await readFile(join(created.path, 'CLAUDE.md'), 'utf8'), 'Keep Claude instructions');
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('unsupported instruction filenames are rejected before creating a workspace', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'create-agent-test-'));
  try {
    for (const filename of ['../escape.md', '/tmp/escape.md', 'other.md', '', null]) {
      await assert.rejects(createAgentWorkspace(temp, 'Invalid', filename), /Choose agent.md or CLAUDE.md/);
    }
    assert.deepEqual(await readdir(temp), []);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
