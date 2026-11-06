export const canPause = job => ['running', 'queued'].includes(job.status);
// A download added for later (held) is a download that has not been started: it is resumed like a paused one.
export const canResume = job => ['paused', 'interrupted', 'held'].includes(job.status) && !job.resumeRequested;
export const canCancel = job => ['running', 'queued', 'held', 'paused', 'interrupted', 'failed'].includes(job.status);
export const visibleJobs = (jobs, filter) => jobs.filter(job => filter === 'all' ||
  (filter === 'running' ? ['running', 'queued', 'held', 'paused'].includes(job.status) :
    filter === 'failed' ? ['failed', 'interrupted', 'cancelled'].includes(job.status) : job.status === filter));

// Only visible slots trade places: filtering must not reshuffle hidden rows.
export function moveVisible(jobs, filter, from, target, before = true) {
  const visible = visibleJobs(jobs, filter), ordered = visible.map(job => job.id);
  if (from === target || !ordered.includes(from) || !ordered.includes(target)) return jobs.map(job => job.id);
  ordered.splice(ordered.indexOf(from), 1);
  ordered.splice(ordered.indexOf(target) + (before ? 0 : 1), 0, from);
  const shown = new Set(ordered); let index = 0;
  return jobs.map(job => shown.has(job.id) ? ordered[index++] : job.id);
}

export function selectionState(jobs, visible, selected) {
  const chosen = jobs.filter(job => selected.has(job.id));
  const visibleSelected = visible.filter(job => selected.has(job.id)).length;
  return {
    count: chosen.length, hidden: chosen.length - visibleSelected,
    all: visible.length > 0 && visibleSelected === visible.length,
    mixed: visibleSelected > 0 && visibleSelected < visible.length,
    pause: chosen.filter(canPause).length, resume: chosen.filter(canResume).length,
    cancel: chosen.filter(canCancel).length, clear: chosen.filter(job => job.canClear).length
  };
}

