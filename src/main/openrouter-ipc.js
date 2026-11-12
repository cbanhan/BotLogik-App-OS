import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { findMentionFiles } from './openrouter-files.js';
import { createOpenRouter } from './openrouter.js';

export function registerOpenRouter({ ipcMain, BrowserWindow, safeStorage, shell, directory, getAgents, getIgnoredNames = async () => [], canStart, onActivity = () => {}, onTrace = () => {} }) {
  const senders = new Map();
  const aliases = new Map();
  const bindings = new Map();
  const workspaceAgents = new Map();
  const router = createOpenRouter({ directory: join(directory, 'openrouter'), safeStorage, getIgnoredNames,
    onTrace(root, id, event) { onTrace({ agentId: workspaceAgents.get(root), provider: 'openrouter', id, conversationId: id }, event); },
    onChange(owner, chat) {
      const sender = senders.get(owner);
      if (sender && !sender.isDestroyed()) sender.send('openrouter:changed', chat);
      onActivity(chat.root, chat.busy);
    }
  });
  function trusted(event) {
    if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('OpenRouter is only available in the app window.');
    if (!senders.has(event.sender.id)) {
      const owner = event.sender.id;
      senders.set(owner, event.sender);
      event.sender.once('destroyed', () => { router.stopOwner(owner); senders.delete(owner); });
    }
  }
  async function workspace(event, input) {
    trusted(event);
    const agent = (await getAgents()).find(a => a.id === input?.agentId && a.path === input?.path);
    if (!agent) throw new Error('Select a connected workspace.');
    const root = await realpath(agent.path);
    aliases.set(agent.path, root);
    workspaceAgents.set(root, agent.id);
    bindings.set(`${agent.id}:${agent.path}`, root);
    return root;
  }
  ipcMain.handle('openrouter:openLink', (event, url) => {
    trusted(event);
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Unsupported link.');
    return shell.openExternal(parsed.href);
  });
  ipcMain.handle('openrouter:openKeys', event => { trusted(event); return shell.openExternal('https://openrouter.ai/settings/keys'); });
  for (const method of ['status', 'models', 'saveKey', 'removeKey']) {
    ipcMain.handle(`openrouter:${method}`, async (event, value) => { trusted(event); return router[method](value); });
  }
  for (const method of ['list', 'get', 'create', 'send', 'stop', 'decide', 'modelPreference', 'mentionFiles', 'pin', 'remove']) {
    ipcMain.handle(`openrouter:${method}`, async (event, input = {}) => {
      trusted(event);
      const cancelling = method === 'stop' || method === 'decide';
      const root = cancelling ? bindings.get(`${input.agentId}:${input.path}`) : await workspace(event, input);
      if (!root) throw new Error('No OpenRouter session for this workspace.');
      if (method === 'send' || method === 'create') await canStart(input.agentId, root);
      if (method === 'mentionFiles') return findMentionFiles(root, input.query, await getIgnoredNames());
      if (method === 'modelPreference') return router.modelPreference(root, input.model);
      if (method === 'pin') return router.pin(root, input.id, input.pinned);
      if (method === 'remove') return router.remove(root, input.id);
      if (method === 'list') return router.list(root);
      if (method === 'get') return router.get(root, input.id);
      if (method === 'create') return router.create(root, input.model);
      if (method === 'send') return router.send(root, event.sender.id, input);
      if (method === 'stop') return router.stop(root, event.sender.id);
      if (method === 'decide') return router.decide(root, event.sender.id, input.id, input.allowed);
    });
  }
  const cleanup = () => router.purgeStale().catch(error => console.error('OpenRouter history cleanup failed:', error.message));
  void cleanup();
  setInterval(cleanup, 60 * 60 * 1000).unref();
  const running = router.isRunning;
  router.isRunning = path => running(aliases.get(path) || path);
  return router;
}
