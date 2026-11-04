import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readlink, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { duplicateAgentWorkspace } from '../src/main/create-agent.js';
test('duplicates all files into unique siblings, preserves links, and leaves the original intact', async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'duplicate-agent-')));
  try {
    const source = join(temp, 'agent');
    await mkdir(join(source,'.hidden','nested'), {recursive:true});
    await writeFile(join(source,'.hidden','nested','data'), 'private config');
    await writeFile(join(source,'agent.md'), 'instructions');
    await symlink('agent.md', join(source,'link'));
    await writeFile(join(temp,'agent-copy'), 'existing file');
    const results = await Promise.all([duplicateAgentWorkspace(source), duplicateAgentWorkspace(source)]);
    assert.equal(new Set(results.map(item => item.path)).size, 2);
    for (const result of results) {
      assert.ok(result.path.startsWith(join(temp,'agent-copy-')));
      assert.equal(await readFile(join(result.path,'.hidden','nested','data'),'utf8'), 'private config');
      assert.equal(await readlink(join(result.path,'link')), 'agent.md');
      await writeFile(join(result.path,'agent.md'), 'changed');
    }
    assert.equal(await readFile(join(source,'agent.md'),'utf8'), 'instructions');
    assert.equal(await readFile(join(temp,'agent-copy'),'utf8'), 'existing file');
  } finally { await rm(temp, {recursive:true,force:true}); }
});
