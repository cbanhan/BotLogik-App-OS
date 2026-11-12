// Keep this function self-contained: the CLI hook embeds it without dependencies.
export function traceDetails(value, limit = 2000) {
  function clean(item, depth = 0) {
    if (depth > 5) return '[nested data omitted]';
    if (typeof item === 'string') return item.slice(0, 8000)
      .replace(/(?:sk-[\w-]+|gh[pousr]_[\w]+|Bearer\s+[^\s"']+)/gi, '[redacted]')
      .replace(/(--(?:api[-_]?key|password|secret|token)\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/gi, '$1[redacted]')
      .replace(/((?:api[_-]?key|password|passwd|secret|token|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]');
    if (Array.isArray(item)) return item.slice(0, 30).map(v => clean(v, depth + 1));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).slice(0, 40).map(([key, v]) => [key,
      /password|secret|token|authorization|api.?key|reasoning|thinking/i.test(key) ? '[redacted]' : clean(v, depth + 1)]));
    return item;
  }
  let text;
  try { const result = clean(value); text = typeof result === 'string' ? result : JSON.stringify(result); } catch { text = '[unavailable]'; }
  text = text || '';
  return text.length > limit ? text.slice(0, limit) + '\n[truncated]' : text;
}
