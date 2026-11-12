import { normalizeChatModel, validateChatModel, chatModelArgs, chatSwitchCommand, assertChatSwitchSession } from './chat-models.js';
import { applyClaudeFocus } from './claude-presentation.js';
import { createToolTraces } from './tool-traces.js';
import { freshTerminalEnvironment } from './terminal-environment.js';
import { resolveCli } from './cli-discovery.js';
import { discoverClaudeModels, assertClaudeModelSupported } from './claude-models.js';
import { stageImage, imagePrompt, imageBytes, MAX_IMAGES } from './image-attachments.js';
import { createAgentWorkspace, duplicateAgentWorkspace } from './create-agent.js';
import { createActivityBridge } from './activity-bridge.js';
import { createConversationHistory, validConversationId, resumeCommand } from './conversation-history.js';
import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, nativeImage, clipboard, Menu, MenuItem, safeStorage, shell } from 'electron';
import { registerOpenRouter } from './openrouter-ipc.js';
import { createAppUpdates } from './app-updates.js';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, watch } from 'node:fs';
import { appendFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);
const pty = require('node-pty');
const { autoUpdater } = require('electron-updater');
let appUpdates;
let openRouter;
const execFileAsync = promisify(execFile);

const conversationHistory = createConversationHistory();
let historyAgents = [];

const SENTINELS = ['CLAUDE.md', 'agent.md', 'tools.json', '.claude'];
const FILE_SENTINELS = ['CLAUDE.md', 'agent.md', 'tools.json', 'memory.md', '.env.example', 'workspace.json', 'README.md'];
const LEGACY_DEFAULT_GLOBAL_IGNORED_NAMES = [
  '.git',
  'node_modules',
  'dist',
  'out',
  'build',
  '.next',
  '.turbo',
  'Library',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  'coverage'
];
const DEFAULT_GLOBAL_IGNORED_NAMES = [];
const TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.json',
  '.jsonc',
  '.env',
  '.txt',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
  '.html',
  '.xml',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.sh',
  '.zsh',
  '.bash',
  '.sql',
  '.graphql',
  '.gql'
]);
const STARTER_FILE_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.toml']);
const STARTER_FILE_NAMES = new Set(['CLAUDE.md', 'AGENTS.md', 'agent.md', 'README.md', 'CLAUDE', 'AGENTS', 'agent', 'README']);
const MAX_EDITOR_FILE_BYTES = 50 * 1024 * 1024;
const MAX_AGENTS = 50;
const CONFIG_DIR = join(homedir(), '.agent-logik');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const CRON_TIME_ZONE = 'America/New_York';
const CRON_DAY_INDEXES = [0, 1, 2, 3, 4, 5, 6];
const CRON_DAY_DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const CRON_DAY_SHORT_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SCHEDULED_RUN_STATUSES = new Set(['running', 'completed', 'failed', 'stopped']);
const MAX_SCHEDULED_RUNS_PER_AGENT = 20;
const SCHEDULED_STATE_DIR = '.agent-logik';
const SCHEDULED_RUNS_DIR = 'runs';
const SCHEDULED_ROUTER_FILE = 'router.md';
const SCHEDULED_STATE_FILE = 'state.md';
const SCHEDULED_TASKS_FILE = 'tasks.json';
const SCHEDULED_EVENTS_FILE = 'events.jsonl';
const SCHEDULED_EDITABLE_FILES = new Set([SCHEDULED_ROUTER_FILE, SCHEDULED_STATE_FILE, SCHEDULED_TASKS_FILE]);
const SCHEDULED_READABLE_FILES = new Set([...SCHEDULED_EDITABLE_FILES, SCHEDULED_EVENTS_FILE]);
const ROUTER_MAX_WORDS = 500;
const STATE_MAX_WORDS = 2000;
const TASKS_MAX_OPEN = 25;
const EVENTS_MAX_LINES = 20;
const EVENTS_MAX_CHARS = 8000;
const RUN_SUMMARY_MAX_CHARS = 4000;
let agentWatcher = null;
let agentWatchDebounce = null;
const terminalSessions = new Map();
const pendingManagedLaunches = new Set();
const toolTraces = createToolTraces({ path: join(CONFIG_DIR, 'tool-traces.json'), onChange() {
  for (const window of BrowserWindow.getAllWindows()) sendToWebContents(window.webContents, 'traces:changed', {});
} });
let activityBridge;
const traceContexts = new Map();
function getActivityBridge() {
  if (!activityBridge) activityBridge = createActivityBridge({
    directory: join(app.getPath('userData'), 'activity-hooks'),
    onTrace(activity, event) {
      const context = { agentId: activity.agentId, provider: activity.provider, id: activity.conversationId || activity.generation, conversationId: activity.conversationId };
      const previous = traceContexts.get(activity.generation);
      if (previous && previous.id !== context.id) void toolTraces.end(previous);
      traceContexts.set(activity.generation, context);
      if (event.hook_event_name === 'BotLogikSessionStarted') void toolTraces.begin(context, activity.detail);
      else if (event.hook_event_name === 'BotLogikSessionClosed') {
        void toolTraces.end(context);
        traceContexts.delete(activity.generation);
      }
      else void toolTraces.event(context, event);
    },
    onChange(activity) {
      const session = terminalSessions.get(activity.sessionId);
      if (session?.monitor?.activity.generation !== activity.generation) return;
      if (activity.conversationId) session.conversationId = activity.conversationId;
      sendToWebContents(session.owner, 'terminal:activity', activity);
    }
  });
  return activityBridge;
}
const runningAgentPowerKeys = new Set();
let caffeinateProcess = null;
let caffeinateUnavailable = false;
let powerSaveBlockerId = null;
let cronSchedulerInterval = null;

function hashPath(path) {
  return createHash('sha1').update(path).digest('hex').slice(0, 12);
}

function uniqExisting(paths) {
  return [...new Set(paths.map((path) => resolve(path)))].filter((path) => existsSync(path));
}

function normalizeRelativeStarterPath(relativePath) {
  const normalized = String(relativePath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (!normalized) throw new Error('Choose a starter context file');

  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) throw new Error('Choose a starter context file');
  if (parts.some((part) => part === '.' || part === '..')) throw new Error('Path traversal is not allowed');
  return parts.join('/');
}

function starterAbsolutePath(agentPath, relativePath) {
  return resolve(agentPath, normalizeRelativeStarterPath(relativePath));
}

function isStarterFileNameAllowed(name) {
  if (isSecretEnvName(name)) return false;
  if (STARTER_FILE_NAMES.has(name)) return true;
  return STARTER_FILE_EXTENSIONS.has(extname(name).toLowerCase());
}

function defaultScanRoots() {
  const cwd = process.cwd();
  return uniqExisting([
    dirname(cwd),
    cwd,
    join(homedir(), 'Desktop'),
    join(homedir(), 'Projects'),
    join(homedir(), 'projects'),
    join(homedir(), 'workspace'),
    join(homedir(), 'code')
  ]);
}

function configuredScanRoots(config) {
  const configuredRoots = Array.isArray(config.roots) ? config.roots : [];
  const roots = config.autoDiscoverEnabled === true
    ? [...configuredRoots, ...defaultScanRoots()]
    : configuredRoots;
  return uniqExisting(roots);
}

async function readConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    const config = JSON.parse(raw);
    const globalIgnoredNames = normalizeGlobalIgnoredNames(config.globalIgnoredNames, DEFAULT_GLOBAL_IGNORED_NAMES);
    return {
      roots: Array.isArray(config.roots) ? config.roots : [],
      pinnedPaths: Array.isArray(config.pinnedPaths) ? config.pinnedPaths.map((path) => resolve(path)) : [],
      favorites: Array.isArray(config.favorites) ? config.favorites : [],
      agentOrder: Array.isArray(config.agentOrder) ? config.agentOrder : [],
      removedPaths: Array.isArray(config.removedPaths) ? config.removedPaths.map((path) => resolve(path)) : [],
      agentUsage: (config.agentUsage && typeof config.agentUsage === 'object' && !Array.isArray(config.agentUsage)) ? config.agentUsage : {},
      recentSessions: Array.isArray(config.recentSessions) ? config.recentSessions : [],
      cronSchedules: Array.isArray(config.cronSchedules) ? config.cronSchedules : [],
      scheduledRuns: Array.isArray(config.scheduledRuns) ? config.scheduledRuns : [],
      agentStarterFiles: (config.agentStarterFiles && typeof config.agentStarterFiles === 'object' && !Array.isArray(config.agentStarterFiles)) ? config.agentStarterFiles : {},
      globalIgnoredNames: hasOnlyLegacyDefaultIgnoredNames(globalIgnoredNames) ? [] : globalIgnoredNames,
      chatContrast: normalizeChatContrast(config.chatContrast),
      reduceToolClutter: config.reduceToolClutter === true,
      chatModelDefaults: config.chatModelDefaults && typeof config.chatModelDefaults === 'object' && !Array.isArray(config.chatModelDefaults) ? config.chatModelDefaults : {},
      autoDiscoverEnabled: config.autoDiscoverEnabled === true
    };
  } catch {
    return {
      roots: [],
      pinnedPaths: [],
      favorites: [],
      agentOrder: [],
      removedPaths: [],
      agentUsage: {},
      recentSessions: [],
      cronSchedules: [],
      scheduledRuns: [],
      agentStarterFiles: {},
      globalIgnoredNames: [...DEFAULT_GLOBAL_IGNORED_NAMES],
      chatContrast: null,
      reduceToolClutter: false,
      chatModelDefaults: {},
      autoDiscoverEnabled: false
    };
  }
}

async function writeConfig(config) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function getScanRoots(config) {
  return configuredScanRoots(config);
}

function normalizeGlobalIgnoredNames(value, fallback = []) {
  const source = Array.isArray(value) ? value : fallback;
  const names = [];
  source.forEach((item) => {
    const name = String(item || '').trim();
    if (!name || name === '.' || name === '..') return;
    if (name.includes('/') || name.includes('\\')) return;
    if (!names.includes(name)) names.push(name);
  });
  return names;
}

function hasOnlyLegacyDefaultIgnoredNames(names) {
  if (!Array.isArray(names) || names.length !== LEGACY_DEFAULT_GLOBAL_IGNORED_NAMES.length) return false;
  const legacyNames = new Set(LEGACY_DEFAULT_GLOBAL_IGNORED_NAMES);
  return names.every((name) => legacyNames.has(name));
}

async function getSettings() {
  const config = await readConfig();
  const { launchOnStartup } = getLaunchOnStartupSetting();
  return {
    defaultGlobalIgnoredNames: [...DEFAULT_GLOBAL_IGNORED_NAMES],
    globalIgnoredNames: config.globalIgnoredNames,
    launchOnStartup,
    chatContrast: config.chatContrast,
    reduceToolClutter: config.reduceToolClutter
  };
}

function getLaunchOnStartupSetting() {
  try {
    const settings = app.getLoginItemSettings();
    return { launchOnStartup: Boolean(settings.openAtLogin) };
  } catch {
    return { launchOnStartup: false };
  }
}

function normalizeChatContrast(value) {
  return ['original', 'charcoal', 'midnight', 'slate', 'deep-teal'].includes(value) ? value : null;
}

async function saveChatContrast(value) {
  const chatContrast = normalizeChatContrast(value);
  if (!chatContrast) throw new Error('Invalid chat contrast');
  const config = await readConfig();
  await writeConfig({ ...config, chatContrast });
  return { chatContrast };
}

async function saveReduceToolClutter(enabled) {
  if (typeof enabled !== 'boolean') throw new Error('Invalid tool clutter setting');
  const config = await readConfig();
  await writeConfig({ ...config, reduceToolClutter: enabled });
  return { reduceToolClutter: enabled };
}

async function saveLaunchOnStartup(enabled) {
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
  return getLaunchOnStartupSetting();
}

async function saveGlobalIgnoredNames(names) {
  const normalized = normalizeGlobalIgnoredNames(names);
  const config = await readConfig();
  await writeConfig({
    ...config,
    globalIgnoredNames: normalized
  });
  return getSettings();
}

async function hasSentinel(path) {
  return SENTINELS.some((sentinel) => existsSync(join(path, sentinel)));
}

async function findSentinels(path) {
  return SENTINELS.filter((sentinel) => existsSync(join(path, sentinel)));
}

async function getGitBranch(path) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', path, 'branch', '--show-current'], { timeout: 1200 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function isGitRepository(path) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', path, 'rev-parse', '--is-inside-work-tree'], { timeout: 1200 });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

async function hasGitChanges(path) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', path, 'status', '--porcelain'], { timeout: 1200 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function latestCommitAgeMs(path) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', path, 'log', '-1', '--format=%ct'], { timeout: 1200 });
    const seconds = Number(stdout.trim());
    return Number.isFinite(seconds) ? Date.now() - seconds * 1000 : null;
  } catch {
    return null;
  }
}

async function countTopLevelFiles(path) {
  try {
    const config = await readConfig();
    const globalIgnoredNames = new Set(config.globalIgnoredNames);
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => !globalIgnoredNames.has(entry.name)).length;
  } catch {
    return 0;
  }
}

async function inferStatus(path) {
  if (!existsSync(path)) return 'offline';
  if (!(await hasSentinel(path))) return 'idle';
  if (existsSync(join(path, '.claude-running')) || existsSync(join(path, '.agent-lock'))) return 'busy';

  const commitAge = await latestCommitAgeMs(path);
  if (commitAge !== null && commitAge > 60 * 60 * 1000) return 'idle';

  return (await hasGitChanges(path)) ? 'ready' : 'ready';
}

async function buildAgentInfo(path, favorites, agentUsage = {}, agentStarterFiles = {}) {
  const id = hashPath(path);
  const usage = agentUsage[id] || {};
  const entries = await readdir(path).catch(() => []);
  const starterFile = await starterMetadataForAgent(path, agentStarterFiles[id]);
  return {
    id,
    name: basename(path),
    path,
    status: await inferStatus(path),
    branch: await getGitBranch(path),
    fileCount: await countTopLevelFiles(path),
    hasClaude: entries.includes('CLAUDE.md') || entries.includes('.claude'),
    hasTools: entries.includes('tools.json'),
    isFavorite: favorites.includes(id),
    openCount: usage.openCount || 0,
    lastOpened: usage.lastOpened || null,
    starterFile
  };
}

function orderRank(id, orderedIds) {
  const index = orderedIds.indexOf(id);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function sortAgentsByManualOrder(agents, config) {
  return [...agents].sort((a, b) => {
    if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;

    const orderedIds = a.isFavorite ? (config.favorites || []) : (config.agentOrder || []);
    const aRank = orderRank(a.id, orderedIds);
    const bRank = orderRank(b.id, orderedIds);
    if (aRank !== bRank) return aRank - bRank;

    return a.name.localeCompare(b.name);
  });
}

function isPreviewableTextName(name) {
  if (name.toLowerCase() === '.gitignore') return true;
  if (FILE_SENTINELS.includes(name)) return true;
  if (name.startsWith('.env')) return name === '.env.example';
  return TEXT_EXTENSIONS.has(extname(name).toLowerCase());
}

function isSecretEnvName(name) {
  return name.startsWith('.env') && name !== '.env.example';
}

function isInsidePath(parent, child) {
  const result = relative(parent, child);
  return result === '' || (!result.startsWith('..') && !isAbsolute(result));
}

async function resolveWorkspacePath(agentPath, targetPath, { allowMissing = false } = {}) {
  const workspace = resolve(agentPath);
  const resolvedTarget = resolve(targetPath);

  let realWorkspace;
  try {
    realWorkspace = await realpath(workspace);
  } catch {
    throw new Error('Workspace is unavailable');
  }

  if (!isInsidePath(workspace, resolvedTarget)) {
    throw new Error('Path is outside the selected workspace');
  }

  if (allowMissing) {
    let existingParent = dirname(resolvedTarget);
    while (!existsSync(existingParent) && existingParent !== dirname(existingParent)) {
      existingParent = dirname(existingParent);
    }
    const realExistingParent = await realpath(existingParent);
    if (!isInsidePath(realWorkspace, realExistingParent)) {
      throw new Error('Path resolves outside the selected workspace');
    }
    return { workspace, realWorkspace, target: resolvedTarget, realTarget: resolvedTarget };
  }

  let realTarget;
  try {
    realTarget = await realpath(resolvedTarget);
  } catch {
    throw new Error('File no longer exists');
  }

  if (!isInsidePath(realWorkspace, realTarget)) {
    throw new Error('Path resolves outside the selected workspace');
  }

  return { workspace, realWorkspace, target: resolvedTarget, realTarget };
}

async function openWorkspaceTerminal(agentPath, targetPath = agentPath) {
  if (process.platform !== 'darwin') throw new Error('Open in Terminal is available on macOS.');
  if (typeof agentPath !== 'string' || typeof targetPath !== 'string' || !agentPath || !targetPath) {
    throw new Error('Choose a workspace folder first.');
  }
  const { realTarget } = await resolveWorkspacePath(agentPath, targetPath);
  if (!(await stat(realTarget)).isDirectory()) throw new Error('Terminal can only be opened for a folder.');
  // Pass the directory directly to Terminal through Launch Services, never a shell command.
  await execFileAsync('/usr/bin/open', ['-b', 'com.apple.Terminal', realTarget], { timeout: 10000 });
  return { path: realTarget };
}

async function resolveWorkspaceRelativePath(agentPath, relativePath) {
  const input = String(relativePath || '').trim();
  if (!input) throw new Error('Enter a path');
  if (isAbsolute(input)) throw new Error('Use a relative path inside the workspace');

  const parts = input.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) throw new Error('Enter a path');
  if (parts.some((part) => part === '.' || part === '..')) throw new Error('Path traversal is not allowed');
  const config = await readConfig();
  const globalIgnoredNames = new Set(config.globalIgnoredNames);
  if (parts.some((part) => globalIgnoredNames.has(part))) {
    throw new Error('That path is ignored by BotLogik');
  }

  const target = resolve(agentPath, ...parts);
  return resolveWorkspacePath(agentPath, target, { allowMissing: true });
}

function assertAgentPathMatches(agentId, agentPath) {
  const resolvedAgentPath = resolve(String(agentPath || '').trim());
  if (!agentId || hashPath(resolvedAgentPath) !== String(agentId).trim()) {
    throw new Error('Runtime state does not match the selected workspace');
  }
  return resolvedAgentPath;
}

function countWords(value) {
  const words = String(value || '').trim().match(/\S+/g);
  return words ? words.length : 0;
}

function safeRuntimeFileName(file) {
  const normalized = String(file || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) throw new Error('Runtime file is required');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) throw new Error('Path traversal is not allowed');
  if (SCHEDULED_READABLE_FILES.has(normalized)) return normalized;
  if (parts.length === 2 && parts[0] === SCHEDULED_RUNS_DIR && /^[A-Za-z0-9_.:-]+\.json$/.test(parts[1])) {
    return `${parts[0]}/${parts[1]}`;
  }
  throw new Error('Runtime file is not readable');
}

async function scheduledRuntimeBase(agentPath) {
  const workspace = resolve(agentPath);
  const runtimeDir = resolve(workspace, SCHEDULED_STATE_DIR);
  const { target } = await resolveWorkspacePath(workspace, runtimeDir, { allowMissing: true });
  if (!isInsidePath(workspace, target)) throw new Error('Runtime path is outside the selected workspace');
  if (existsSync(target)) {
    const runtimeStat = await lstat(target);
    if (runtimeStat.isSymbolicLink()) throw new Error('Runtime state directory cannot be a symlink');
    const realWorkspace = await realpath(workspace);
    const realRuntimeDir = await realpath(target);
    if (!isInsidePath(realWorkspace, realRuntimeDir)) throw new Error('Runtime path resolves outside the selected workspace');
  }
  return { workspace, runtimeDir: target };
}

async function scheduledRuntimePath(agentPath, file, { allowMissing = false } = {}) {
  const { runtimeDir } = await scheduledRuntimeBase(agentPath);
  const safeFile = safeRuntimeFileName(file);
  const target = resolve(runtimeDir, safeFile);
  const realRuntimeDir = existsSync(runtimeDir) ? await realpath(runtimeDir) : runtimeDir;
  if (!isInsidePath(runtimeDir, target)) throw new Error('Runtime path is outside the state directory');
  if (!allowMissing) {
    const realTarget = await realpath(target).catch(() => {
      throw new Error('Runtime file does not exist');
    });
    if (!isInsidePath(realRuntimeDir, realTarget)) throw new Error('Runtime path resolves outside the state directory');
  }
  return { runtimeDir, file: safeFile, target };
}

function defaultRouterContent() {
  return [
    '# BotLogik Scheduled Runtime Router',
    '',
    'Use this file only as the entrypoint for BotLogik scheduled-runtime continuity.',
    '',
    '- Read `.agent-logik/state.md` for the compact current snapshot before answering status or continuity questions.',
    '- Read `.agent-logik/tasks.json` for open and recently completed task state.',
    '- Read `.agent-logik/events.jsonl` for recent BotLogik audit events when needed.',
    '- Read `.agent-logik/runs/` for run launch snapshots when needed.',
    '',
    'Keep these files small and factual. They supplement, but do not replace, `CLAUDE.md`, `AGENTS.md`, `agent.md`, or project instructions.',
    '',
    'After meaningful scheduled work, update `state.md` and `tasks.json` so the next scheduled run can continue from the right place.'
  ].join('\n');
}

function defaultStateContent() {
  return [
    '# Scheduled Agent State',
    '',
    '## Objective',
    '- ',
    '',
    '## Current Position',
    '- ',
    '',
    '## Active Assumptions',
    '- ',
    '',
    '## Open Blockers',
    '- ',
    '',
    '## Next Action',
    '- ',
    '',
    '## Do Not Forget',
    '- '
  ].join('\n');
}

function defaultTasksContent() {
  return `${JSON.stringify({ open_tasks: [], completed_tasks: [] }, null, 2)}\n`;
}

async function readTextIfExists(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function appendScheduledRuntimeEvent(agentPath, event = {}) {
  const { runtimeDir } = await scheduledRuntimeBase(agentPath);
  if (!existsSync(runtimeDir)) return;
  const target = resolve(runtimeDir, SCHEDULED_EVENTS_FILE);
  const compact = {
    timestamp: normalizeIsoDate(event.timestamp) || new Date().toISOString(),
    type: String(event.type || 'event').slice(0, 64),
    source: String(event.source || 'botlogik').slice(0, 64),
    file: event.file ? String(event.file).slice(0, 160) : null,
    summary: String(event.summary || '').slice(0, 240)
  };
  await appendFile(target, `${JSON.stringify(compact)}\n`, 'utf8');
}

async function ensureScheduledRuntimeFiles(agentPath) {
  const { runtimeDir } = await scheduledRuntimeBase(agentPath);
  await mkdir(resolve(runtimeDir, SCHEDULED_RUNS_DIR), { recursive: true });

  const defaults = [
    [SCHEDULED_ROUTER_FILE, defaultRouterContent()],
    [SCHEDULED_STATE_FILE, defaultStateContent()],
    [SCHEDULED_TASKS_FILE, defaultTasksContent()],
    [SCHEDULED_EVENTS_FILE, '']
  ];
  const created = [];
  for (const [file, content] of defaults) {
    const target = resolve(runtimeDir, file);
    if (existsSync(target)) continue;
    await writeFile(target, content, { encoding: 'utf8', flag: 'wx' });
    created.push(file);
  }

  if (created.length > 0) {
    await appendScheduledRuntimeEvent(agentPath, {
      type: 'runtime_initialized',
      source: 'botlogik',
      summary: `Created ${created.join(', ')}`
    });
  }
  return scheduledRuntimeStatus(agentPath);
}

function tasksMetadata(content) {
  try {
    const parsed = JSON.parse(content || '{}');
    const openTasks = Array.isArray(parsed.open_tasks) ? parsed.open_tasks.length : 0;
    return { valid: true, openTasks };
  } catch (error) {
    return { valid: false, openTasks: 0, error: error.message || 'Invalid JSON' };
  }
}

async function scheduledRuntimeStatus(agentPath) {
  const { runtimeDir } = await scheduledRuntimeBase(agentPath);
  const exists = existsSync(runtimeDir);
  const files = {};
  const warnings = [];

  for (const file of [SCHEDULED_ROUTER_FILE, SCHEDULED_STATE_FILE, SCHEDULED_TASKS_FILE, SCHEDULED_EVENTS_FILE]) {
    const target = resolve(runtimeDir, file);
    if (!existsSync(target)) {
      files[file] = { exists: false, size: 0, wordCount: 0 };
      continue;
    }
    const fileStat = await stat(target);
    const content = await readTextIfExists(target);
    files[file] = {
      exists: true,
      size: fileStat.size,
      sizeLabel: formatBytes(fileStat.size),
      modified: fileStat.mtime.toISOString(),
      modifiedMs: fileStat.mtimeMs,
      wordCount: countWords(content)
    };
  }

  const taskMeta = tasksMetadata(await readTextIfExists(resolve(runtimeDir, SCHEDULED_TASKS_FILE)));
  files[SCHEDULED_TASKS_FILE].openTasks = taskMeta.openTasks;
  files[SCHEDULED_TASKS_FILE].valid = taskMeta.valid;
  if (!taskMeta.valid) files[SCHEDULED_TASKS_FILE].error = taskMeta.error;

  const events = (await readTextIfExists(resolve(runtimeDir, SCHEDULED_EVENTS_FILE))).split('\n').filter(Boolean);
  files[SCHEDULED_EVENTS_FILE].lineCount = events.length;

  let runs = [];
  const runsDir = resolve(runtimeDir, SCHEDULED_RUNS_DIR);
  if (existsSync(runsDir)) {
    const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
    runs = (await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map(async (entry) => {
        const fileStat = await stat(resolve(runsDir, entry.name));
        return {
          file: `${SCHEDULED_RUNS_DIR}/${entry.name}`,
          name: entry.name,
          size: fileStat.size,
          sizeLabel: formatBytes(fileStat.size),
          modified: fileStat.mtime.toISOString(),
          modifiedMs: fileStat.mtimeMs
        };
      })))
      .sort((a, b) => b.modifiedMs - a.modifiedMs)
      .slice(0, MAX_SCHEDULED_RUNS_PER_AGENT);
  }

  if (files[SCHEDULED_ROUTER_FILE].wordCount > ROUTER_MAX_WORDS) warnings.push('router.md exceeds budget');
  if (files[SCHEDULED_STATE_FILE].wordCount > STATE_MAX_WORDS) warnings.push('state.md needs compaction');
  if (taskMeta.openTasks > TASKS_MAX_OPEN) warnings.push('tasks.json has too many open tasks');
  if (events.length > EVENTS_MAX_LINES) warnings.push('events.jsonl has more history than the prompt budget reads');

  return {
    exists,
    directory: SCHEDULED_STATE_DIR,
    files,
    runs,
    budgets: {
      routerMaxWords: ROUTER_MAX_WORDS,
      stateMaxWords: STATE_MAX_WORDS,
      tasksMaxOpen: TASKS_MAX_OPEN,
      eventsMaxLines: EVENTS_MAX_LINES,
      eventsMaxChars: EVENTS_MAX_CHARS,
      runSummaryMaxChars: RUN_SUMMARY_MAX_CHARS
    },
    warnings
  };
}

async function readScheduledRuntimeFile(agentPath, file) {
  const { file: safeFile, target } = await scheduledRuntimePath(agentPath, file);
  const fileStat = await stat(target);
  if (!fileStat.isFile()) throw new Error('Runtime path is not a file');
  const content = await readFile(target, 'utf8');
  const visibleContent = safeFile === SCHEDULED_EVENTS_FILE
    ? content.split('\n').filter(Boolean).slice(-EVENTS_MAX_LINES).join('\n')
    : content;
  return {
    ok: true,
    file: safeFile,
    content: visibleContent,
    size: fileStat.size,
    sizeLabel: formatBytes(fileStat.size),
    modified: fileStat.mtime.toISOString(),
    modifiedMs: fileStat.mtimeMs,
    editable: SCHEDULED_EDITABLE_FILES.has(safeFile)
  };
}

async function saveScheduledRuntimeFile(agentPath, file, content, expected = {}) {
  const { file: safeFile, target } = await scheduledRuntimePath(agentPath, file);
  if (!SCHEDULED_EDITABLE_FILES.has(safeFile)) throw new Error('Runtime file is read-only');

  const linkStat = await lstat(target);
  if (linkStat.isSymbolicLink()) throw new Error('Symlinked runtime files cannot be edited');
  const fileStat = await stat(target);
  if (!fileStat.isFile()) throw new Error('Runtime path is not a file');

  const expectedSize = Number(expected?.size);
  const expectedModifiedMs = Number(expected?.modifiedMs);
  if (
    Number.isFinite(expectedSize) &&
    Number.isFinite(expectedModifiedMs) &&
    (fileStat.size !== expectedSize || Math.abs(fileStat.mtimeMs - expectedModifiedMs) > 1)
  ) {
    return { ok: false, reason: 'modified', content: 'This runtime file changed on disk. Reload it before saving.' };
  }

  const normalizedContent = String(content ?? '');
  if (safeFile === SCHEDULED_TASKS_FILE) {
    JSON.parse(normalizedContent);
  }

  await writeFile(target, normalizedContent, 'utf8');
  await appendScheduledRuntimeEvent(agentPath, {
    type: 'user_state_edit',
    source: 'botlogik',
    file: safeFile,
    summary: `Saved ${safeFile}`
  });
  return readScheduledRuntimeFile(agentPath, safeFile);
}

async function writeScheduledRunSnapshot(schedule, run, status) {
  if (!schedule?.statefulRuntimeEnabled || !run?.id) return;
  const { runtimeDir } = await scheduledRuntimeBase(schedule.agentPath);
  const runsDir = resolve(runtimeDir, SCHEDULED_RUNS_DIR);
  await mkdir(runsDir, { recursive: true });
  const safeName = `${String(run.id).replace(/[^A-Za-z0-9_.:-]/g, '_')}.json`;
  const snapshot = {
    runId: run.id,
    scheduleAgentId: schedule.agentId,
    scheduleLabel: cronScheduleLabel(schedule),
    startedAt: run.startedAt,
    originalMessagePreview: String(schedule.startMessage || '').slice(0, 240),
    runtimeStatus: status
      ? {
          warnings: status.warnings,
          files: {
            routerWords: status.files?.[SCHEDULED_ROUTER_FILE]?.wordCount || 0,
            stateWords: status.files?.[SCHEDULED_STATE_FILE]?.wordCount || 0,
            openTasks: status.files?.[SCHEDULED_TASKS_FILE]?.openTasks || 0,
            eventLines: status.files?.[SCHEDULED_EVENTS_FILE]?.lineCount || 0
          }
        }
      : null
  };
  await writeFile(resolve(runsDir, safeName), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

function scheduledRuntimeWarnings(status) {
  const warnings = Array.isArray(status?.warnings) ? status.warnings : [];
  if (!warnings.length) return '';
  return [
    'BotLogik state budget warnings:',
    ...warnings.map((warning) => `- ${warning}`),
    'Compact the runtime files before adding more durable state.'
  ].join('\n');
}

async function buildScheduledRuntimePrompt(schedule, run = null) {
  if (schedule?.statefulRuntimeEnabled !== true) return schedule?.startMessage || '';
  const status = await ensureScheduledRuntimeFiles(schedule.agentPath);
  await appendScheduledRuntimeEvent(schedule.agentPath, {
    type: 'scheduled_run_launched',
    source: 'botlogik',
    summary: run?.id ? `Launched scheduled run ${run.id}` : 'Launched scheduled run'
  });
  if (run) await writeScheduledRunSnapshot(schedule, run, status);
  const warnings = scheduledRuntimeWarnings(status);
  return [
    'BotLogik scheduled runtime is enabled for this run.',
    'Read `.agent-logik/router.md` first, then follow its routing guidance for state, tasks, recent events, and run snapshots.',
    warnings,
    'User scheduled message:',
    schedule.startMessage
  ].filter(Boolean).join('\n\n');
}

async function buildManualRuntimePrefix(agentPath, starterRelativePath = null) {
  const routerPath = resolve(agentPath, SCHEDULED_STATE_DIR, SCHEDULED_ROUTER_FILE);
  if (!existsSync(routerPath)) return '';
  const lines = ['@.agent-logik/router.md'];
  if (starterRelativePath) {
    try {
      const validation = await validateStarterFile(agentPath, starterRelativePath);
      lines.push(`@${validation.relativePath}`);
    } catch {
      // Invalid starter context is intentionally ignored here; the UI already surfaces starter validity.
    }
  }
  return `${lines.join('\n')}\n\n`;
}

async function validateStarterFile(agentPath, relativePath) {
  const normalizedRelativePath = normalizeRelativeStarterPath(relativePath);
  const target = starterAbsolutePath(agentPath, normalizedRelativePath);
  const { target: resolvedTarget } = await resolveWorkspacePath(agentPath, target);
  const fileName = basename(resolvedTarget);

  if (!isStarterFileNameAllowed(fileName)) {
    throw new Error('This file type cannot be used as starter context');
  }

  const linkStat = await lstat(resolvedTarget);
  if (linkStat.isSymbolicLink()) throw new Error('Symlinked files cannot be used as starter context');

  const fileStat = await stat(resolvedTarget);
  if (!fileStat.isFile()) throw new Error('Starter context must be a file');

  return {
    relativePath: normalizedRelativePath,
    size: fileStat.size,
    modified: fileStat.mtime.toISOString()
  };
}

async function starterMetadataForAgent(agentPath, starterEntry) {
  if (!starterEntry?.relativePath) return null;
  try {
    const baseEntry = {
      relativePath: normalizeRelativeStarterPath(starterEntry.relativePath),
      updatedAt: starterEntry.updatedAt || null
    };
    const validation = await validateStarterFile(agentPath, baseEntry.relativePath);
    return { ...baseEntry, ...validation, valid: true, reason: null };
  } catch (error) {
    return {
      relativePath: String(starterEntry.relativePath || ''),
      updatedAt: starterEntry.updatedAt || null,
      valid: false,
      reason: error.message || 'Starter context unavailable'
    };
  }
}

function assertEditableTextName(fileName, { allowSecretEnv = false } = {}) {
  if (isSecretEnvName(fileName)) {
    if (allowSecretEnv) return;
    throw new Error('Secret environment files cannot be edited');
  }
  if (!isPreviewableTextName(fileName)) throw new Error('This file type cannot be edited');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatModified(ms) {
  const diff = Date.now() - ms;
  const day = 24 * 60 * 60 * 1000;
  if (diff < 60 * 1000) return 'just now';
  if (diff < 60 * 60 * 1000) return `${Math.max(1, Math.floor(diff / (60 * 1000)))}m ago`;
  if (diff < day) return 'today';
  if (diff < day * 2) return 'yesterday';
  if (diff < day * 30) return `${Math.floor(diff / day)}d ago`;
  return new Date(ms).toLocaleDateString();
}

function sortFileInfo(a, b) {
  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;

  const aIndex = FILE_SENTINELS.indexOf(a.name);
  const bIndex = FILE_SENTINELS.indexOf(b.name);
  if (aIndex !== -1 || bIndex !== -1) {
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;
    return aIndex - bIndex;
  }
  return a.name.localeCompare(b.name);
}

async function listWorkspaceFiles(agentPath) {
  const workspace = resolve(agentPath);
  if (!existsSync(workspace)) return [];

  const config = await readConfig();
  const globalIgnoredNames = new Set(config.globalIgnoredNames);
  const files = [];
  const walk = async (dir, depth = 0) => {
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const visibleEntries = entries
      .filter((entry) => {
        if (globalIgnoredNames.has(entry.name)) return false;
        if (entry.isDirectory()) return true;
        return entry.isFile() || entry.isSymbolicLink();
      });

    const sortedFiles = visibleEntries
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .sort((a, b) => {
        const aIndex = FILE_SENTINELS.indexOf(a.name);
        const bIndex = FILE_SENTINELS.indexOf(b.name);
        if (aIndex !== -1 || bIndex !== -1) {
          if (aIndex === -1) return 1;
          if (bIndex === -1) return -1;
          return aIndex - bIndex;
        }
        return a.name.localeCompare(b.name);
      });

    const sortedDirectories = visibleEntries
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of sortedDirectories) {
      const filePath = resolve(dir, entry.name);
      const relativePath = relative(workspace, filePath);

      files.push({
        kind: 'directory',
        name: entry.name,
        path: filePath,
        relativePath,
        depth,
        ext: '',
        size: 0,
        sizeLabel: '',
        modified: null,
        modifiedLabel: '',
        isSymlink: false,
        previewable: false
      });

      await walk(filePath, depth + 1);
    }

    for (const entry of sortedFiles) {
      const filePath = resolve(dir, entry.name);
      const relativePath = relative(workspace, filePath);

      let fileStat;
      let realFilePath = filePath;
      try {
        fileStat = await stat(filePath);
        if (entry.isSymbolicLink()) realFilePath = await realpath(filePath);
      } catch {
        continue;
      }
      if (!fileStat.isFile()) continue;

      const ext = entry.name.startsWith('.env') ? 'env' : extname(entry.name).replace(/^\./, '').toLowerCase();
      files.push({
        kind: 'file',
        name: entry.name,
        path: filePath,
        realPath: realFilePath,
        relativePath,
        depth,
        ext,
        size: fileStat.size,
        sizeLabel: formatBytes(fileStat.size),
        modified: fileStat.mtime.toISOString(),
        modifiedMs: fileStat.mtimeMs,
        modifiedLabel: formatModified(fileStat.mtimeMs),
        isSymlink: entry.isSymbolicLink(),
        previewable: isPreviewableTextName(entry.name) && !isSecretEnvName(entry.name),
        secretEnv: isSecretEnvName(entry.name)
      });
    }
  };

  await walk(workspace);
  return files;
}

async function readWorkspaceFile(agentPath, filePath, options = {}) {
  let resolvedPath;
  let fileStat;
  try {
    ({ target: resolvedPath } = await resolveWorkspacePath(agentPath, filePath));
    fileStat = await stat(resolvedPath);
  } catch (error) {
    if (String(error?.message || '').includes('no longer exists')) {
      return { ok: false, reason: 'missing', content: '[file no longer exists]' };
    }
    throw error;
  }

  const fileName = basename(resolvedPath);
  const isSecretEnv = isSecretEnvName(fileName);
  if (isSecretEnv && !options?.revealSecretEnv) {
    return { ok: false, reason: 'secret', content: '[secret environment files cannot be previewed]' };
  }

  if (!fileStat.isFile()) return { ok: false, reason: 'not-file', content: '[not a file]' };
  if (fileStat.size > MAX_EDITOR_FILE_BYTES) {
    return {
      ok: false,
      reason: 'too-large',
      content: `[file exceeds the 50 MB editor limit - ${formatBytes(fileStat.size)}]`,
      size: fileStat.size,
      modified: fileStat.mtime.toISOString(),
      modifiedMs: fileStat.mtimeMs
    };
  }
  if (!isPreviewableTextName(fileName) && !isSecretEnv) {
    return { ok: false, reason: 'unsupported', content: '[preview unavailable for this file type]' };
  }

  const buffer = await readFile(resolvedPath);
  if (buffer.includes(0)) return { ok: false, reason: 'binary', content: '[binary file - cannot preview]' };
  return {
    ok: true,
    reason: fileStat.size === 0 ? 'empty' : null,
    content: buffer.toString('utf8'),
    size: fileStat.size,
    modified: fileStat.mtime.toISOString(),
    modifiedMs: fileStat.mtimeMs
  };
}

async function saveWorkspaceFile(agentPath, filePath, content, expected = {}) {
  const { target } = await resolveWorkspacePath(agentPath, filePath);
  const fileName = basename(target);
  const allowSecretEnv = Boolean(expected?.allowSecretEnv);
  assertEditableTextName(fileName, { allowSecretEnv });

  const linkStat = await lstat(target);
  if (linkStat.isSymbolicLink()) throw new Error('Symlinked files cannot be edited');

  let fileStat;
  try {
    fileStat = await stat(target);
  } catch {
    throw new Error('File no longer exists');
  }
  if (!fileStat.isFile()) throw new Error('Only files can be saved');

  const expectedSize = Number(expected?.size);
  const expectedModifiedMs = Number(expected?.modifiedMs);
  if (
    Number.isFinite(expectedSize) &&
    Number.isFinite(expectedModifiedMs) &&
    (fileStat.size !== expectedSize || Math.abs(fileStat.mtimeMs - expectedModifiedMs) > 1)
  ) {
    return {
      ok: false,
      reason: 'modified',
      content: 'This file changed on disk after it was opened. Reload it before saving.'
    };
  }

  const normalizedContent = String(content ?? '');
  const byteLength = Buffer.byteLength(normalizedContent, 'utf8');
  if (byteLength > MAX_EDITOR_FILE_BYTES) {
    throw new Error(`File exceeds the 50 MB editor limit (${formatBytes(byteLength)}); cannot save`);
  }

  await writeFile(target, normalizedContent, 'utf8');
  const refreshed = await stat(target);
  return {
    ok: true,
    path: target,
    size: refreshed.size,
    sizeLabel: formatBytes(refreshed.size),
    modified: refreshed.mtime.toISOString(),
    modifiedLabel: formatModified(refreshed.mtimeMs),
    modifiedMs: refreshed.mtimeMs
  };
}

async function createWorkspaceFolder(agentPath, relativePath) {
  const { target } = await resolveWorkspaceRelativePath(agentPath, relativePath);
  await mkdir(dirname(target), { recursive: true });
  try {
    await mkdir(target);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('A file or folder with this name already exists');
    throw error;
  }
  return { ok: true, path: target };
}

async function createWorkspaceFile(agentPath, relativePath, content = '') {
  const { target } = await resolveWorkspaceRelativePath(agentPath, relativePath);
  const fileName = basename(target);
  assertEditableTextName(fileName, { allowSecretEnv: isSecretEnvName(fileName) });
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });

  const normalizedContent = String(content ?? '');
  const byteLength = Buffer.byteLength(normalizedContent, 'utf8');
  if (byteLength > MAX_EDITOR_FILE_BYTES) {
    throw new Error(`File exceeds the 50 MB editor limit (${formatBytes(byteLength)}); cannot create`);
  }

  await writeFile(target, normalizedContent, { encoding: 'utf8', flag: 'wx' });
  return { ok: true, path: target };
}

async function moveWorkspaceEntry(agentPath, sourcePath, destinationRelativePath) {
  const { workspace, target: source } = await resolveWorkspacePath(agentPath, sourcePath);
  if (source === workspace) throw new Error('The workspace root cannot be moved');

  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink()) throw new Error('Symlinked entries cannot be moved');

  const { target: destination } = await resolveWorkspaceRelativePath(agentPath, destinationRelativePath);
  if (existsSync(destination)) throw new Error('A file or folder already exists at that path');

  if (sourceStat.isDirectory() && isInsidePath(source, destination)) {
    throw new Error('A folder cannot be moved inside itself');
  }

  await mkdir(dirname(destination), { recursive: true });
  await rename(source, destination);
  return { ok: true, path: destination };
}

async function deleteWorkspaceEntry(agentPath, targetPath) {
  const { workspace, target } = await resolveWorkspacePath(agentPath, targetPath);
  if (target === workspace) throw new Error('The workspace root cannot be deleted');

  const targetStat = await lstat(target);
  if (targetStat.isSymbolicLink()) throw new Error('Symlinked entries cannot be deleted');

  await rm(target, { recursive: targetStat.isDirectory(), force: false });
  return { ok: true, path: target };
}

async function git(args, cwd, options = {}) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { timeout: 5000, ...options });
    return stdout;
  } catch (error) {
    if (typeof error.stdout === 'string' && error.stdout.length > 0) return error.stdout;
    throw error;
  }
}

function parseBranchLine(line) {
  const result = { branch: 'HEAD', tracking: null, ahead: 0, behind: 0 };
  const value = line.replace(/^##\s*/, '').trim();
  const bracketIndex = value.indexOf(' [');
  const branchPart = bracketIndex === -1 ? value : value.slice(0, bracketIndex);
  const meta = bracketIndex === -1 ? '' : value.slice(bracketIndex + 2, -1);
  const [branch, tracking] = branchPart.split('...');
  result.branch = branch || 'HEAD';
  result.tracking = tracking || null;

  const ahead = meta.match(/ahead (\d+)/);
  const behind = meta.match(/behind (\d+)/);
  result.ahead = ahead ? Number(ahead[1]) : 0;
  result.behind = behind ? Number(behind[1]) : 0;
  return result;
}

function normalizeGitChange(line) {
  const indexStatus = line[0];
  const worktreeStatus = line[1];
  const status = line.startsWith('??') ? '?' : (worktreeStatus !== ' ' ? worktreeStatus : indexStatus);
  const rawFile = line.slice(3);
  if (status === 'R') {
    const [oldFile, file] = rawFile.split(' -> ');
    return { status, file: file || rawFile, oldFile };
  }
  return { status, file: rawFile };
}

async function getGitStatus(repoPath) {
  const cwd = resolve(repoPath);
  try {
    const isRepo = (await git(['rev-parse', '--is-inside-work-tree'], cwd)).trim() === 'true';
    if (!isRepo) return { branch: '', tracking: null, ahead: 0, behind: 0, changes: [], isRepo: false };
  } catch {
    return { branch: '', tracking: null, ahead: 0, behind: 0, changes: [], isRepo: false };
  }

  const output = await git(['status', '--short', '--branch'], cwd);
  const lines = output.split('\n').filter(Boolean);
  const branchInfo = lines[0]?.startsWith('##') ? parseBranchLine(lines[0]) : { branch: 'HEAD', tracking: null, ahead: 0, behind: 0 };
  const changes = lines.slice(1).map(normalizeGitChange).filter((change) => change.file);
  return { ...branchInfo, changes, isRepo: true };
}

async function getGitDiff(repoPath, filePath, status) {
  const cwd = resolve(repoPath);
  const relFile = filePath;
  const absFile = resolve(cwd, relFile);

  if (status === '?') {
    try {
      return await execFileAsync('git', ['diff', '--no-index', '--', '/dev/null', absFile], { timeout: 5000 }).then(({ stdout }) => stdout);
    } catch (error) {
      return error.stdout || '';
    }
  }

  let diff = await git(['diff', '--', relFile], cwd).catch(() => '');
  if (!diff.trim()) diff = await git(['diff', '--cached', '--', relFile], cwd).catch(() => '');
  return diff || `[no diff available for ${relFile}]`;
}

async function scanRoot(root, depth = 0, found = new Map(), ignoredNames = new Set()) {
  if (found.size >= MAX_AGENTS) return found;

  let rootStat;
  try {
    rootStat = await stat(root);
  } catch {
    return found;
  }

  if (!rootStat.isDirectory()) return found;

  if (await hasSentinel(root)) {
    found.set(resolve(root), true);
  }

  if (depth >= 2) return found;

  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    if (found.size >= MAX_AGENTS) break;
    if (!entry.isDirectory() || ignoredNames.has(entry.name)) continue;
    await scanRoot(join(root, entry.name), depth + 1, found, ignoredNames);
  }

  return found;
}

async function scanAgents() {
  const config = await readConfig();
  const roots = await getScanRoots(config);
  const found = new Map();
  const pinnedPaths = new Set(config.pinnedPaths.map((path) => resolve(path)));
  const globalIgnoredNames = new Set(config.globalIgnoredNames);

  pinnedPaths.forEach((path) => {
    if (existsSync(path)) found.set(resolve(path), true);
  });

  for (const root of roots) {
    await scanRoot(root, 0, found, globalIgnoredNames);
    if (found.size >= MAX_AGENTS) break;
  }

  const removedPaths = config.removedPaths.map((path) => resolve(path));
  const visiblePaths = [...found.keys()].filter((path) => {
    const resolvedPath = resolve(path);
    if (pinnedPaths.has(resolvedPath)) return !removedPaths.includes(resolvedPath);
    return !removedPaths.some((removedPath) => isInsidePath(removedPath, resolvedPath));
  });
  const agents = await Promise.all(visiblePaths.map((path) => buildAgentInfo(path, config.favorites, config.agentUsage, config.agentStarterFiles)));
  historyAgents = sortAgentsByManualOrder(agents, config);
  return historyAgents;
}

async function inspectDirectory(dirPath) {
  const path = resolve(dirPath);
  const dirStat = await stat(path);
  if (!dirStat.isDirectory()) throw new Error('Selected path is not a directory');

  const sentinels = await findSentinels(path);
  const isGitRepo = await isGitRepository(path);
  return {
    path,
    name: basename(path),
    isAgentWorkspace: sentinels.length > 0,
    sentinels,
    isGitRepo,
    branch: isGitRepo ? await getGitBranch(path) : null
  };
}

async function connectAgentPath(dirPath, { force = false } = {}) {
  const inspection = await inspectDirectory(dirPath);
  const config = await readConfig();
  const pinnedPaths = new Set(config.pinnedPaths.map((path) => resolve(path)));
  const removedPaths = new Set(config.removedPaths.map((path) => resolve(path)));
  const agents = await scanAgents();
  const existingAgent = agents.find((agent) => resolve(agent.path) === inspection.path);

  if (existingAgent) {
    return { status: 'already-connected', inspection, agent: existingAgent, agents };
  }

  if (!inspection.isAgentWorkspace && !force) {
    return { status: 'needs-confirmation', inspection, agents };
  }

  pinnedPaths.add(inspection.path);
  removedPaths.delete(inspection.path);
  await writeConfig({
    ...config,
    pinnedPaths: [...pinnedPaths],
    removedPaths: [...removedPaths]
  });

  const updatedAgents = await scanAgents();
  return {
    status: inspection.isAgentWorkspace ? 'connected' : 'connected-generic',
    inspection,
    agent: updatedAgents.find((agent) => resolve(agent.path) === inspection.path) || null,
    agents: updatedAgents
  };
}

function broadcastAgentsChanged() {
  clearTimeout(agentWatchDebounce);
  agentWatchDebounce = setTimeout(async () => {
    const agents = await scanAgents();
    BrowserWindow.getAllWindows().forEach((window) => {
      sendToWebContents(window.webContents, 'agents:changed', agents);
    });
  }, 300);
}

async function startAgentWatch() {
  stopAgentWatch();
  const config = await readConfig();
  const roots = await getScanRoots(config);

  agentWatcher = roots
    .map((root) => {
      try {
        return watch(root, { recursive: true }, (_event, filename) => {
          if (!filename) return;
          const changed = String(filename);
          if (SENTINELS.some((sentinel) => changed.endsWith(sentinel)) || changed.includes('.claude')) {
            broadcastAgentsChanged();
          }
        });
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function stopAgentWatch() {
  if (!agentWatcher) return;
  agentWatcher.forEach((watcher) => watcher.close());
  agentWatcher = null;
}

function shellCommand() {
  if (process.env.SHELL) return process.env.SHELL;
  return process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh';
}

function shellArgs(shell) {
  if (process.platform === 'win32') return ['-NoLogo'];
  return shell.endsWith('zsh') || shell.endsWith('bash') || shell.endsWith('sh') ? ['-l', '-i'] : [];
}

function managedAgentCommand(provider, mode = 'default', prompt = '', model = '', reasoningEffort = '') {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const normalizedMode = String(mode || 'default').trim().toLowerCase();
  const execution = normalizeScheduleExecution({ provider: normalizedProvider, model, reasoningEffort });
  const modelArgs = execution.model ? ['--model', execution.model] : [];
  const effortArgs = execution.reasoningEffort && execution.reasoningEffort !== 'default' ? (normalizedProvider === 'claude'
    ? ['--effort', execution.reasoningEffort]
    : ['-c', `model_reasoning_effort="${execution.reasoningEffort}"`]) : [];

  if (normalizedProvider === 'claude') {
    if (normalizedMode === 'default') return { command: 'claude', args: [] };
    if (normalizedMode === 'skip-permissions') return { command: 'claude', args: ['--dangerously-skip-permissions'] };
    if (normalizedMode === 'prompt') {
      const message = String(prompt || '');
      if (!message.trim()) throw new Error('Prompt is required');
      return { command: 'claude', args: ['--dangerously-skip-permissions', ...modelArgs, ...effortArgs, '-p', message] };
    }
  }

  if (normalizedProvider === 'codex') {
    if (normalizedMode === 'prompt') {
      if (!String(prompt || '').trim()) throw new Error('Prompt is required');
      return { command: 'codex', args: ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', ...modelArgs, ...effortArgs, '--', String(prompt)] };
    }
    if (normalizedMode === 'default') return { command: 'codex', args: [] };
    if (normalizedMode === 'bypass-sandbox') return { command: 'codex', args: ['--dangerously-bypass-approvals-and-sandbox'] };
  }

  throw new Error(`Unsupported managed agent launch: ${provider || 'unknown'} ${mode || ''}`.trim());
}

function augmentedEnv() {
  const extraPaths = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    `${homedir()}/.local/bin`,
    `${homedir()}/.npm-global/bin`,
    `${homedir()}/.nvm/versions/node/current/bin`
  ];
  const existing = process.env.PATH || '';
  const parts = existing.split(':').filter(Boolean);
  for (const p of extraPaths) {
    if (!parts.includes(p)) parts.push(p);
  }
  return { ...process.env, PATH: parts.join(':') };
}

function terminalKey(webContentsId, agentId) {
  return `${webContentsId}:${agentId}`;
}

function powerKey(webContentsId, agentId) {
  return `${webContentsId}:${agentId}`;
}

function isSleepBlockerActive() {
  return Boolean(caffeinateProcess || powerSaveBlockerId !== null);
}

function startElectronSleepBlocker() {
  if (powerSaveBlockerId !== null) return;
  powerSaveBlockerId = powerSaveBlocker.start('prevent-display-sleep');
}

function startSleepBlocker() {
  if (isSleepBlockerActive()) return;

  if (process.platform === 'darwin' && !caffeinateUnavailable) {
    const child = spawn('caffeinate', ['-i'], { stdio: 'ignore' });
    caffeinateProcess = child;

    child.once('error', () => {
      if (caffeinateProcess !== child) return;
      caffeinateProcess = null;
      caffeinateUnavailable = true;
      if (runningAgentPowerKeys.size > 0) startElectronSleepBlocker();
    });

    child.once('exit', () => {
      if (caffeinateProcess !== child) return;
      caffeinateProcess = null;
      if (runningAgentPowerKeys.size > 0) syncSleepBlocker();
    });
    return;
  }

  startElectronSleepBlocker();
}

function stopSleepBlocker() {
  if (caffeinateProcess) {
    const child = caffeinateProcess;
    caffeinateProcess = null;
    child.kill();
  }

  if (powerSaveBlockerId !== null) {
    if (powerSaveBlocker.isStarted(powerSaveBlockerId)) {
      powerSaveBlocker.stop(powerSaveBlockerId);
    }
    powerSaveBlockerId = null;
  }
}

function syncSleepBlocker() {
  if (runningAgentPowerKeys.size > 0) {
    startSleepBlocker();
  } else {
    stopSleepBlocker();
  }
}

function clearWindowPowerKeys(webContentsId) {
  const prefix = `${webContentsId}:`;
  for (const key of runningAgentPowerKeys) {
    if (key.startsWith(prefix)) runningAgentPowerKeys.delete(key);
  }
  syncSleepBlocker();
}

function stopTerminalSession(key) {
  const session = terminalSessions.get(key);
  if (!session) return;
  session.monitor?.dispose(0, null, true);
  session.process.kill();
  terminalSessions.delete(key);
  runningAgentPowerKeys.delete(key);
  syncSleepBlocker();
}

function stopWindowTerminalSessions(webContentsId) {
  const prefix = `${webContentsId}:`;
  for (const key of terminalSessions.keys()) {
    if (key.startsWith(prefix)) stopTerminalSession(key);
  }
  clearWindowPowerKeys(webContentsId);
}

function sendToWebContents(webContents, channel, payload) {
  if (!webContents || webContents.isDestroyed()) return false;

  try {
    webContents.send(channel, payload);
    return true;
  } catch (error) {
    if (error?.message?.includes('Object has been destroyed')) return false;
    throw error;
  }
}

function isValidCronTime(value) {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hours, minutes] = value.split(':').map(Number);
  return hours >= 0 && hours < 24 && [0, 15, 30, 45].includes(minutes);
}

function normalizeIsoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function timingSignature(schedule) {
  if (!schedule) return '';
  return JSON.stringify({
    type: schedule.type,
    daysOfWeek: normalizeCronDays(schedule.daysOfWeek),
    times: Array.isArray(schedule.times) ? [...schedule.times].sort() : [],
    intervalMinutes: Number(schedule.intervalMinutes) || 0,
    startTime: schedule.startTime || null
  });
}

function normalizeCronDays(days) {
  const source = Array.isArray(days) && days.length > 0 ? days : CRON_DAY_INDEXES;
  const normalized = [...new Set(source
    .map((day) => Number(day))
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
    .sort((a, b) => a - b);
  return normalized.length ? normalized : [...CRON_DAY_INDEXES];
}

function normalizeScheduleExecution(value) {
  const provider = value.provider || 'claude';
  if (!['claude', 'codex'].includes(provider)) throw new Error('Choose Claude or Codex.');
  const model = String(value.model || '').trim();
  if (model.length > 200 || (model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]*$/.test(model))) throw new Error('Enter a valid model ID.');
  const reasoningEffort = String(value.reasoningEffort || 'medium').trim() || 'medium';
  const allowed = provider === 'claude' ? ['', 'default', 'low', 'medium', 'high', 'xhigh', 'max']
    : ['', 'default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  if (!allowed.includes(reasoningEffort)) throw new Error('Choose a valid reasoning effort for this provider.');
  return { provider, model, reasoningEffort };
}

function normalizeCronSchedule(schedule, existingSchedule = null) {
  if (!schedule || typeof schedule !== 'object') throw new Error('Invalid cron schedule');
  const agentId = String(schedule.agentId || '').trim();
  const agentPath = String(schedule.agentPath || '').trim();
  const type = schedule.type;
  const startMessage = String(schedule.startMessage || '').trim();

  if (!agentId) throw new Error('Agent is required');
  if (!agentPath) throw new Error('Agent path is required');
  if (!startMessage) throw new Error('Starting message is required');
  if (type !== 'times' && type !== 'interval') throw new Error('Schedule type must be times or interval');

  const createdAt = normalizeIsoDate(existingSchedule?.createdAt) || normalizeIsoDate(schedule.createdAt) || new Date().toISOString();
  const normalized = {
    agentId,
    agentPath: resolve(agentPath),
    ...normalizeScheduleExecution(schedule),
    type,
    daysOfWeek: normalizeCronDays(schedule.daysOfWeek),
    times: [],
    intervalMinutes: 0,
    startTime: null,
    createdAt,
    lastFiredAt: null,
    startMessage,
    enabled: schedule.enabled !== false,
    statefulRuntimeEnabled: schedule.statefulRuntimeEnabled === true
  };

  if (type === 'times') {
    const times = [...new Set((Array.isArray(schedule.times) ? schedule.times : []).filter(isValidCronTime))].sort();
    if (times.length === 0) throw new Error('Select at least one time');
    normalized.times = times;
  } else {
    const intervalMinutes = Number(schedule.intervalMinutes);
    if (!Number.isFinite(intervalMinutes) || intervalMinutes < 5) {
      throw new Error('Interval must be at least 5 minutes');
    }
    normalized.intervalMinutes = Math.floor(intervalMinutes);
    normalized.startTime = normalizeIsoDate(schedule.startTime);
  }

  if (existingSchedule && timingSignature(existingSchedule) === timingSignature(normalized)) {
    normalized.lastFiredAt = normalizeIsoDate(existingSchedule.lastFiredAt);
  }

  return normalized;
}

function normalizeScheduledRun(run) {
  if (!run || typeof run !== 'object') return null;
  const id = String(run.id || '').trim();
  const agentId = String(run.agentId || '').trim();
  const agentPath = String(run.agentPath || '').trim();
  const startedAt = normalizeIsoDate(run.startedAt);
  const status = SCHEDULED_RUN_STATUSES.has(run.status) ? run.status : 'running';

  if (!id || !agentId || !agentPath || !startedAt) return null;

  const normalized = {
    id,
    agentId,
    agentPath: resolve(agentPath),
    startedAt,
    provider: run.provider === 'codex' ? 'codex' : 'claude',
    model: String(run.model || ''),
    reasoningEffort: String(run.reasoningEffort || ''),
    status,
    scheduleLabel: String(run.scheduleLabel || '').trim()
  };

  if (validConversationId(run.conversationId)) normalized.conversationId = run.conversationId;
  const finishedAt = normalizeIsoDate(run.finishedAt);
  if (finishedAt) normalized.finishedAt = finishedAt;
  if (run.exitCode !== undefined && run.exitCode !== null && Number.isFinite(Number(run.exitCode))) {
    normalized.exitCode = Number(run.exitCode);
  }
  if (run.signal !== undefined && run.signal !== null && String(run.signal).trim()) {
    normalized.signal = String(run.signal).trim();
  }
  if (run.messagePreview !== undefined && run.messagePreview !== null && String(run.messagePreview).trim()) {
    normalized.messagePreview = String(run.messagePreview).trim().slice(0, 240);
  }

  return normalized;
}

function capScheduledRuns(runs) {
  const normalizedRuns = (Array.isArray(runs) ? runs : [])
    .map(normalizeScheduledRun)
    .filter(Boolean)
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

  const countsByAgent = new Map();
  return normalizedRuns.filter((run) => {
    const count = countsByAgent.get(run.agentId) || 0;
    if (count >= MAX_SCHEDULED_RUNS_PER_AGENT) return false;
    countsByAgent.set(run.agentId, count + 1);
    return true;
  });
}

function scheduledRunsForAgent(runs, agentId = null) {
  return capScheduledRuns(runs)
    .filter((run) => !agentId || run.agentId === agentId)
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

function createScheduledRun(schedule, now = new Date()) {
  return normalizeScheduledRun({
    id: `${schedule.agentId}:${now.getTime()}:${Math.random().toString(36).slice(2, 8)}`,
    agentId: schedule.agentId,
    agentPath: schedule.agentPath,
    startedAt: now.toISOString(),
    ...normalizeScheduleExecution(schedule),
    conversationId: schedule.provider === 'codex' ? undefined : randomUUID(),
    status: 'running',
    scheduleLabel: cronScheduleLabel(schedule),
    messagePreview: schedule.startMessage
  });
}

function normalizeCronSchedules(schedules) {
  return (Array.isArray(schedules) ? schedules : [])
    .map((schedule) => {
      try {
        return normalizeCronSchedule(schedule, schedule);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function cronScheduleLabel(schedule) {
  if (!schedule) return 'Scheduled run';
  if (schedule.enabled === false) return 'Paused';
  const days = normalizeCronDays(schedule.daysOfWeek);
  const selectedDays = new Set(days);
  const dayLabel = days.length === 7 ? 'Mon-Sun' : CRON_DAY_DISPLAY_ORDER
    .filter((day) => selectedDays.has(day))
    .map((day) => CRON_DAY_SHORT_NAMES[day])
    .join(', ');
  if (schedule.type === 'times') {
    const times = Array.isArray(schedule.times) ? schedule.times : [];
    return times.length ? `${dayLabel} at ${times.join(', ')}` : 'Specific times';
  }
  const minutes = Number(schedule.intervalMinutes) || 0;
  const daySuffix = days.length === 7 ? '' : ` on ${dayLabel}`;
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return `Every ${hours} hour${hours === 1 ? '' : 's'}${daySuffix}`;
  }
  return `Every ${minutes} minute${minutes === 1 ? '' : 's'}${daySuffix}`;
}

async function settleStaleScheduledRunsOnStartup() {
  const config = await readConfig();
  const now = new Date().toISOString();
  let changed = false;
  const scheduledRuns = capScheduledRuns(config.scheduledRuns).map((run) => {
    if (run.status !== 'running') return run;
    changed = true;
    return {
      ...run,
      status: 'stopped',
      finishedAt: run.finishedAt || now,
      messagePreview: run.messagePreview || 'App closed before completion'
    };
  });
  if (changed) await writeConfig({ ...config, scheduledRuns });
}

function easternTimeParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CRON_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23'
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

function easternWeekdayIndex(date) {
  const weekday = easternTimeParts(date).weekday;
  return CRON_DAY_SHORT_NAMES.indexOf(weekday);
}

function easternHHMM(date) {
  const parts = easternTimeParts(date);
  return `${parts.hour}:${parts.minute}`;
}

function easternSlotKey(date, hhmm = easternHHMM(date)) {
  const parts = easternTimeParts(date);
  return `${parts.year}-${parts.month}-${parts.day}T${hhmm}`;
}

function isAgentRunning(agentId) {
  return [...runningAgentPowerKeys].some((key) => key.endsWith(`:${agentId}`));
}

function shouldFireCronSchedule(schedule, now = new Date()) {
  if (appUpdates?.installing || openRouter?.isRunning(schedule?.agentPath)) return false;
  if (!schedule?.enabled || isAgentRunning(schedule.agentId)) return false;
  if (!schedule.agentPath || !existsSync(schedule.agentPath)) return false;
  if (!normalizeCronDays(schedule.daysOfWeek).includes(easternWeekdayIndex(now))) return false;
  const currentHHMM = easternHHMM(now);

  if (schedule.type === 'times') {
    if (!Array.isArray(schedule.times) || !schedule.times.includes(currentHHMM)) return false;
    const lastFiredAt = schedule.lastFiredAt ? new Date(schedule.lastFiredAt) : null;
    if (!lastFiredAt || Number.isNaN(lastFiredAt.getTime())) return true;
    return easternSlotKey(lastFiredAt) < easternSlotKey(now, currentHHMM);
  }

  if (schedule.type === 'interval') {
    const intervalMinutes = Number(schedule.intervalMinutes);
    if (!Number.isFinite(intervalMinutes) || intervalMinutes < 5) return false;
    const anchor = new Date(schedule.lastFiredAt || schedule.startTime || schedule.createdAt);
    if (Number.isNaN(anchor.getTime())) return false;
    return now.getTime() - anchor.getTime() >= intervalMinutes * 60 * 1000;
  }

  return false;
}

function startCronScheduler() {
  if (cronSchedulerInterval) return;

  cronSchedulerInterval = setInterval(async () => {
    try {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length === 0) return;

      const config = await readConfig();
      let changed = false;
      const now = new Date();
      const scheduledRuns = [...config.scheduledRuns];
      const cronSchedules = [];
      const pendingFires = [];
      for (const schedule of normalizeCronSchedules(config.cronSchedules)) {
        if (!shouldFireCronSchedule(schedule, now)) {
          cronSchedules.push(schedule);
          continue;
        }
        const updated = { ...schedule, lastFiredAt: now.toISOString() };
        const run = createScheduledRun(updated, now);
        if (run) scheduledRuns.unshift(run);
        changed = true;
        const runtimePrompt = await buildScheduledRuntimePrompt(updated, run);
        pendingFires.push({
            agentId: updated.agentId,
            agentPath: updated.agentPath,
            lastFiredAt: updated.lastFiredAt,
            startMessage: runtimePrompt,
            originalStartMessage: updated.startMessage,
            statefulRuntimeEnabled: updated.statefulRuntimeEnabled === true,
            runId: run?.id || null
        });
        cronSchedules.push(updated);
      }

      if (changed) await writeConfig({ ...config, cronSchedules, scheduledRuns: capScheduledRuns(scheduledRuns) });
      for (const payload of pendingFires) {
        windows.forEach(window => sendToWebContents(window.webContents, 'cron:fire', payload));
      }
    } catch (error) {
      console.warn('Cron scheduler tick failed', error);
    }
  }, 60 * 1000);
}

ipcMain.handle('agents:scan', scanAgents);
ipcMain.handle('agents:connect', async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const options = {
    title: 'Select Agent Workspace',
    buttonLabel: 'Connect',
    properties: ['openDirectory', 'createDirectory']
  };
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);

  if (result.canceled || result.filePaths.length === 0) return null;
  return connectAgentPath(result.filePaths[0]);
});
// Creation is scoped to the parent chosen in this renderer's native folder picker.
const newAgentParents = new Map();
const creatingAgents = new Set();
ipcMain.handle('agents:choose-parent', async event => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const options = { title: 'Choose Location for New Agent', buttonLabel: 'Choose Location', defaultPath: homedir(), properties: ['openDirectory', 'createDirectory'] };
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths.length || event.sender.isDestroyed()) return null;
  const parentPath = await realpath(result.filePaths[0]);
  if (!newAgentParents.has(event.sender.id)) {
    const senderId = event.sender.id;
    event.sender.once('destroyed', () => newAgentParents.delete(senderId));
  }
  newAgentParents.set(event.sender.id, parentPath);
  return parentPath;
});
ipcMain.handle('agents:create', async (event, name, instructionFile = 'agent.md') => {
  const senderId = event.sender.id;
  const parentPath = newAgentParents.get(senderId);
  if (!parentPath) throw new Error('Choose a location for your new agent first.');
  if (creatingAgents.has(senderId)) throw new Error('An agent is already being created.');
  creatingAgents.add(senderId);
  try {
    const result = await createAgentWorkspace(parentPath, name, instructionFile);
    if (result.status === 'exists') return result;
    try {
      const connected = await connectAgentPath(result.path, { force: true });
      return { ...connected, status: 'connected' };
    } catch (error) {
      return { status: 'created-unconnected', path: result.path, message: `The folder and ${instructionFile} were created, but the agent could not be connected: ${error.message}` };
    }
  } finally { creatingAgents.delete(senderId); }
});
const duplicatingAgents = new Set();
ipcMain.handle('agents:duplicate', async (event, agentId) => {
  if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('Duplicate from the app window.');
  if (duplicatingAgents.has(agentId)) throw new Error('This agent is already being duplicated.');
  duplicatingAgents.add(agentId);
  try {
    const agent = (await scanAgents()).find(item => item.id === agentId);
    if (!agent) throw new Error('Agent is no longer connected.');
    const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
      type: 'question',
      title: 'Duplicate agent',
      message: `Duplicate “${agent.name}”?`,
      detail: 'This will copy the entire agent folder into a new folder beside the original.',
      buttons: ['Cancel', 'Duplicate'],
      defaultId: 1,
      cancelId: 0,
      noLink: true
    });
    if (response !== 1) return { status: 'cancelled' };
    const result = await duplicateAgentWorkspace(agent.path);
    try { return await connectAgentPath(result.path, { force: true }); }
    catch (error) { throw new Error(`Copied to ${result.path}, but could not connect: ${error.message}`); }
  } finally { duplicatingAgents.delete(agentId); }
});
async function scheduleModelOptions(cwd = homedir()) {
  let codex = [];
  try {
    const cache = JSON.parse(await readFile(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json'), 'utf8'));
    codex = (cache.models || []).filter(model => model.visibility !== 'hide' && typeof model.slug === 'string').map(model => ({
      id: model.slug, label: model.display_name || model.slug,
      efforts: (model.supported_reasoning_levels || []).map(level => level.effort)
        .filter(level => ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(level))
    }));
  } catch { /* Provider default remains available without a local cache. */ }
  let claude;
  let claudeVersion = '';
  let claudeError = '';
  try {
    const discovery = await discoverClaudeModels({ cwd, env: augmentedEnv() });
    claude = discovery.models;
    claudeVersion = discovery.version;
  } catch (error) {
    claudeError = `${error.message} Explicit Claude model choices are unavailable until supported models can be verified.`;
    claude = [];
  }
  return { claude, codex, claudeVersion, claudeError };
}
function assertChatModelRequest(event, request) {
  if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('Use the model selector in the app window.');
  return assertAgentPathMatches(request.agentId, request.cwd);
}
ipcMain.handle('chat-models:get', async (event, request = {}) => {
  const cwd = assertChatModelRequest(event, request);
  const root = await realpath(cwd);
  const config = await readConfig();
  const session = terminalSessions.get(terminalKey(event.sender.id, request.agentId));
  return { defaults: config.chatModelDefaults[root] || {}, session: session?.managed && session.mode !== 'prompt' ? {
    provider: session.provider, token: session.modelToken, selection: session.modelSelection,
    resumed: session.mode === 'resume'
  } : null };
});
ipcMain.handle('chat-models:catalog', async (event, request = {}) => scheduleModelOptions(assertChatModelRequest(event, request)));
ipcMain.handle('chat-models:save', async (event, request = {}) => {
  const cwd = assertChatModelRequest(event, request);
  const root = await realpath(cwd);
  const selection = validateChatModel(request.provider, request, await scheduleModelOptions(cwd));
  const config = await readConfig();
  config.chatModelDefaults[root] = { ...config.chatModelDefaults[root], [request.provider]: selection };
  await writeConfig(config);
  return selection;
});
ipcMain.handle('chat-models:prepare', async (event, request = {}) => {
  const cwd = assertChatModelRequest(event, request);
  const key = terminalKey(event.sender.id, request.agentId);
  const session = terminalSessions.get(key);
  const guard = { ...request, sender: event.sender };
  assertChatSwitchSession(session, guard);
  const inputRevision = session.inputRevision || 0;
  if (request.provider === 'codex') validateChatModel(request.provider, request, await scheduleModelOptions(cwd));
  if (terminalSessions.get(key) !== session || (session.inputRevision || 0) !== inputRevision) throw new Error('The chat or terminal input changed. Reopen the selector.');
  assertChatSwitchSession(session, guard);
  const command = chatSwitchCommand(request.provider, request, request.control);
  // Never press Enter, erase a draft, or claim that the CLI applied a request.
  session.process.write('\x1b[200~' + command + '\x1b[201~');
  return { command };
});
ipcMain.handle('cron:models', (_event, { agentId, cwd } = {}) => scheduleModelOptions(
  agentId ? assertAgentPathMatches(agentId, cwd) : homedir()
));
ipcMain.handle('agents:connect-path', async (_event, agentPath) => connectAgentPath(agentPath, { force: true }));
ipcMain.handle('agents:watch', startAgentWatch);
ipcMain.on('agents:unwatch', stopAgentWatch);
ipcMain.handle('app:environment', async () => ({
  isPackaged: app.isPackaged
}));
ipcMain.handle('app:check-for-updates', async (event) => {
  if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Updates can only be checked from the app window.');
  }
  if (!appUpdates) throw new Error('Updater is not ready.');
  await appUpdates.check();
});
ipcMain.handle('settings:get', getSettings);
ipcMain.handle('settings:save-reduce-tool-clutter', async (_event, value) => saveReduceToolClutter(value));
ipcMain.handle('settings:save-chat-contrast', async (_event, value) => saveChatContrast(value));
ipcMain.handle('settings:save-global-ignored-names', async (_event, names) => saveGlobalIgnoredNames(names));
ipcMain.handle('settings:save-launch-on-startup', async (_event, enabled) => saveLaunchOnStartup(enabled));
ipcMain.handle('files:open-terminal', async (event, agentPath, targetPath) => {
  if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Terminal can only be opened from the app window.');
  }
  return openWorkspaceTerminal(agentPath, targetPath);
});
ipcMain.handle('files:list', async (_event, agentPath) => listWorkspaceFiles(agentPath));
ipcMain.handle('files:read', async (_event, agentPath, filePath, options) => readWorkspaceFile(agentPath, filePath, options));
ipcMain.handle('files:save', async (_event, agentPath, filePath, content, expected) => saveWorkspaceFile(agentPath, filePath, content, expected));
ipcMain.handle('files:create-folder', async (_event, agentPath, relativePath) => createWorkspaceFolder(agentPath, relativePath));
ipcMain.handle('files:create-file', async (_event, agentPath, relativePath, content) => createWorkspaceFile(agentPath, relativePath, content));
ipcMain.handle('files:move', async (_event, agentPath, sourcePath, destinationRelativePath) => moveWorkspaceEntry(agentPath, sourcePath, destinationRelativePath));
ipcMain.handle('files:delete', async (_event, agentPath, targetPath) => deleteWorkspaceEntry(agentPath, targetPath));
ipcMain.handle('git:status', async (_event, repoPath) => getGitStatus(repoPath));
ipcMain.handle('git:diff', async (_event, repoPath, filePath, status) => getGitDiff(repoPath, filePath, status));
ipcMain.handle('starter-files:list', async () => {
  const config = await readConfig();
  return config.agentStarterFiles;
});
ipcMain.handle('starter-files:set', async (_event, { agentId, agentPath, relativePath } = {}) => {
  if (!agentId || !agentPath || !relativePath) throw new Error('Missing starter context details');
  const resolvedAgentPath = resolve(agentPath);
  if (hashPath(resolvedAgentPath) !== agentId) throw new Error('Starter context does not match the selected workspace');

  const validation = await validateStarterFile(resolvedAgentPath, relativePath);
  const config = await readConfig();
  const agentStarterFiles = {
    ...config.agentStarterFiles,
    [agentId]: {
      relativePath: validation.relativePath,
      updatedAt: new Date().toISOString()
    }
  };
  await writeConfig({ ...config, agentStarterFiles });
  return agentStarterFiles;
});
ipcMain.handle('starter-files:clear', async (_event, { agentId } = {}) => {
  if (!agentId) throw new Error('Missing agent id');
  const config = await readConfig();
  const agentStarterFiles = { ...config.agentStarterFiles };
  delete agentStarterFiles[agentId];
  await writeConfig({ ...config, agentStarterFiles });
  return agentStarterFiles;
});
ipcMain.handle('agents:reorder', async (_event, section, orderedIds) => {
  if (!['favorites', 'connected'].includes(section) || !Array.isArray(orderedIds)) {
    return scanAgents();
  }

  const config = await readConfig();
  const cleanOrderedIds = [...new Set(orderedIds.filter((id) => typeof id === 'string' && id.trim()))];
  const currentAgents = await scanAgents();

  if (section === 'favorites') {
    const visibleFavoriteIds = new Set(currentAgents.filter((agent) => agent.isFavorite).map((agent) => agent.id));
    const orderedFavorites = cleanOrderedIds.filter((id) => visibleFavoriteIds.has(id));
    const remainingFavorites = config.favorites.filter((id) => !orderedFavorites.includes(id));
    await writeConfig({ ...config, favorites: [...orderedFavorites, ...remainingFavorites] });
    return scanAgents();
  }

  const visibleConnectedIds = currentAgents.filter((agent) => !agent.isFavorite).map((agent) => agent.id);
  const visibleConnectedSet = new Set(visibleConnectedIds);
  const orderedConnected = cleanOrderedIds.filter((id) => visibleConnectedSet.has(id));
  const missingConnected = visibleConnectedIds.filter((id) => !orderedConnected.includes(id));
  await writeConfig({ ...config, agentOrder: [...orderedConnected, ...missingConnected] });
  return scanAgents();
});
ipcMain.handle('favorites:toggle', async (_event, agentId) => {
  const config = await readConfig();
  const favorites = config.favorites.includes(agentId)
    ? config.favorites.filter((id) => id !== agentId)
    : [...config.favorites, agentId];
  await writeConfig({ ...config, favorites });
  return scanAgents();
});
ipcMain.handle('agents:remove', async (_event, agentPath) => {
  const config = await readConfig();
  const removedPath = resolve(agentPath);
  const removedAgentId = hashPath(removedPath);
  const pinnedPaths = new Set(config.pinnedPaths);
  const removedPaths = new Set(config.removedPaths);
  const cronSchedules = config.cronSchedules.filter((schedule) => resolve(schedule.agentPath) !== removedPath);
  const scheduledRuns = config.scheduledRuns.filter((run) => {
    const normalized = normalizeScheduledRun(run);
    return normalized && normalized.agentPath !== removedPath;
  });
  const agentStarterFiles = { ...config.agentStarterFiles };
  delete agentStarterFiles[removedAgentId];
  pinnedPaths.delete(removedPath);
  removedPaths.add(removedPath);
  await writeConfig({ ...config, pinnedPaths: [...pinnedPaths], removedPaths: [...removedPaths], cronSchedules, scheduledRuns, agentStarterFiles });
  return scanAgents();
});
ipcMain.handle('usage:track', async (_event, { agentId, agentName, branch }) => {
  const config = await readConfig();
  const now = new Date().toISOString();

  const agentUsage = { ...config.agentUsage };
  agentUsage[agentId] = {
    openCount: (agentUsage[agentId]?.openCount || 0) + 1,
    lastOpened: now
  };

  const title = branch
    ? `Session · ${branch}`
    : `Session · ${new Date(now).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

  const recentSessions = config.recentSessions.filter((s) => s.agentId !== agentId);
  recentSessions.unshift({ agentId, agentName, title, updatedAt: now });

  const updated = { ...config, agentUsage, recentSessions: recentSessions.slice(0, 20) };
  await writeConfig(updated);
  return { agentUsage, recentSessions: updated.recentSessions };
});
ipcMain.handle('sessions:list', async () => {
  return conversationHistory.list(historyAgents.length ? historyAgents : await scanAgents());
});
ipcMain.handle('cron:save', async (_event, schedule) => {
  const config = await readConfig();
  const existingSchedule = config.cronSchedules.find((item) => item.agentId === schedule?.agentId);
  const normalized = normalizeCronSchedule(schedule, existingSchedule);
  const models = await scheduleModelOptions(normalized.agentPath);
  if (normalized.provider === 'claude') assertClaudeModelSupported(normalized, models);
  const selectedModel = models[normalized.provider].find(model => model.id === normalized.model);
  const retainedModel = normalized.provider !== 'claude' && existingSchedule?.provider === normalized.provider && existingSchedule?.model === normalized.model;
  if (normalized.model && !selectedModel && !retainedModel) throw new Error('Choose a model from the list or use Provider default.');
  if (normalized.reasoningEffort !== 'default' && selectedModel?.efforts && !selectedModel.efforts.includes(normalized.reasoningEffort)) {
    throw new Error('Choose a supported reasoning effort for this model.');
  }
  // Discovery can take several seconds; retain unrelated settings changed while waiting.
  const currentConfig = await readConfig();
  const updated = [...currentConfig.cronSchedules.filter((item) => item.agentId !== normalized.agentId), normalized];
  await writeConfig({ ...currentConfig, cronSchedules: updated });
  return normalizeCronSchedules(updated);
});
ipcMain.handle('cron:delete', async (_event, agentId) => {
  const config = await readConfig();
  const updated = config.cronSchedules.filter((schedule) => schedule.agentId !== agentId);
  const scheduledRuns = config.scheduledRuns.filter((run) => normalizeScheduledRun(run)?.agentId !== agentId);
  await writeConfig({ ...config, cronSchedules: updated, scheduledRuns });
  return normalizeCronSchedules(updated);
});
ipcMain.handle('cron:list', async () => {
  const config = await readConfig();
  return normalizeCronSchedules(config.cronSchedules);
});
ipcMain.handle('cron:runs:list', async (_event, agentId = null) => {
  const config = await readConfig();
  const runs = scheduledRunsForAgent(config.scheduledRuns, typeof agentId === 'string' && agentId.trim() ? agentId : null);
  const capped = capScheduledRuns(config.scheduledRuns);
  if (capped.length !== config.scheduledRuns.length) {
    await writeConfig({ ...config, scheduledRuns: capped });
  }
  return runs;
});
ipcMain.handle('cron:runs:mimic', async (_event, agentId) => {
  const cleanAgentId = String(agentId || '').trim();
  if (!cleanAgentId) throw new Error('Agent is required');

  const config = await readConfig();
  const schedule = config.cronSchedules.find((item) => item.agentId === cleanAgentId);
  if (!schedule) throw new Error('No schedule found for this agent');
  if (!schedule.agentPath || !existsSync(schedule.agentPath)) throw new Error('Scheduled workspace does not exist');

  const now = new Date();
  const run = createScheduledRun(schedule, now);
  const scheduledRuns = capScheduledRuns([run, ...config.scheduledRuns]);
  await writeConfig({ ...config, scheduledRuns });
  const runtimePrompt = await buildScheduledRuntimePrompt(schedule, run);

  return {
    agentId: schedule.agentId,
    agentPath: schedule.agentPath,
    startMessage: runtimePrompt,
    originalStartMessage: schedule.startMessage,
    statefulRuntimeEnabled: schedule.statefulRuntimeEnabled === true,
    runId: run.id,
    runs: scheduledRunsForAgent(scheduledRuns, schedule.agentId)
  };
});
ipcMain.handle('cron:runs:update', async (_event, runUpdate = {}) => {
  if (!runUpdate || typeof runUpdate !== 'object') throw new Error('Invalid scheduled run update');
  const id = String(runUpdate.id || '').trim();
  if (!id) throw new Error('Scheduled run id is required');

  const config = await readConfig();
  const existingRuns = capScheduledRuns(config.scheduledRuns);
  const existing = existingRuns.find((run) => run.id === id);
  if (!existing) throw new Error('Scheduled run not found');

  const status = SCHEDULED_RUN_STATUSES.has(runUpdate.status) ? runUpdate.status : existing.status;
  const allowed = {
    ...existing,
    status,
    finishedAt: normalizeIsoDate(runUpdate.finishedAt) || existing.finishedAt,
    exitCode: runUpdate.exitCode === null ? null : runUpdate.exitCode,
    signal: runUpdate.signal === null ? null : runUpdate.signal
  };
  if (runUpdate.messagePreview !== undefined && runUpdate.messagePreview !== null) {
    allowed.messagePreview = String(runUpdate.messagePreview).trim().slice(0, 240);
  }

  const normalized = normalizeScheduledRun(allowed);
  const scheduledRuns = capScheduledRuns(existingRuns.map((run) => run.id === id ? normalized : run));
  await writeConfig({ ...config, scheduledRuns });
  return scheduledRunsForAgent(scheduledRuns, normalized.agentId);
});
ipcMain.handle('scheduled-state:status', async (_event, { agentId, agentPath } = {}) => {
  const resolvedAgentPath = assertAgentPathMatches(agentId, agentPath);
  return scheduledRuntimeStatus(resolvedAgentPath);
});
ipcMain.handle('scheduled-state:initialize', async (_event, { agentId, agentPath } = {}) => {
  const resolvedAgentPath = assertAgentPathMatches(agentId, agentPath);
  return ensureScheduledRuntimeFiles(resolvedAgentPath);
});
ipcMain.handle('scheduled-state:read', async (_event, { agentId, agentPath, file } = {}) => {
  const resolvedAgentPath = assertAgentPathMatches(agentId, agentPath);
  return readScheduledRuntimeFile(resolvedAgentPath, file);
});
ipcMain.handle('scheduled-state:save', async (_event, { agentId, agentPath, file, content, expected } = {}) => {
  const resolvedAgentPath = assertAgentPathMatches(agentId, agentPath);
  return saveScheduledRuntimeFile(resolvedAgentPath, file, content, expected);
});
ipcMain.handle('scheduled-state:manual-prefix', async (_event, { agentId, agentPath, starterRelativePath } = {}) => {
  const resolvedAgentPath = assertAgentPathMatches(agentId, agentPath);
  return buildManualRuntimePrefix(resolvedAgentPath, starterRelativePath);
});
ipcMain.handle('power:set-agent-running', async (event, { agentId, running } = {}) => {
  if (!agentId) {
    return { activeCount: runningAgentPowerKeys.size, blocking: isSleepBlockerActive() };
  }

  const key = powerKey(event.sender.id, agentId);
  if (running === true) {
    runningAgentPowerKeys.add(key);
  } else {
    runningAgentPowerKeys.delete(key);
  }
  syncSleepBlocker();

  return { activeCount: runningAgentPowerKeys.size, blocking: isSleepBlockerActive() };
});
for (const method of ['list', 'clear']) ipcMain.handle(`traces:${method}`, async (event, input = {}) => {
  if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('Traces are only available in the app window.');
  const agent = (await scanAgents()).find(a => a.id === input.agentId && a.path === input.path);
  if (!agent) throw new Error('Select a connected workspace.');
  if (method === 'clear') await toolTraces.clear(agent.id, typeof input.id === 'string' ? input.id : undefined);
  return toolTraces.list(agent.id);
});

ipcMain.handle('terminal:start', async (event, { agentId, cwd }) => {
  if (appUpdates?.installing) throw new Error('BotLogik is restarting to update.');
  const resolvedCwd = assertAgentPathMatches(agentId, cwd);
  if (openRouter?.isRunning(await realpath(resolvedCwd))) throw new Error('Stop the OpenRouter run before starting a terminal.');
  if (!existsSync(resolvedCwd)) {
    throw new Error(`Workspace does not exist: ${resolvedCwd}`);
  }

  const sender = event.sender;
  const key = terminalKey(sender.id, agentId);
  const existing = terminalSessions.get(key);
  if (existing && existing.cwd === resolvedCwd && !existing.managed) {
    return { sessionId: key, cwd: resolvedCwd, shell: existing.shell, reused: true };
  }
  if (existing) stopTerminalSession(key);

  const shell = shellCommand();
  const child = pty.spawn(shell, shellArgs(shell), {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: resolvedCwd,
    env: freshTerminalEnvironment(augmentedEnv())
  });

  terminalSessions.set(key, { process: child, cwd: resolvedCwd, shell, owner: sender });

  child.onData((data) => {
    sendToWebContents(sender, 'terminal:output', { sessionId: key, data });
  });

  child.onExit(({ exitCode, signal }) => {
    if (terminalSessions.get(key)?.process !== child) return;
    terminalSessions.delete(key);
    runningAgentPowerKeys.delete(key);
    syncSleepBlocker();
    sendToWebContents(sender, 'terminal:exit', { sessionId: key, code: exitCode, signal });
  });

  return { sessionId: key, cwd: resolvedCwd, shell };
});
ipcMain.handle('terminal:start-managed', async (event, { agentId, cwd, provider, mode, prompt, conversationId, runId, model, reasoningEffort } = {}) => {
  if (appUpdates?.installing) throw new Error('BotLogik is restarting to update.');
  const resolvedCwd = assertAgentPathMatches(agentId, cwd);
  if (openRouter?.isRunning(await realpath(resolvedCwd))) throw new Error('Stop the OpenRouter run before starting a terminal.');
  if (!existsSync(resolvedCwd)) {
    throw new Error(`Workspace does not exist: ${resolvedCwd}`);
  }

  const sender = event.sender;
  const key = terminalKey(sender.id, agentId);
  if (pendingManagedLaunches.has(key)) throw new Error('This workspace is already starting an agent.');
  pendingManagedLaunches.add(key);
  try {
    let launch;
    let providerConversationId = null;
    let modelSelection = null;
    if (mode === 'resume') {
      await conversationHistory.list(historyAgents.length ? historyAgents : await scanAgents());
      const saved = conversationHistory.get(provider, conversationId);
      if (!saved || saved.agentId !== agentId) throw new Error('This saved conversation is no longer available for this workspace. Refresh history and try again.');
      launch = resumeCommand(provider, conversationId);
      providerConversationId = conversationId;
    } else {
      if (runId) {
        const config = await readConfig();
        const run = config.scheduledRuns.find(item => item.id === runId && item.agentId === agentId);
        if (!run) throw new Error('Scheduled run not found');
        provider = run.provider || 'claude';
        model = run.model || '';
        reasoningEffort = run.reasoningEffort || '';
      }
      if (provider === 'claude' && mode === 'prompt') {
        assertClaudeModelSupported({ model, reasoningEffort }, await scheduleModelOptions(resolvedCwd));
      }
      if (mode !== 'prompt') {
        const config = await readConfig();
        const preference = model === undefined ? config.chatModelDefaults[await realpath(resolvedCwd)]?.[provider] : { model, reasoningEffort };
        modelSelection = normalizeChatModel(preference);
        if (modelSelection.model) validateChatModel(provider, modelSelection, await scheduleModelOptions(resolvedCwd));
      }
      launch = managedAgentCommand(provider, mode, prompt, model, reasoningEffort);
      if (modelSelection) launch.args.push(...chatModelArgs(provider, modelSelection));
      if (provider === 'claude') {
        if (runId) {
          const config = await readConfig();
          const run = config.scheduledRuns.find(run => run.id === runId && run.agentId === agentId);
          if (!run || !validConversationId(run.conversationId)) throw new Error('Scheduled conversation not found');
          providerConversationId = run.conversationId;
        } else providerConversationId = randomUUID();
        launch.args.push('--session-id', providerConversationId);
      }
    }
    const existing = terminalSessions.get(key);
    if (mode === 'resume' && existing?.managed) {
      if (existing.provider === provider && existing.conversationId === conversationId && !existing.runId) {
        return { sessionId: key, provider, conversationId, reused: true, activity: existing.monitor?.activity.snapshot() };
      }
      if (existing.runId) throw new Error('Stop the scheduled run before resuming a conversation in this workspace.');
      const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(sender), {
        type: 'question', buttons: ['Cancel', 'Resume conversation'], defaultId: 0, cancelId: 0,
        message: 'Replace the active terminal session?',
        detail: 'The current agent process will stop. Its saved conversation remains in history.'
      });
      if (response !== 1) return { cancelled: true };
      if (terminalSessions.get(key) !== existing) throw new Error('The active session changed. Please try again.');
    }
    const launchEnv = augmentedEnv();
    launch.command = await resolveCli(launch.command, launchEnv);
    if (existing) stopTerminalSession(key);
    const monitor = await getActivityBridge().prepare({ provider, agentId, sessionId: key,
      conversationId: providerConversationId, automated: mode === 'prompt', env: launchEnv });
    launch.args.push(...monitor.args);
    let presentationNotice = '';
    if (provider === 'claude' && mode !== 'prompt' && (await readConfig()).reduceToolClutter) {
      presentationNotice = applyClaudeFocus({ provider, mode, version: monitor.version, args: launch.args, env: launchEnv });
    }
    let child;
    try {
      child = pty.spawn(launch.command, launch.args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: resolvedCwd,
        env: {
          ...launchEnv,
          ...monitor.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor'
        }
      });
    } catch (error) {
      monitor.dispose(1, null);
      // The rejected launch is the failure notification; no session was registered.
      throw error;
    }

    terminalSessions.set(key, {
      process: child,
      cwd: resolvedCwd,
      command: launch.command,
      args: launch.args,
      managed: true,
      mode,
      modelToken: randomUUID(),
      modelSelection,
      provider,
      conversationId: providerConversationId,
      runId,
      owner: sender,
      monitor
    });

    child.onData((data) => {
      sendToWebContents(sender, 'terminal:output', { sessionId: key, data });
    });

    child.onExit(({ exitCode, signal }) => {
      if (terminalSessions.get(key)?.process !== child) return;
      monitor.dispose(exitCode, signal);
      terminalSessions.delete(key);
      runningAgentPowerKeys.delete(key);
      syncSleepBlocker();
      sendToWebContents(sender, 'terminal:exit', { sessionId: key, code: exitCode, signal });
    });

    return { sessionId: key, cwd: resolvedCwd, command: launch.command, args: launch.args, managed: true, provider, conversationId: providerConversationId, activity: monitor.activity.snapshot(), presentationNotice };
  } finally { pendingManagedLaunches.delete(key); }
});
// Capture the owning session before opening the picker; never insert into a replacement.
ipcMain.handle('references:pick-and-insert', async (event, agentId) => {
  const key = terminalKey(event.sender.id, agentId);
  const session = terminalSessions.get(key);
  if (!session?.managed || session.owner !== event.sender || session.runId) {
    throw new Error('Open a manual Claude or Codex session first.');
  }
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: 'Add a file or folder reference',
    buttonLabel: 'Add path',
    properties: ['openFile', 'openDirectory']
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  const path = result.filePaths[0];
  if (/[\x00-\x1f\x7f-\x9f]/.test(path)) throw new Error('This path contains unsupported control characters.');
  const entry = await stat(path);
  if (!entry.isFile() && !entry.isDirectory()) throw new Error('Choose a file or folder.');
  if (terminalSessions.get(key) !== session || !session.managed || session.runId) {
    throw new Error('The agent session changed. Choose the path again.');
  }
  const text = ' ' + JSON.stringify(path) + ' ';
  session.process.write('\x1b[200~' + text + '\x1b[201~');
  return { text };
});

// Staged references belong to one renderer and workspace; arbitrary text never reaches a shell.
const stagedImages = new Map();
function imageStore(sender) {
  if (!stagedImages.has(sender.id)) {
    stagedImages.set(sender.id, new Map());
    sender.once('destroyed', () => stagedImages.delete(sender.id));
  }
  return stagedImages.get(sender.id);
}
ipcMain.handle('images:pick', async event => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: 'Attach images', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
  });
  if (result.canceled) return [];
  if (result.filePaths.length > MAX_IMAGES) throw new Error('Choose up to 10 images at a time.');
  return result.filePaths.map(path => ({ path, name: basename(path) }));
});
ipcMain.handle('images:read-webp', async (_event, path) => {
  if (typeof path !== 'string' || extname(path).toLowerCase() !== '.webp') throw new Error('Choose a WebP image.');
  return imageBytes({ path });
});
ipcMain.handle('images:stage', async (event, { agentId, agentPath, source, images } = {}) => {
  const root = assertAgentPathMatches(agentId, agentPath);
  if (source === 'clipboard') {
    const image = clipboard.readImage();
    if (image.isEmpty()) throw new Error('No image on the clipboard. Copy an image or screenshot first.');
    images = [{ bytes: image.toPNG(), name: 'Screenshot.png' }];
  }
  if (!Array.isArray(images) || !images.length || images.length > MAX_IMAGES) throw new Error('Choose up to 10 images at a time.');
  const result = { images: [], errors: [] };
  const store = imageStore(event.sender);
  for (const source of images) {
    try {
      if ([...store.values()].filter(image => image.agentId === agentId).length >= MAX_IMAGES) throw new Error('Remove an image first. You can queue up to 10 images per workspace.');
      const image = await stageImage(root, source, nativeImage);
      store.set(image.id, { ...image, agentId });
      result.images.push(image);
    } catch (error) { result.errors.push(error.message); }
  }
  return result;
});
ipcMain.handle('images:insert', async (event, { agentId, ids } = {}) => {
  const session = terminalSessions.get(terminalKey(event.sender.id, agentId));
  if (!session?.managed || session.owner !== event.sender || session.runId) throw new Error('Open a manual Claude or Codex session first.');
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_IMAGES) throw new Error('Choose 1–10 images.');
  const store = imageStore(event.sender);
  const images = ids.map(id => store.get(id));
  if (images.some(image => !image || image.agentId !== agentId)) throw new Error('These images belong to a different workspace.');
  for (const image of images) {
    if (!(await lstat(image.path)).isFile()) throw new Error('An image is no longer available. Attach it again.');
  }
  if (terminalSessions.get(terminalKey(event.sender.id, agentId)) !== session) throw new Error('The terminal changed. Try again.');
  const text = imagePrompt(session.provider, images.map(image => image.path));
  session.process.write('\x1b[200~' + text + '\x1b[201~');
  for (const id of ids) store.delete(id);
  return { inserted: images.length, text };
});
ipcMain.handle('images:release', (event, ids) => {
  if (Array.isArray(ids)) for (const id of ids) imageStore(event.sender).delete(id);
});

ipcMain.on('terminal:input', (_event, { sessionId, input }) => {
  const session = terminalSessions.get(sessionId);
  if (!session || session.owner !== _event.sender || typeof input !== 'string') return;
  session.inputRevision = (session.inputRevision || 0) + 1;
  if (['\x03', '\x1b', '\x1b\x1b'].includes(input)) session.monitor?.activity.accept({ hook_event_name: 'InputInterrupt' });
  session.process.write(input);
});
ipcMain.on('terminal:resize', (_event, { sessionId, cols, rows }) => {
  const session = terminalSessions.get(sessionId);
  if (!session) return;
  session.process.resize(cols, rows);
});
ipcMain.handle('terminal:stop', async (_event, sessionId) => {
  stopTerminalSession(sessionId);
  return { stopped: true };
});

function createWindow() {
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    title: 'BotLogik',
    backgroundColor: '#19191a',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  const webContentsId = window.webContents.id;
  window.webContents.on('will-prevent-unload', () => appUpdates?.cancelInstall());
  window.webContents.on('destroyed', () => {
    stopWindowTerminalSessions(webContentsId);
  });
}

app.whenReady().then(async () => {
  openRouter = registerOpenRouter({
    ipcMain, BrowserWindow, safeStorage, shell, directory: CONFIG_DIR,
    onTrace: (context, event) => toolTraces.event(context, event),
    getAgents: () => scanAgents(),
    getIgnoredNames: async () => (await readConfig()).globalIgnoredNames,
    canStart: async (agentId, root) => {
      if (appUpdates?.installing) throw new Error('BotLogik is restarting to update.');
      if ([...terminalSessions].some(([key, session]) => key.endsWith(`:${agentId}`) || session.cwd === root)
          || [...pendingManagedLaunches].some(key => key.endsWith(`:${agentId}`))
          || isAgentRunning(agentId)) throw new Error('Stop the terminal or scheduled session before using OpenRouter.');
    },
    onActivity: (root, busy) => {
      const key = `openrouter:${root}`;
      if (busy) runningAgentPowerKeys.add(key); else runningAgentPowerKeys.delete(key);
      syncSleepBlocker();
    }
  });
  const updateItem = new MenuItem({ label: 'Check for Updates…', click: () => appUpdates.check() });
  const menu = Menu.getApplicationMenu() || Menu.buildFromTemplate([
    { role: 'appMenu' }, { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }
  ]);
  menu.items[0].submenu.insert(1, updateItem);
  Menu.setApplicationMenu(menu);
  const packageMetadata = JSON.parse(await readFile(join(app.getAppPath(), 'package.json'), 'utf8'));
  appUpdates = createAppUpdates({
    enabled: packageMetadata.botlogikOfficialUpdates === true,
    app, updater: autoUpdater, dialog,
    hasActiveSessions: () => openRouter?.busy || terminalSessions.size > 0 || pendingManagedLaunches.size > 0 || runningAgentPowerKeys.size > 0,
    onState: ({ busy, downloaded, installing }) => {
      updateItem.label = busy ? 'Checking / Downloading Update…' : downloaded ? 'Restart to Update…' : 'Check for Updates…';
      updateItem.enabled = !busy && !installing;
    }
  });
  await settleStaleScheduledRunsOnStartup();
  startCronScheduler();
  createWindow();
  if (app.isPackaged) setTimeout(() => appUpdates.check({ silent: true }), 30_000).unref();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopAgentWatch();
  for (const key of terminalSessions.keys()) stopTerminalSession(key);
  runningAgentPowerKeys.clear();
  syncSleepBlocker();
  if (process.platform !== 'darwin') app.quit();
});
