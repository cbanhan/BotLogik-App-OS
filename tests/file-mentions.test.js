import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileMentions, activeFileMention, mentionToken } from '../src/shared/file-mentions.js';
import { findMentionFiles, readMentionFiles } from '../src/main/openrouter-files.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'botlogik-mentions-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('mentions parse paths and quoted names, exclude email addresses, and preserve exact removal ranges', () => {
  const text = 'Read @README.md, @src/main.js and @"docs/My notes.md". Contact a@example.com';
  const result = fileMentions(text);
  assert.deepEqual(result.map(m => m.path), ['README.md', 'src/main.js', 'docs/My notes.md']);
  assert.deepEqual(result.map(m => text.slice(m.start, m.end)), ['@README.md', '@src/main.js', '@"docs/My notes.md"']);
  for (const path of ['src/index.js', 'docs/ü space.md', 'docs/a"quote.md', 'README']) assert.equal(fileMentions(mentionToken(path))[0].path, path);
  assert.equal(activeFileMention('Contact a@example.com', 21), null);
  assert.equal(activeFileMention('Read @src/ma', 12).query, 'src/ma');
  assert.equal(activeFileMention('Read @"My no', 12).query, 'My no');
  const middle = activeFileMention('Read @notes.md next', 9);
  assert.equal(middle.end, 14);
});

test('file search shows relative paths and excludes secrets, symlinks, ignored directories and non-text files', async t => {
  const root = await fixture(t);
  for (const dir of ['src', 'docs', '.git', 'node_modules', 'ignored']) await mkdir(join(root, dir));
  for (const file of ['src/readme.md', 'docs/readme.md', '.env', '.git/config.md', 'node_modules/code.js', 'ignored/note.md', 'photo.png', 'README', 'docs/My notes.md']) await writeFile(join(root, file), 'hello');
  await symlink(join(root, 'src'), join(root, 'linked'));
  const result = await findMentionFiles(root, '', ['ignored']);
  assert.deepEqual(result.files, ['docs/My notes.md', 'docs/readme.md', 'README', 'src/readme.md'].sort((a,b)=>a.localeCompare(b)));
  assert.deepEqual((await findMentionFiles(root, 'src readme')).files, ['src/readme.md']);
  assert.equal(result.limited, false);
});

test('attachments read current disk snapshots, deduplicate, and reject unsafe or unreadable files', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'note.md'), 'Original');
  const before = await readMentionFiles(root, '@note.md');
  await writeFile(join(root, 'note.md'), 'Updated');
  const after = await readMentionFiles(root, '@note.md @note.md');
  assert.equal(after.length, 1); assert.equal(after[0].content, 'Updated'); assert.notEqual(after[0].sha256, before[0].sha256);
  await writeFile(join(root, 'binary.txt'), Buffer.from([0,1,2]));
  await writeFile(join(root, 'invalid.txt'), Buffer.from([255,255]));
  await writeFile(join(root, 'large.md'), 'x'.repeat(50001));
  await writeFile(join(root, '.env'), 'SECRET=yes');
  await mkdir(join(root, 'folder.md'));
  await symlink(join(root, 'note.md'), join(root, 'link.md'));
  for (const text of ['@../outside.md', '@/tmp/outside.md', '@link.md', '@.env', '@binary.txt', '@invalid.txt', '@large.md', '@missing.md', '@folder.md']) await assert.rejects(readMentionFiles(root, text), /Cannot attach/);
  await assert.rejects(readMentionFiles(root, '@note.md', ['note.md']), /ignored/);
  await assert.rejects(readMentionFiles(root, 'Read @"unfinished file.md'), /Finish the quoted/);
});

test('attachment count and combined byte limits are enforced before sending', async t => {
  const root = await fixture(t);
  for (let i=0;i<9;i++) await writeFile(join(root, `${i}.md`), 'x'.repeat(40000));
  await assert.rejects(readMentionFiles(root, '@0.md @1.md @2.md'), /100 KB total/);
  await assert.rejects(readMentionFiles(root, Array.from({length:9}, (_,i)=>`@${i}.md`).join(' ')), /up to 8 files/);
});
