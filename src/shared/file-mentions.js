// Mentions are relative paths. Quoted mentions support spaces, Unicode and punctuation.
export function fileMentions(text) {
  const result = [];
  const pattern = /(^|[\s(])@("(?:\\.|[^"\\])*"|[^\s,;!?()[\]{}<>"`]+)/gu;
  for (const match of String(text).matchAll(pattern)) {
    const raw = match[2];
    let path;
    try { path = raw.startsWith('"') ? JSON.parse(raw) : raw.replace(/[.:]+$/, ''); } catch { continue; }
    if (!path) continue;
    const start = match.index + match[1].length;
    const end = start + 1 + (raw.startsWith('"') ? raw.length : path.length);
    result.push({ path, start, end });
  }
  return result;
}

export function mentionToken(path) {
  return `@${/^[\w./-]+$/.test(path) ? path : JSON.stringify(path)}`;
}

export function activeFileMention(text, cursor) {
  const prefix = text.slice(0, cursor);
  const match = /(^|[\s(])@([^\s@"`]*|"(?:\\.|[^"\\])*)$/.exec(prefix);
  if (!match) return null;
  const start = match.index + match[1].length;
  const full = fileMentions(text).find(item => item.start === start);
  const query = match[2].startsWith('"') ? match[2].slice(1).replace(/\\"/g, '"').replace(/\\\\/g, '\\') : match[2];
  return { start, end: full?.end || cursor, query };
}
