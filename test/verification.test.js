import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyCompletedFile, mediaExpectation, VerificationError } from '../src/verification.js';

function fixture(t, tools = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-verify-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'output.bin'); fs.writeFileSync(file, 'test-file-bytes');
  if (tools) { fs.writeFileSync(path.join(root, 'ffprobe.exe'), 'test-double'); fs.writeFileSync(path.join(root, 'ffmpeg.exe'), 'test-double'); }
  return { file, toolsDirectory: root, signal: new AbortController().signal };
}
test('normal dosyada boyut ve kullanıcı SHA-256 değeri kontrol edilir; medya beklenmez', async t => {
  const input = fixture(t), expectedSha256 = createHash('sha256').update('test-file-bytes').digest('hex');
  const result = await verifyCompletedFile({ ...input, expectedSize: 15, expectedSha256, probe: async () => { throw new Error('must not probe'); } });
  assert.equal(result.status, 'passed'); assert.equal(result.level, 'bytes'); assert.equal(result.sha256, expectedSha256);
});
test('boyut veya SHA-256 eşleşmezse doğrulama başarısızdır, dosya silinmez', async t => {
  const input = fixture(t);
  await assert.rejects(verifyCompletedFile({ ...input, expectedSize: 200 }), VerificationError);
  await assert.rejects(verifyCompletedFile({ ...input, expectedSha256: 'a'.repeat(64) }), VerificationError);
  assert.equal(fs.readFileSync(input.file, 'utf8'), 'test-file-bytes');
});
test('bilerek sessiz videoda zorunlu ses beklenmez', async t => {
  const input = fixture(t); const media = mediaExpectation({ vcodec: 'h264', acodec: 'none', height: 720, duration: 10 });
  const result = await verifyCompletedFile({ ...input, media, probe: async (_file, _tools, _duration, _signal, options) => { assert.equal(options.requireAudio, false); return { height: 720, audio: false }; } });
  assert.equal(result.status, 'passed'); assert.equal(result.media.audio, false);
});
test('seçilen çözünürlük ile çıktı uyuşmazlığı reddedilir', async t => {
  const input = fixture(t);
  await assert.rejects(verifyCompletedFile({ ...input, media: { expectedHeight: 1080 }, probe: async () => ({ height: 360 }) }), /çözünürlü/);
});
test('derin tarama ancak temel medya doğrulamasından sonra çalışır', async t => {
  const input = fixture(t); const order = [];
  const result = await verifyCompletedFile({ ...input, media: { requireVideo: true }, deep: true,
    probe: async () => { order.push('probe'); return { height: 720 }; }, onDeep: () => order.push('phase'), decoder: async () => { order.push('decode'); }
  });
  assert.deepEqual(order, ['probe', 'phase', 'decode']); assert.equal(result.deep, true); assert.equal(result.level, 'deep-media');
});
test('derin taramada hata dosyayı tamamlanmış yapmaz', async t => {
  const input = fixture(t);
  await assert.rejects(verifyCompletedFile({ ...input, media: {}, deep: true, probe: async () => ({ height: 720 }), decoder: async () => { throw new Error('decode failure'); } }), /decode failure/);
});
test('ffprobe yoksa başarı iddiası yerine sınırlı doğrulama gösterilir', async t => {
  const input = fixture(t, false);
  const result = await verifyCompletedFile({ ...input, media: {} });
  assert.equal(result.status, 'limited'); assert.match(result.warning, /ffprobe/);
});
test('iptal edilmiş doğrulama dosya okumaya veya decoder başlatmaya geçmez', async t => {
  const input = fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(verifyCompletedFile({ ...input, signal: controller.signal }), { name: 'AbortError' });
});
