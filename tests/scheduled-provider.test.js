import { assertClaudeModelSupported } from '../src/main/claude-models.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../src/main/main.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function normalizeScheduleExecution('), source.indexOf('function normalizeCronSchedule(')) + source.slice(source.indexOf('function managedAgentCommand('), source.indexOf('function augmentedEnv(')), context);
test('legacy schedules default to Claude, model IDs are validated', () => {
  assert.equal(context.normalizeScheduleExecution({}).provider, 'claude');
  assert.equal(context.normalizeScheduleExecution({}).model, '');
  assert.throws(() => context.normalizeScheduleExecution({provider:'other'}));
  assert.throws(() => context.normalizeScheduleExecution({model:'--bad'}));
});
test('scheduled commands use selected models and bypass permissions for both providers', () => {
  const prompt = 'Task with "quotes" and $(literal)';
  const codex = context.managedAgentCommand('codex', 'prompt', prompt, 'custom-model');
  assert.equal(codex.command, 'codex');
  assert.deepEqual(Array.from(codex.args), ['exec','--dangerously-bypass-approvals-and-sandbox','--skip-git-repo-check','--model','custom-model','-c','model_reasoning_effort="medium"','--',prompt]);
  const claude = context.managedAgentCommand('claude', 'prompt', prompt, 'opus');
  assert.deepEqual(Array.from(claude.args), ['--dangerously-skip-permissions','--model','opus','--effort','medium','-p',prompt]);
  assert.ok(!context.managedAgentCommand('codex','prompt','Task').args.includes('--model'));
  assert.throws(() => context.managedAgentCommand('codex','prompt',' '));
});
test('schedule normalization preserves provider and model while migrating legacy schedules', () => {
  const state = vm.createContext({resolve: value => value, CRON_DAY_INDEXES:[0,1,2,3,4,5,6]});
  vm.runInContext(source.slice(source.indexOf('function isValidCronTime('), source.indexOf('function normalizeScheduledRun(')), state);
  const schedule = {agentId:'a',agentPath:'/workspace',type:'interval',intervalMinutes:30,startMessage:'Task',provider:'codex',model:'test-model'};
  const saved = state.normalizeCronSchedule(schedule);
  assert.equal(saved.provider,'codex');
  assert.equal(saved.model,'test-model');
  const legacy = state.normalizeCronSchedule({...schedule,provider:undefined,model:undefined});
  assert.equal(legacy.provider,'claude');
  assert.equal(legacy.model,'');
  assert.equal(legacy.reasoningEffort,'medium');
});

test('effort is provider-specific and safely forwarded as CLI arguments', () => {
  assert.equal(context.normalizeScheduleExecution({}).reasoningEffort, 'medium');
  assert.throws(() => context.normalizeScheduleExecution({provider:'claude', reasoningEffort:'ultra'}));
  assert.throws(() => context.normalizeScheduleExecution({provider:'codex', reasoningEffort:'high"; bad'}));
  const codex = context.managedAgentCommand('codex', 'prompt', 'Task', 'gpt-test', 'xhigh');
  assert.deepEqual(Array.from(codex.args), ['exec','--dangerously-bypass-approvals-and-sandbox','--skip-git-repo-check','--model','gpt-test','-c','model_reasoning_effort="xhigh"','--','Task']);
  const claude = context.managedAgentCommand('claude', 'prompt', 'Task', 'claude-opus-5-5', 'max');
  assert.deepEqual(Array.from(claude.args), ['--dangerously-skip-permissions','--model','claude-opus-5-5','--effort','max','-p','Task']);
  assert.ok(context.managedAgentCommand('codex','prompt','Task').args.includes('model_reasoning_effort="medium"'));
  assert.ok(context.managedAgentCommand('claude','prompt','Task').args.includes('medium'));
  assert.equal(context.normalizeScheduleExecution({reasoningEffort:''}).reasoningEffort,'medium');
  assert.ok(!context.managedAgentCommand('claude','prompt','Task','older-model','default').args.includes('--effort'));
});

test('saved schedules and historical runs retain their own effort settings', () => {
  const state = vm.createContext({resolve: value => value, CRON_DAY_INDEXES:[0,1,2,3,4,5,6], SCHEDULED_RUN_STATUSES:new Set(['running']), validConversationId: () => false});
  vm.runInContext(source.slice(source.indexOf('function isValidCronTime('), source.indexOf('function capScheduledRuns(')), state);
  const saved = state.normalizeCronSchedule({agentId:'a',agentPath:'/workspace',type:'interval',intervalMinutes:30,startMessage:'Task',provider:'codex',model:'test-model',reasoningEffort:'high'});
  assert.equal(saved.reasoningEffort,'high');
  const run = state.normalizeScheduledRun({...saved,id:'run',startedAt:new Date().toISOString()});
  saved.reasoningEffort='low';
  assert.equal(run.reasoningEffort,'high');
  assert.equal(state.normalizeScheduledRun({...run,reasoningEffort:undefined}).reasoningEffort,'');
});

test('schedule save validates catalog objects and preserves unavailable saved models', async () => {
  let save;
  let stored = [];
  const state = vm.createContext({
    assertClaudeModelSupported,
    ipcMain: {handle: (_name, handler) => {save=handler;}},
    readConfig: async () => ({cronSchedules:stored}),
    writeConfig: async config => {stored=config.cronSchedules;},
    normalizeCronSchedule: value => context.normalizeScheduleExecution(value),
    normalizeCronSchedules: value => value,
    scheduleModelOptions: async () => ({codex:[{id:'test-model',efforts:['low','high']}],claude:[]})
  });
  vm.runInContext(source.slice(source.indexOf("ipcMain.handle('cron:save'"), source.indexOf("ipcMain.handle('cron:delete'")),state);
  await save(null,{provider:'codex',model:'test-model',reasoningEffort:'high'});
  assert.equal(stored[0].reasoningEffort,'high');
  await assert.rejects(save(null,{provider:'codex',model:'test-model',reasoningEffort:'xhigh'}), /supported reasoning/);
  await assert.rejects(save(null,{provider:'codex',model:'unknown'}), /Choose a model/);
  stored=[{provider:'codex',model:'retired',reasoningEffort:'high'}];
  await save(null,{provider:'codex',model:'retired',reasoningEffort:'high'});
  assert.equal(stored[0].model,'retired');
  stored=[{provider:'claude',model:'retired',reasoningEffort:'high'}];
  await assert.rejects(save(null,{provider:'claude',model:'retired',reasoningEffort:'high'}), /verify supported Claude/);
  assert.equal(stored[0].model,'retired');
});

test('scheduled launch rechecks Claude support before constructing a command', async () => {
  let launch;
  const pending = new Set();
  const state = vm.createContext({
    ipcMain:{handle:(_name,handler)=>{launch=handler;}}, appUpdates:null, openRouter:null,
    assertAgentPathMatches:()=>'/workspace', realpath:async value=>value, existsSync:()=>true,
    terminalKey:()=> 'key', pendingManagedLaunches:pending,
    readConfig:async()=>({scheduledRuns:[{id:'run',agentId:'agent',provider:'claude',model:'retired',reasoningEffort:'medium'}]}),
    scheduleModelOptions:async()=>({claude:[{id:'sonnet',efforts:['medium']}]}),
    assertClaudeModelSupported,
    managedAgentCommand:()=>{throw new Error('Must not construct a command');}
  });
  vm.runInContext(source.slice(source.indexOf("ipcMain.handle('terminal:start-managed'"),source.indexOf('// Capture the owning session')),state);
  await assert.rejects(launch({sender:{id:1}},{agentId:'agent',cwd:'/workspace',provider:'claude',mode:'prompt',runId:'run',prompt:'Task'}), /no longer listed/);
  assert.equal(pending.size,0);
});
