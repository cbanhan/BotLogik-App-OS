import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
const button = () => ({disabled:false, classList:{toggle(){}}});
test('all scheduler mimic controls use their own agent and disable missing or busy schedules', () => {
  const hint = {};
  const context = vm.createContext({
    scheduleMimicButton:button(), cronMimicButton:button(), scheduledRunsMimicButton:button(),
    activeScheduleAgentId:'page', pendingCronAgentId:'modal',
    scheduledRunsModal:{dataset:{agentId:'history'}},
    cronSchedulesByAgent:new Map(['page','modal','history'].map(id=>[id,{}])),
    mimicPendingAgents:new Set(), runtimeStatusByAgent:new Map(),
    hasActiveScheduledRun:()=>false, document:{getElementById:()=>hint}
  });
  vm.runInContext(source.slice(source.indexOf('      function renderMimicButtons()'),source.indexOf('      function renderScheduleView(')),context);
  context.renderMimicButtons();
  for (const key of ['scheduleMimicButton','cronMimicButton','scheduledRunsMimicButton']) assert.equal(context[key].disabled,false);
  context.mimicPendingAgents.add('modal'); context.renderMimicButtons();
  assert.equal(context.cronMimicButton.disabled,true);
  assert.equal(context.scheduleMimicButton.disabled,false);
  context.cronSchedulesByAgent.delete('history'); context.runtimeStatusByAgent.set('page','running');
  context.renderMimicButtons();
  assert.equal(context.scheduledRunsMimicButton.disabled,true);
  assert.equal(context.scheduleMimicButton.disabled,true);
  context.mimicPendingAgents.clear(); context.renderMimicButtons();
  assert.equal(context.cronMimicButton.disabled,false);
  assert.match(hint.textContent,/saved schedule/);
  context.cronSchedulesByAgent.delete('modal'); context.renderMimicButtons();
  assert.match(hint.textContent,/Save the schedule first/);
});
