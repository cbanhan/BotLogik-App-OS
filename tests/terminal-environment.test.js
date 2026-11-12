import test from 'node:test';
import assert from 'node:assert/strict';
import { freshTerminalEnvironment } from '../src/main/terminal-environment.js';

test('embedded shells do not inherit Apple Terminal restoration state', () => {
  const parent = {
    TERM_PROGRAM: 'Apple_Terminal', TERM_PROGRAM_VERSION: '1', TERM_SESSION_ID: 'parent-session',
    SHELL_SESSION_FILE: '/synthetic/session', SHELL_SESSION_HISTFILE: '/synthetic/history',
    SHELL_SESSION_DID_INIT: '1', SHELL_SESSIONS_DISABLE: '0',
    PATH: '/usr/bin', SHELL: '/bin/zsh', HISTFILE: '/synthetic/.zsh_history', ZDOTDIR: '/synthetic/config'
  };
  const env = freshTerminalEnvironment(parent);
  assert.equal(env.TERM_PROGRAM, 'BotLogik');
  assert.equal(env.SHELL_SESSIONS_DISABLE, '1');
  assert.ok(!('TERM_SESSION_ID' in env));
  assert.ok(!('TERM_PROGRAM_VERSION' in env));
  assert.ok(!Object.keys(env).some(key => key.startsWith('SHELL_SESSION_')));
  for (const key of ['PATH', 'SHELL', 'HISTFILE', 'ZDOTDIR']) assert.equal(env[key], parent[key]);
  assert.equal(parent.TERM_SESSION_ID, 'parent-session');
  assert.deepEqual(freshTerminalEnvironment(parent), env);
});
