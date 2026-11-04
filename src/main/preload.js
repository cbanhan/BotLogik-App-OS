import { clipboard, contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('botlogik', {
  platform: process.platform,
  openrouter: {
    openLink: url => ipcRenderer.invoke('openrouter:openLink', url),
    pin: request => ipcRenderer.invoke('openrouter:pin', request),
    remove: request => ipcRenderer.invoke('openrouter:remove', request),
    mentionFiles: request => ipcRenderer.invoke('openrouter:mentionFiles', request),
    modelPreference: request => ipcRenderer.invoke('openrouter:modelPreference', request),
    openKeys: () => ipcRenderer.invoke('openrouter:openKeys'),
    status: () => ipcRenderer.invoke('openrouter:status'),
    models: () => ipcRenderer.invoke('openrouter:models'),
    saveKey: key => ipcRenderer.invoke('openrouter:saveKey', key),
    removeKey: () => ipcRenderer.invoke('openrouter:removeKey'),
    list: request => ipcRenderer.invoke('openrouter:list', request),
    get: request => ipcRenderer.invoke('openrouter:get', request),
    create: request => ipcRenderer.invoke('openrouter:create', request),
    send: request => ipcRenderer.invoke('openrouter:send', request),
    stop: request => ipcRenderer.invoke('openrouter:stop', request),
    decide: request => ipcRenderer.invoke('openrouter:decide', request),
    onChanged: callback => {
      const listener = (_event, chat) => callback(chat);
      ipcRenderer.on('openrouter:changed', listener);
      return () => ipcRenderer.removeListener('openrouter:changed', listener);
    }
  },
  app: {
    environment: () => ipcRenderer.invoke('app:environment'),
    checkForUpdates: () => ipcRenderer.invoke('app:check-for-updates')
  },
  agents: {
    duplicate: agentId => ipcRenderer.invoke('agents:duplicate', agentId),
    scan: () => ipcRenderer.invoke('agents:scan'),
    connect: () => ipcRenderer.invoke('agents:connect'),
    chooseParent: () => ipcRenderer.invoke('agents:choose-parent'),
    create: (name, instructionFile) => ipcRenderer.invoke('agents:create', name, instructionFile),
    connectPath: (agentPath) => ipcRenderer.invoke('agents:connect-path', agentPath),
    remove: (agentPath) => ipcRenderer.invoke('agents:remove', agentPath),
    reorder: (section, orderedIds) => ipcRenderer.invoke('agents:reorder', section, orderedIds),
    watch: () => ipcRenderer.invoke('agents:watch'),
    unwatch: () => ipcRenderer.send('agents:unwatch'),
    onChanged: (callback) => {
      const listener = (_event, agents) => callback(agents);
      ipcRenderer.on('agents:changed', listener);
      return () => ipcRenderer.removeListener('agents:changed', listener);
    }
  },
  favorites: {
    toggle: (agentId) => ipcRenderer.invoke('favorites:toggle', agentId)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    saveChatContrast: (value) => ipcRenderer.invoke('settings:save-chat-contrast', value),
    saveGlobalIgnoredNames: (names) => ipcRenderer.invoke('settings:save-global-ignored-names', names),
    saveLaunchOnStartup: (enabled) => ipcRenderer.invoke('settings:save-launch-on-startup', enabled)
  },
  files: {
    openTerminal: (agentPath, targetPath) => ipcRenderer.invoke('files:open-terminal', agentPath, targetPath),
    list: (agentPath) => ipcRenderer.invoke('files:list', agentPath),
    read: (agentPath, filePath, options) => ipcRenderer.invoke('files:read', agentPath, filePath, options),
    save: (agentPath, filePath, content, expected) => ipcRenderer.invoke('files:save', agentPath, filePath, content, expected),
    createFile: (agentPath, relativePath, content) => ipcRenderer.invoke('files:create-file', agentPath, relativePath, content),
    createFolder: (agentPath, relativePath) => ipcRenderer.invoke('files:create-folder', agentPath, relativePath),
    move: (agentPath, sourcePath, destinationRelativePath) => ipcRenderer.invoke('files:move', agentPath, sourcePath, destinationRelativePath),
    delete: (agentPath, targetPath) => ipcRenderer.invoke('files:delete', agentPath, targetPath)
  },
  references: {
    pickAndInsert: (agentId) => ipcRenderer.invoke('references:pick-and-insert', agentId)
  },
  images: {
    pick: () => ipcRenderer.invoke('images:pick'),
    readWebp: (path) => ipcRenderer.invoke('images:read-webp', path),
    stage: (request) => ipcRenderer.invoke('images:stage', request),
    insert: (request) => ipcRenderer.invoke('images:insert', request),
    release: (ids) => ipcRenderer.invoke('images:release', ids),
    pathForFile: (file) => webUtils.getPathForFile(file)
  },
  clipboard: {
    writeText: (text) => clipboard.writeText(String(text ?? ''))
  },
  git: {
    status: (repoPath) => ipcRenderer.invoke('git:status', repoPath),
    diff: (repoPath, filePath, status) => ipcRenderer.invoke('git:diff', repoPath, filePath, status)
  },
  usage: {
    track: (agentId, agentName, branch) => ipcRenderer.invoke('usage:track', { agentId, agentName, branch })
  },
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list')
  },
  starterFiles: {
    list: () => ipcRenderer.invoke('starter-files:list'),
    set: (agentId, agentPath, relativePath) => ipcRenderer.invoke('starter-files:set', { agentId, agentPath, relativePath }),
    clear: (agentId) => ipcRenderer.invoke('starter-files:clear', { agentId })
  },
  cron: {
    models: (agentId, cwd) => ipcRenderer.invoke('cron:models', { agentId, cwd }),
    save: (schedule) => ipcRenderer.invoke('cron:save', schedule),
    delete: (agentId) => ipcRenderer.invoke('cron:delete', agentId),
    list: () => ipcRenderer.invoke('cron:list'),
    runsList: (agentId) => ipcRenderer.invoke('cron:runs:list', agentId),
    runsMimic: (agentId) => ipcRenderer.invoke('cron:runs:mimic', agentId),
    runsUpdate: (run) => ipcRenderer.invoke('cron:runs:update', run),
    onFire: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('cron:fire', listener);
      return () => ipcRenderer.removeListener('cron:fire', listener);
    }
  },
  scheduledState: {
    status: (agentId, agentPath) => ipcRenderer.invoke('scheduled-state:status', { agentId, agentPath }),
    initialize: (agentId, agentPath) => ipcRenderer.invoke('scheduled-state:initialize', { agentId, agentPath }),
    read: (agentId, agentPath, file) => ipcRenderer.invoke('scheduled-state:read', { agentId, agentPath, file }),
    save: (agentId, agentPath, file, content, expected) => ipcRenderer.invoke('scheduled-state:save', { agentId, agentPath, file, content, expected }),
    manualPrefix: (agentId, agentPath, starterRelativePath) => ipcRenderer.invoke('scheduled-state:manual-prefix', { agentId, agentPath, starterRelativePath })
  },
  power: {
    setAgentRunning: (agentId, running) => ipcRenderer.invoke('power:set-agent-running', { agentId, running })
  },
  terminal: {
    start: (agentId, cwd) => ipcRenderer.invoke('terminal:start', { agentId, cwd }),
    startManaged: (agentId, cwd, provider, mode, prompt, conversationId, runId, model, reasoningEffort) => ipcRenderer.invoke('terminal:start-managed', { agentId, cwd, provider, mode, prompt, conversationId, runId, model, reasoningEffort }),
    input: (sessionId, input) => ipcRenderer.send('terminal:input', { sessionId, input }),
    resize: (sessionId, cols, rows) => ipcRenderer.send('terminal:resize', { sessionId, cols, rows }),
    stop: (sessionId) => ipcRenderer.invoke('terminal:stop', sessionId),
    onActivity: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('terminal:activity', listener);
      return () => ipcRenderer.removeListener('terminal:activity', listener);
    },
    onOutput: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('terminal:output', listener);
      return () => ipcRenderer.removeListener('terminal:output', listener);
    },
    onExit: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('terminal:exit', listener);
      return () => ipcRenderer.removeListener('terminal:exit', listener);
    }
  }
});
