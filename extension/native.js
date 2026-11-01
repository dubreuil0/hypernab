(() => {
  const T = (key, vars) => globalThis.HypernabText?.t(key, vars) ?? key; // texts: public/strings.js, in the language of the app
  class NativeChannel {
    constructor(runtime, host = globalThis.HypernabNativeHost || 'com.hypernab.app') {
      this.runtime = runtime; this.pending = new Map(); this.closed = false;
      try { this.port = runtime.connectNative(host); }
      catch { throw new Error(T('x.native-messaging-is-not-available-run')); }
      this.port.onMessage.addListener(message => {
        if (message?.version !== 1 || typeof message.id !== 'string') return;
        const pending = this.pending.get(message.id); if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.ok === true) pending.resolve(message.data);
        else { const error = new Error(message.error?.message || T('x.the-native-command-failed')); error.code = message.error?.code || 'NATIVE_ERROR'; pending.reject(error); }
      });
      this.port.onDisconnect.addListener(() => {
        const detail = runtime.lastError?.message || this.port.error?.message || '';
        const error = new Error(/not found|No such native|not registered/i.test(detail) ? T('x.the-browser-connection-is-not-set') : /forbidden|permission|not allowed/i.test(detail) ? T('x.this-extension-id-is-not-allowed') : T('x.the-browser-connection-was-lost-an'));
        error.code = 'NATIVE_DISCONNECTED'; this.fail(error);
      });
    }
    fail(error) {
      this.closed = true;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear();
    }
    request(command) {
      if (this.closed) return Promise.reject(Object.assign(new Error(T('x.the-browser-connection-is-being-set')), { code: 'NATIVE_DISCONNECTED' }));
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error(T('x.the-connection-timed-out-the-result')), { code: 'NATIVE_TIMEOUT' })); }, command.route === '/api/inspect' ? 75000 : 20000);
        this.pending.set(id, { resolve, reject, timer });
        try { this.port.postMessage({ ...command, version: 1, id }); }
        catch { clearTimeout(timer); this.pending.delete(id); reject(new Error(T('x.the-native-message-could-not-be'))); }
      });
    }
    close() { this.fail(new Error(T('x.the-native-connection-was-closed'))); this.port.disconnect(); }
  }
  globalThis.HypernabNativeChannel = NativeChannel;
})();
