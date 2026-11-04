const ACTIVITY_STYLES = {
  'session-open': { dot: 'bg-mute/60', badge: 'bg-white/[.06] text-mute', label: 'Session open', dotColor: 'bg-mute/60', cardAccent: 'border-l-2 border-white/[.05]' },
  working: { dot: 'bg-green pulse-dot', badge: 'bg-green/10 text-green badge-running', label: 'Working', dotColor: 'bg-green', cardAccent: 'border-l-2 border-green/50 bg-green/[.03]' },
  'needs-approval': { dot: 'bg-amber', badge: 'bg-amber/15 text-amber', label: 'Needs approval', dotColor: 'bg-amber', cardAccent: 'border-l-2 border-amber/60 bg-amber/[.05]' },
  'needs-input': { dot: 'bg-amber', badge: 'bg-amber/15 text-amber', label: 'Needs input', dotColor: 'bg-amber', cardAccent: 'border-l-2 border-amber/60 bg-amber/[.05]' },
  ready: { dot: 'bg-blue', badge: 'bg-blue/10 text-blue', label: 'Ready', dotColor: 'bg-blue', cardAccent: 'border-l-2 border-blue/30' },
  error: { dot: 'bg-rose', badge: 'bg-rose/10 text-rose', label: 'Error', dotColor: 'bg-rose', cardAccent: 'border-l-2 border-rose/50 bg-rose/[.03]' }
};

export function activityStatusInfo(processStatus, activity) {
  if (processStatus !== 'running' && !(processStatus === 'stopped' && activity?.state === 'error')) return null;
  const style = ACTIVITY_STYLES[activity?.state] || ACTIVITY_STYLES['session-open'];
  return { ...style, detail: activity?.detail || 'The agent process is open; detailed activity is unavailable.' };
}

export function isCurrentActivity(current, incoming) {
  return Boolean(current && incoming && current.generation === incoming.generation
    && current.sessionId === incoming.sessionId && current.agentId === incoming.agentId
    && Number.isInteger(incoming.sequence) && incoming.sequence > current.sequence);
}
