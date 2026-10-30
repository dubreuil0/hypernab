import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, parseRemoteUrl, validToken, safeTitle } from '../src/security.js';

test('yerel ve özel ağ adreslerini reddeder', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.1.2', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.1.1.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1']) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});
test('protokol, kullanıcı bilgisi, port ve yerel adres denetimi', () => {
  for (const url of ['file:///C:/secret', 'ftp://example.com/a', 'https://user:pass@example.com', 'http://127.1/a', 'http://0x7f000001/a', 'http://[::1]/a', 'http://localhost/a', 'https://example.com:1234/a']) assert.throws(() => parseRemoteUrl(url), url);
  assert.equal(parseRemoteUrl('https://example.com/video.mp4#test').href, 'https://example.com/video.mp4');
});
test('token uzunluğu ve içeriği karşılaştırılır', () => {
  assert.equal(validToken('abc', 'abc'), true);
  assert.equal(validToken('ab', 'abc'), false);
  assert.equal(validToken('abd', 'abc'), false);
  assert.equal(validToken(undefined, 'abc'), false);
});
test('dosya adları yol karakterleri ve kontrol kodlarından arındırılır', () => {
  assert.equal(safeTitle('../bad:file.mp4'), '.._bad_file.mp4');
  assert.equal(safeTitle(''), 'video');
  assert.ok(safeTitle('a'.repeat(200)).length <= 100);
});
