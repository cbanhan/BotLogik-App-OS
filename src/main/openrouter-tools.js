import { lstat, realpath, readdir, mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, relative, join, dirname, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const LIMIT = 100_000;
const hidden = name => ['.git', '.ssh', '.aws', '.agent-logik', 'node_modules', '.venv'].includes(name) || (name.startsWith('.env') && name !== '.env.example');
const hash = text => createHash('sha256').update(text).digest('hex');
const schema = (name, description, properties, required) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
const string = { type: 'string' };
export const localTools = [
  schema('list_files', 'List a workspace directory. Use . for the root. Secret and dependency directories are excluded.', { path: string }, ['path']),
  schema('read_file', 'Read a UTF-8 workspace file and its sha256, required when overwriting it. Maximum 100 KB.', { path: string }, ['path']),
  schema('search_files', 'Search literal text recursively in workspace files; bounded to 1000 files and 100 matches.', { query: string }, ['query']),
  schema('write_file', 'Create or replace a UTF-8 file after user approval. For existing files supply sha256 from read_file; for new files use "new". Parent directories are created.', { path: string, content: string, expected_sha256: string }, ['path', 'content', 'expected_sha256']),
  schema('run_command', 'Run a shell command in the workspace after explicit approval. Commands have user permissions, are not sandboxed, and stop after 120 seconds. Do not start background services.', { command: string }, ['command'])
];

export async function workspacePath(root, input, { missing = false } = {}) {
  if (typeof input !== 'string' || !input || input.length > 4096 || isAbsolute(input) || input.includes('\0')) throw new Error('Use a relative workspace path.');
  const parts = input.split(/[\\/]/).filter(p => p && p !== '.');
  if (parts.some(p => p === '..' || hidden(p))) throw new Error('This path is outside the permitted workspace files.');
  const canonical = await realpath(root);
  if (canonical !== resolve(root)) throw new Error('Workspace location changed. Reopen the conversation.');
  let target = canonical;
  for (const part of parts) {
    target = join(target, part);
    try { if ((await lstat(target)).isSymbolicLink()) throw new Error('Symlinks are not permitted.'); }
    catch (e) { if (!(missing && e.code === 'ENOENT')) throw e; }
  }
  if (relative(canonical, target).startsWith('..')) throw new Error('Path escapes workspace.');
  return target;
}

async function textFile(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > LIMIT) throw new Error('Only text files up to 100 KB can be read.');
    const text = await handle.readFile('utf8');
    if (text.includes('\0')) throw new Error('Binary files are not supported.');
    return text;
  } finally { await handle.close(); }
}

export function runCommand(command, root, signal, { timeout = 120_000 } = {}) {
  signal.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    // Do not expose the app process environment (which may contain provider credentials).
    const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    env.PATH = [env.PATH, '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':');
    const child = spawn('/bin/zsh', ['-f', '-c', command], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false;
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
    signal.addEventListener('abort', kill, { once: true });
    const collect = data => { if (output.length < 30_000) output += data.toString().slice(0, 30_000 - output.length); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', kill); kill(); };
    child.once('error', e => { cleanup(); reject(e); });
    child.once('close', code => {
      cleanup();
      if (signal.aborted) return reject(new Error('Stopped by user.'));
      resolveResult({ exitCode: code, timedOut, output, truncated: output.length >= 30_000 });
    });
  });
}

export async function executeLocalTool(root, name, args, { signal, approve }) {
  signal.throwIfAborted();
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid tool arguments.');
  if (name === 'run_command') {
    if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 10_000) throw new Error('Invalid command.');
    if (!await approve({ name, command: args.command, warning: 'This command runs with your user permissions, outside a sandbox. It can access files and the network beyond this workspace.' })) return { denied: true, message: 'User denied this command. Do not retry it.' };
    signal.throwIfAborted();
    return runCommand(args.command, await realpath(root), signal);
  }
  if (name === 'search_files') {
    if (typeof args.query !== 'string' || !args.query || args.query.length > 1000) throw new Error('Provide a search query (1–1000 characters).');
    const matches = []; let count = 0;
    const walk = async (dir, depth = 0) => {
      if (depth > 12) return;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        signal.throwIfAborted();
        if (count >= 1000 || matches.length >= 100) return;
        if (hidden(entry.name) || entry.isSymbolicLink()) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { count++; await walk(await workspacePath(root, relative(root, path)), depth + 1); }
        else if (entry.isFile()) {
          count++;
          try { const text = await textFile(await workspacePath(root, relative(root, path))); text.split('\n').forEach((line, i) => { if (line.includes(args.query) && matches.length < 100) matches.push({ path: relative(root, path), line: i + 1, text: line.slice(0, 500) }); }); } catch {}
        }
      }
    };
    await walk(root); return { matches, limited: count >= 1000 || matches.length >= 100 };
  }
  if (!['read_file', 'list_files', 'write_file'].includes(name)) throw new Error('Unknown local tool.');
  let target = await workspacePath(root, args.path, { missing: name === 'write_file' });
  if (name === 'list_files') return (await readdir(target, { withFileTypes: true })).filter(e => !hidden(e.name) && !e.isSymbolicLink()).slice(0, 500).map(e => ({ name: e.name, directory: e.isDirectory() }));
  if (name === 'read_file') { const content = await textFile(target); return { content, sha256: hash(content) }; }
  if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > LIMIT || args.content.includes('\0') || typeof args.expected_sha256 !== 'string') throw new Error('Provide text up to 100 KB and expected_sha256.');
  const check = async () => {
    try { if ((await lstat(target)).nlink > 1) throw new Error('Cannot overwrite a file with hard links.'); const current = await textFile(target); if (hash(current) !== args.expected_sha256) throw new Error('File changed. Read it again before editing.'); return current; }
    catch (e) { if (e.code === 'ENOENT' && args.expected_sha256 === 'new') return null; throw e; }
  };
  const before = await check();
  if (!await approve({ name, path: args.path, before, after: args.content })) return { denied: true, message: 'User denied this edit. Do not retry it.' };
  signal.throwIfAborted();
  target = await workspacePath(root, args.path, { missing: true });
  await check();
  await mkdir(dirname(target), { recursive: true });
  target = await workspacePath(root, args.path, { missing: true });
  signal.throwIfAborted();
  const handle = await open(target, constants.O_WRONLY | constants.O_NOFOLLOW | (before === null ? constants.O_CREAT | constants.O_EXCL : 0), 0o600);
  try {
    if (before !== null) {
      // Check again before truncation; concurrent external edits must not be silently overwritten.
      await check();
      await handle.truncate(0);
    }
    await handle.writeFile(args.content, 'utf8');
  } finally { await handle.close(); }
  return { saved: args.path, sha256: hash(args.content) };
}
