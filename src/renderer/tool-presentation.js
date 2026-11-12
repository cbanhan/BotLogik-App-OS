export function toolWorkingLabel(name) {
  if (name === 'run_command') return 'Running commands…';
  if (['read_file', 'list_files', 'search_files'].includes(name)) return 'Reading files…';
  return 'Working…';
}
export function toolResultState(content) {
  try {
    const result = JSON.parse(content);
    if (result?.denied) return 'denied';
    if (result?.error || result?.is_error || result?.timedOut || (Number.isInteger(result?.exitCode) && result.exitCode !== 0) || (Number.isInteger(result?.code) && result.code !== 0) || result?.signal) return 'failed';
    if (!result || (Object.hasOwn(result, 'exitCode') && result.exitCode === null)) return 'unknown';
    return 'completed';
  } catch { return 'unknown'; }
}
export function toolGroupSummary(messages, index, busy, activeTool) {
  const calls = messages[index].tool_calls || [];
  const results = new Map();
  for (const message of messages.slice(index + 1)) {
    if (message.role !== 'tool') break;
    results.set(message.tool_call_id, toolResultState(message.content));
  }
  const states = calls.map(call => results.get(call.id));
  if (states.includes('failed')) return 'Tool failed';
  if (states.includes('denied')) return 'Tool declined';
  if (states.every(state => state === 'completed')) return `Completed · ${calls.length} tool ${calls.length === 1 ? 'call' : 'calls'}`;
  if (busy && states.some(state => !state)) return toolWorkingLabel(activeTool);
  return 'Tool activity · completion unavailable';
}
