# Hypernab gizlilik politikası

[English](PRIVACY.md)

Son güncelleme: 2 Kasım 2026

Hypernab, kendi bilgisayarında çalışan bir indirme yöneticisi ve ona video ile dosya veren bir tarayıcı eklentisidir. **Hypernab verini toplamaz, bir sunucuda saklamaz, satmaz ve kimseyle paylaşmaz.** Hesap, bulut hizmeti, reklam ve kullanım analizi yoktur. Geliştirici senin ya da indirmelerin hakkında hiçbir şey almaz.

## Tarayıcı eklentisi verinle ne yapar

Eklenti, ziyaret ettiğin sayfalara yalnızca tek işi için erişir: istediğin videoyu veya dosyayı bulup aynı bilgisayardaki Hypernab uygulamasına vermek.

| Ne | Neden | Nereye gider |
|---|---|---|
| Açtığın sayfalardaki medya isteklerinin adresleri ve yanıt başlıkları | Oynayan videoyu veya yayını fark edip **İndir** düğmesini göstermek | Yalnızca bilgisayarındaki Hypernab uygulamasına (`127.0.0.1`), sen indirmek istediğinde |
| Sağ tıklayıp **Hypernab ile indir** dediğin bağlantının adresi (ve bulunduğu sayfa) | O tek dosyayı Hypernab'a vermek | Yalnızca bilgisayarındaki Hypernab uygulamasına, yalnızca o tıklamada |
| Tarayıcı çerezleri | Bazı dosya ve videolar, giriş yaptığın oturumla alınabilir | **Yalnızca o dosya için bir düğmeye bastığında ya da bir bağlantıda "Hypernab ile indir"i seçtiğinde** okunur, yalnızca o dosyanın adresi için, yalnızca bilgisayarındaki uygulamaya gider; diske, günlüğe veya rapora yazılmaz |
| Eklenti ayarların (örneğin dil ve dosya boyutu sınırı) | Seçimlerini hatırlamak | Bilgisayarında tarayıcının kendi eklenti deposunda durur |

Eklenti, oynatabildiğin video ve altyazıları bulmanın ötesinde sayfa içeriğini okumaz, yazdıklarını kaydetmez, gezinti geçmişini izlemez ve **kendi bilgisayarındaki Hypernab uygulaması dışında hiçbir sunucuya ağ isteği yapmaz.** İnternetten yüklenen kod çalıştırmaz. Eklenti tarayıcının kendi indirmelerini izlemez ya da devralmaz. Tarayıcılar eklentileri gizli (incognito) pencerede ancak sen izin verirsen çalıştırır; gizli pencerede normal oturumun çerezleri hiç kullanılmaz.

## Hypernab uygulaması ne yapar

- Seçtiğin dosyaları, seçtiğin adresten bilgisayarındaki bir klasöre indirir. O sunucular senden, bir tarayıcının göndereceği gibi sıradan bir indirme isteği görür.
- Bilgisayarında yerel bir veritabanında indirme geçmişi tutar (dosya adı, durum, boyut). Çerez ya da istek başlığı içermez. İstediğinde temizleyebilirsin.
- Açıldıktan kısa süre sonra bir kez GitHub'a yeni sürüm olup olmadığını sorar. Yeni sürüm senin onayın olmadan indirilmez. GitHub, her web sitesi gibi sıradan bir web isteğinin bilgisini (örneğin IP adresini) görür.
- İsteğe bağlı olarak (varsayılan kapalı), bağlantı eklemeyi önermek için panoyu okur; yalnızca bu ayar açıkken. Panodan hiçbir şey saklanmaz ya da gönderilmez.

## Hypernab'ın yapmadıkları

- İndirmelerini, geçmişini, çerezlerini, adreslerini ya da ayarlarını geliştiriciye veya üçüncü kişilere göndermez.
- DRM'yi ya da erişim kısıtlarını aşmaz.
- Verini reklam, profil çıkarma ya da kredi kararları için kullanmaz ve satmaz.

## Kontrol sende

Araç çubuğundaki simgeye bir kez tıklayıp yakalamayı kapatabilir, eklentiyi tarayıcından kaldırabilir ya da uygulamayı Windows'tan kaldırabilirsin. Kaldırınca bilgisayarında tutulan ayarlar ve geçmiş de gider. İndirdiğin dosyalar senindir, silinmez.

## Değişiklikler ve iletişim

Bu politika değişirse yeni hâli yeni bir tarihle burada yayınlanır. Sorular için: <https://github.com/dubreuil0/hypernab/issues> adresinde bir konu aç.
