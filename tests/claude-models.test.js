import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { discoverClaudeModels, normalizeClaudeModels, assertClaudeModelSupported } from '../src/main/claude-models.js';

const nextModel = { value:'sonnet', resolvedModel:'claude-sonnet-5-6', displayName:'Sonnet 5.6', supportedEffortLevels:['low','medium','high'] };
test('new locally advertised versions appear as rolling aliases and pinned choices', () => {
  const models = normalizeClaudeModels([nextModel, {value:'old-model',displayName:'Older model'}]);
  assert.equal(models[0].label,'Sonnet 5.6 · latest alias');
  assert.equal(models[1].id,'claude-sonnet-5-6');
  assert.deepEqual(models[1].efforts,['low','medium','high']);
  assert.deepEqual(models[2].efforts,[]);
  assert.throws(() => normalizeClaudeModels([]));
});

function fakeProcess(onInput) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => {child.killed=true;};
  child.stdin.on('data', data => onInput(JSON.parse(data.toString()),child));
  return child;
}
test('discovery reads only initialization metadata and handles split responses', async () => {
  let process;
  const result = await discoverClaudeModels({cwd:'/workspace',spawnProcess:(command,args,options) => {
    assert.equal(command,'claude'); assert.equal(options.cwd,'/workspace');
    assert.ok(args.includes('--no-session-persistence'));
    process=fakeProcess((request,child)=>{
      assert.equal(request.type,'control_request'); assert.equal(request.request.subtype,'initialize');
      const response=JSON.stringify({type:'control_response',response:{request_id:request.request_id,subtype:'success',response:{models:[nextModel],claude_code_version:'test'}}})+'\n';
      child.stdout.write('unrelated output\n');
      child.stdout.write(response.slice(0,80));child.stdout.write(response.slice(80));
    });return process;
  }});
  assert.equal(result.version,'test');assert.equal(result.models[1].id,'claude-sonnet-5-6');assert.equal(process.killed,true);
});
test('timeouts and malformed catalogs fail without leaving a child running', async () => {
  const child=fakeProcess(()=>{});
  await assert.rejects(discoverClaudeModels({timeoutMs:10,spawnProcess:()=>child}),/timed out/);
  assert.equal(child.killed,true);
  await assert.rejects(discoverClaudeModels({spawnProcess:()=>fakeProcess((request,p)=>p.stdout.write(JSON.stringify({type:'control_response',response:{request_id:request.request_id,subtype:'success',response:{models:[]}}})+'\n'))}),/no usable models/);
});


test('Claude validation rejects retired pins and unverified discovery, including default', () => {
  const claude = normalizeClaudeModels([nextModel]);
  assert.doesNotThrow(() => assertClaudeModelSupported({model:'sonnet',reasoningEffort:'medium'}, {claude}));
  assert.doesNotThrow(() => assertClaudeModelSupported({model:'claude-sonnet-5-6'}, {claude}));
  assert.throws(() => assertClaudeModelSupported({model:'claude-sonnet-5-5'}, {claude}), /no longer listed/);
  assert.throws(() => assertClaudeModelSupported({model:'sonnet'}, {claude,claudeError:'offline'}), /verify supported/);
  assert.throws(() => assertClaudeModelSupported({}, {claude:[]}), /verify supported/);
});
