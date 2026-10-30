(() => {
  class NativeChannel {
    constructor(runtime, host = globalThis.HypernabNativeHost || 'com.hypernab.app') {
      this.runtime = runtime; this.pending = new Map(); this.closed = false;
      try { this.port = runtime.connectNative(host); }
      catch { throw new Error('Native Messaging kullanılamıyor. Hypernab Native kurulumunu çalıştır.'); }
      this.port.onMessage.addListener(message => {
        if (message?.version !== 1 || typeof message.id !== 'string') return;
        const pending = this.pending.get(message.id); if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.ok === true) pending.resolve(message.data);
        else { const error = new Error(message.error?.message || 'Native komutu başarısız.'); error.code = message.error?.code || 'NATIVE_ERROR'; pending.reject(error); }
      });
      this.port.onDisconnect.addListener(() => {
        const detail = runtime.lastError?.message || this.port.error?.message || '';
        const error = new Error(/not found|No such native|not registered/i.test(detail) ? 'Tarayıcı bağlantısı kurulu değil. Hypernab → Ayarlar → Tarayıcı bağlantısı bölümünden Kur / onar kullan.' : /forbidden|permission|not allowed/i.test(detail) ? 'Bu eklenti kimliğine izin verilmiyor. Doğru paketi yükle ve Hypernab tarayıcı bağlantısını onar.' : 'Tarayıcı bağlantısı kesildi. Otomatik yeniden bağlantı deneniyor.');
        error.code = 'NATIVE_DISCONNECTED'; this.fail(error);
      });
    }
    fail(error) {
      this.closed = true;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear();
    }
    request(command) {
      if (this.closed) return Promise.reject(Object.assign(new Error('Tarayıcı bağlantısı yeniden kuruluyor.'), { code: 'NATIVE_DISCONNECTED' }));
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error('Bağlantı zaman aşımına uğradı. Gönderimin sonucu kontrol ediliyor.'), { code: 'NATIVE_TIMEOUT' })); }, command.route === '/api/inspect' ? 75000 : 20000);
        this.pending.set(id, { resolve, reject, timer });
        try { this.port.postMessage({ ...command, version: 1, id }); }
        catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('Native mesajı gönderilemedi; yeniden bağlan.')); }
      });
    }
    close() { this.fail(new Error('Native bağlantısı kapatıldı.')); this.port.disconnect(); }
  }
  globalThis.HypernabNativeChannel = NativeChannel;
})();
