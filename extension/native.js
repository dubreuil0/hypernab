(() => {
  const T = (key, vars) => globalThis.HypernabText?.t(key, vars) ?? key; // texts: public/strings.js, in the language of the app
  // The connection keeps a small helper program running next to the browser (~50 MB). It is closed after a quiet minute with nothing
  // waiting, and every user of a channel opens a new one when it finds it closed, so it is there whenever something asks.
  const IDLE_MS = 60000;
  class NativeChannel {
    constructor(runtime, host = globalThis.HypernabNativeHost || 'com.hypernab.app') {
      this.runtime = runtime; this.pending = new Map(); this.closed = false; this.idleTimer = null;
      try { this.port = runtime.connectNative(host); }
      catch { throw new Error(T('x.native-messaging-is-not-available-run')); }
      this.port.onMessage.addListener(message => {
        if (message?.version !== 1 || typeof message.id !== 'string') return;
        const pending = this.pending.get(message.id); if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.ok === true) pending.resolve(message.data);
        else { const error = new Error(message.error?.message || T('x.the-native-command-failed')); error.code = message.error?.code || 'NATIVE_ERROR'; pending.reject(error); }
        this.idle();
      });
      this.port.onDisconnect.addListener(() => {
        const detail = runtime.lastError?.message || this.port.error?.message || '';
        const error = new Error(/not found|No such native|not registered/i.test(detail) ? T('x.the-browser-connection-is-not-set') : /forbidden|permission|not allowed/i.test(detail) ? T('x.this-extension-id-is-not-allowed') : T('x.the-browser-connection-was-lost-an'));
        error.code = 'NATIVE_DISCONNECTED'; this.fail(error);
      });
      this.idle();
    }
    // Starts the quiet-minute count when nothing is waiting; any request stops it.
    idle() {
      clearTimeout(this.idleTimer);
      if (this.closed || this.pending.size) return;
      this.idleTimer = setTimeout(() => { if (!this.closed && !this.pending.size) this.close(); }, globalThis.HypernabNativeIdleMs || IDLE_MS);
    }
    fail(error) {
      this.closed = true; clearTimeout(this.idleTimer);
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear();
    }
    request(command) {
      if (this.closed) return Promise.reject(Object.assign(new Error(T('x.the-browser-connection-is-being-set')), { code: 'NATIVE_DISCONNECTED' }));
      clearTimeout(this.idleTimer);
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error(T('x.the-connection-timed-out-the-result')), { code: 'NATIVE_TIMEOUT' })); this.idle(); }, command.route === '/api/inspect' ? 75000 : 20000);
        this.pending.set(id, { resolve, reject, timer });
        try { this.port.postMessage({ ...command, version: 1, id }); }
        catch { clearTimeout(timer); this.pending.delete(id); reject(new Error(T('x.the-native-message-could-not-be'))); this.idle(); }
      });
    }
    close() { this.fail(new Error(T('x.the-native-connection-was-closed'))); try { this.port.disconnect(); } catch { /* already gone */ } }
  }
  globalThis.HypernabNativeChannel = NativeChannel;
})();
