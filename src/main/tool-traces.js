import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { traceDetails } from '../shared/trace-details.js';

const TOOL_EVENTS = new Set(['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure']);
export function createToolTraces({ path, onChange = () => {}, now = () => Date.now() }) {
  let sessions = [], queue = Promise.resolve(), storageError = '';
  const ready = readFile(path, 'utf8').then(text => {
    sessions = JSON.parse(text);
    if (!Array.isArray(sessions)) sessions = [];
    sessions = sessions.filter(s => s && typeof s.id === 'string' && typeof s.agentId === 'string' && Array.isArray(s.tools) && Number.isFinite(s.updatedAt));
    for (const session of sessions) {
      session.active = false;
      for (const tool of session.tools || []) if (['running', 'waiting'].includes(tool.status)) tool.status = 'unknown';
    }
  }).catch(error => { if (error.code !== 'ENOENT') storageError = 'Saved tool traces could not be read.'; });
  function trim() {
    sessions = sessions.filter(s => now() - s.updatedAt < 30 * 86400000).sort((a, b) => a.updatedAt - b.updatedAt).slice(-50);
    let remaining = 1000;
    for (const session of [...sessions].reverse()) {
      session.tools = session.tools.slice(-Math.min(200, remaining));
      if (!remaining) session.tools = [];
      remaining -= session.tools.length;
    }
  }
  function change(fn) {
    queue = queue.then(async () => {
      await ready; fn(); trim();
      try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path + '.tmp', JSON.stringify(sessions), { mode: 0o600 });
        await rename(path + '.tmp', path); storageError = '';
      } catch { storageError = 'Tool traces are visible, but could not be saved on this Mac.'; }
      onChange();
    }).catch(() => { storageError = 'A tool trace could not be recorded.'; });
    return queue;
  }
  function sessionFor(context) {
    let session = sessions.find(s => s.agentId === context.agentId && s.provider === context.provider && s.id === context.id);
    if (!session) {
      if (context.conversationId) sessions = sessions.filter(s => !(s.agentId === context.agentId && s.provider === context.provider && !s.conversationId && !s.tools.length));
      session = { id: context.id, agentId: context.agentId, provider: context.provider, conversationId: context.conversationId || null,
        startedAt: now(), updatedAt: now(), turn: 0, active: true, availability: 'Waiting for provider events; hooks may be disabled.', tools: [] };
      sessions.push(session);
    }
    session.updatedAt = now();
    if (context.conversationId) session.conversationId = context.conversationId;
    return session;
  }
  return {
    begin(context, availability) { return change(() => { const s = sessionFor(context); s.active = true; s.availability = availability; }); },
    event(context, event) {
      if (!context.agentId || !context.id) return Promise.resolve();
      return change(() => {
        const s = sessionFor(context), name = event.hook_event_name;
        if (s.conversationId && event.session_id && s.conversationId !== event.session_id) return;
        s.availability = 'Receiving tool activity';
        if (name === 'UserPromptSubmit') {
          for (const tool of s.tools) if (['running', 'waiting'].includes(tool.status)) tool.status = 'unknown';
          s.turn++; s.active = true;
        }
        if (['Stop', 'SessionEnd', 'Interrupt', 'StopFailure'].includes(name)) {
          for (const tool of s.tools) if (['running', 'waiting'].includes(tool.status)) tool.status = 'unknown';
        }
        if (!TOOL_EVENTS.has(name)) return;
        const callId = event.tool_use_id || event.tool_call_id;
        let tool = callId && s.tools.find(t => t.callId === callId && t.turn === s.turn);
        if (!tool) {
          tool = { id: randomUUID(), callId: callId || null, turn: s.turn, name: traceDetails(event.tool_name || 'Tool', 100),
            startedAt: name === 'PreToolUse' ? now() : null, observedAt: now(), status: 'unknown', input: '', output: '' };
          s.tools.push(tool);
        }
        if (event.tool_input !== undefined) tool.input = traceDetails(event.tool_input);
        if (name === 'PreToolUse') { tool.status = 'running'; tool.startedAt ??= now(); }
        if (name === 'PermissionRequest') tool.status = 'waiting';
        if (name === 'PostToolUse' || name === 'PostToolUseFailure') {
          let response = event.tool_response;
          if (typeof response === 'string') { try { response = JSON.parse(response); } catch {} }
          const failed = event.tool_failed === true || name === 'PostToolUseFailure' || response?.is_error === true || response?.success === false || Boolean(response?.error) || (Number.isInteger(response?.exit_code) && response.exit_code !== 0);
          tool.status = failed ? 'failed' : event.denied || response?.denied === true ? 'denied' : 'succeeded';
          tool.finishedAt = now();
          tool.output = traceDetails(event.tool_response ?? event.error ?? 'Result not supplied by provider.');
        }
      });
    },
    end(context) { return change(() => {
      const s = sessionFor(context); s.active = false;
      for (const tool of s.tools) if (['running', 'waiting'].includes(tool.status)) tool.status = 'unknown';
    }); },
    async list(agentId) { await ready; await queue; trim(); return { sessions: structuredClone(sessions.filter(s => s.agentId === agentId)), storageError }; },
    clear(agentId, id) { return change(() => { sessions = sessions.filter(s => s.agentId !== agentId || (id && s.id !== id)); }); },
    flush() { return queue; }
  };
}
