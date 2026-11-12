import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChatModel, validateChatModel, chatModelArgs, chatSwitchCommand, assertChatSwitchSession } from '../src/main/chat-models.js';
const catalog = { claude: [{ id: 'opus', efforts: ['low','high'] }], codex: [{ id: 'gpt-test', efforts: ['medium','high'] }] };
test('manual defaults leave provider model and effort alone', () => {
  assert.deepEqual(normalizeChatModel(), {model:'', reasoningEffort:'default'});
  assert.deepEqual(chatModelArgs('claude', {}), []);
  assert.deepEqual(chatModelArgs('codex', {model:'gpt-test'}), ['--model','gpt-test']);
});
test('launch preferences use session flags with no configuration writes', () => {
  assert.deepEqual(chatModelArgs('claude', {model:'opus',reasoningEffort:'high'}), ['--model','opus','--effort','high']);
  assert.deepEqual(chatModelArgs('codex', {model:'gpt-test',reasoningEffort:'medium'}), ['--model','gpt-test','-c','model_reasoning_effort="medium"']);
});
test('catalog validation rejects removed models and unsupported effort', () => {
  assert.throws(() => validateChatModel('claude',{model:'removed'},catalog), /unavailable/);
  assert.throws(() => validateChatModel('claude',{model:'opus',reasoningEffort:'medium'},catalog), /does not support/);
  assert.equal(validateChatModel('claude',{model:'opus',reasoningEffort:'high'},catalog).model, 'opus');
  for (const model of ['opus\n/clear','--help','opus high','x;exit']) assert.throws(() => normalizeChatModel({model}));
  assert.throws(() => normalizeChatModel({reasoningEffort:'high'}));
});
test('Claude switches only open pickers; Codex commands contain no submit', () => {
  assert.equal(chatSwitchCommand('claude',{model:'opus',reasoningEffort:'high'}), '/model');
  assert.equal(chatSwitchCommand('claude',{},'effort'), '/effort');
  assert.equal(chatSwitchCommand('codex',{model:'gpt-test',reasoningEffort:'high'}), '/model gpt-test --reasoning=high');
  assert.equal(chatSwitchCommand('codex',{}), '/model');
});
test('switch guard rejects stale, scheduled, foreign, busy and unconfirmed sessions', () => {
  const sender = {}; const session = {managed:true,owner:sender,provider:'codex',modelToken:'one',mode:'default',monitor:{activity:{snapshot:()=>({state:'ready'})}}};
  const request = {sender,provider:'codex',token:'one',emptyPrompt:true};
  assert.doesNotThrow(() => assertChatSwitchSession(session,request));
  for (const change of [{token:'old'},{sender:{}},{emptyPrompt:false},{provider:'claude'}]) assert.throws(() => assertChatSwitchSession(session,{...request,...change}));
  for (const change of [{runId:'run'},{mode:'prompt'},{managed:false}]) assert.throws(() => assertChatSwitchSession({...session,...change},request));
  for (const state of ['working','needs-approval','needs-input']) assert.throws(() => assertChatSwitchSession({...session,monitor:{activity:{snapshot:()=>({state})}}},request));
});
