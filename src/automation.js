import fs from 'node:fs';
import { spawn } from 'node:child_process';

export function powerAction(action) {
  if (process.platform !== 'win32') throw new Error('Bu işlem yalnızca Windows için kullanılabilir.');
  const command = action === 'shutdown' ? ['shutdown.exe', ['/s', '/t', '0']] : ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::Suspend, $false, $false)']];
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command[1], { windowsHide: true, stdio: 'ignore' });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error('Windows güç işlemini reddetti.')));
  });
}

export class Automation {
  constructor(queue, file, { now = Date.now, execute = powerAction } = {}) {
    this.queue = queue; this.file = file; this.now = now; this.execute = execute;
    this.schedule = null; this.power = null; this.error = null;
    try { const saved = JSON.parse(fs.readFileSync(file, 'utf8')); if (saved.schedule?.at > now() && queue.settings.queueNames.includes(saved.schedule.queue)) this.schedule = saved.schedule; } catch {}
    // Power actions are deliberately never restored after restart.
  }
  info() { return { schedule: this.schedule, power: this.power && { action: this.power.action, deadline: this.power.deadline }, error: this.error }; }
  configure(input) {
    let schedule = this.schedule, power = this.power;
    if ('schedule' in input) {
      schedule = input.schedule;
      if (schedule !== null && (!Number.isFinite(schedule?.at) || schedule.at <= this.now() || schedule.at > this.now() + 366 * 86400000 || !this.queue.settings.queueNames.includes(schedule.queue))) throw new Error('Gelecekteki bir tarih ve geçerli kuyruk seç.');
      if (schedule) schedule = { at: schedule.at, queue: schedule.queue };
    }
    if ('power' in input) {
      if (input.power !== null && !['shutdown', 'sleep'].includes(input.power)) throw new Error('Geçersiz bitiş işlemi.');
      const ids = this.queue.jobs.filter(job => ['running', 'queued', 'held'].includes(job.status)).map(job => job.id);
      if (input.power && !ids.length) throw new Error('Önce indirme ekle.');
      power = input.power ? { action: input.power, ids, deadline: null } : null;
    }
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ schedule })); fs.renameSync(this.file + '.tmp', this.file);
    this.schedule = schedule; this.power = power; this.error = null; return this.info();
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.schedule && this.schedule.at <= this.now()) {
        const name = this.schedule.queue;
        this.configure({ schedule: null }); // one-shot; consume before starting
        this.queue.startQueue(name);
      }
      if (this.power) {
        const watched = this.power.ids.map(id => this.queue.jobs.find(job => job.id === id));
        if (watched.some(job => !job || ['failed', 'cancelled', 'interrupted', 'paused'].includes(job.status))) { this.power = null; this.error = 'Bitiş işlemi iptal edildi: tamamlanmayan veya duraklatılan indirme var.'; return; }
        const ready = watched.every(job => job.status === 'completed') && !this.queue.active.size && !this.queue.jobs.some(job => ['running', 'queued', 'held', 'paused', 'interrupted'].includes(job.status));
        if (!ready) { this.power.deadline = null; return; }
        this.power.deadline ??= this.now() + 60000;
        if (this.now() >= this.power.deadline) { const action = this.power.action; this.power = null; await this.execute(action); }
      }
    } catch (error) { this.error = error.message; this.power = null; }
    finally { this.busy = false; }
  }
}
