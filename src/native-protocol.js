import { m } from './messages.js';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const MAX_NATIVE_INPUT = 32768;
export const MAX_NATIVE_OUTPUT = 900000;
export function nativeFrame(value, max = MAX_NATIVE_OUTPUT) {
  const data = Buffer.from(JSON.stringify(value), 'utf8');
  if (data.length > max) throw new Error(m('e.the-native-message-size-limit-was'));
  const header = Buffer.alloc(4); header.writeUInt32LE(data.length);
  return Buffer.concat([header, data]);
}
export class NativeDecoder {
  constructor(onMessage, max = MAX_NATIVE_INPUT) { this.buffer = Buffer.alloc(0); this.onMessage = onMessage; this.max = max; }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE();
      if (!length || length > this.max) throw new Error(m('e.invalid-native-message-length'));
      if (this.buffer.length < 4 + length) break;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(this.buffer.subarray(4, 4 + length));
      const value = JSON.parse(text);
      this.buffer = this.buffer.subarray(4 + length);
      this.onMessage(value);
    }
    if (this.buffer.length > this.max + 4) throw new Error(m('e.the-native-input-limit-was-exceeded'));
  }
  end() { if (this.buffer.length) throw new Error('Eksik Native mesaj.'); }
}
export function validateNativeRequest(message) {
  if (!message || message.version !== 1 || typeof message.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(message.id)) throw new Error(m('e.invalid-native-command-id-version'));
  if (['launch', 'show'].includes(message.action)) {
    if (Object.keys(message).some(key => !['id', 'version', 'action'].includes(key))) throw new Error(m('e.the-open-app-command-takes-no'));
    return { action: message.action };
  }
  if (message.action !== 'request' || !['GET', 'POST'].includes(message.method) || typeof message.route !== 'string') throw new Error(m('e.invalid-native-command'));
  const get = /^\/api\/(?:status|prefs|jobs|submissions\/[a-f0-9-]{36})$/i;
  const post = /^\/api\/(?:inspect|sniff|subtitles|duplicates|jobs|files\/take|hls\/active-audio|jobs\/[a-f0-9-]{36}\/(?:pause|resume|cancel)|submissions\/[a-f0-9-]{36}\/abandon|app\/shutdown)$/i;
  if (!(message.method === 'GET' ? get : post).test(message.route)) throw new Error(m('e.this-native-command-is-not-allowed'));
  if (message.method === 'GET' && message.body !== undefined) throw new Error(m('e.a-get-command-takes-no-body'));
  if (message.method === 'POST' && (!message.body || typeof message.body !== 'object' || Array.isArray(message.body))) throw new Error(m('e.the-command-body-must-be-an'));
  if (['/api/jobs', '/api/files/take'].includes(message.route) && message.method === 'POST' && !/^[a-f0-9-]{36}$/i.test(message.body.submissionId || '')) throw new Error(m('e.a-permanent-submission-id-is-required'));
  return { action: 'request', route: message.route, method: message.method, body: message.body };
}
export function validateNativeCaller(config, args) {
  const chromium = /^chrome-extension:\/\/([a-p]{32})\/?$/.exec(args[0] || '');
  if (chromium) {
    return config.chromiumIds?.includes(chromium[1]) === true;
  }
  // Firefox supplies manifest path and signed/temporary Gecko add-on id, not moz-extension UUID.
  return args.length >= 2 && config.firefoxIds?.includes(args[1]) === true && typeof args[0] === 'string' && path.isAbsolute(args[0]) &&
    typeof config.firefoxManifest === 'string' && path.resolve(args[0]).toLowerCase() === path.resolve(config.firefoxManifest).toLowerCase();
}
export const nativeRequestHash = message => createHash('sha256').update(JSON.stringify(message)).digest('hex');
