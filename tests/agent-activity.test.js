import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentActivity } from '../src/main/agent-activity.js';
import { activityStatusInfo, isCurrentActivity } from '../src/renderer/activity-status.js';

function tracker(provider = 'claude') {
  return new AgentActivity({ generation: 'launch-1', provider, agentId: 'a', sessionId: 'terminal', conversationId: 'conversation' });
}
const event = (hook_event_name, fields = {}) => ({ hook_event_name, session_id: 'conversation', ...fields });

test('prompt, tool, permission, answer and completion transitions keep the process separate', () => {
  const state = tracker();
  assert.equal(state.snapshot().state, 'session-open');
  state.accept(event('SessionStart')); assert.equal(state.state, 'ready');
  state.accept(event('UserPromptSubmit')); assert.equal(state.state, 'working');
  state.accept(event('PermissionRequest', { tool_name: 'Bash', tool_use_id: 'tool-1' }));
  assert.equal(state.state, 'needs-approval');
  state.accept(event('PostToolUse', { tool_name: 'Bash', tool_use_id: 'unrelated' }));
  assert.equal(state.state, 'needs-approval');
  state.accept(event('PostToolUse', { tool_name: 'Bash', tool_use_id: 'tool-1' }));
  assert.equal(state.state, 'working');
  state.accept(event('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'q' }));
  assert.equal(state.state, 'needs-input');
  state.accept(event('PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'q' }));
  state.accept(event('Stop')); assert.equal(state.state, 'ready');
  assert.equal(activityStatusInfo('running', state.snapshot()).label, 'Ready');
  assert.equal(activityStatusInfo('idle', state.snapshot()), null);
});

test('idle reminders, child events and events for other conversations do not change activity', () => {
  const state = tracker();
  state.accept(event('UserPromptSubmit'));
  const before = state.snapshot();
  state.accept(event('Notification', { notification_type: 'idle_prompt' }));
  state.accept(event('Stop', { agent_id: 'child' }));
  state.accept(event('Stop', { session_id: 'another-conversation' }));
  assert.deepEqual(state.snapshot(), before);
  state.accept(event('Notification', { notification_type: 'permission_prompt' }));
  assert.equal(state.state, 'needs-approval');
});

test('failed tools allow recovery; confirmed turn/process failures become Error', () => {
  const state = tracker();
  state.accept(event('PostToolUseFailure')); assert.equal(state.state, 'working');
  state.accept(event('StopFailure')); assert.equal(state.state, 'error');
  state.accept(event('UserPromptSubmit')); assert.equal(state.state, 'working');
  state.exit(1, null); assert.equal(state.state, 'error');
  assert.equal(activityStatusInfo('stopped', state.snapshot()).label, 'Error');
  const before = state.snapshot();
  state.accept(event('Stop')); assert.deepEqual(state.snapshot(), before);
});

test('interrupts clear attention; stop-hook continuations fall back instead of claiming completion', () => {
  const state = tracker('codex');
  state.accept(event('PreToolUse', { tool_name: 'request_user_input' }));
  assert.equal(state.state, 'needs-input');
  state.accept(event('InputInterrupt')); assert.equal(state.state, 'session-open');
  state.accept(event('UserPromptSubmit')); assert.equal(state.state, 'working');
  state.accept(event('Stop', { stop_hook_active: true })); assert.equal(state.state, 'session-open');
  state.exit(1, 'SIGTERM', true); assert.equal(state.state, 'stopped');
});

test('new launch generations and out-of-order activity cannot overwrite the current sidebar status', () => {
  const state = tracker();
  const before = state.snapshot();
  state.accept(event('UserPromptSubmit'));
  assert.equal(isCurrentActivity(before, state.snapshot()), true);
  assert.equal(isCurrentActivity(state.snapshot(), before), false);
  assert.equal(isCurrentActivity(before, { ...state.snapshot(), generation: 'old-launch' }), false);
  assert.equal(isCurrentActivity(before, { ...state.snapshot(), agentId: 'other' }), false);
  assert.equal(activityStatusInfo('running', null).label, 'Session open');
});


test('in-terminal conversation switches adopt the new ID and reject late events from the old conversation', () => {
  const state = tracker();
  state.accept(event('SessionStart'));
  const before = state.snapshot();
  state.accept(event('SessionStart', { source: 'clear', session_id: 'new-conversation' }));
  assert.equal(state.conversationId, 'new-conversation');
  assert.ok(state.sequence > before.sequence);
  state.accept(event('PermissionRequest'));
  assert.equal(state.state, 'ready');
  state.accept(event('UserPromptSubmit', { session_id: 'new-conversation' }));
  assert.equal(state.state, 'working');
});
