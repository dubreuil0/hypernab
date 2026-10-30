# Hypernab

Windows için yerel indirme yöneticisi ve Firefox, Chrome, Edge, Brave için medya yakalama eklentisi. İndirmeler bilgisayarında kalır; hesap, bulut veya izleme yoktur.

**Sürüm:** uygulama 0.10.25 · eklenti 0.5.13 · Windows 10/11 (x64)

## Özellikler

- **Hızlı indirme:** parçalı ve uyarlanabilir bağlantı sayısıyla indirme, kaldığı yerden devam, hız sınırı.
- **Tarayıcıdan yakalama:** eklenti, oynattığın videoyu algılar ve sayfada "Hypernab ile indir" düğmesi gösterir. Kalite listesinden seçersin; seçmediğin kaliteye sessizce düşülmez.
- **Kuyruk:** adlandırılmış kuyruklar, zamanlama, sürükleyerek sıralama, genel eşzamanlılık sınırı, "Sonra ekle".
- **Otomatik toparlanma:** geçici sunucu hatalarında, kopmalarda ve eksik verilerde sınırlı ve iptal edilebilir yeniden deneme; yalnızca bozuk parça yeniden indirilir.
- **Akışlar:** HLS ve ayrı görüntü/ses akışları FFmpeg ile birleştirilir; sonuç ffprobe ile doğrulanır.
- **Alt yazı:** oynatıcıdan veya akıştan yakalanan alt yazı videoya gömülür ya da ayrı dosya olarak kaydedilir (Ayarlar'dan seçilir).
- **Oynatma listeleri:** listeyi görüp istediğin bölümleri kuyruğa ekleme.
- **Akıllı adlandırma ve klasörleme:** güvenli Windows dosya adları, isteğe bağlı klasör düzeni; mevcut dosyalar üzerine yazılmaz.
- **Geçmiş:** kuyruğu temizlesen de silinmeyen, aranabilir geçmiş. Kuyruğu temizlemek dosyaları silmez.
- **Tepsi hızlı paneli:** toplam hız ve ilk işler; tekli ve toplu duraklat/sürdür.
- **Arayüz:** koyu, açık ve sistem teması; dört vurgu rengi; küçük/normal/büyük yazı; kompakt veya normal liste. Düşük donanımda akıcı kalması için bulanıklık, büyük gölge ve sürekli animasyon kullanılmaz.

## Kurulum

1. [Sürümler](../../releases) sayfasından `Hypernab-Setup-<sürüm>.exe` dosyasını indir ve çalıştır.
2. Kurulum henüz **kod imzalı değildir**; Windows "bilinmeyen yayıncı" uyarısı gösterebilir.
3. Kurulum Node.js, yt-dlp ve FFmpeg'i kendi içinde getirir; ayrıca bir şey kurman gerekmez.

### Eklenti

Eklenti kaynaktan derlenir: `npm run build:extensions` komutu `build/extensions` altında Firefox ve Chromium paketlerini üretir.

- **Firefox:** `about:debugging#/runtime/this-firefox` → *Geçici eklenti yükle* → `build/extensions/firefox/manifest.json`. Geçici yükleme Firefox kapanınca kaybolur; kalıcı kurulum için imzalı paket gerekir.
- **Chrome, Edge, Brave:** `chrome://extensions` (veya `edge://extensions`) → Geliştirici modu → *Paketlenmemiş öğe yükle* → `build/extensions/chromium`.

## Güncelleme

Uygulama açıldıktan kısa süre sonra yeni sürüm olup olmadığına bir kez bakar. Tepsi menüsündeki **Güncellemeleri denetle** ile elle de denetleyebilirsin.

- Yeni sürüm **sen onaylamadan indirilmez**.
- Kurulum **aktif indirme yokken** önerilir; kapatmadan önce motor güvenle durdurulur, kuyruk ve ayarlar korunur.
- Paket sürüm sayfasından alınır ve SHA-512 özetiyle doğrulanır.

## Gizlilik ve güvenlik

- Yerel motor yalnızca `127.0.0.1` üzerinde çalışır; her istek eşleştirme anahtarı ve kaynak denetimi gerektirir.
- Tarayıcı çerezleri yalnızca sen sayfadaki düğmeye bastığında, yalnızca seçtiğin videonun adresi için kullanılır; diske, günlüğe veya rapora yazılmaz.
- DRM korumalı içerik ve erişim kısıtlamaları **aşılmaz**. Yalnızca indirme iznin olan içerikler için kullan.
- Geçmiş yerel bir veritabanında tutulur; dosya adı ve durum gibi bilgileri tutar; kaynak adresi, istek başlığı ve çerez içermez.

## Sınırlar

- Her sitede çalışacağı garanti edilmez; siteler değişebilir. Sorun olursa eklenti penceresindeki **Teşhis raporunu kopyala** düğmesi çerez ve sorgu bilgisi içermeyen bir rapor üretir.
- Yalnızca sayfada özel bir katman olarak çizilen altyazılar yakalanamaz.
- Windows kod imzası ve kalıcı (imzalı) Firefox paketi henüz yoktur.

## Geliştirme

Gereksinim: Node.js 22.13 veya üstü.

```
npm install
npm test                  # birim testleri
npm run check             # sözdizimi denetimi
npm run build:extensions  # eklenti paketleri
npm run dist              # Windows kurulum paketi (dist/)
node scripts/desktop-smoke.js   # paketlenmiş uygulamada uçtan uca kontrol
```

Yayından önce `node scripts/privacy-check.js --repo --package --history` çalıştırılır; kişisel bilgi veya özel terim bulursa yayın durur.

## Lisans ve üçüncü taraf bileşenler

Tüm hakları saklıdır. Kurulum paketi Electron, Node.js, yt-dlp ve FFmpeg'i değiştirmeden içerir; lisansları için [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) dosyasına bak.
