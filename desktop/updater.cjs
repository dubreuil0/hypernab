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
  async check(manual = false) {
    if (this.state === 'checking' || this.state === 'downloading') {
      if (manual) await this.dialog.showMessageBox({ type: 'info', message: t('desk.update.busy') });
      return this.state;
    }
    if (this.state === 'ready') { this.pending = true; return this.state; }
    this.state = 'checking'; this.manual = manual;
    try {
      const result = await this.autoUpdater.checkForUpdates();
      const next = result?.updateInfo?.version;
      if (!next || !this.newer(next)) {
        this.state = 'idle';
        if (manual) await this.dialog.showMessageBox({ type: 'info', message: t('desk.update.current'), detail: t('desk.update.installed', { version: this.version }) });
        return this.state;
      }
      this.state = 'available';
      const answer = await this.dialog.showMessageBox({ type: 'question', buttons: [t('app.download'), t('desk.update.later')], defaultId: 0, cancelId: 1,
        message: t('desk.update.available', { version: next }), detail: t('desk.update.availableDetail') });
      if (answer.response !== 0) { this.state = 'idle'; return this.state; }
      this.state = 'downloading';
      await this.autoUpdater.downloadUpdate();
      this.state = 'ready'; this.pending = true; this.asked = false;
    } catch (error) {
      this.state = 'idle'; this.log(error);
      if (manual) await this.dialog.showMessageBox({ type: 'warning', message: t('desk.update.checkFailed'), detail: t('desk.update.checkFailedDetail') });
    }
    return this.state;
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
module.exports = { Updater, busy };
