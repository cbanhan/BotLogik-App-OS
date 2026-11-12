import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentActivity } from './agent-activity.js';
import { activityHookSource } from './activity-hook-source.js';

const execFileAsync = promisify(execFile);
const COMMON_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact', 'Stop'];
const CLAUDE_EVENTS = [...COMMON_EVENTS, 'PostToolUseFailure', 'StopFailure', 'Notification', 'Elicitation', 'ElicitationResult'];
const quoteShell = value => `'${String(value).replace(/'/g, "'\\''")}'`;

export function supportsActivityHooks(provider, version) {
  const match = String(version).match(/(\d+)\.(\d+)\.(\d+)/);
  const minimum = provider === 'claude' ? [2, 1, 236] : provider === 'codex' ? [0, 147, 0] : null;
  if (!match || !minimum) return false;
  const numbers = match.slice(1).map(Number);
  for (let i = 0; i < 3; i++) {
    if (numbers[i] !== minimum[i]) return numbers[i] > minimum[i];
  }
  return true;
}

export function activityHookArgs(provider, command) {
  if (provider === 'claude') {
    const hooks = Object.fromEntries(CLAUDE_EVENTS.map(event => [event, [{ hooks: [{ type: 'command', command, timeout: 1 }] }]]));
    return ['--settings', JSON.stringify({ hooks })];
  }
  if (provider === 'codex') {
    // Session flags form their own hook layer. Existing user/project hooks still run.
    return COMMON_EVENTS.flatMap(event => ['-c', `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=1}]}]`]);
  }
  return [];
}

export function createActivityBridge({ directory, executable = process.execPath, onChange = () => {}, onTrace = () => {},
  getVersion = async (provider, env) => (await execFileAsync(provider, ['--version'], { env, timeout: 2500, maxBuffer: 8192 })).stdout,
  platform = process.platform } = {}) {
  const records = new Map();
  let server;
  let starting;
  let helper;

  async function start() {
    if (starting) return starting;
    starting = (async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      helper = join(directory, 'report-activity.cjs');
      const existing = await readFile(helper, 'utf8').catch(() => null);
      if (existing !== activityHookSource) await writeFile(helper, activityHookSource, { mode: 0o600 });
      server = createServer((request, response) => {
        const token = (request.headers.authorization || '').replace(/^Bearer /, '');
        const record = records.get(token);
        if (request.method !== 'POST' || request.url !== '/activity' || !record || request.headers.origin) {
          response.writeHead(403).end(); request.resume(); return;
        }
        let body = '';
        request.setEncoding('utf8');
        request.on('data', chunk => {
          body += chunk;
          if (body.length > 32768) request.destroy();
        });
        request.on('error', () => {});
        request.on('end', () => {
          try {
            // Recheck after reading: the session may have been replaced in the meantime.
            if (records.get(token) !== record) { response.writeHead(410).end(); return; }
            const event = JSON.parse(body);
            record.accept(event);
            if (!event.agent_id && !event.isSidechain && (!event.session_id || !record.conversationId || event.session_id === record.conversationId)) onTrace(record.snapshot(), event);
            response.writeHead(204).end();
          } catch { response.writeHead(400).end(); }
        });
      });
      server.requestTimeout = 1500;
      server.headersTimeout = 1500;
      server.maxConnections = 64;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      server.unref();
      return server.address().port;
    })().catch(error => { server?.close(); starting = null; throw error; });
    return starting;
  }

  return {
    async prepare({ provider, agentId, sessionId, conversationId, automated, env }) {
      const activity = new AgentActivity({ provider, agentId, sessionId, conversationId, automated,
        generation: randomUUID(), onChange });
      let token;
      const result = { args: [], env: {}, activity,
        dispose(code, signal, intentional = false) {
          if (token) records.delete(token);
          activity.exit(code, signal, intentional);
          onTrace(activity.snapshot(), { hook_event_name: 'BotLogikSessionClosed' });
        } };
      try {
        const version = await getVersion(provider, env);
        result.version = version;
        if (platform === 'win32' || !supportsActivityHooks(provider, version)) {
          activity.detail = 'Session open. Detailed activity is unavailable for this CLI version or platform.';
          onTrace(activity.snapshot(), { hook_event_name: 'BotLogikSessionStarted' });
          return result;
        }
        const port = await start();
        token = randomBytes(32).toString('hex');
        records.set(token, activity);
        // Stable hook command lets Codex retain the user's hook trust between launches.
        // Per-launch credentials stay in the child's environment, never in hook definitions.
        const command = `ELECTRON_RUN_AS_NODE=1 ${quoteShell(executable)} ${quoteShell(helper)}`;
        result.args = activityHookArgs(provider, command);
        result.env = { BOTLOGIK_ACTIVITY_PORT: String(port), BOTLOGIK_ACTIVITY_TOKEN: token };
      } catch {
        if (token) records.delete(token);
        activity.detail = 'Session open. Detailed activity monitoring could not start; terminal controls remain available.';
      }
      onTrace(activity.snapshot(), { hook_event_name: 'BotLogikSessionStarted' });
      return result;
    },
    async close() {
      for (const activity of records.values()) activity.exit(0, null, true);
      records.clear();
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
      server = null;
      starting = null;
    }
  };
}
