import { m } from './messages.js';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import { readHls } from './hls.js';
import { SourceExpiredError, publishFile } from './transfer.js';
import { recoverRead, RemoteResponseError, IncompleteResourceError } from './recovery.js';
import { setTimeout as wait } from 'node:timers/promises';
import { ConnectionBudget } from './connection-budget.js';

// Fetch through the guarded HTTP layer; FFmpeg sees LOCAL playlists only (never a remote URL).
// With a stagingName the pieces of an earlier, interrupted attempt are kept and reused (a pause or a retry does not start over):
// only completely written pieces ever carry their final name, and a track is reused only when its list is the same list
// (same piece count, durations and container); otherwise that track starts fresh.
export async function downloadHls({ sources, directory, toolsDirectory, signal, request, headersFor = () => ({}), spawn, connections = 4, throttle, onProgress = () => {}, onPhase = () => {}, onRetry = () => {}, recovery = {}, stagingName = null }) {
  signal.throwIfAborted();
  const staging = path.join(directory, stagingName || `hls-${randomUUID()}`);
  fs.mkdirSync(staging, { recursive: stagingName !== null });
  if (stagingName) for (const name of fs.readdirSync(staging)) if (name.endsWith('.part')) fs.rmSync(path.join(staging, name), { force: true });
  const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]);
  const localLists = []; let received = 0, networkBytes = 0, active = 0;
  let targetConnections = Math.min(8, Math.max(1, Math.trunc(connections) || 1));
  const slots = new ConnectionBudget({ total: targetConnections, perHost: targetConnections });
  const cooldowns = new Map(), inflight = new Map();
  const progress = () => onProgress(received + [...inflight.values()].reduce((sum, n) => sum + n, 0), active, { networkBytes, targetConnections });
  const retry = url => detail => {
    targetConnections = Math.max(1, Math.floor(targetConnections / 2));
    slots.limit = slots.perHost = targetConnections; slots.drain();
    const host = new URL(url).hostname;
    cooldowns.set(host, Math.max(cooldowns.get(host) || 0, Date.now() + detail.delayMs));
    onRetry({ ...detail, connections: targetConnections });
  };
  for (const [track, source] of sources.entries()) {
    const playlist = source.hlsPlaylist || await readHls({ url: source.url, signal: combined, request, headers: headersFor(source.url), recovery: { ...recovery, onRetry: retry(source.url) } });
    if (!playlist || playlist.variants.length || playlist.live) throw new Error(m('e.the-chosen-hls-variant-is-not'));
    const pieces = [...(playlist.map ? [{ url: playlist.map, init: true }] : []), ...playlist.segments];
    let next = 0;
    const names = pieces.map((piece, index) => `${track}-${index}.${playlist.map ? 'mp4' : 'ts'}`);
    const reused = new Set();
    if (stagingName) {
      const identity = path.join(staging, `identity-${track}.json`);
      const key = createHash('sha256').update(JSON.stringify([Boolean(playlist.map), pieces.length, playlist.segments.map(segment => segment.duration)])).digest('hex');
      let same = false; try { same = JSON.parse(fs.readFileSync(identity, 'utf8')).key === key; } catch { /* first attempt, or unreadable: this track starts fresh */ }
      if (!same) for (const name of fs.readdirSync(staging)) if (name.startsWith(`${track}-`)) fs.rmSync(path.join(staging, name), { force: true });
      fs.writeFileSync(identity, JSON.stringify({ key }));
      if (same) for (const [index, name] of names.entries()) { try { const size = fs.statSync(path.join(staging, name)).size; if (size > 0) { reused.add(index); received += size; } } catch { /* piece not there yet */ } }
      progress();
    }
    const worker = async workerIndex => {
      while (next < pieces.length) {
        combined.throwIfAborted();
        if (workerIndex >= targetConnections) return;
        const index = next++, piece = pieces[index];
        if (reused.has(index)) continue; // kept from the earlier attempt
        const target = path.join(staging, names[index]);
        await recoverRead(async deadline => {
          const host = new URL(piece.url).hostname;
          const partial = `${target}.${randomUUID()}.part`;
          let response, release;
          try {
            release = await slots.acquire(host, deadline);
            while ((cooldowns.get(host) || 0) > Date.now()) await wait(cooldowns.get(host) - Date.now(), null, { signal: deadline });
            deadline.throwIfAborted();
            ({ response } = await request(piece.url, deadline, headersFor(piece.url)));
            active++;
            if ([401, 403, 410].includes(response.statusCode)) throw new SourceExpiredError(m('e.the-hls-source-address-must-be'));
            if (response.statusCode !== 200) throw new RemoteResponseError(response.statusCode, response.headers, m('e.resource.hls-segment'));
            if (/text\/html|application\/(?:json|xml)/i.test(response.headers['content-type'] || '')) throw new Error(m('e.a-non-media-response-was-received'));
            const expected = Number(response.headers['content-length']) || null;
            let bytes = 0;
            const meter = new Transform({ transform(chunk, _encoding, callback) {
              bytes += chunk.length; networkBytes += chunk.length;
              if (bytes > 128 * 1048576) { callback(new Error(m('e.the-hls-segment-size-limit-was'))); return; }
              Promise.resolve(throttle?.(chunk.length, deadline)).then(() => { inflight.set(target, bytes); progress(); callback(null, chunk); }, callback);
            } });
            await pipeline(response, meter, fs.createWriteStream(partial, { flags: 'wx' }), { signal: deadline });
            if (!bytes || (expected && expected !== bytes)) throw new IncompleteResourceError(m('e.an-hls-segment-is-missing-the'));
            deadline.throwIfAborted();
            await publishFile(partial, target, deadline); // works on non-hardlink filesystems too; never overwrites a committed piece
            received += bytes;
          } finally {
            if (response) { response.destroy(); active--; }
            release?.();
            inflight.delete(target);
            fs.rmSync(partial, { force: true });
            progress();
          }
        }, { maxElapsedMs: 180000, ...recovery, signal: combined, onRetry: retry(piece.url) });
      }
    };
    const outcomes = await Promise.allSettled(Array.from({ length: Math.min(targetConnections, pieces.length) }, (_, index) => worker(index).catch(error => { controller.abort(error); throw error; })));
    const failed = outcomes.find(outcome => outcome.status === 'rejected');
    if (failed) throw controller.signal.reason || failed.reason;
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${Math.ceil(playlist.segments.reduce((n, s) => Math.max(n, s.duration), 0))}`];
    if (playlist.map) lines.push(`#EXT-X-MAP:URI="${names[0]}"`);
    for (const [index, segment] of playlist.segments.entries()) lines.push(`#EXTINF:${segment.duration},`, names[index + (playlist.map ? 1 : 0)]);
    lines.push('#EXT-X-ENDLIST');
    const local = path.join(staging, `track-${track}.m3u8`);
    fs.writeFileSync(local, lines.join('\n'));
    localLists.push(local);
  }
  const output = path.join(staging, 'output.mp4');
  fs.rmSync(output, { force: true }); // a merge interrupted earlier left a half file, and ffmpeg runs with -n (never overwrite)
  onPhase('merging');
  const args = ['-v', 'error', '-nostdin', '-n'];
  for (const local of localLists) args.push('-protocol_whitelist', 'file', '-allowed_extensions', 'ALL', '-i', local);
  if (localLists.length === 2) args.push('-map', '0:v:0', '-map', '1:a:0');
  else args.push('-map', '0:v:0?', '-map', '0:a:0?');
  args.push('-c', 'copy', output);
  signal.throwIfAborted();
  await new Promise((resolve, reject) => {
    const child = spawn(path.join(toolsDirectory, 'ffmpeg.exe'), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], signal });
    // Do not echo media-controlled text (URLs/session data) from FFmpeg.
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('close', code => signal.aborted ? reject(signal.reason) : code === 0 ? resolve() : reject(new Error(m('e.the-hls-file-could-not-be'))));
  });
  return { output, staging };
}
