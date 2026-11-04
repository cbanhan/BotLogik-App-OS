import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import vm from 'node:vm';

const source = await readFile(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
function section(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
function setup() {
  const calls = [];
  const context = vm.createContext({
    currentFiles: [
      { path: '/workspace/docs', relativePath: 'docs', kind: 'directory', name: 'docs' },
      { path: '/workspace/docs/note.md', relativePath: 'docs/note.md', name: 'note.md', kind: 'file' }
    ],
    selectedTreePath: null, activeAgentId: 'a', currentFilesAgentId: 'a', inlineEntry: null,
    selectedFile: null, selectedFileDirty: false, documentsForEntry: () => [], relocateOpenDocuments() {}, expandedFolders: new Set(),
    agentById: () => ({ id: 'a', path: '/workspace' }), renderFileRows() {},
    document: { getElementById: () => null }, fileList: { querySelectorAll: () => [] },
    expandParentFolders() {}, showToast: text => calls.push(text), starterForAgent: () => null,
    fileAffectsSelection: () => false, updateGitBadge() {}, renderFiles: async () => {},
    window: { botlogik: { files: {
      createFolder: async (...args) => { calls.push(args); return { path: '/workspace/docs/new' }; },
      createFile: async (...args) => { calls.push(args); return { path: '/workspace/docs/new.md' }; },
      move: async (...args) => { calls.push(args); return { path: '/workspace/docs/renamed.md' }; }
    } } }
  });
  vm.runInContext(section('      function joinRelativePath(', '      function hideFileContextMenu('), context);
  vm.runInContext(section('      function selectedCreationDirectory(', '      function showMoveModal('), context);
  return { context, calls };
}

test('creation uses selected folders, file parents, or root and expands its destination', () => {
  const { context: c } = setup();
  assert.equal(c.selectedCreationDirectory(), '');
  c.selectedTreePath = '/workspace/docs/note.md';
  assert.equal(c.selectedCreationDirectory(), 'docs');
  c.selectedTreePath = '/workspace/docs';
  c.beginInlineEntry('folder');
  assert.equal(c.inlineEntry.parent, 'docs');
  assert.ok(c.expandedFolders.has('/workspace/docs'));
  c.cancelInlineEntry();
  assert.equal(c.inlineEntry, null);
});

test('inline names reject paths and duplicates while allowing unchanged rename', () => {
  const { context: c } = setup();
  for (const value of ['', '..', '../escape', 'a/b', 'a\\b', 'a\0b', 'note.md']) {
    assert.ok(c.inlineEntryValidation({ value, parent: 'docs' }), value);
  }
  assert.equal(c.inlineEntryValidation({ value: 'new.md', parent: 'docs' }), '');
  assert.equal(c.inlineEntryValidation({ value: 'note.md', parent: 'docs', target: c.currentFiles[1] }), '');
});

test('creation submits just the name in the chosen directory and prevents duplicate submits', async () => {
  const { context: c, calls } = setup();
  c.beginInlineEntry('folder', 'docs');
  c.inlineEntry.value = 'new';
  await Promise.all([c.confirmInlineEntry(), c.confirmInlineEntry()]);
  assert.deepEqual(calls[0], ['/workspace', 'docs/new']);
  assert.equal(calls.filter(Array.isArray).length, 1);
  assert.equal(c.inlineEntry, null);
  assert.equal(c.selectedTreePath, '/workspace/docs/new');
});

test('failed writes keep the inline draft; changing agents prevents submission', async () => {
  const { context: c } = setup();
  c.beginInlineEntry('file', 'docs');
  c.inlineEntry.value = 'new.md';
  c.window.botlogik.files.createFile = async () => { throw new Error('Already exists'); };
  await c.confirmInlineEntry();
  assert.equal(c.inlineEntry.value, 'new.md');
  assert.equal(c.inlineEntry.error, 'Already exists');
  assert.equal(c.inlineEntry.busy, false);
  c.activeAgentId = 'b';
  c.window.botlogik.files.createFile = () => assert.fail('must not submit in another workspace');
  await c.confirmInlineEntry();
});

test('rename uses the existing move API within the same parent', async () => {
  const { context: c, calls } = setup();
  c.beginInlineEntry('rename', 'docs', c.currentFiles[1]);
  c.inlineEntry.value = 'renamed.md';
  await c.confirmInlineEntry();
  assert.deepEqual(calls[0], ['/workspace', '/workspace/docs/note.md', 'docs/renamed.md']);
});

test('folder creation rejects an existing destination instead of reporting success', async () => {
  const main = await readFile(new URL('../src/main/main.js', import.meta.url), 'utf8');
  const dir = await mkdtemp(join(tmpdir(), 'botlogik-folder-test-'));
  try {
    const c = vm.createContext({ mkdir, dirname, resolveWorkspaceRelativePath: async (_, path) => ({ target: join(dir, path) }) });
    vm.runInContext(main.slice(main.indexOf('async function createWorkspaceFolder('), main.indexOf('async function createWorkspaceFile(')), c);
    await c.createWorkspaceFolder(dir, 'docs/new');
    await assert.rejects(c.createWorkspaceFolder(dir, 'docs/new'), /already exists/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
