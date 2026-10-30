const positive = value => Number.isFinite(value) && value > 0;
export function sourceSize(source, duration) {
  const size = source?.filesize || source?.filesize_approx;
  if (positive(size)) return size;
  const rate = source?.tbr || source?.abr;
  return positive(rate) && positive(duration) ? Math.round(rate * 1000 / 8 * duration) : null;
}

// Master BANDWIDTH already includes its alternate audio. A separate captured audioUrl does NOT.
export function hlsTotalEstimate({ offeredBytes, savedBytes, savedAudioBytes, info = {}, companion = null, separateAudio = false }) {
  const streams = info.requested_formats?.length ? info.requested_formats : [info];
  let base = positive(offeredBytes) ? offeredBytes : positive(savedBytes) ? savedBytes : null;
  if (!base) {
    const sizes = streams.map(s => sourceSize(s, info.duration));
    base = info.nativeHls && streams.length === 2 ? sourceSize(streams.find(s => s.vcodec !== 'none'), info.duration)
      : sizes.every(positive) ? sizes.reduce((sum, size) => sum + size, 0) : null;
  }
  if (!separateAudio || streams.length > 1) return base;
  const audio = companion?.formats?.find(s => s.vcodec === 'none') || companion;
  const audioSize = sourceSize(audio, companion?.duration) || (positive(savedAudioBytes) ? savedAudioBytes : null);
  return positive(base) && positive(audioSize) ? base + audioSize : null;
}
