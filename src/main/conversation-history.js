import { readdir, lstat, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, basename, dirname } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validConversationId = value => typeof value === 'string' && UUID.test(value);
const cleanTitle = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
const contentText = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(item => ['text', 'input_text'].includes(item.type)).map(item => item.text || '').join(' ') : '';

// Provider transcript formats are internal. Keep tolerant readers isolated here.
export function parseConversation(provider, lines, fallbackId, modifiedAt) {
  let id = provider === 'claude' ? fallbackId : null;
  let cwd = null;
  let title = '';
  let prompt = '';
  let timestamp = 0;
  let child = false;
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (provider === 'claude') {
      if (entry.isSidechain) child = true;
      if (entry.cwd) cwd = entry.cwd;
      if (entry.sessionId) id = entry.sessionId;
      if (entry.type === 'custom-title') title = cleanTitle(entry.customTitle) || title;
      if (!title && entry.type === 'summary') title = cleanTitle(entry.summary);
      if (!prompt && entry.type === 'user' && !entry.isMeta) {
        const text = contentText(entry.message?.content);
        if (text && !text.trim().startsWith('<')) prompt = cleanTitle(text);
      }
    } else {
      const payload = entry.payload || {};
      if (entry.type === 'session_meta') {
        id = payload.id || payload.session_id;
        cwd = payload.cwd;
        child = Boolean(payload.source?.subagent || payload.thread_source?.subagent);
      }
      if (!prompt && entry.type === 'event_msg' && payload.type === 'user_message') prompt = cleanTitle(payload.message);
      if (!prompt && entry.type === 'response_item' && payload.role === 'user') {
        const text = contentText(payload.content);
        if (text && !text.trim().startsWith('<') && !text.startsWith('# AGENTS.md')) prompt = cleanTitle(text);
      }
    }
    const time = Date.parse(entry.timestamp);
    if (Number.isFinite(time)) timestamp = Math.max(timestamp, time);
  }
  if (child || !validConversationId(id) || typeof cwd !== 'string' || !cwd.startsWith('/')) return null;
  return { provider, conversationId: id, cwd, title: title || prompt || `${provider === 'claude' ? 'Claude' : 'Codex'} conversation`, updatedAt: new Date(Math.max(timestamp, modifiedAt)).toISOString() };
}

async function transcriptLines(path, size) {
  const file = await open(path, 'r');
  try {
    // Read the beginning for metadata/first prompt and the end for recent activity.
    const head = Buffer.alloc(Math.min(size, 512 * 1024));
    await file.read(head, 0, head.length, 0);
    if (size <= head.length) return head.toString('utf8').split('\n');
    const tail = Buffer.alloc(Math.min(size - head.length, 128 * 1024));
    await file.read(tail, 0, tail.length, size - tail.length);
    return [...head.toString('utf8').split('\n').slice(0, -1), ...tail.toString('utf8').split('\n').slice(1)];
  } finally { await file.close(); }
}

async function collectFiles(root, depth, result = []) {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    if (result.length >= 10000) break;
    const path = join(root, entry.name);
    if (entry.isDirectory() && depth > 0 && entry.name !== 'subagents') await collectFiles(path, depth - 1, result);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) result.push(path);
  }
  return result;
}

async function codexTitles(root) {
  const titles = new Map();
  let file;
  try {
    file = await open(join(dirname(root), 'session_index.jsonl'), 'r');
    const { size } = await file.stat();
    const buffer = Buffer.alloc(Math.min(size, 2 * 1024 * 1024));
    await file.read(buffer, 0, buffer.length, size - buffer.length);
    const lines = buffer.toString('utf8').split('\n');
    for (const line of size > buffer.length ? lines.slice(1) : lines) {
      try {
        const entry = JSON.parse(line);
        if (validConversationId(entry.id) && cleanTitle(entry.thread_name)) titles.set(entry.id, cleanTitle(entry.thread_name));
      } catch {}
    }
  } catch { /* Older installations may not have a title index. */ }
  finally { await file?.close(); }
  return titles;
}

export function createConversationHistory({ claudeRoot = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects'), codexRoot = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions') } = {}) {
  const cache = new Map();
  let current = new Map();
  let pending = null;
  async function scan(agents) {
    const workspaces = new Map();
    for (const agent of agents) {
      try { workspaces.set(await realpath(agent.path), agent); } catch {}
    }
    const found = new Map();
    const seenFiles = new Set();
    const titles = await codexTitles(codexRoot);
    for (const [provider, root, depth] of [['claude', claudeRoot, 1], ['codex', codexRoot, 3]]) {
      for (const path of await collectFiles(root, depth)) {
        seenFiles.add(path);
        try {
          const info = await lstat(path);
          if (!info.isFile()) continue;
          let record = cache.get(path);
          if (!record || record.mtime !== info.mtimeMs || record.size !== info.size) {
            const summary = parseConversation(provider, await transcriptLines(path, info.size), basename(path, '.jsonl'), info.mtimeMs);
            record = { mtime: info.mtimeMs, size: info.size, summary };
            cache.set(path, record);
          }
          if (!record.summary) continue;
          const canonical = await realpath(record.summary.cwd).catch(() => resolve(record.summary.cwd));
          const agent = workspaces.get(canonical);
          if (!agent) continue;
          const key = `${provider}:${record.summary.conversationId}`;
          const conversation = { ...record.summary, agentId: agent.id, agentName: agent.name };
          if (provider === 'codex' && titles.has(conversation.conversationId)) conversation.title = titles.get(conversation.conversationId);
          if (!found.has(key) || found.get(key).updatedAt < conversation.updatedAt) found.set(key, conversation);
        } catch { /* Deleted, unreadable or partially written transcripts do not break history. */ }
      }
    }
    for (const path of cache.keys()) if (!seenFiles.has(path)) cache.delete(path);
    current = found;
    return [...found.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }
  return {
    list(agents) {
      if (!pending) pending = scan(agents).finally(() => { pending = null; });
      return pending;
    },
    get(provider, id) { return current.get(`${provider}:${id}`); }
  };
}

export function resumeCommand(provider, id) {
  if (!validConversationId(id)) throw new Error('Invalid conversation ID');
  if (provider === 'claude') return { command: 'claude', args: ['--resume', id] };
  if (provider === 'codex') return { command: 'codex', args: ['resume', id] };
  throw new Error('Unsupported conversation provider');
}
