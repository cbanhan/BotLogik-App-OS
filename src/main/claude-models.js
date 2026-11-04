import { spawn } from 'node:child_process';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,199}$/.test(value);

export function normalizeClaudeModels(models) {
  if (!Array.isArray(models)) throw new Error('Claude Code did not return a model list.');
  const result = new Map();
  for (const model of models) {
    if (!validId(model.value)) continue;
    const id = model.value === 'default' ? '' : model.value;
    const resolvedModel = validId(model.resolvedModel) ? model.resolvedModel : '';
    const alias = id && resolvedModel && id !== resolvedModel;
    const name = String(model.displayName || model.value);
    const efforts = Array.isArray(model.supportedEffortLevels)
      ? model.supportedEffortLevels.filter(level => EFFORTS.includes(level))
      : model.supportsEffort ? ['low', 'medium', 'high'] : [];
    result.set(id, { id, label: `${name}${!id && resolvedModel ? ' · ' + resolvedModel : ''}${alias ? ' · latest alias' : ''}`, resolvedModel, efforts });
    if (alias && !result.has(resolvedModel)) {
      result.set(resolvedModel, { id: resolvedModel, label: `${name} · pinned`, resolvedModel, efforts });
    }
  }
  if (!result.size) throw new Error('Claude Code returned no usable models.');
  return [...result.values()];
}

// The same initialize control exchange used by the Agent SDK's supportedModels().
// No user message is sent: no model inference, tools, hooks, or saved chat.
// https://code.claude.com/docs/en/agent-sdk/typescript#modelinfo
export function discoverClaudeModels({ cwd, env = process.env, timeoutMs = 12000, spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    let timer;
    let settled = false;
    let pending = '';
    let bytes = 0;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.stdin.destroy();
      child?.kill('SIGKILL');
      if (error) reject(error); else resolve(value);
    };
    try {
      child = spawnProcess('claude', [
        '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--settings', '{"disableAllHooks":true}', '--tools', ''
      ], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      timer = setTimeout(() => finish(new Error('Claude Code model discovery timed out.')), timeoutMs);
      child.on('error', () => finish(new Error('Could not start the installed Claude Code.')));
      child.on('close', () => finish(new Error('Claude Code closed before returning its models.')));
      child.stdin.on('error', () => finish(new Error('Could not query Claude Code models.')));
      child.stderr.resume();
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) return finish(new Error('Claude Code model response was too large.'));
        pending += chunk.toString();
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0 && !settled) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.type !== 'control_response' || message.response?.request_id !== 'botlogik-models') continue;
          if (message.response.subtype !== 'success') return finish(new Error('Claude Code could not list its models.'));
          try {
            const response = message.response.response;
            finish(null, { models: normalizeClaudeModels(response.models), version: response.claude_code_version || '' });
          } catch (error) { finish(error); }
        }
      });
      child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'botlogik-models', request: { subtype: 'initialize' } }) + '\n');
    } catch { finish(new Error('Could not query the installed Claude Code.')); }
  });
}

export function assertClaudeModelSupported(execution, catalog) {
  if (catalog.claudeError || !catalog.claude?.length) {
    throw new Error('Could not verify supported Claude models. Reopen schedule settings and retry.');
  }
  const model = catalog.claude.find(item => item.id === (execution.model || ''));
  if (!model) throw new Error('This model is no longer listed by the installed Claude Code. Choose a supported model in schedule settings.');
  const effort = execution.reasoningEffort || 'medium';
  if (effort !== 'default' && model.efforts && !model.efforts.includes(effort)) {
    throw new Error('Choose a supported reasoning effort for this Claude model.');
  }
}
