// Update flow: nothing is downloaded or installed without the user's click, and never while a transfer is running.
// The package comes from the project's GitHub release; electron-updater checks its SHA-512 against latest.yml.
const { t } = require('./texts.cjs');
const busy = jobs => jobs.some(job => job.settling || ['queued', 'running'].includes(job.status));

class Updater {
  constructor({ autoUpdater, dialog, version, onInstall, log = () => {} }) {
    Object.assign(this, { autoUpdater, dialog, version, onInstall, log });
    autoUpdater.autoDownload = false; autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false; autoUpdater.allowDowngrade = false;
    this.state = 'idle'; // idle | checking | available | downloading | ready
    this.pending = false; this.asked = false; this.manual = false;
  }
  // `inline` (the Settings row): no "up to date" / "check failed" / "busy" boxes; the outcome is returned for the window to show:
  // { state: 'current' | 'available' | 'ready' | 'busy' | 'failed', version, latest?, error? }. A newer version still asks before downloading.
  // Otherwise the new state of the updater is returned (the tray menu and the quiet start check ignore it).
  async check(manual = false, inline = false) {
    const out = (outcome, extra = {}) => (inline ? { state: outcome, version: this.version, ...extra } : this.state);
    if (this.state === 'checking' || this.state === 'downloading') {
      if (manual && !inline) await this.dialog.showMessageBox({ type: 'info', message: t('desk.update.busy') });
      return out('busy');
    }
    if (this.state === 'ready') { this.pending = true; return out('ready', { latest: this.latest }); }
    this.state = 'checking'; this.manual = manual;
    try {
      const result = await this.autoUpdater.checkForUpdates();
      const next = result?.updateInfo?.version;
      if (!next || !this.newer(next)) {
        this.state = 'idle';
        if (manual && !inline) await this.dialog.showMessageBox({ type: 'info', message: t('desk.update.current'), detail: t('desk.update.installed', { version: this.version }) });
        return out('current');
      }
      this.state = 'available'; this.latest = next;
      const answer = await this.dialog.showMessageBox({ type: 'question', buttons: [t('app.download'), t('desk.update.later')], defaultId: 0, cancelId: 1,
        message: t('desk.update.available', { version: next }), detail: t('desk.update.availableDetail') });
      if (answer.response !== 0) { this.state = 'idle'; return out('available', { latest: next }); }
      this.state = 'downloading';
      // The Settings row must not sit on "Checking…" while ~200 MB arrive: it gets "downloading" at once and the download goes on here;
      // when it is in, idle() offers the restart as usual. A failed download only returns the updater to idle (the next check retries).
      if (inline) {
        this.autoUpdater.downloadUpdate().then(() => { this.state = 'ready'; this.pending = true; this.asked = false; }, error => { this.state = 'idle'; this.log(error); });
        return out('downloading', { latest: next });
      }
      await this.autoUpdater.downloadUpdate();
      this.state = 'ready'; this.pending = true; this.asked = false;
      return out('ready', { latest: next });
    } catch (error) {
      this.state = 'idle'; this.log(error);
      if (manual && !inline) await this.dialog.showMessageBox({ type: 'warning', message: t('desk.update.checkFailed'), detail: t('desk.update.checkFailedDetail') });
      return out('failed', { error: 'check-failed' }); // never the raw error text (it can hold addresses)
    }
  }
  newer(next) {
    const parts = value => String(value).split('.').map(Number);
    const a = parts(next), b = parts(this.version);
    if (a.some(Number.isNaN) || b.some(Number.isNaN)) return false;
    for (let i = 0; i < Math.max(a.length, b.length); i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); }
    return false;
  }
  // Called with the jobs the app already polls; installation is offered only when nothing is transferring.
  async idle(jobs) {
    if (this.state !== 'ready' || !this.pending || this.asked || busy(jobs)) return false;
    this.asked = true;
    const answer = await this.dialog.showMessageBox({ type: 'question', buttons: [t('desk.update.restart'), t('desk.update.later')], defaultId: 0, cancelId: 1,
      message: t('desk.update.ready'), detail: t('desk.update.readyDetail') });
    if (answer.response !== 0) { this.pending = false; return false; }
    await this.onInstall(() => this.autoUpdater.quitAndInstall(true, true));
    return true;
  }
}
// The quiet check a minute after start runs unless the user turned it off in Settings (anything but an explicit false means on).
const checkAtStart = settings => settings?.checkUpdatesOnStart !== false;
module.exports = { Updater, busy, checkAtStart };
