// An embedded shell must not resume the Apple Terminal session that launched us.
export function freshTerminalEnvironment(base) {
  const env = { ...base };
  for (const name of Object.keys(env)) {
    if (name === 'TERM_SESSION_ID' || name === 'TERM_PROGRAM_VERSION' || name.startsWith('SHELL_SESSION_')) delete env[name];
  }
  return {
    ...env,
    TERM_PROGRAM: 'BotLogik',
    SHELL_SESSIONS_DISABLE: '1',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor'
  };
}
