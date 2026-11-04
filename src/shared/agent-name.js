export function agentNameError(value) {
  const name = String(value || '').trim();
  if (!name) return 'Enter a name for your agent.';
  if (name === '.' || name === '..' || /[<>:"/\\|?*\x00-\x1f]/.test(name)) {
    return 'Use a folder name without slashes or special path characters.';
  }
  if (name.endsWith('.')) return 'The name cannot end with a period.';
  if (new TextEncoder().encode(name).length > 200) return 'Use a shorter agent name (up to 200 bytes).';
  return '';
}
