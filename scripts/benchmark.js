import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { extractMediaInfo } from '../src/media.js';
import { requestRemote } from '../src/network.js';

const url = process.argv[2];
if (!url) throw new Error('Video sayfası adresini argüman olarak ver.');
const signal = AbortSignal.timeout(90000);
const info = await extractMediaInfo({ url, toolsDirectory: fileURLToPath(new URL('../tools', import.meta.url)), signal });
if (!/^https?$/.test(info.protocol) || info.requested_formats?.length) throw new Error('Seçilen kaynak tek HTTP dosyası değil.');
const headers = Object.fromEntries(Object.entries(info.http_headers || {}).filter(([key]) => /^(user-agent|referer|accept|origin)$/i.test(key)));
async function range(start, end) {
  const { response } = await requestRemote(info.url, signal, { ...headers, Range: `bytes=${start}-${end}` });
  const expected = new RegExp(`^bytes ${start}-${end}/(\\d+)$`).exec(response.headers['content-range'] || '');
  if (response.statusCode !== 206 || !expected) { response.destroy(); throw new Error(`Range desteklenmedi: HTTP ${response.statusCode}`); }
  let size = 0;
  for await (const chunk of response) size += chunk.length;
  if (size !== end - start + 1) throw new Error('Eksik parça.');
  return { size, total: Number(expected[1]) };
}
const probe = await range(0, 0);
const bytes = Math.min(2 * 1024 * 1024, probe.total);
const start = performance.now();
await range(0, bytes - 1);
const sequential = (performance.now() - start) / 1000;
const parallelStart = performance.now();
await Promise.all(Array.from({ length: 8 }, (_, i) => range(Math.floor(i * bytes / 8), Math.floor((i + 1) * bytes / 8) - 1)));
const parallel = (performance.now() - parallelStart) / 1000;
console.log(JSON.stringify({ format: info.format_id, height: info.height, total: probe.total, sampleBytes: bytes, sequentialSeconds: sequential, parallelSeconds: parallel, sequentialBytesPerSecond: bytes / sequential, parallelBytesPerSecond: bytes / parallel }, null, 2));
