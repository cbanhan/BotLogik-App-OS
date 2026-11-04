// Activity is presentation state. It must never determine whether a PTY accepts input.
const INPUT_TOOLS = new Set(['AskUserQuestion', 'request_user_input', 'requestUserInput']);
const MAX_PENDING = 64;

export class AgentActivity {
  constructor({ generation, provider, agentId, sessionId, conversationId = null, automated = false, onChange = () => {} }) {
    Object.assign(this, { generation, provider, agentId, sessionId, conversationId, automated, onChange });
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    this.state = 'session-open';
    this.detail = provider === 'codex'
      ? 'Session open. If detailed status stays unavailable, review the BotLogik status hooks in Codex /hooks.'
      : 'Session open. Waiting for provider activity events; hooks may be disabled by settings or policy.';
  }

  snapshot() {
    return { generation: this.generation, provider: this.provider, agentId: this.agentId, sessionId: this.sessionId,
      conversationId: this.conversationId, state: this.state, detail: this.detail, sequence: this.sequence };
  }

  publish(state, detail, force = false) {
    if (this.closed || (!force && this.state === state && this.detail === detail)) return;
    this.state = state;
    this.detail = detail;
    this.sequence++;
    this.onChange(this.snapshot());
  }

  active(detail = 'The agent is processing your request.') {
    const pending = [...this.pending.values()];
    if (pending.includes('needs-approval')) this.publish('needs-approval', 'The agent requested a permission decision. Open its terminal to review it.');
    else if (pending.includes('needs-input')) this.publish('needs-input', 'The agent has an explicit question or input request. Open its terminal to answer.');
    else this.publish('working', detail);
  }

  accept(event) {
    if (this.closed || !event || typeof event !== 'object' || event.agent_id || event.isSidechain) return;
    if (this.conversationId && event.session_id && this.conversationId !== event.session_id) {
      // /clear and /resume can replace the conversation inside the same live CLI process.
      if (event.hook_event_name !== 'SessionStart' || !['clear', 'resume', 'compact'].includes(event.source)) return;
      this.conversationId = event.session_id;
    }
    if (!this.conversationId && typeof event.session_id === 'string') this.conversationId = event.session_id;
    const name = event.hook_event_name;
    const tool = String(event.tool_name || '').replace(/^functions\./, '');
    const toolId = event.tool_use_id || event.tool_call_id || tool || 'request';
    switch (name) {
      case 'SessionStart':
        this.pending.clear();
        this.publish(this.automated ? 'working' : 'ready', this.automated ? 'The scheduled task has started.' : 'The session is ready for a prompt.', true);
        break;
      case 'UserPromptSubmit':
        this.pending.clear();
        this.active();
        break;
      case 'PreToolUse':
        if (INPUT_TOOLS.has(tool) && this.pending.size < MAX_PENDING) this.pending.set(toolId, 'needs-input');
        this.active(INPUT_TOOLS.has(tool) ? undefined : 'The agent is using a tool.');
        break;
      case 'PermissionRequest':
        if (this.pending.size < MAX_PENDING) this.pending.set(toolId, INPUT_TOOLS.has(tool) ? 'needs-input' : 'needs-approval');
        this.active();
        break;
      case 'PostToolUse':
      case 'PostToolUseFailure':
        this.pending.delete(toolId);
        this.pending.delete('notification');
        this.active(name === 'PostToolUseFailure' ? 'A tool failed; the agent is handling the result.' : 'The agent is processing a tool result.');
        break;
      case 'Notification':
        if (event.notification_type === 'permission_prompt') this.pending.set('notification', 'needs-approval');
        else if (['elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'].includes(event.notification_type)) this.pending.set('notification', 'needs-input');
        else return; // idle_prompt is a reminder, not evidence that help is needed.
        this.active();
        break;
      case 'Elicitation':
        this.pending.set('elicitation', 'needs-input');
        this.active();
        break;
      case 'ElicitationResult':
        this.pending.delete('elicitation');
        this.pending.delete('notification');
        this.active();
        break;
      case 'PreCompact':
      case 'PostCompact':
        this.active('The agent is managing its conversation context.');
        break;
      case 'Stop':
        this.pending.clear();
        this.publish(event.stop_hook_active ? 'session-open' : 'ready', event.stop_hook_active
          ? 'Completion hooks may continue this turn; waiting for the next activity event.'
          : 'The agent finished responding. This does not mean the entire task is complete.');
        break;
      case 'StopFailure':
        this.pending.clear();
        this.publish('error', 'The provider reported a failed turn. Open the terminal for details.');
        break;
      case 'InputInterrupt':
        this.pending.clear();
        this.publish('session-open', 'An interrupt key was sent. Waiting for the next provider activity event.');
        break;
      case 'SessionEnd':
      case 'Interrupt':
        this.pending.clear();
        this.publish('session-open', name === 'Interrupt' ? 'The turn was interrupted. Waiting for the next provider event.' : 'The provider session is ending.');
        break;
    }
  }

  exit(code, signal, intentional = false) {
    this.pending.clear();
    this.publish(!intentional && (signal || (code !== undefined && code !== 0)) ? 'error' : 'stopped',
      intentional ? 'The session was stopped.' : signal ? 'The agent process exited unexpectedly.' : code ? `The agent exited with code ${code}. Open the terminal for details.` : 'The agent process has exited.');
    this.closed = true;
  }
}
