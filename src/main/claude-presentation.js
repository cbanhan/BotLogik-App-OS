// Conservatively enable the documented Focus/fullscreen settings on the verified
// baseline or newer. Older versions keep their native presentation.
export function applyClaudeFocus({ provider, mode, version, args, env }) {
  if (provider !== 'claude' || mode === 'prompt') return '';
  const match = String(version || '').match(/(\d+)\.(\d+)\.(\d+)/);
  const [major, minor, patch] = match ? match.slice(1).map(Number) : [];
  if (!match || !(major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 311))))) {
    return 'Reduce tool clutter needs Claude Code 2.1.311 or newer. This session will use the normal view.';
  }
  const index = args.indexOf('--settings');
  if (index >= 0) {
    const settings = JSON.parse(args[index + 1]);
    args[index + 1] = JSON.stringify({ ...settings, tui: 'fullscreen', viewMode: 'focus' });
  } else args.push('--settings', JSON.stringify({ tui: 'fullscreen', viewMode: 'focus' }));
  env.CLAUDE_CODE_NO_FLICKER = '1';
  env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = '0';
  return '';
}
