import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { applyClaudeFocus } from '../src/main/claude-presentation.js';
import { toolWorkingLabel, toolResultState, toolGroupSummary } from '../src/renderer/tool-presentation.js';

test('tool clutter defaults off and survives restart and unrelated config writes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'botlogik-clutter-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const source = await readFile(new URL('../src/main/main.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('async function readConfig()'), source.indexOf('async function getScanRoots'))
    + source.slice(source.indexOf('function normalizeChatContrast('), source.indexOf('async function saveLaunchOnStartup'));
  const fresh = () => {
    const context = vm.createContext({readFile,writeFile,mkdir,resolve,CONFIG_DIR:directory,CONFIG_PATH:join(directory,'config.json'),DEFAULT_GLOBAL_IGNORED_NAMES:[],normalizeGlobalIgnoredNames:v=>v||[],hasOnlyLegacyDefaultIgnoredNames:()=>false});
    vm.runInContext(code, context); return context;
  };
  assert.equal((await fresh().readConfig()).reduceToolClutter,false);
  await fresh().saveReduceToolClutter(true);
  await fresh().saveChatContrast('midnight');
  assert.equal((await fresh().readConfig()).reduceToolClutter,true);
  await assert.rejects(fresh().saveReduceToolClutter('false'), /Invalid/);
  await fresh().saveReduceToolClutter(false);
  assert.equal((await fresh().readConfig()).reduceToolClutter,false);
});
test('Focus settings preserve hook configuration and only affect the child environment', () => {
  const hooks = { PreToolUse: [{ hooks: [] }] };
  const args = ['--resume','synthetic','--settings',JSON.stringify({hooks})];
  const env = {PATH:'/usr/bin',CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN:'1'};
  assert.equal(applyClaudeFocus({provider:'claude',mode:'resume',version:'2.1.311 (Claude Code)',args,env}), '');
  assert.deepEqual(JSON.parse(args[3]),{hooks,tui:'fullscreen',viewMode:'focus'});
  assert.equal(env.PATH,'/usr/bin');
  assert.equal(env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN,'0');
});
test('compact tool presentation distinguishes working, failures, denials, and incomplete results', () => {
  assert.equal(toolWorkingLabel('run_command'),'Running commands…');
  assert.equal(toolWorkingLabel('read_file'),'Reading files…');
  assert.equal(toolWorkingLabel(null),'Working…');
  assert.equal(toolResultState('{"exitCode":1}'),'failed');
  assert.equal(toolResultState('{"exitCode":null,"timedOut":true}'),'failed');
  assert.equal(toolResultState('{"denied":true}'),'denied');
  assert.equal(toolResultState('Run interrupted'),'unknown');
  const messages = [{role:'assistant',tool_calls:[{id:'a',function:{name:'run_command'}}]}];
  assert.equal(toolGroupSummary(messages,0,true,'run_command'),'Running commands…');
  assert.match(toolGroupSummary(messages,0,false,null),/unavailable/);
  messages.push({role:'tool',tool_call_id:'a',content:'{"exitCode":0}'});
  assert.equal(toolGroupSummary(messages,0,false,null),'Completed · 1 tool call');
});
