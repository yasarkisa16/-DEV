# IS Validation Dashboard

Google Sheets üzerindeki **IS Validation takip listesini** yönetici bakış açısıyla raporlayan
Google Apps Script web uygulaması. Anlık durum fotoğrafının yanı sıra **gecikme, yaşlandırma,
trend, sorumluluk dağılımı ve veri kalitesi** görünümleri sunar.

> Bilingual: the whole interface can be switched between Turkish and English with the TR/EN
> toggle in the header. All measures, table columns and alerts are translated.

---

## İçindekiler

- [Özellikler](#özellikler)
- [Dosyalar](#dosyalar)
- [Kurulum](#kurulum)
- [Kolon eşleme (otomatik algılama)](#kolon-eşleme-otomatik-algılama)
- [Yapılandırma](#yapılandırma)
- [Haftalık yönetici e-postası](#haftalık-yönetici-e-postası)
- [Yerel önizleme](#yerel-önizleme)
- [Tanımlar](#tanımlar)
- [Sorun giderme](#sorun-giderme)

---

## Özellikler

### Yönetici katmanı
- **Yönetici Özeti şeridi** — bugün aksiyon gerektiren her şey sayfanın en üstünde:
  sevkiyata 7 günden az kalanlar, termini geçenler, 90+ gündür hareketsizler,
  Order bilgisi eksik olanlar ve veri eksikliği taşıyan kayıtlar. Her rozet tıklanabilir
  ve listeyi doğrudan o kırılıma indirger.
- **6 KPI kartı** — Toplam / Tamamlanan / Bekleyen / İptal / Geciken / Kritik.
  Her kartın altında ikincil bir ölçüm bulunur (ortalama çevrim süresi, en eski bekleyen iş,
  toplam içindeki pay).
- **Hedefe kıyaslı göstergeler** — tamamlama ve iptal göstergelerinde hedef çizgisi işaretlenir,
  renk hedefin altında/üstünde olmaya göre değişir.
- **Yaşlandırma analizi** — bekleyen işlerin 0-30 / 31-60 / 61-90 / 90+ gün dağılımı.
- **Trend grafiği** — tarih kolonu varsa son 12 ayın aylık akışı, yoksa yıl bazında
  portföy kırılımı; her ikisinde de tamamlama oranı ikinci eksende çizgi olarak gösterilir.
- **Kırılım grafikleri** — Tip, Sorumlu ve Müşteri bazında yığılmış tamamlama dağılımı
  (ilgili kolon sayfada varsa otomatik açılır).
- **Veri kalitesi paneli** — eksik yıl, boş status, okunamayan sevkiyat tarihi, eksik Order,
  mükerrer Bursa Ref. Her bulgu tıklanınca ilgili kayıtlar tabloya filtrelenir.

### Operasyon
- Sıralanabilir tablo kolonları, satıra tıklayınca **tüm sayfa kolonlarını gösteren detay penceresi**.
- **Kalan Gün** ve **Yaş** kolonları — sevkiyat geri sayımı süreç aşamasından bağımsız olarak görünür.
- Filtreler: Status, Type, Year, Sorumlu, Müşteri, EDI Availability, serbest metin arama.
- **Excel/CSV dışa aktarım** (UTF-8 BOM + noktalı virgül, Türkçe Excel ile uyumlu) ve **yazdırma görünümü**.
- Otomatik yenileme (5 / 15 / 30 dakika) ve "son güncelleme" damgası.
- **Haftalık otomatik e-posta özeti** (Apps Script zamanlayıcısı).

### Dayanıklılık
- Sunucu asla ham exception atmaz; hata yapısal olarak döner ve panelde okunabilir bir kutuda gösterilir.
- Veri **parça parça (chunked) cache** ile 5 dakika saklanır; `getDataRange()` her açılışta tetiklenmez.
- ECharts veya Bootstrap CDN'ine erişilemezse panel çökmez — grafikler yerine bilgi notu gösterilir,
  KPI'lar ve tablo çalışmaya devam eder.
- Tüm hücre içerikleri HTML-escape edilir (proje adındaki tırnak/`<` karakterleri satırı bozmaz).

---

## Dosyalar

| Dosya | Açıklama |
|---|---|
| `Kod.gs` | Sunucu tarafı: veri okuma, cache, kolon algılama, haftalık e-posta raporu |
| `Index.html` | Panelin tamamı (HTML + CSS + istemci JS, i18n dahil) |
| `appsscript.json` | Apps Script manifesti (zaman dilimi, kapsamlar, web app ayarları) |

---

## Kurulum

1. [script.google.com](https://script.google.com) üzerinde yeni bir proje açın.
2. **Proje ayarları → "appsscript.json" manifest dosyasını göster** seçeneğini işaretleyin.
3. Bu depodaki üç dosyayı projeye kopyalayın:
   - `Kod.gs` → aynı isimde bir script dosyası
   - `Index.html` → **`Index`** adında bir HTML dosyası (isim birebir bu olmalı, `doGet` bunu arar)
   - `appsscript.json` → mevcut manifest içeriğini değiştirin
4. `Kod.gs` içindeki `CONFIG.SHEET_URL` ve `CONFIG.SHEET_NAME` değerlerini kendi sayfanıza göre ayarlayın.
5. Editörde **`debugColumnDetection`** fonksiyonunu bir kez çalıştırın. İlk çalıştırmada izin
   isteyecektir. `Yürütme günlüğü` bölümünde hangi başlığın hangi alana eşlendiğini görürsünüz —
   yanlış eşleşme varsa [aşağıya](#kolon-eşleme-otomatik-algılama) bakın.
6. **Dağıt → Yeni dağıtım → Web uygulaması**: "Şu kullanıcı olarak yürüt: Ben",
   "Erişimi olanlar: Kuruluşunuzdaki herkes" (veya ihtiyacınıza göre).
7. Verilen URL'yi paylaşın.

---

## Kolon eşleme (otomatik algılama)

Panel sayfanın başlık satırını okuyup kolonları kendi bulur. Eşleştirme büyük/küçük harf,
Türkçe karakter ve noktalama farklarına duyarsızdır. Bir başlık yalnızca **bir** alana atanır ve
tanım sırası önceliklidir (örneğin `IS Status`, `Status` alanını kapmaz).

| Alan | Aranan başlık kalıpları | Zorunlu mu? |
|---|---|---|
| `year` | Year, Yıl | Önerilir (yaşlandırma ve trend buna dayanır) |
| `ref` | Bursa Ref, Reference, Referans | Önerilir |
| `project` | Project Name, Proje Adı | **Evet** (boş olan satırlar atlanır) |
| `type` | Type, Tip, Kategori | Hayır |
| `status` | Status, Durum | **Evet** (tüm KPI'ların temeli) |
| `isStatus` | IS Status, IS Validation | Hayır |
| `order` | Order, Sipariş | Hayır |
| `firstShipment` | First Shipment, İlk Sevkiyat | Önerilir (geri sayım buna dayanır) |
| `targetDate` | Target Date, Due Date, Termin, Hedef Tarih | Hayır (varsa gecikme bundan hesaplanır) |
| `createdDate` | Request Date, Creation Date, Kayıt Tarihi, Talep Tarihi | Hayır (varsa **aylık trend** açılır) |
| `closedDate` | Close Date, Completion Date, Tamamlanma | Hayır (varsa **ortalama çevrim süresi** açılır) |
| `owner` | Owner, Responsible, Sorumlu, Assignee | Hayır (varsa sorumlu filtresi + grafiği açılır) |
| `customer` | Customer, Müşteri, Client, OEM | Hayır (varsa müşteri filtresi + grafiği açılır) |
| `plant` | Plant, Site, Lokasyon | Hayır |
| `ediEu` / `ediVst` | ... EDI Availability EU / VST | Hayır |
| `comment` | Comment, Note, Açıklama | Hayır |

Olmayan kolonlara bağlı paneller **hiç görünmez**, hata üretmez. Yeni bir kolon eklemek için
`Kod.gs` içindeki `COLUMN_PATTERNS` dizisine bir satır eklemeniz yeterlidir.

### Desteklenen tarih formatları

`20.08.2026` · `20/08/2026` · `2026-08-20` · `08/2026` (ayın son günü) · `CW32` · `W32-2026` ·
`Aug-26` · `Ağustos 2026` · `Kasım`

Okunamayan bir tarih **sessizce yok sayılmaz** — veri kalitesi panelinde "Sevkiyat tarihi
okunamıyor" başlığı altında sayılır ve tek tıkla listelenir.

---

## Yapılandırma

`Kod.gs` içindeki `CONFIG` bloğu:

| Ayar | Varsayılan | Anlamı |
|---|---|---|
| `TARGET_COMPLETION_RATE` | `90` | Tamamlama göstergesindeki hedef çizgisi (%) |
| `MAX_CANCELLATION_RATE` | `10` | İptal göstergesindeki üst sınır (%) |
| `STALE_WARNING_DAYS` | `90` | Bu süreden uzun bekleyen iş "TIKANDI" sayılır |
| `SHIPMENT_CRITICAL_DAYS` | `7` | Sevkiyata bu kadar gün kalınca "KRİTİK" |
| `CACHE_TTL_SECONDS` | `300` | Cache ömrü. `0` yapmayın; "Yenile" butonu zaten cache'i atlar |
| `REPORT_RECIPIENTS` | `[]` | Haftalık raporun gideceği e-posta adresleri |

Bu değerler istemciye `meta.config` içinde gönderilir; arayüzde ayrıca değiştirmeye gerek yoktur.

---

## Haftalık yönetici e-postası

1. `CONFIG.REPORT_RECIPIENTS` dizisine alıcıları yazın: `['mudur@firma.com']`
2. Editörde **`installWeeklyTrigger`** fonksiyonunu bir kez çalıştırın (Pazartesi 08:00 kurar).
3. Test için **`sendWeeklyReport`** fonksiyonunu elle çalıştırabilirsiniz.
4. Kaldırmak için **`removeWeeklyTrigger`**.

E-posta; KPI tablosu, tamamlama/iptal oranları ve **aksiyon gereken ilk 10 projeyi**
(geciken → kritik → tıkanmış sırasıyla) ve panele giden bir bağlantıyı içerir.

---

## Yerel önizleme

`Index.html` Apps Script dışında da açılabilir. `google.script.run` bulunamazsa panel,
gerçek veri yapısını taklit eden 56 satırlık bir **demo veri seti** üretir:

```bash
# depo kökünde
python3 -m http.server 8000
# tarayıcıda: http://localhost:8000/Index.html
```

Bu mod yalnızca geliştirme içindir; canlı veriye erişmez.

---

## Tanımlar

Panelde geçen ölçümlerin tam tanımı:

- **Tamamlanan (Done):** `Status` alanı `DONE` / `COMPLETED` / `TAMAM` içeren kayıt.
- **İptal (Cancel):** `Status` alanı `CANCEL` / `İPTAL` içeren kayıt.
- **Bekleyen (Pending):** yukarıdaki ikisine girmeyen her kayıt.
- **Geciken (Overdue):** bekleyen **ve** termini/sevkiyat tarihi bugünden önce olan kayıt.
  Tarih bilgisi hiç yoksa, `Year` değeri içinde bulunulan yıldan küçükse geciken sayılır.
- **Kritik:** bekleyen, henüz gecikmemiş, sevkiyatına `SHIPMENT_CRITICAL_DAYS` günden az kalan kayıt.
- **Tıkanmış (Stale):** bekleyen ve açılışından bu yana `STALE_WARNING_DAYS` günden fazla geçmiş kayıt.
  Açılış tarihi kolonu yoksa ilgili yılın 1 Ocak'ı başlangıç kabul edilir.
- **Yaş:** açılış tarihinden bugüne geçen gün (yalnızca bekleyen kayıtlarda gösterilir).
- **Kalan Gün:** termin (yoksa ilk sevkiyat) tarihine kalan gün; negatif değer gecikmeyi gösterir.
- **Çevrim süresi:** yalnızca hem açılış hem kapanış tarihi kolonu varsa hesaplanır.

Tüm hesaplar **tarayıcının o anki tarihine** göre yapılır; sabit bir tarih kullanılmaz.

---

## Sorun giderme

| Belirti | Sebep / Çözüm |
|---|---|
| "…sekmesi bulunamadı" | `CONFIG.SHEET_NAME` yanlış. Hata mesajı mevcut sekme adlarını listeler. |
| KPI'lar 0, tablo boş | `status` kolonu algılanmamış olabilir. `debugColumnDetection` çıktısını kontrol edin. |
| Grafikler yerine "CDN'e erişilemedi" notu | Kurum ağı jsDelivr/cdnjs'i engelliyor. Kütüphaneleri kurum içi bir sunucuya alıp `Index.html` içindeki `<script>`/`<link>` adreslerini değiştirin. |
| Sayılar güncel değil | Veri 5 dakika cache'lenir. Başlıktaki **Yenile** butonu cache'i atlar. |
| "Excel'e Aktar" bir şey indirmiyor | Tarayıcı sandbox indirmeyi engellemiştir; panel bu durumda CSV metnini kopyalanabilir bir pencerede gösterir. |
| Yaş/gecikme değerleri şişkin görünüyor | Açılış tarihi kolonu yoksa yılın 1 Ocak'ı kullanılır. Bir `Request Date` kolonu eklemek bu ölçümü hassaslaştırır. |
