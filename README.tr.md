# Hypernab

[English](README.md)

Windows için yerel indirme yöneticisi ve Firefox, Chrome, Edge, Brave ve Opera için medya yakalama eklentisi. İndirmeler bilgisayarında kalır; hesap, bulut veya izleme yoktur.

**Sürüm:** uygulama 0.16.2 · eklenti 0.11.1 · Windows 10/11 (x64)

## Özellikler

- **Hızlı indirme:** parçalı ve uyarlanabilir bağlantı sayısıyla indirme, kaldığı yerden devam, hız sınırı (çalışan indirmeye de anında uygulanır).
- **İstediğin her dosya:** tarayıcıda bir bağlantıya sağ tıkla ve **Hypernab ile indir**'i seç, ya da bağlantıları uygulamaya yapıştır (**Birden çok bağlantı ekle**, ya da isteğe bağlı pano önerisi). Dosya gerçek adıyla kaydedilir, parçalara bölünerek hızlandırılır, boyutu ve yapısı (zip, pdf, program, resim...) doğrulanır ve Windows'un "internetten indirildi" işareti eklenir. Hypernab tarayıcının kendi indirmelerini arkandan devralmaz.

- **Kuyruk:** adlandırılmış kuyruklar, zamanlama, sürükleyerek sıralama, genel eşzamanlılık sınırı, "Sonra ekle".
- **Otomatik toparlanma:** geçici sunucu hatalarında, kopmalarda ve eksik verilerde sınırlı ve iptal edilebilir yeniden deneme; yalnızca bozuk parça yeniden indirilir. HLS indirmelerinde duraklatma, yeniden başlatma ve yeniden deneme bitmiş parçaları korur; yalnızca eksikler indirilir.
- **Akışlar:** HLS ve ayrı görüntü/ses akışları FFmpeg ile birleştirilir; sonuç ffprobe ile doğrulanır.
- **Alt yazı:** oynatıcıdan veya akıştan yakalanan alt yazı videoya gömülür ve varsayılan alt yazı ayrıca aynı adla `.srt` olarak yanına yazılır; böylece VLC, Media Player ve Films & TV kendiliğinden gösterir. Adı olmayan alt yazı dosyalarının dili 30 dilde içindeki kelimelerden anlaşılır; eski kod sayfalarındaki dosyalar (Windows-125x, GBK, Shift_JIS, EUC-KR, Big5, UTF-16...) doğru okunur. Ayarlar'dan yalnız gömme, yalnız yan dosya ya da kapalı seçilebilir.
- **Dil:** uygulama ve eklenti İngilizce ve Türkçe gelir. Varsayılan olarak Windows'un dilini izler (uygulamada o dilin metni yoksa İngilizce); Ayarlar'dan seçilir.
- **Dil tercihleri:** Ayarlar'dan varsayılan altyazı dili (varsayılan: arayüz dili) ve ses dili seçilir. Sayfa kendi altyazısını söylediyse o kazanır; seçtiğin dilde parça yoksa hiçbiri işaretlenmez. Ses, altyazı diline bağlı değildir: oynatıcıda çalan ses, yoksa ayardaki ses tercihi, yoksa sitenin varsayılanı seçilir ve panelde yazılır.
- **Altyazılı video biçimi:** mp4 içindeki gömülü altyazıyı VLC kendiliğinden açmaz (yan `.srt` dosyasını açar). İstersen Ayarlar'dan "mkv olarak kaydet" seçilir: video kayıpsız mkv'ye kopyalanır ve VLC varsayılan altyazıyı kendisi açar. Varsayılan: mp4 kalır.
- **Oynatma listeleri:** listeyi görüp istediğin bölümleri kuyruğa ekleme.
- **Birden çok bağlantı:** bağlantı kutusunun yanındaki düğme, her satıra bir bağlantı olacak şekilde en çok 100 bağlantı alır. Dosya tarayıcı indirmesi gibi alınır (gerçek ad, boyut ve yapı doğrulanır); sayfa medya motoruna en iyi kaliteyle gider; listede olanlar atlanır. İstersen (Ayarlar > Masaüstü, varsayılan kapalı) uygulama, penceresi öne gelince panoda bulduğu bağlantıları eklemeyi önerir; pano yalnızca bu açıkken okunur, hiçbir şey saklanmaz veya gönderilmez.
- **Akıllı adlandırma ve klasörleme:** her alfabede güvenli Windows dosya adları, isteğe bağlı klasör düzeni; mevcut dosyalar üzerine yazılmaz. Her şey Windows gibi tek indirme klasörüne iner; Ayarlar'daki tek bir anahtar yeni indirmeleri Video, Music, Images, Documents, Archives, Programs ve Other klasörlerine ayırır (indirilmiş dosyalar hiçbir zaman taşınmaz).
- **Geçmiş:** kuyruğu temizlesen de silinmeyen, aranabilir geçmiş. Kuyruğu temizlemek dosyaları silmez.
- **Tepsi hızlı paneli:** toplam hız ve ilk işler; tekli ve toplu duraklat/sürdür.
- **Arayüz:** koyu, açık ve sistem teması; dört vurgu rengi; küçük/normal/büyük yazı; kompakt veya normal liste. Düşük donanımda akıcı kalması için bulanıklık, büyük gölge ve sürekli animasyon kullanılmaz.

## Kurulum

1. [Sürümler](../../releases) sayfasından `Hypernab-Setup-<sürüm>.exe` dosyasını indir ve çalıştır.
2. Kurulum henüz **kod imzalı değildir**; Windows "bilinmeyen yayıncı" uyarısı gösterebilir.
3. Kurulum Node.js, yt-dlp ve FFmpeg'i kendi içinde getirir; ayrıca bir şey kurman gerekmez.

### İstediğin her dosyayı indirme

Bir sayfadaki bağlantıya sağ tıkla ve **Hypernab ile indir**'i seç. Bu kadar: tarayıcıda hiçbir şey duraklatılmaz, bekletilmez ya da izlenmez; bu yüzden her tarayıcıda aynı çalışır. O tek adresin çerezleri yalnızca o tıklamada, yalnızca o adres için okunur, yalnızca bilgisayarındaki uygulamaya gider ve hiç kaydedilmez. Sonuç araç çubuğu simgesinde kısa süre görünür ("OK" ya da "!" ve nedeni ipucunda); uygulama kapalıysa video düğmesindeki gibi açılır. Yakalama kapalıyken öğe gizlenir.

Eklenti `downloads` izni istemez. Dosya yerine bir web sayfasına giden bağlantı açık bir nedenle reddedilir.

### Eklenti

Eklenti kaynaktan derlenir: `npm run build:extensions` komutu `build/extensions` altında Firefox ve Chromium paketlerini üretir.

- **Chrome, Edge, Brave, Opera** (aynı klasör): tarayıcının eklentiler sayfası (`chrome://extensions`, `edge://extensions`, `brave://extensions`, `opera://extensions`) → Geliştirici modu → *Paketlenmemiş öğe yükle* → `build/extensions/chromium`.
- **Firefox:** `about:debugging#/runtime/this-firefox` → *Geçici eklenti yükle* → `build/extensions/firefox/manifest.json`. Geçici yükleme Firefox kapanınca kaybolur; kalıcı kurulum için imzalı paket gerekir.

Uygulamanın **Ayarlar > Tarayıcı eklentisi** bölümü bu adımları kopyalanabilir adreslerle gösterir.

Masaüstü uygulamasında aynı bölüm, bilgisayarda bulunan her desteklenen tarayıcı için bir **<tarayıcı> için kur** düğmesiyle başlar: o tarayıcının eklentiler sayfasını ve eklenti klasörünü açar, seçilecek yolu panoya kopyalar; onay her zaman tarayıcının kendisinden gelir, arkandan hiçbir şey kurulmaz. Eklenti uygulamaya ulaşınca yeşil bir işaret çıkar.

**Kullanım:** Açılır pencere yoktur. Araç çubuğundaki Hypernab simgesine **tıklamak yakalamayı açar/kapatır** (kapalıyken simge gri olur ve üstünde kırmızı çapraz çizgi görünür; sayfada düğme ve panel çıkmaz, hiçbir şey kaydedilmez). **Sağ tıklayınca** menü açılır: *Hypernab'ı aç*, *Bu sayfayı incele*, *Videoları yakala*, *Ayarlar ve teşhis*. Bir bağlantıda sağ tık *Hypernab ile indir* gösterir. Video oynayınca sayfada çıkan **İndir** düğmesi asıl indirme yeridir.

## Güncelleme

Uygulama açıldıktan kısa süre sonra yeni sürüm olup olmadığına bir kez bakar. Tepsi menüsündeki **Güncellemeleri denetle** ile elle de denetleyebilirsin.

- Yeni sürüm **sen onaylamadan indirilmez**.
- Kurulum **aktif indirme yokken** önerilir; kapatmadan önce motor güvenle durdurulur, kuyruk ve ayarlar korunur.
- Paket sürüm sayfasından alınır ve SHA-512 özetiyle doğrulanır.

## Gizlilik ve güvenlik

Tam politika [PRIVACY.tr.md](PRIVACY.tr.md) dosyasındadır.

- Yerel motor yalnızca `127.0.0.1` üzerinde çalışır; her istek eşleştirme anahtarı ve kaynak denetimi gerektirir.
- Tarayıcı çerezleri yalnızca sen sayfadaki düğmeye bastığında (ya da bir bağlantıda "Hypernab ile indir"i seçtiğinde), yalnızca seçtiğin adres için kullanılır. Bellekte tutulur. Medya motoru (yt-dlp) gerektirdiğinde, yalnızca o tek çalışma süresince Windows geçici klasöründe kısa ömürlü bir dosyaya yazılır ve çalışma biter bitmez silinir (artıklar bir sonraki başlangıçta süpürülür). Geçmişe, günlüğe ya da rapora hiçbir zaman yazılmaz.
- DRM korumalı içerik ve erişim kısıtlamaları **aşılmaz**. Yalnızca indirme iznin olan içerikler için kullan.
- İndirme listesi (`%APPDATA%\Hypernab\data` içindeki `queue.json`) her iş için dosya adını, durumu, klasörü, kaynak adresini (varsa imzalı sorgusuyla), geldiği sayfanın adresini (sorgusuz) ve User-Agent bilgisini tutar. Geçmiş başlığı, dosya adını, klasörü, site adını, boyutu ve zamanları tutar. **Çerezler ve diğer istek başlıkları hiçbir zaman kaydedilmez.** Kuyruğu temizlemek kayıtlarını listeden kaldırır; indirilen dosyalar durur. Uygulamayı kaldırınca veri klasörü kalır (yeniden kurunca kuyruğun ve ayarların bulunur); her şeyi silmek için o klasörü sil. yt-dlp'nin kendi önbelleği de o klasörde tutulur, ev klasöründe değil.

## Sınırlar

- Her sitede çalışacağı garanti edilmez; siteler değişebilir. Sorun olursa eklentinin ayarlar sayfasındaki **Teşhis raporunu kopyala** düğmesi çerez ve sorgu bilgisi içermeyen bir rapor üretir (ilgili sayfaların site adlarını ve kısaltılmış yol parçalarını içerir).
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

Metinler `public/strings.js` içinde (İngilizce ve Türkçe yan yana); koda yeni metin yazılmaz. Yayından önce `node scripts/privacy-check.js --repo --package --history` çalıştırılır; kişisel bilgi veya özel terim bulursa yayın durur.

## Lisans ve üçüncü taraf bileşenler

Tüm hakları saklıdır. Kurulum paketi Electron, Node.js, yt-dlp ve FFmpeg'i değiştirmeden içerir; lisansları için [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) dosyasına bak.
