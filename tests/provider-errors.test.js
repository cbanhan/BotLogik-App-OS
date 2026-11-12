import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCli } from '../src/main/cli-discovery.js';
import { describeFailure, redactDetails } from '../src/renderer/provider-errors.js';

test('CLI discovery uses executable files and reports missing tools without claiming they are uninstalled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'botlogik-cli-'));
  try {
    await writeFile(join(root, 'claude'), 'fixture');
    await assert.rejects(resolveCli('claude', { PATH: root }), /EACCES/);
    await chmod(join(root, 'claude'), 0o700);
    assert.equal(await resolveCli('claude', { PATH: root }), join(root, 'claude'));
    await mkdir(join(root, 'codex'));
    await assert.rejects(resolveCli('codex', { PATH: root }), /CLI_NOT_FOUND/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('persistent diagnostic summaries exclude arbitrary messages and secrets', () => {
  const message = 'private prompt /private/workspace sk-or-secret-token';
  const result = describeFailure('OpenRouter', 'request', message);
  assert.ok(!JSON.stringify(result).includes(message));
  assert.ok(!redactDetails(message).includes('sk-or-secret-token'));
  assert.equal(describeFailure('Claude', 'launch', 'CLI_NOT_FOUND').reason, 'not-found');
  assert.equal(describeFailure('OpenRouter', 'request', 'Invalid API key').reason, 'authentication');
});
