import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';

const source = await readFile(new URL('../src/main/main.js', import.meta.url), 'utf8');
const configCode = source.slice(source.indexOf('async function readConfig()'), source.indexOf('async function getScanRoots'));
const contrastCode = source.slice(source.indexOf('function normalizeChatContrast('), source.indexOf('async function saveLaunchOnStartup'));

test('chat contrast survives a fresh settings context for every option and unrelated config writes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'botlogik-contrast-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const configPath = join(directory, 'config.json');
  const fresh = () => {
    const context = vm.createContext({readFile, writeFile, mkdir, resolve,
      CONFIG_DIR:directory, CONFIG_PATH:configPath,
      DEFAULT_GLOBAL_IGNORED_NAMES:[],
      normalizeGlobalIgnoredNames: value => value || [],
      hasOnlyLegacyDefaultIgnoredNames: () => false});
    vm.runInContext(configCode + contrastCode, context);
    return context;
  };
  await writeFile(configPath, JSON.stringify({favorites:['keep-me']}));
  for (const value of ['original','charcoal','midnight','slate','deep-teal']) {
    await fresh().saveChatContrast(value);
    const restarted = fresh();
    const config = await restarted.readConfig();
    assert.equal(config.chatContrast, value);
    assert.equal(config.favorites[0], 'keep-me');
    await restarted.writeConfig({...config, agentOrder:['one']});
    assert.equal((await fresh().readConfig()).chatContrast, value);
  }
  await assert.rejects(fresh().saveChatContrast('unknown'), /Invalid chat contrast/);
  assert.equal((await fresh().readConfig()).chatContrast, 'deep-teal');
});
