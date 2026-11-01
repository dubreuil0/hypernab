import { T } from './t.js';
const PHASES = ["queued","held","resolving","probing","downloading","checking-resume","waiting-connection","pausing","paused","waiting-resume","merging","verifying","deep-verifying","processing","publishing","completed","failed","cancelled","interrupted"];
const phases = new Proxy({}, { get: (_, phase) => (PHASES.includes(phase) ? T(`app.phase.${phase}`) : undefined) }); // read when used, in the language of the moment
export function durationText(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return T('app.time.unknown');
  const value = Math.ceil(seconds);
  if (value < 60) return T('app.time.s', { s: value });
  if (value < 3600) return T('app.duration.ms', { m: Math.floor(value / 60), s: value % 60 });
  return T('app.time.hm', { h: Math.floor(value / 3600), m: Math.floor(value % 3600 / 60) });
}
export function progressView(job, fmt) {
  const p = job.progress || { phase: job.status, received: job.received, total: job.total, speed: 0, etaSeconds: null };
  let stage = phases[p.phase] || phases[job.status] || job.status;
  if (p.phase === 'checking-resume' && job.transfer?.resumeTotal) stage += ` (${job.transfer.resumeChecked || 0}/${job.transfer.resumeTotal})`;
  const size = `${fmt(p.received)} / ${p.total > 0 ? (p.sizeKind === 'approx' ? T('app.sizeApprox', { size: fmt(p.total) }) : fmt(p.total)) : T('app.size.unknown')}`;
  const transferring = job.status === 'running' && p.phase === 'downloading';
  const speed = transferring ? T('app.speedPer', { size: fmt(p.speed) }) : null;
  const remaining = transferring ? p.etaSeconds !== null && Number.isFinite(p.etaSeconds) ? T('app.eta.about', { time: durationText(p.etaSeconds) })
    : p.etaReason === 'estimate-exceeded' ? T('app.eta.exceeded')
    : p.etaReason === 'unknown-size' ? T('app.eta.unknownSize')
    : p.etaReason === 'processing' ? T('app.eta.processing')
    : p.etaReason === 'stalled' ? T('app.eta.stalled') : T('app.eta.calculating2') : null;
  return { stage, size, speed, remaining, percent: p.percent ?? null };
}
