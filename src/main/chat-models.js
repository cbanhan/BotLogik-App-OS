// Manual chat preferences never inherit the scheduler's implicit Medium effort.
export function normalizeChatModel(value = {}) {
  const model = value.model ?? '';
  const reasoningEffort = value.reasoningEffort || 'default';
  if (typeof model !== 'string' || model.length > 160 || (model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model))) throw new Error('Invalid model.');
  if (!['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(reasoningEffort)) throw new Error('Invalid reasoning effort.');
  if (!model && reasoningEffort !== 'default') throw new Error('Choose a model before setting reasoning effort.');
  return { model, reasoningEffort };
}
export function validateChatModel(provider, value, catalog) {
  if (!['claude', 'codex'].includes(provider)) throw new Error('Choose Claude or Codex.');
  const selection = normalizeChatModel(value);
  if (!selection.model) return selection;
  const model = catalog[provider]?.find(item => item.id === selection.model);
  if (!model) throw new Error('This model is unavailable. Refresh the model list and choose another.');
  if (selection.reasoningEffort !== 'default' && !model.efforts?.includes(selection.reasoningEffort)) throw new Error('This model does not support that reasoning effort.');
  return selection;
}
export function chatModelArgs(provider, value) {
  const { model, reasoningEffort } = normalizeChatModel(value);
  return [...(model ? ['--model', model] : []), ...(reasoningEffort === 'default' ? [] : provider === 'claude'
    ? ['--effort', reasoningEffort] : ['-c', `model_reasoning_effort="${reasoningEffort}"`])];
}
export function chatSwitchCommand(provider, value, control = 'model') {
  if (provider === 'claude') {
    if (!['model', 'effort'].includes(control)) throw new Error('Invalid picker.');
    return `/${control}`;
  }
  if (provider !== 'codex') throw new Error('Unsupported provider.');
  const { model, reasoningEffort } = normalizeChatModel(value);
  return '/model' + (model ? ` ${model}` : '') + (reasoningEffort !== 'default' ? ` --reasoning=${reasoningEffort}` : '');
}
export function assertChatSwitchSession(session, { sender, token, provider, emptyPrompt }) {
  if (!session?.managed || session.owner !== sender || session.runId || session.mode === 'prompt' || session.modelToken !== token || session.provider !== provider) throw new Error('The chat changed. Reopen the model selector.');
  if (emptyPrompt !== true) throw new Error('Confirm the terminal is at an empty prompt.');
  if (['working', 'needs-approval', 'needs-input'].includes(session.monitor?.activity.snapshot().state)) throw new Error('Wait until the agent finishes and returns to its prompt.');
}
