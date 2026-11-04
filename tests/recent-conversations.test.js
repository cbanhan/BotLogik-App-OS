import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
function functionSource(name, next) {
  return source.slice(source.indexOf(`      ${name}`), source.indexOf(next, source.indexOf(`      ${name}`)));
}

test('history separates automated runs and chats, scopes agents, and paginates columns independently', () => {
  const lists = Object.fromEntries(['home-chats', 'home-runs', 'agent-chats', 'agent-runs'].map(id => [id, {
    rows: [], set innerHTML(value) { this.rows = []; this.empty = value; }, appendChild(row) { this.rows.push(row); }
  }]));
  const more = { classList: { toggle() {} }, setAttribute() {} };
  let clicked;
  const context = {
    document: { getElementById: id => lists[id] || more, createElement: () => ({ addEventListener(event, handler) { this.click = handler; } }) },
    recentSessions: [{ agentId: 'a', provider: 'claude', conversationId: 'one', updatedAt: '2026-09-30T11:00:00Z', title: 'Saved task' }, { agentId: 'removed', provider: 'codex', conversationId: 'hidden', updatedAt: '2026-09-30T12:00:00Z' }],
    scheduledRunsByAgent: new Map([['a', [{ id: 'run', agentId: 'a', conversationId: 'one', startedAt: '2026-09-30T10:00:00Z', status: 'completed' }, { id: 'old', agentId: 'a', startedAt: '2026-09-29T10:00:00Z', status: 'failed' }]]]),
    agentById: id => ['a', 'b'].includes(id) ? { name: id } : null,
    activeAgentId: null, agentShowAllChats: false, homeShowAllChats: false,
    historyShowAllRuns: { home: false, agent: false }, scheduleExecutionLabel: () => 'Claude',
    esc: value => value, formatRunTimestamp: value => value, scheduledRunStatusClass: () => '',
    resumeConversation: session => { clicked = session.conversationId; }, showScheduledRunsModal: (agent, run) => { clicked = run; }
  };
  vm.createContext(context);
  vm.runInContext(functionSource('function renderRecentSessions()', "      document.getElementById('home-chats-more')"), context);
  context.renderRecentSessions();
  assert.equal(lists['home-chats'].rows.length, 0); // linked scheduled conversation is not duplicated
  assert.equal(lists['home-runs'].rows.length, 2);
  assert.match(lists['home-runs'].rows[0].innerHTML, /Details/);
  lists['home-runs'].rows[0].click(); assert.equal(clicked, 'run');
  lists['home-runs'].rows[1].click(); assert.equal(clicked, 'old');
  context.recentSessions = Array.from({ length: 15 }, (_, i) => ({ agentId: 'a', provider: 'codex', conversationId: `c${i}`, updatedAt: '2026-09-30T11:00:00Z', title: 'Chat' }));
  context.renderRecentSessions(); assert.equal(lists['home-chats'].rows.length, 10);
  context.homeShowAllChats = true;
  context.renderRecentSessions(); assert.equal(lists['home-chats'].rows.length, 15);
  assert.equal(lists['home-runs'].rows.length, 2);
  context.recentSessions.unshift({ agentId: 'b', provider: 'codex', conversationId: 'other', updatedAt: '2026-10-01T12:00:00Z', title: 'Other agent' });
  context.activeAgentId = 'a';
  context.renderRecentSessions();
  assert.equal(lists['agent-chats'].rows.length, 10);
  assert.ok(lists['agent-chats'].rows.every(row => !row.innerHTML.includes('Other agent')));
  context.agentShowAllChats = true;
  context.renderAgentRecentSessions();
  assert.equal(lists['agent-chats'].rows.length, 15);
  lists['agent-chats'].rows[0].click(); assert.equal(clicked, 'c0');
  assert.equal(lists['agent-runs'].rows.length, 2);
  context.scheduledRunsByAgent.set('a', Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, agentId: 'a', startedAt: '2026-09-30T10:00:00Z', status: 'completed' })));
  context.renderAgentRecentSessions(); assert.equal(lists['agent-runs'].rows.length, 10);
  context.historyShowAllRuns.agent = true;
  context.renderAgentRecentSessions(); assert.equal(lists['agent-runs'].rows.length, 12);
  assert.equal(lists['agent-chats'].rows.length, 15);
  context.activeAgentId = 'b'; context.renderAgentRecentSessions();
  assert.equal(lists['agent-chats'].rows.length, 1);
  assert.equal(lists['agent-runs'].rows.length, 0);
  lists['agent-chats'].rows[0].click(); assert.equal(clicked, 'other');
  context.activeAgentId = 'empty'; context.renderAgentRecentSessions();
  assert.equal(lists['agent-chats'].rows.length, 0);
  assert.match(lists['agent-chats'].empty, /No saved chats/);
});

test('resume navigation respects cancelled navigation and scheduled activity', async () => {
  const calls = [];
  const context = { resumingConversation: false, hasActiveScheduledRun: () => false,
    showToast: message => calls.push(message), openAgentNewChat: async () => false,
    launchAgentInTerminal: async (...args) => calls.push(args) };
  vm.createContext(context);
  vm.runInContext(functionSource('async function resumeConversation(session)', '      function renderRecentSessions()'), context);
  const session = { agentId: 'a', provider: 'codex', conversationId: 'id' };
  await context.resumeConversation(session); assert.equal(calls.length, 0);
  context.openAgentNewChat = async () => true;
  await context.resumeConversation(session); assert.deepEqual(calls[0], ['codex', 'resume', 'id']);
  context.hasActiveScheduledRun = () => true;
  await context.resumeConversation(session); assert.match(calls[1], /Stop the scheduled run/);
});
