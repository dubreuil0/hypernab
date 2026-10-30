const phases = { queued: 'Sırasını bekliyor', held: 'Sırada', resolving: 'Kaynak hazırlanıyor', probing: 'Kaynak kontrol ediliyor', downloading: 'İndiriliyor',
  'checking-resume': 'Önceki parçalar karşılaştırılıyor', 'waiting-connection': 'Bağlantı bekleniyor',
  pausing: 'Duraklatılıyor', paused: 'Duraklatıldı', 'waiting-resume': 'Devam için bekliyor',
  merging: 'Ses ve görüntü birleştiriliyor', verifying: 'Dosya doğrulanıyor', 'deep-verifying': 'Derin hata taraması',
  processing: 'Son işlem yapılıyor', publishing: 'Dosya kaydediliyor', completed: 'Tamamlandı', failed: 'Başarısız', cancelled: 'İptal edildi', interrupted: 'Kesintiye uğradı' };
export function durationText(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'hesaplanamıyor';
  const value = Math.ceil(seconds);
  if (value < 60) return `${value} sn`;
  if (value < 3600) return `${Math.floor(value / 60)} dk ${value % 60} sn`;
  return `${Math.floor(value / 3600)} sa ${Math.floor(value % 3600 / 60)} dk`;
}
export function progressView(job, fmt) {
  const p = job.progress || { phase: job.status, received: job.received, total: job.total, speed: 0, etaSeconds: null };
  let stage = phases[p.phase] || phases[job.status] || job.status;
  if (p.phase === 'checking-resume' && job.transfer?.resumeTotal) stage += ` (${job.transfer.resumeChecked || 0}/${job.transfer.resumeTotal})`;
  const size = `${fmt(p.received)} / ${p.total > 0 ? `${p.sizeKind === 'approx' ? 'Yaklaşık ' : ''}${fmt(p.total)}` : 'Boyut bilinmiyor'}`;
  const transferring = job.status === 'running' && p.phase === 'downloading';
  const speed = transferring ? `${fmt(p.speed)}/sn` : null;
  const remaining = transferring ? p.etaSeconds !== null && Number.isFinite(p.etaSeconds) ? `Yaklaşık ${durationText(p.etaSeconds)} kaldı`
    : p.etaReason === 'estimate-exceeded' ? 'Boyut tahmini aşıldı; kalan süre henüz hesaplanamıyor'
    : p.etaReason === 'unknown-size' ? 'Kalan süre hesaplanamıyor: boyut bilinmiyor'
    : p.etaReason === 'processing' ? 'Aktarım tamamlandı; son işlemler bekleniyor'
    : p.etaReason === 'stalled' ? 'Veri bekleniyor; kalan süre hesaplanamıyor' : 'Kalan süre hesaplanıyor…' : null;
  return { stage, size, speed, remaining, percent: p.percent ?? null };
}
