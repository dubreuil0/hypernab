# Hypernab gizlilik politikası

[English](PRIVACY.md)

Son güncelleme: 3 Kasım 2026

Hypernab, kendi bilgisayarında çalışan bir indirme yöneticisi ve ona video ile dosya veren bir tarayıcı eklentisidir. **Hypernab verini toplamaz, bir sunucuda saklamaz, satmaz ve kimseyle paylaşmaz.** Hesap, bulut hizmeti, reklam ve kullanım analizi yoktur. Geliştirici senin ya da indirmelerin hakkında hiçbir şey almaz.

## Tarayıcı eklentisi verinle ne yapar

Eklenti, ziyaret ettiğin sayfalara yalnızca tek işi için erişir: istediğin videoyu veya dosyayı bulup aynı bilgisayardaki Hypernab uygulamasına vermek.

| Ne | Neden | Nereye gider |
|---|---|---|
| Açtığın sayfalardaki medya isteklerinin adresleri ve yanıt başlıkları | Oynayan videoyu veya yayını fark edip **İndir** düğmesini göstermek | Yalnızca bilgisayarındaki Hypernab uygulamasına (`127.0.0.1`), sen indirmek istediğinde |
| Sağ tıklayıp **Hypernab ile indir** dediğin bağlantının adresi (ve bulunduğu sayfa) | O tek dosyayı Hypernab'a vermek | Yalnızca bilgisayarındaki Hypernab uygulamasına, yalnızca o tıklamada |
| Tarayıcı çerezleri | Bazı dosya ve videolar, giriş yaptığın oturumla alınabilir | **Yalnızca o dosya için bir düğmeye bastığında ya da bir bağlantıda "Hypernab ile indir"i seçtiğinde** okunur, yalnızca o dosyanın adresi için, yalnızca bilgisayarındaki uygulamaya gider. Bellekte tutulur; medya motoru (yt-dlp) gerektirdiğinde yalnızca o tek çalışma süresince kısa ömürlü bir geçici dosyaya yazılır ve çalışma bitince silinir (artıklar bir sonraki başlangıçta süpürülür). Geçmişe, günlüğe ya da rapora hiçbir zaman yazılmaz |
| Eklenti ayarların (örneğin dil ve dosya boyutu sınırı) | Seçimlerini hatırlamak | Bilgisayarında tarayıcının kendi eklenti deposunda durur |

Eklenti, oynatabildiğin video ve altyazıları bulmanın ötesinde sayfa içeriğini okumaz, yazdıklarını kaydetmez, gezinti geçmişini izlemez ve **kendi bilgisayarındaki Hypernab uygulaması dışında hiçbir sunucuya ağ isteği yapmaz.** İnternetten yüklenen kod çalıştırmaz. Hata bildirimi için kopyalayabildiğin rapor ilgili sayfaların site adlarını ve kısaltılmış yol parçalarını içerir, hiçbir zaman sorgu ya da çerez içermez ve bilgisayarından yalnızca sen bir yere yapıştırırsan çıkar. Eklenti tarayıcının kendi indirmelerini izlemez ya da devralmaz. Tarayıcılar eklentileri gizli (incognito) pencerede ancak sen izin verirsen çalıştırır; gizli pencerede normal oturumun çerezleri hiç kullanılmaz.

## Hypernab uygulaması ne yapar

- Seçtiğin dosyaları, seçtiğin adresten bilgisayarındaki bir klasöre indirir. O sunucular senden, bir tarayıcının göndereceği gibi sıradan bir indirme isteği görür.
- İndirme listeni ve geçmişini bilgisayarında tutar: dosya adı, durum, klasör, boyut ve zamanlar, site adı; listedeki işler için ayrıca kaynak adresi (varsa imzalı sorgusuyla), geldiğin sayfanın adresi (sorgusuz) ve indirmeyle gönderilen tarayıcı adı (User-Agent). Çerezleri hiçbir zaman kaydetmez. Kuyruğu temizlemek liste kayıtlarını kaldırır; indirilen dosyalar durur.
- Açıldıktan kısa süre sonra bir kez GitHub'a yeni sürüm olup olmadığını sorar. Yeni sürüm senin onayın olmadan indirilmez. GitHub, her web sitesi gibi sıradan bir web isteğinin bilgisini (örneğin IP adresini) görür.
- İsteğe bağlı olarak (varsayılan kapalı), bağlantı eklemeyi önermek için panoyu okur; yalnızca bu ayar açıkken. Panodan hiçbir şey saklanmaz ya da gönderilmez.

## Hypernab'ın yapmadıkları

- İndirmelerini, geçmişini, çerezlerini, adreslerini ya da ayarlarını geliştiriciye veya üçüncü kişilere göndermez.
- DRM'yi ya da erişim kısıtlarını aşmaz.
- Verini reklam, profil çıkarma ya da kredi kararları için kullanmaz ve satmaz.

## Kontrol sende

Araç çubuğundaki simgeye bir kez tıklayıp yakalamayı kapatabilir, eklentiyi tarayıcından kaldırabilir ya da uygulamayı Windows'tan kaldırabilirsin. Eklentiyi kaldırınca ayarları da gider. Uygulamayı kaldırınca veri klasörü (`%APPDATA%\Hypernab\data`: kuyruk, geçmiş, ayarlar) kalır, yeniden kurunca bulunur; her şeyi silmek için o klasörü sil. İndirdiğin dosyalar senindir, silinmez.

## Değişiklikler ve iletişim

Bu politika değişirse yeni hâli yeni bir tarihle burada yayınlanır. Sorular için: <https://github.com/dubreuil0/hypernab/issues> adresinde bir konu aç.
