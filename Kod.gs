/**
 * =============================================================================
 *  IS VALIDATION DASHBOARD — SUNUCU TARAFI / SERVER SIDE
 *  Google Apps Script (V8)
 * =============================================================================
 *  Sorumluluklar / Responsibilities:
 *    1. Google Sheet'ten veriyi okumak (chunk'lı cache ile)
 *    2. Kolon başlıklarını otomatik algılamak (TR/EN eş anlamlı destekli)
 *    3. Yapısal hata nesnesi döndürmek (asla ham exception atmamak)
 *    4. Haftalık yönetici e-posta özetini üretmek ve göndermek
 * =============================================================================
 */

const CONFIG = {
  SHEET_URL: 'https://docs.google.com/spreadsheets/d/1TagEpzdo5B3vBsca151ks18jZjOEkV5WhDTX40njo8I/edit',
  SHEET_NAME: 'Bursa Follow Up',

  // --- Cache ---
  CACHE_PREFIX: 'isdash_v2',
  CACHE_TTL_SECONDS: 300,          // 5 dakika
  CACHE_CHUNK_SIZE: 90000,         // CacheService anahtar başına ~100KB sınırı
  CACHE_MAX_CHUNKS: 60,

  // --- Yönetim hedefleri / Management targets ---
  TARGET_COMPLETION_RATE: 90,      // % tamamlama hedefi
  MAX_CANCELLATION_RATE: 10,       // % kabul edilebilir iptal üst sınırı
  STALE_WARNING_DAYS: 90,          // Bu süreden uzun bekleyen iş "tıkanmış" sayılır
  SHIPMENT_CRITICAL_DAYS: 7,       // Sevkiyata bu kadar gün kalınca kritik

  // --- Haftalık rapor ---
  REPORT_RECIPIENTS: [],           // ör: ['mudur@firma.com', 'ekip@firma.com']
  REPORT_SUBJECT: 'IS Validation — Haftalik Yonetici Ozeti',
  REPORT_RISK_LIMIT: 10
};

/* =============================================================================
 *  STANDART MODÜL DEĞİŞKENLERİ (SETUP_CLAUDE.md)
 *  FB_SHEET_ID   : Feedback ve giriş loglarının toplandığı merkezi spreadsheet.
 *                  Burada panelin kendi veri dosyası kullanılıyor.
 *  PROJECT_NAME  : Log sekmesi adının ön eki.
 *  TIMEOUT_MIN   : Sekme arka planda bu süreyi aşarsa oturum kapanmış sayılır.
 * ========================================================================== */
var FB_SHEET_ID  = '1TagEpzdo5B3vBsca151ks18jZjOEkV5WhDTX40njo8I';
var PROJECT_NAME = 'IS Validation Dashboard';
var LOG_SHEET    = PROJECT_NAME + '_GirisLoglari';
var TIMEOUT_MIN  = 10;

/* =============================================================================
 *  MODÜL 4 — KAYNAK → HEDEF OTOMATİK AKTARIM AYARLARI
 *  Kaynak dosyaya yeni satır eklendiğinde, eşleşen kolonlar hedef takip
 *  sayfasına otomatik kopyalanır. Kolon eşleşmesi başlık adlarından otomatik
 *  kurulur; farklı isimlendirmeler MAP ile elle bağlanabilir.
 * ========================================================================== */
const SYNC = {
  SOURCE_ID: '1odpzS7XdaxhhFuRoZ7ht_24Y4LJ3VSM1fdG4ydtHPrE',
  SOURCE_GID: 811830514,           // Sekme GID'i (URL'deki #gid=... değeri)
  SOURCE_SHEET_NAME: '',           // Doluysa GID yerine bu ad kullanılır
  SOURCE_HEADER_ROW: 0,            // 0 = otomatik bul (rapor başlıkları 1. satırda olmayabilir)
  SOURCE_HEADER_SCAN_ROWS: 25,     // Otomatik aramada taranacak ilk satır sayısı

  TARGET_SHEET_NAME: 'Bursa Follow Up',
  TARGET_HEADER_ROW: 1,

  // Mükerrer kaydı engelleyen benzersiz anahtar (hedefteki başlık adı).
  // Bulunamazsa son işlenen kaynak satır numarası üzerinden çalışılır.
  KEY_TARGET_HEADER: 'Bursa Ref',
  KEY_SOURCE_HEADER: '',           // Boşsa hedefle eşleşen kaynak kolonu kullanılır

  // Kaynaktan ASLA doldurulmayacak kolonlar. Aktarım "IS Status"a kadar olan
  // tanımlayıcı alanları getirir; sonrasındaki iş akışı alanlarını ekip doldurur.
  EXCLUDE_TARGET_HEADERS: [
    'IS Status', 'Order', 'First Shipment', 'Shipment Oty', 'Status',
    'Next 12 Month EDI Availability EU', 'Next 12 Month EDI Availability VST',
    'MPS', 'COMMENT', 'Comment', 'Comments', 'Yorum'
  ],

  // Yeni satıra sabit yazılacak değerler: { 'Hedef Başlık': 'Değer' }
  DEFAULTS: {
    'IS Status': 'Not in Liberation'
  },

  // Başlık adları birebir tutmadığında elle bağlama: { 'Hedef Başlık': 'Kaynak Başlık' }
  MAP: {
    'Project Name': 'Kit'          // Kaynakta proje adı "Kit" kolonunda tutuluyor
  },

  // Kaynak dosyada yıllara yayılmış geçmiş kayıtlar bulunur. Aktarımın bunları
  // toplu hâlde hedefe boşaltmaması için iki güvenlik önlemi vardır:
  //   1) Baseline — markSyncBaseline() çalıştırıldığı andaki tüm anahtarlar
  //      "zaten bilinen" sayılır; sonrasında yalnızca yeni eklenenler aktarılır.
  //   2) MIN_LAUNCH_YEAR — bu yıldan eski kayıtlar hiç değerlendirilmez.
  BASELINE_SHEET_NAME: 'Sync Baseline',
  MIN_LAUNCH_YEAR: 0,              // 0 = filtre yok; ör. 2026 → sadece 2026 ve sonrası
  IGNORED_KEY_VALUES: ['TBD', 'N/A', 'NA', '-', '?', 'YOK'],

  DRY_RUN: false,                  // true → yazma yapmaz, sadece raporlar
  LOG_SHEET_NAME: 'Sync Log',
  MAX_ROWS_PER_RUN: 500,

  // --- Otomatik kontrol sıklığı ---
  TRIGGER_MINUTES: 15,             // Geçerli değerler: 1, 5, 10, 15, 30

  // --- Yeni kayıt bildirimi ---
  NOTIFY_ENABLED: true,
  NOTIFY_RECIPIENTS: [
    'alpay.mutlu@valeo.com',
    'resul.akbulut@valeo.com',
    'cem.kapitan@valeo.com',
    'yasar.kisa@valeo.com'
  ],
  NOTIFY_ACTION_OWNER: 'Alpay Mutlu',   // Aksiyon takibi rica edilen kişi
  NOTIFY_MAX_CARDS: 20                  // E-postada en fazla kaç kart gösterilsin
};

/**
 * Kolon otomatik algılama tanımları.
 * Sıra ÖNEMLİDİR: daha özel alanlar (isStatus, ediEu) genel olanlardan (status) önce
 * çözülür, böylece "IS Status" başlığı yanlışlıkla "Status" alanına atanmaz.
 * exact  : normalize edilmiş başlıkla birebir eşleşme
 * contains: normalize edilmiş başlık içinde geçme
 */
const COLUMN_PATTERNS = [
  { field: 'ediEu',        exact: [], contains: ['edi availability eu', 'edi eu', 'availability eu'] },
  { field: 'ediVst',       exact: [], contains: ['edi availability vst', 'edi vst', 'availability vst'] },
  { field: 'isStatus',     exact: ['is status'], contains: ['is status', 'is validation', 'validation status'] },
  { field: 'firstShipment',exact: ['first shipment'], contains: ['first shipment', 'ilk sevkiyat', 'shipment date', 'sevkiyat'] },
  { field: 'targetDate',   exact: [], contains: ['target date', 'due date', 'deadline', 'planned date', 'hedef tarih', 'termin'] },
  { field: 'createdDate',  exact: [], contains: ['request date', 'creation date', 'created', 'open date', 'start date', 'kayit tarihi', 'talep tarihi', 'baslangic'] },
  { field: 'closedDate',   exact: [], contains: ['close date', 'closed date', 'completion date', 'done date', 'kapanis', 'tamamlanma'] },
  { field: 'status',       exact: ['status', 'durum'], contains: ['overall status', 'genel durum', 'status'] },
  { field: 'year',         exact: ['year', 'yil'], contains: ['year', 'yil'] },
  { field: 'ref',          exact: ['bursa ref', 'ref'], contains: ['bursa ref', 'reference', 'referans', 'ref no', 'ref'] },
  { field: 'project',      exact: ['project name', 'proje adi'], contains: ['project name', 'proje adi', 'project', 'proje'] },
  { field: 'type',         exact: ['type', 'tip'], contains: ['type', 'tip', 'tur', 'category', 'kategori'] },
  { field: 'order',        exact: ['order'], contains: ['order no', 'order', 'siparis'] },
  { field: 'owner',        exact: [], contains: ['owner', 'responsible', 'sorumlu', 'assignee', 'in charge', 'pilot', 'atanan'] },
  { field: 'customer',     exact: [], contains: ['customer', 'musteri', 'client', 'oem', 'account'] },
  { field: 'region',       exact: ['region', 'bolge'], contains: ['region', 'bolge', 'zone'] },
  { field: 'plant',        exact: [], contains: ['plant', 'site', 'location', 'lokasyon', 'fabrika'] },
  { field: 'comment',      exact: ['comment', 'comments', 'yorum'], contains: ['comment', 'yorum', 'remark', 'notlar', 'aciklama'] }
];

/** Yorum olarak yorumlanacak başlıklar (birden fazla olabilir). */
const COMMENT_HEADER_PATTERNS = ['comment', 'yorum', 'remark', 'notlar', 'aciklama', 'feedback', 'note'];

/* ==========================================================================
 *  WEB APP GİRİŞİ
 * ========================================================================== */

function doGet() {
  // Modül 2 — oturum kaydı. Log yazılamazsa panel yine de açılmalıdır.
  let session = { sessionId: '', email: '' };
  try { session = createSession(); } catch (e) { Logger.log('Oturum kaydi basarisiz: ' + e); }

  const template = HtmlService.createTemplateFromFile('Index');
  template.sessionId  = session.sessionId;
  template.userEmail  = session.email;
  template.timeoutMin = TIMEOUT_MIN;

  return template.evaluate()
      .setTitle('IS Validation Dashboard')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ==========================================================================
 *  ANA VERİ SERVİSİ
 * ========================================================================== */

/**
 * Panelin tek veri giriş noktası.
 * @param {boolean} forceRefresh true ise cache atlanır ve sayfa yeniden okunur.
 * @return {Object} { ok:true, rows:[...], meta:{...} }  ya da  { ok:false, error:{...} }
 */
function getDashboardData(forceRefresh) {
  try {
    if (!forceRefresh) {
      const cached = readCache_();
      if (cached) {
        cached.meta.cached = true;
        return cached;
      }
    }

    const ss = SpreadsheetApp.openByUrl(CONFIG.SHEET_URL);
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
    if (!sheet) {
      return errorResult_(
        "'" + CONFIG.SHEET_NAME + "' sekmesi bulunamadi.",
        'Mevcut sekmeler: ' + ss.getSheets().map(function (s) { return s.getName(); }).join(', ')
      );
    }

    const values = sheet.getDataRange().getDisplayValues();
    if (values.length < 2) {
      return errorResult_('Sayfada veri satiri yok.', CONFIG.SHEET_NAME + ' sekmesi bos veya sadece baslik satiri iceriyor.');
    }

    const headers = values[0].map(function (h) { return String(h || '').trim(); });
    const columnMap = detectColumns_(headers);
    const projectHeader = columnMap.project;

    const rows = [];
    for (let i = 1; i < values.length; i++) {
      const raw = values[i];
      const obj = {};
      let hasContent = false;
      for (let c = 0; c < headers.length; c++) {
        if (!headers[c]) continue;
        const cell = String(raw[c] == null ? '' : raw[c]).trim();
        obj[headers[c]] = cell;
        if (cell !== '') hasContent = true;
      }
      if (!hasContent) continue;
      if (projectHeader && !obj[projectHeader]) continue;   // eski davranışın korunması
      obj.__row = i + 1;                                     // Sheet'teki gerçek satır no
      rows.push(obj);
    }

    const tz = Session.getScriptTimeZone() || 'Europe/Istanbul';
    const now = new Date();

    const payload = {
      ok: true,
      rows: rows,
      meta: {
        headers: headers.filter(String),
        columnMap: columnMap,
        commentHeaders: detectCommentHeaders_(headers),
        detectedFields: Object.keys(columnMap).filter(function (k) { return !!columnMap[k]; }),
        totalRows: rows.length,
        sheetName: CONFIG.SHEET_NAME,
        sheetUrl: CONFIG.SHEET_URL,
        generatedAt: Utilities.formatDate(now, tz, "dd.MM.yyyy HH:mm"),
        generatedAtIso: now.toISOString(),
        timeZone: tz,
        cached: false,
        config: {
          targetCompletionRate: CONFIG.TARGET_COMPLETION_RATE,
          maxCancellationRate: CONFIG.MAX_CANCELLATION_RATE,
          staleWarningDays: CONFIG.STALE_WARNING_DAYS,
          shipmentCriticalDays: CONFIG.SHIPMENT_CRITICAL_DAYS
        }
      }
    };

    writeCache_(payload);
    return payload;

  } catch (e) {
    return errorResult_('Veri okunurken beklenmeyen bir hata olustu.', String(e && e.message ? e.message : e));
  }
}

function errorResult_(message, detail) {
  return { ok: false, error: { message: message, detail: detail || '' } };
}

/* ==========================================================================
 *  KOLON ALGILAMA
 * ========================================================================== */

function normalizeHeader_(h) {
  const map = { 'İ': 'I', 'I': 'I', 'ı': 'i', 'Ş': 'S', 'ş': 's', 'Ğ': 'G', 'ğ': 'g',
                'Ü': 'U', 'ü': 'u', 'Ö': 'O', 'ö': 'o', 'Ç': 'C', 'ç': 'c' };
  return String(h || '')
      .replace(/[İIışŞĞğÜüÖöÇç]/g, function (c) { return map[c] || c; })
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
}

/**
 * Başlıkları kanonik alan adlarına eşler. Bir başlık yalnızca bir alana atanır.
 * @return {Object} { field: "Orijinal Baslik" | null }
 */
function detectColumns_(headers) {
  const normalized = headers.map(normalizeHeader_);
  const claimed = {};
  const map = {};

  COLUMN_PATTERNS.forEach(function (def) {
    let found = -1;

    for (let e = 0; e < def.exact.length && found === -1; e++) {
      for (let i = 0; i < normalized.length; i++) {
        if (!claimed[i] && normalized[i] && normalized[i] === def.exact[e]) { found = i; break; }
      }
    }
    for (let c = 0; c < def.contains.length && found === -1; c++) {
      for (let i = 0; i < normalized.length; i++) {
        if (!claimed[i] && normalized[i] && normalized[i].indexOf(def.contains[c]) !== -1) { found = i; break; }
      }
    }

    if (found !== -1) { claimed[found] = true; map[def.field] = headers[found]; }
    else { map[def.field] = null; }
  });

  return map;
}

/**
 * Yorum içeren tüm başlıkları döndürür (Comment, Comments, Yorum, Remark ...).
 * columnMap tek başlık tutar; panel detay kartı hepsini göstermek için bunu kullanır.
 */
function detectCommentHeaders_(headers) {
  return headers.filter(function (h) {
    if (!h) return false;
    const n = normalizeHeader_(h);
    return COMMENT_HEADER_PATTERNS.some(function (p) { return n.indexOf(p) !== -1; });
  });
}

/* ==========================================================================
 *  CACHE (chunk'lı — CacheService anahtar başına ~100KB sınırı için)
 * ========================================================================== */

function readCache_() {
  try {
    const cache = CacheService.getScriptCache();
    const head = cache.get(CONFIG.CACHE_PREFIX + '_head');
    if (!head) return null;

    const count = parseInt(head, 10);
    if (isNaN(count) || count < 1) return null;

    const keys = [];
    for (let i = 0; i < count; i++) keys.push(CONFIG.CACHE_PREFIX + '_' + i);

    const parts = cache.getAll(keys);
    let json = '';
    for (let i = 0; i < count; i++) {
      const piece = parts[CONFIG.CACHE_PREFIX + '_' + i];
      if (piece == null) return null;            // Parçalardan biri düşmüş → cache geçersiz
      json += piece;
    }
    return JSON.parse(json);
  } catch (e) {
    return null;                                  // Cache hatası hiçbir zaman paneli düşürmemeli
  }
}

function writeCache_(payload) {
  try {
    const json = JSON.stringify(payload);
    const size = CONFIG.CACHE_CHUNK_SIZE;
    const count = Math.ceil(json.length / size);
    if (count > CONFIG.CACHE_MAX_CHUNKS) return;  // Çok büyük → cache'lemeyi atla

    const bundle = {};
    for (let i = 0; i < count; i++) {
      bundle[CONFIG.CACHE_PREFIX + '_' + i] = json.substr(i * size, size);
    }
    bundle[CONFIG.CACHE_PREFIX + '_head'] = String(count);

    CacheService.getScriptCache().putAll(bundle, CONFIG.CACHE_TTL_SECONDS);
  } catch (e) {
    // Cache yazılamazsa sessizce devam
  }
}

/** Menüden veya editörden manuel cache temizleme. */
function clearCache() {
  const cache = CacheService.getScriptCache();
  const keys = [CONFIG.CACHE_PREFIX + '_head'];
  for (let i = 0; i < CONFIG.CACHE_MAX_CHUNKS; i++) keys.push(CONFIG.CACHE_PREFIX + '_' + i);
  cache.removeAll(keys);
  return 'Cache temizlendi.';
}

/* ==========================================================================
 *  ORTAK YARDIMCILAR (durum sınıflama + tarih ayrıştırma)
 *  Not: Aynı mantık istemci tarafında da bulunur; e-posta raporu sunucuda
 *  üretildiği için burada da gereklidir.
 * ========================================================================== */

function cell_(row, header) {
  if (!header) return '';
  const v = row[header];
  return v == null ? '' : String(v).trim();
}

function classifyStatus_(value) {
  const s = String(value || '').toUpperCase();
  if (s.indexOf('CANCEL') !== -1 || s.indexOf('IPTAL') !== -1 || s.indexOf('İPTAL') !== -1) return 'CANCEL';
  if (s.indexOf('DONE') !== -1 || s.indexOf('COMPLET') !== -1 || s.indexOf('TAMAM') !== -1) return 'DONE';
  return 'PENDING';
}

function startOfDay_(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Esnek tarih ayrıştırma: dd.MM.yyyy, dd/MM/yyyy, yyyy-MM-dd, MM/yyyy,
 * "CW32", "W32-2026", "Aug-26", "Ağustos 2026" gibi yaygın formatlar.
 * @return {Date|null}
 */
function parseFlexibleDate_(input) {
  const str = String(input || '').trim();
  if (!str) return null;
  if (/^(TBD|N\/A|NA|-|\?)$/i.test(str)) return null;

  let m;

  // yyyy-MM-dd
  m = str.match(/^(\d{4})[-.\/](\d{1,2})[-.\/](\d{1,2})$/);
  if (m) return safeDate_(+m[1], +m[2] - 1, +m[3]);

  // dd.MM.yyyy | dd/MM/yyyy
  m = str.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})$/);
  if (m) {
    const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    return safeDate_(y, +m[2] - 1, +m[1]);
  }

  // MM/yyyy | MM.yyyy  → ilgili ayın son günü
  m = str.match(/^(\d{1,2})[.\/](\d{4})$/);
  if (m) return safeDate_(+m[2], +m[1], 0);

  // CW32 | W32 | CW32-2026
  m = str.match(/^(?:C?W)\s*(\d{1,2})(?:[-.\/ ](\d{4}))?$/i);
  if (m) {
    const year = m[2] ? +m[2] : new Date().getFullYear();
    const d = new Date(year, 0, 1 + (parseInt(m[1], 10) - 1) * 7);
    return startOfDay_(d);
  }

  // Ay adı: "Aug-26", "Agustos 2026", "Oct 2026", "Kasim"
  m = normalizeHeader_(str).match(/^([a-z]+)\s*(\d{2,4})?$/);
  if (m) {
    const mi = monthIndex_(m[1]);
    if (mi !== -1) {
      const y = !m[2] ? new Date().getFullYear() : (+m[2] < 100 ? 2000 + +m[2] : +m[2]);
      return safeDate_(y, mi + 1, 0);              // Ayın son günü
    }
  }

  return null;
}

/** Ay adını (TR/EN, tam veya kısaltma) 0-11 aralığına çevirir; bulunamazsa -1. */
function monthIndex_(word) {
  const months = { jan:0,ocak:0,feb:1,subat:1,mar:2,mart:2,apr:3,nisan:3,may:4,mayis:4,jun:5,haziran:5,
                   jul:6,temmuz:6,aug:7,agustos:7,sep:8,eylul:8,oct:9,ekim:9,nov:10,kasim:10,dec:11,aralik:11 };
  if (months[word] !== undefined) return months[word];
  const short = word.substring(0, 3);
  return months[short] !== undefined ? months[short] : -1;
}

function safeDate_(y, m, d) {
  const dt = new Date(y, m, d);
  return isNaN(dt.getTime()) ? null : dt;
}

/* ==========================================================================
 *  HAFTALIK YÖNETİCİ RAPORU
 * ========================================================================== */

/**
 * Panelin özet metriklerini sunucu tarafında hesaplar (e-posta raporu için).
 */
function computeSummary_(payload) {
  const col = payload.meta.columnMap;
  const today = startOfDay_(new Date());
  const summary = { total: payload.rows.length, done: 0, pending: 0, cancel: 0,
                    overdue: 0, critical: 0, stale: 0, risks: [] };

  payload.rows.forEach(function (row) {
    const state = classifyStatus_(cell_(row, col.status));
    if (state === 'DONE') { summary.done++; return; }
    if (state === 'CANCEL') { summary.cancel++; return; }
    summary.pending++;

    const due = parseFlexibleDate_(cell_(row, col.targetDate)) ||
                parseFlexibleDate_(cell_(row, col.firstShipment));
    const daysLeft = due ? Math.ceil((due - today) / 86400000) : null;

    const year = parseInt(cell_(row, col.year), 10);
    const start = parseFlexibleDate_(cell_(row, col.createdDate)) ||
                  (isNaN(year) ? null : new Date(year, 0, 1));
    const age = start ? Math.floor((today - start) / 86400000) : null;

    const overdue = (daysLeft !== null && daysLeft < 0) ||
                    (daysLeft === null && !isNaN(year) && year < today.getFullYear());
    const critical = !overdue && daysLeft !== null && daysLeft <= CONFIG.SHIPMENT_CRITICAL_DAYS;
    const stale = age !== null && age >= CONFIG.STALE_WARNING_DAYS;

    if (overdue) summary.overdue++;
    if (critical) summary.critical++;
    if (stale) summary.stale++;

    if (overdue || critical || stale) {
      summary.risks.push({
        ref: cell_(row, col.ref) || '-',
        project: cell_(row, col.project) || '-',
        owner: cell_(row, col.owner) || '-',
        isStatus: cell_(row, col.isStatus) || '-',
        daysLeft: daysLeft,
        age: age,
        kind: overdue ? 'GECIKTI' : (critical ? 'KRITIK' : 'TIKANDI')
      });
    }
  });

  summary.completionRate = summary.total ? Math.round((summary.done / summary.total) * 100) : 0;
  summary.cancellationRate = summary.total ? Math.round((summary.cancel / summary.total) * 100) : 0;

  summary.risks.sort(function (a, b) {
    const av = a.daysLeft === null ? 9999 : a.daysLeft;
    const bv = b.daysLeft === null ? 9999 : b.daysLeft;
    if (av !== bv) return av - bv;
    return (b.age || 0) - (a.age || 0);
  });
  summary.risks = summary.risks.slice(0, CONFIG.REPORT_RISK_LIMIT);

  return summary;
}

/**
 * Haftalık özet e-postasını gönderir. Zamanlanmış tetikleyici bu fonksiyonu çağırır.
 */
function sendWeeklyReport() {
  const recipients = CONFIG.REPORT_RECIPIENTS.filter(String);
  if (!recipients.length) {
    Logger.log('REPORT_RECIPIENTS bos — rapor gonderilmedi.');
    return;
  }

  const payload = getDashboardData(true);
  if (!payload.ok) {
    MailApp.sendEmail(recipients.join(','), CONFIG.REPORT_SUBJECT + ' — HATA',
        payload.error.message + '\n\n' + payload.error.detail);
    return;
  }

  const summary = computeSummary_(payload);
  MailApp.sendEmail({
    to: recipients.join(','),
    subject: CONFIG.REPORT_SUBJECT + ' — ' + payload.meta.generatedAt,
    htmlBody: buildReportHtml_(summary, payload.meta)
  });
}

function buildReportHtml_(s, meta) {
  let dashboardUrl = '';
  try { dashboardUrl = ScriptApp.getService().getUrl() || ''; } catch (e) { dashboardUrl = ''; }

  const kpi = function (label, value, color) {
    return '<td style="padding:14px 10px;text-align:center;border:1px solid #e3e8ee;">' +
           '<div style="font-size:11px;color:#6c757d;letter-spacing:.5px;">' + label + '</div>' +
           '<div style="font-size:26px;font-weight:800;color:' + color + ';">' + value + '</div></td>';
  };

  let html = '<div style="font-family:Segoe UI,Arial,sans-serif;color:#222;max-width:760px;">';
  html += '<h2 style="color:#002b49;margin-bottom:2px;">IS Validation — Haftalik Yonetici Ozeti</h2>';
  html += '<div style="color:#6c757d;font-size:12px;margin-bottom:16px;">' +
          meta.sheetName + ' &middot; ' + meta.generatedAt + '</div>';

  html += '<table style="border-collapse:collapse;width:100%;"><tr>';
  html += kpi('TOPLAM', s.total, '#002b49');
  html += kpi('TAMAMLANAN', s.done, '#78c800');
  html += kpi('BEKLEYEN', s.pending, '#ffc107');
  html += kpi('GECIKEN', s.overdue, '#dc3545');
  html += kpi('IPTAL', s.cancel, '#6c757d');
  html += '</tr></table>';

  const rateColor = s.completionRate >= CONFIG.TARGET_COMPLETION_RATE ? '#78c800'
                  : (s.completionRate >= CONFIG.TARGET_COMPLETION_RATE - 20 ? '#ffc107' : '#dc3545');
  html += '<p style="margin:18px 0 6px;font-size:14px;">Tamamlama orani: ' +
          '<b style="color:' + rateColor + ';">%' + s.completionRate + '</b> ' +
          '<span style="color:#6c757d;">(hedef %' + CONFIG.TARGET_COMPLETION_RATE + ')</span> &nbsp;|&nbsp; ' +
          'Iptal orani: <b>%' + s.cancellationRate + '</b></p>';
  html += '<p style="margin:0 0 18px;font-size:14px;">Sevkiyata ' + CONFIG.SHIPMENT_CRITICAL_DAYS +
          ' gunden az kalan: <b>' + s.critical + '</b> &nbsp;|&nbsp; ' +
          CONFIG.STALE_WARNING_DAYS + '+ gundur bekleyen: <b>' + s.stale + '</b></p>';

  html += '<h3 style="color:#002b49;font-size:15px;margin-bottom:6px;">Aksiyon Gereken Ilk ' +
          CONFIG.REPORT_RISK_LIMIT + ' Proje</h3>';

  if (!s.risks.length) {
    html += '<p style="color:#78c800;font-weight:bold;">Aksiyon gerektiren proje yok.</p>';
  } else {
    html += '<table style="border-collapse:collapse;width:100%;font-size:12px;">' +
            '<tr style="background:#002b49;color:#fff;">' +
            '<th style="padding:7px;text-align:left;">Durum</th>' +
            '<th style="padding:7px;text-align:left;">Ref</th>' +
            '<th style="padding:7px;text-align:left;">Proje</th>' +
            '<th style="padding:7px;text-align:left;">Sorumlu</th>' +
            '<th style="padding:7px;text-align:left;">Bekleyen Adim</th>' +
            '<th style="padding:7px;text-align:right;">Gun</th></tr>';

    s.risks.forEach(function (r, i) {
      const bg = i % 2 ? '#f7f9fb' : '#ffffff';
      const tone = r.kind === 'GECIKTI' ? '#dc3545' : (r.kind === 'KRITIK' ? '#fd7e14' : '#6f42c1');
      const dayTxt = r.daysLeft === null ? (r.age !== null ? r.age + ' gundur bekliyor' : '-')
                   : (r.daysLeft < 0 ? Math.abs(r.daysLeft) + ' gun gecikti' : r.daysLeft + ' gun kaldi');
      html += '<tr style="background:' + bg + ';">' +
              '<td style="padding:6px;border-bottom:1px solid #e3e8ee;color:' + tone + ';font-weight:bold;">' + r.kind + '</td>' +
              '<td style="padding:6px;border-bottom:1px solid #e3e8ee;">' + r.ref + '</td>' +
              '<td style="padding:6px;border-bottom:1px solid #e3e8ee;">' + r.project + '</td>' +
              '<td style="padding:6px;border-bottom:1px solid #e3e8ee;">' + r.owner + '</td>' +
              '<td style="padding:6px;border-bottom:1px solid #e3e8ee;">' + r.isStatus + '</td>' +
              '<td style="padding:6px;border-bottom:1px solid #e3e8ee;text-align:right;">' + dayTxt + '</td></tr>';
    });
    html += '</table>';
  }

  if (dashboardUrl) {
    html += '<p style="margin-top:22px;"><a href="' + dashboardUrl +
            '" style="background:#78c800;color:#fff;padding:10px 18px;border-radius:6px;' +
            'text-decoration:none;font-weight:bold;">Panele Git</a></p>';
  }
  html += '<p style="color:#9aa5b1;font-size:11px;margin-top:20px;">Bu e-posta IS Validation Dashboard tarafindan otomatik uretilmistir.</p>';
  html += '</div>';
  return html;
}

/** Her Pazartesi 08:00'de haftalık raporu kuran yardımcı. Bir kez elle çalıştırılır. */
function installWeeklyTrigger() {
  removeWeeklyTrigger();
  ScriptApp.newTrigger('sendWeeklyReport')
      .timeBased()
      .onWeekDay(ScriptApp.WeekDay.MONDAY)
      .atHour(8)
      .create();
  return 'Haftalik rapor tetikleyicisi kuruldu (Pazartesi 08:00).';
}

function removeWeeklyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendWeeklyReport') ScriptApp.deleteTrigger(t);
  });
  return 'Mevcut haftalik rapor tetikleyicileri kaldirildi.';
}

/** Kurulum kontrolü: kolon algılamanın doğru çalıştığını Logs'ta gösterir. */
function debugColumnDetection() {
  const payload = getDashboardData(true);
  if (!payload.ok) { Logger.log('HATA: ' + payload.error.message + ' — ' + payload.error.detail); return; }
  Logger.log('Bulunan basliklar: ' + payload.meta.headers.join(' | '));
  Logger.log('Kolon eslesmesi: ' + JSON.stringify(payload.meta.columnMap, null, 2));
  Logger.log('Okunan satir: ' + payload.meta.totalRows);
}

/* ==========================================================================
 *  MODÜL 1 — FEEDBACK WIDGET   (SETUP_CLAUDE.md standardı)
 *  Geri bildirimler FB_SHEET_ID dosyasında, appName adlı sekmede toplanır.
 *  Panel FB_APP_NAME = 'Feedback' gönderdiği için sekme adı "Feedback" olur.
 * ========================================================================== */

function submitFeedback(payload) {
  var ss      = SpreadsheetApp.openById(FB_SHEET_ID);
  var tabName = (payload && payload.appName) || 'Genel';
  var sheet   = ss.getSheetByName(tabName);

  if (!sheet) {
    sheet = ss.insertSheet(tabName);
    sheet.getRange(1, 1, 1, 9).setValues([[
      'FeedbackID', 'Email', 'Feedback_Type', 'Priority', 'Message',
      'CreatedAt', 'Comments', 'Status', 'Standardization Y/N'
    ]]).setBackground('#4A6CF7').setFontColor('#FFFFFF').setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 110); sheet.setColumnWidth(2, 200);
    sheet.setColumnWidth(3, 120); sheet.setColumnWidth(4, 90);
    sheet.setColumnWidth(5, 320); sheet.setColumnWidth(6, 160);
    sheet.setColumnWidth(7, 200);
  }

  var id    = Utilities.getUuid().substring(0, 8).toUpperCase();
  var now   = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  var email = Session.getActiveUser().getEmail() || 'Anonim';

  sheet.appendRow([id, email,
    (payload && payload.feedbackType) || '', (payload && payload.priority) || '',
    (payload && payload.message) || '', now, '', 'Open', '']);

  return { success: true, id: id };
}

/* ==========================================================================
 *  MODÜL 2 — GİRİŞ / ÇIKIŞ LOGLAMA   (SETUP_CLAUDE.md standardı)
 *  doGet() zaten mevcut olduğu için standardın öngördüğü gibi yalnızca
 *  createSession / logExit / _getOrCreateLogSheet eklendi ve session satırları
 *  mevcut doGet() içine entegre edildi.
 * ========================================================================== */

function createSession() {
  var sheet     = _getOrCreateLogSheet();
  var sessionId = Utilities.getUuid();
  var email     = Session.getActiveUser().getEmail() || 'Anonim';
  sheet.appendRow([sessionId, email, new Date(), '', '', 'Açık']);
  return { sessionId: sessionId, email: email };
}

function logExit(sessionId, exitTimestamp, durationSec) {
  if (!sessionId) return;
  var sheet = _getOrCreateLogSheet();
  var data  = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (data[i][0] === sessionId && data[i][5] === 'Açık') {
      sheet.getRange(i + 1, 4).setValue(new Date(exitTimestamp));
      sheet.getRange(i + 1, 5).setValue(Math.round(durationSec / 60 * 10) / 10);
      sheet.getRange(i + 1, 6).setValue('Tamamlandı');
      break;
    }
  }
}

function _getOrCreateLogSheet() {
  var ss    = SpreadsheetApp.openById(FB_SHEET_ID);
  var sheet = ss.getSheetByName(LOG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET);
    sheet.appendRow(['Oturum ID', 'E-posta', 'Giriş Zamanı', 'Çıkış Zamanı', 'Süre (dk)', 'Durum']);
    sheet.getRange(1, 1, 1, 6).setFontWeight('bold');
  }
  return sheet;
}

/* ==========================================================================
 *  MODÜL 3 — VERSİYON YÖNETİMİ   (SETUP_CLAUDE.md standardı)
 * ========================================================================== */

/** Panel açılışta bu fonksiyonu çağırır (beta banner + versiyon rozeti). */
function getAppVersion() {
  var props = PropertiesService.getScriptProperties();
  return {
    version:   props.getProperty('APP_VERSION')    || '1.0',
    buildDate: props.getProperty('APP_BUILD_DATE') || '',
    isBeta:    props.getProperty('APP_IS_BETA')    !== 'false'
  };
}

/** Versiyon numarasını artırır — kurulumTrigger / majorDeploy üzerinden çağrılır. */
function bumpVersion(type) {
  var props   = PropertiesService.getScriptProperties();
  var current = props.getProperty('APP_VERSION') || '1.0';
  var parts   = current.split('.').map(Number);
  if (type === 'major') { parts[0]++; parts[1] = 0; }
  else                  { parts[1]++; }
  var next      = parts[0] + '.' + parts[1];
  var buildDate = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  props.setProperty('APP_VERSION',    next);
  props.setProperty('APP_BUILD_DATE', buildDate);
  Logger.log('Versiyon: ' + next + ' (' + buildDate + ')');
  return { version: next, buildDate: buildDate };
}

/** Beta modunu açar/kapatır. Yayına geçerken setBeta(false) çalıştırılır. */
function setBeta(flag) {
  PropertiesService.getScriptProperties().setProperty('APP_IS_BETA', flag ? 'true' : 'false');
  Logger.log('Beta modu: ' + (flag ? 'AÇIK' : 'KAPALI'));
}

/** kurulumTrigger ve majorDeploy'un ortak gövdesi: versiyon artışı + tetikleyiciler. */
function _kurulumYap(bumpType) {
  var info = bumpVersion(bumpType);
  installWeeklyTrigger();
  installSyncTrigger();
  clearCache();
  Logger.log('Kurulum tamamlandi. Surum ' + info.version + ' — tetikleyiciler yeniden kuruldu.');
  return info;
}

/** Küçük değişiklik deploy'u → 1.0 → 1.1 */
function kurulumTrigger() { return _kurulumYap('minor'); }

/** Büyük değişiklik deploy'u → 1.1 → 2.0 */
function majorDeploy() { return _kurulumYap('major'); }

/* ==========================================================================
 *  MODÜL 4 — KAYNAK DOSYADAN OTOMATİK SATIR AKTARIMI
 *  Kaynak sayfaya eklenen yeni kayıtlar, başlık adlarına göre eşleştirilerek
 *  hedef takip sayfasına eklenir. Mevcut satırlar ASLA değiştirilmez.
 * ========================================================================== */

/** GID veya ada göre sekmeyi bulur. */
function resolveSheet_(ss, name, gid) {
  if (name) {
    const byName = ss.getSheetByName(name);
    if (byName) return byName;
  }
  if (gid !== null && gid !== undefined) {
    const sheets = ss.getSheets();
    for (let i = 0; i < sheets.length; i++) {
      if (sheets[i].getSheetId() === Number(gid)) return sheets[i];
    }
  }
  return null;
}

/**
 * Kaynak sayfada başlık satırını bulur. Rapor dosyalarında ilk satırlar çoğu zaman
 * boş ya da başlık bloğudur; bu yüzden hedef başlıklarıyla en çok örtüşen satır seçilir.
 * @return {Object} { row, score, filled }  row 1-tabanlıdır.
 */
function detectSourceHeaderRow_(values, targetHeaders) {
  const targetNorm = targetHeaders.map(normalizeHeader_).filter(String);
  const limit = Math.min(values.length, SYNC.SOURCE_HEADER_SCAN_ROWS || 25);
  let best = { row: 1, score: -1, filled: 0 };

  for (let i = 0; i < limit; i++) {
    const cells = values[i].map(normalizeHeader_);
    const filled = cells.filter(String).length;
    let score = 0;

    cells.forEach(function (c) {
      if (!c) return;
      if (targetNorm.indexOf(c) !== -1) { score += 3; return; }         // birebir başlık
      const partial = targetNorm.some(function (tn) {
        return tn.length >= 4 && (tn.indexOf(c) !== -1 || c.indexOf(tn) !== -1);
      });
      if (partial) score += 1;
    });

    if (score > best.score || (score === best.score && filled > best.filled)) {
      best = { row: i + 1, score: score, filled: filled };
    }
  }
  return best;
}

/** Kullanılacak kaynak başlık satırını çözer (elle ayar > otomatik tespit). */
function resolveSourceHeaderRow_(values, targetHeaders) {
  if (SYNC.SOURCE_HEADER_ROW && SYNC.SOURCE_HEADER_ROW > 0) {
    return { row: SYNC.SOURCE_HEADER_ROW, score: null, filled: null, manual: true };
  }
  return detectSourceHeaderRow_(values, targetHeaders);
}

/**
 * Hedef başlıkları ile kaynak başlıklarını eşleştirir.
 * Öncelik: elle MAP → birebir eşleşme → içerme eşleşmesi.
 */
function buildSyncMapping_(targetHeaders, sourceHeaders) {
  const srcNorm = sourceHeaders.map(normalizeHeader_);
  const excluded = SYNC.EXCLUDE_TARGET_HEADERS.map(normalizeHeader_);
  const used = {};
  const mapping = [];

  targetHeaders.forEach(function (th, ti) {
    if (!th) return;
    const tn = normalizeHeader_(th);
    if (excluded.indexOf(tn) !== -1) return;

    let si = -1;

    if (SYNC.MAP[th]) {
      si = sourceHeaders.indexOf(SYNC.MAP[th]);
      if (si === -1) si = srcNorm.indexOf(normalizeHeader_(SYNC.MAP[th]));
    }
    if (si === -1) {
      for (let i = 0; i < srcNorm.length; i++) {
        if (!used[i] && srcNorm[i] && srcNorm[i] === tn) { si = i; break; }
      }
    }
    if (si === -1 && tn.length >= 4) {
      for (let i = 0; i < srcNorm.length; i++) {
        if (used[i] || !srcNorm[i]) continue;
        if (srcNorm[i].indexOf(tn) !== -1 || tn.indexOf(srcNorm[i]) !== -1) { si = i; break; }
      }
    }

    if (si !== -1) {
      used[si] = true;
      mapping.push({ targetIndex: ti, sourceIndex: si, targetHeader: th, sourceHeader: sourceHeaders[si] });
    }
  });

  return mapping;
}

/**
 * Kaynaktaki yeni satırları hedefe ekler.
 * @param {boolean} silent true ise hata fırlatmaz (tetikleyici kullanımı için).
 * @return {Object} { ok, added, skipped, mapping, message }
 */
function syncNewRows(silent) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return { ok: false, added: 0, message: 'Baska bir senkronizasyon devam ediyor.' };
  }

  try {
    const sourceSs = SpreadsheetApp.openById(SYNC.SOURCE_ID);
    const sourceSheet = resolveSheet_(sourceSs, SYNC.SOURCE_SHEET_NAME, SYNC.SOURCE_GID);
    if (!sourceSheet) throw new Error('Kaynak sekme bulunamadi (GID: ' + SYNC.SOURCE_GID + ').');

    const targetSs = SpreadsheetApp.openByUrl(CONFIG.SHEET_URL);
    const targetSheet = targetSs.getSheetByName(SYNC.TARGET_SHEET_NAME);
    if (!targetSheet) throw new Error('Hedef sekme bulunamadi: ' + SYNC.TARGET_SHEET_NAME);

    const sourceValues = sourceSheet.getDataRange().getDisplayValues();
    const targetValues = targetSheet.getDataRange().getDisplayValues();
    if (!sourceValues.length || !targetValues.length) {
      return finishSync_({ ok: true, added: 0, skipped: 0, mapping: [], message: 'Kaynakta veri satiri yok.' });
    }

    const targetHeaders = targetValues[SYNC.TARGET_HEADER_ROW - 1].map(function (h) { return String(h || '').trim(); });
    const headerInfo = resolveSourceHeaderRow_(sourceValues, targetHeaders);
    const sourceHeaderRow = headerInfo.row;
    if (sourceValues.length <= sourceHeaderRow) {
      return finishSync_({ ok: true, added: 0, skipped: 0, mapping: [], message: 'Kaynakta veri satiri yok.' });
    }
    if (!headerInfo.manual) {
      Logger.log('Kaynak baslik satiri otomatik bulundu: ' + sourceHeaderRow +
                 ' (eslesme puani ' + headerInfo.score + ', ' + headerInfo.filled + ' dolu hucre)');
    }

    const sourceHeaders = sourceValues[sourceHeaderRow - 1].map(function (h) { return String(h || '').trim(); });
    const mapping = buildSyncMapping_(targetHeaders, sourceHeaders);
    if (!mapping.length) {
      throw new Error('Kaynak ve hedef arasinda eslesen kolon bulunamadi (kaynak baslik satiri: ' +
                      sourceHeaderRow + '). debugSourceRows() ile dogru satiri bulup ' +
                      'SYNC.SOURCE_HEADER_ROW degerine yazin veya SYNC.MAP ile elle eslestirin.');
    }

    // --- Anahtar kolonu çöz ---
    const keyTargetIndex = targetHeaders.map(normalizeHeader_).indexOf(normalizeHeader_(SYNC.KEY_TARGET_HEADER));
    let keySourceIndex = -1;
    if (SYNC.KEY_SOURCE_HEADER) {
      keySourceIndex = sourceHeaders.map(normalizeHeader_).indexOf(normalizeHeader_(SYNC.KEY_SOURCE_HEADER));
    } else if (keyTargetIndex !== -1) {
      const km = mapping.filter(function (m) { return m.targetIndex === keyTargetIndex; })[0];
      if (km) keySourceIndex = km.sourceIndex;
    }
    const useKey = keyTargetIndex !== -1 && keySourceIndex !== -1;

    // Anahtar beklenip bulunamadıysa sessizce satır numarasına düşmek yerine uyar:
    // bu modda kaynağa ARAYA eklenen satırlar atlanabilir.
    let warning = '';
    if (!useKey && SYNC.KEY_TARGET_HEADER) {
      warning = 'UYARI: "' + SYNC.KEY_TARGET_HEADER + '" anahtar kolonu ' +
                (keyTargetIndex === -1 ? 'hedefte' : 'kaynakta') +
                ' bulunamadi. Satir numarasi takibine gecildi — araya eklenen satirlar atlanabilir. ' +
                'debugSyncMapping() ile kontrol edin.';
      Logger.log(warning);
    }

    const props = PropertiesService.getScriptProperties();
    const watermark = parseInt(props.getProperty('SYNC_LAST_SOURCE_ROW') || '0', 10);

    // Hedefte hâlihazırda bulunan + baseline'da "bilinen" işaretli anahtarlar
    const existingKeys = {};
    let baselineCount = 0;
    if (useKey) {
      for (let i = SYNC.TARGET_HEADER_ROW; i < targetValues.length; i++) {
        const k = String(targetValues[i][keyTargetIndex] || '').trim().toUpperCase();
        if (k) existingKeys[k] = true;
      }
      const baseline = readBaselineKeys_(targetSs);
      Object.keys(baseline).forEach(function (k) { existingKeys[k] = true; baselineCount++; });
    }

    // Sabit değerlerin hedefteki kolon indeksleri (ör. IS Status → Not in Liberation)
    const targetNormHeaders = targetHeaders.map(normalizeHeader_);
    const defaults = [];
    Object.keys(SYNC.DEFAULTS || {}).forEach(function (header) {
      const ti = targetNormHeaders.indexOf(normalizeHeader_(header));
      if (ti !== -1) defaults.push({ index: ti, value: SYNC.DEFAULTS[header] });
      else Logger.log('UYARI: Sabit deger icin hedef kolon bulunamadi: ' + header);
    });

    // Yıl filtresi (0 = kapalı)
    const yearIndexTarget = targetNormHeaders.indexOf(normalizeHeader_('Year'));
    const yearMapping = mapping.filter(function (m) { return m.targetIndex === yearIndexTarget; })[0];

    // --- Yeni satırları topla ---
    const width = Math.max(targetHeaders.length, targetSheet.getLastColumn());
    const newRows = [];
    const addedKeys = [];
    let skipped = 0;
    let lastProcessedRow = watermark;

    for (let i = sourceHeaderRow; i < sourceValues.length; i++) {
      const rowNumber = i + 1;
      const srcRow = sourceValues[i];

      const hasContent = srcRow.some(function (c) { return String(c || '').trim() !== ''; });
      if (!hasContent) continue;

      // TOPLAM / TOTAL gibi özet satırlarını atla
      const firstCell = String(srcRow[0] || '').trim().toUpperCase();
      if (firstCell === 'TOTAL' || firstCell === 'TOPLAM' || firstCell === 'GENEL TOPLAM') continue;

      // Yıl filtresi
      if (SYNC.MIN_LAUNCH_YEAR && yearMapping) {
        const y = parseInt(String(srcRow[yearMapping.sourceIndex] || '').replace(/[^0-9]/g, ''), 10);
        if (!isNaN(y) && y < SYNC.MIN_LAUNCH_YEAR) continue;
      }

      if (useKey) {
        const key = String(srcRow[keySourceIndex] || '').trim();
        if (!isUsableKey_(key)) { skipped++; continue; }
        if (existingKeys[key.toUpperCase()]) { skipped++; continue; }
        existingKeys[key.toUpperCase()] = true;   // aynı çalıştırmada mükerrer engeli
        addedKeys.push(key);
      } else {
        if (rowNumber <= watermark) continue;      // anahtar yoksa satır numarası ile ilerle
        addedKeys.push('satir ' + rowNumber);
      }

      const out = new Array(width).fill('');
      mapping.forEach(function (m) {
        if (m.targetIndex < width) out[m.targetIndex] = srcRow[m.sourceIndex];
      });
      defaults.forEach(function (d) {
        if (d.index < width) out[d.index] = d.value;
      });
      newRows.push(out);
      lastProcessedRow = Math.max(lastProcessedRow, rowNumber);

      if (newRows.length >= SYNC.MAX_ROWS_PER_RUN) break;
    }

    if (useKey && !baselineCount && newRows.length > 20) {
      warning = 'UYARI: Baseline kurulmamis. Kaynaktaki ' + newRows.length +
                ' gecmis kayit hedefe eklenecek. Once markSyncBaseline() calistirin.';
      Logger.log(warning);
    }

    if (!newRows.length) {
      return finishSync_({ ok: true, added: 0, skipped: skipped, mapping: mapping, warning: warning,
                           message: 'Yeni kayit bulunamadi.' + (warning ? ' ' + warning : '') });
    }

    if (SYNC.DRY_RUN) {
      Logger.log('DRY_RUN — eklenecek kayitlar: ' + addedKeys.join(', '));
      return finishSync_({ ok: true, added: 0, skipped: skipped, mapping: mapping, dryRun: true,
                           warning: warning, keys: addedKeys,
                           message: 'PROVA: ' + newRows.length + ' satir eklenecekti (' +
                                    addedKeys.slice(0, 10).join(', ') + ').' + (warning ? ' ' + warning : '') });
    }

    targetSheet.getRange(targetSheet.getLastRow() + 1, 1, newRows.length, width).setValues(newRows);
    if (!useKey) props.setProperty('SYNC_LAST_SOURCE_ROW', String(lastProcessedRow));

    logSync_(targetSs, newRows.length, skipped, addedKeys, mapping, useKey, warning);
    clearCache();

    // Bildirim e-postası — gönderilemezse aktarım yine de başarılı sayılır.
    try {
      notifyNewRecords_(targetHeaders, newRows);
    } catch (mailError) {
      Logger.log('Bildirim e-postasi gonderilemedi: ' + mailError);
    }

    return finishSync_({ ok: true, added: newRows.length, skipped: skipped, mapping: mapping, warning: warning,
                         message: newRows.length + ' yeni kayit aktarildi.' + (warning ? ' ' + warning : '') });

  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    Logger.log('Senkronizasyon hatasi: ' + msg);
    try { logSync_(SpreadsheetApp.openByUrl(CONFIG.SHEET_URL), 0, 0, [], [], false, msg); } catch (e2) {}
    if (silent) return { ok: false, added: 0, message: msg };
    return { ok: false, added: 0, message: msg };
  } finally {
    lock.releaseLock();
  }
}

function finishSync_(result) {
  Logger.log(result.message);
  return result;
}

function logSync_(ss, added, skipped, keys, mapping, useKey, errorMessage) {
  let sheet = ss.getSheetByName(SYNC.LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SYNC.LOG_SHEET_NAME);
    sheet.appendRow(['Zaman', 'Eklenen', 'Atlanan', 'Yöntem', 'Eşleşen Kolon', 'Eklenen Anahtarlar', 'Hata / Uyarı']);
    sheet.getRange(1, 1, 1, 7).setFontWeight('bold').setBackground('#002b49').setFontColor('#FFFFFF');
    sheet.setFrozenRows(1);
  }
  sheet.appendRow([
    new Date(), added, skipped,
    useKey ? 'Anahtar: ' + SYNC.KEY_TARGET_HEADER : 'Satır numarası',
    (mapping || []).map(function (m) { return m.sourceHeader + ' → ' + m.targetHeader; }).join(' | '),
    (keys || []).slice(0, 30).join(', '),
    errorMessage || ''
  ]);
}

/* --------------------------- Baseline (başlangıç çizgisi) --------------------
 * Kaynak dosyadaki mevcut kayıtları "zaten bilinen" olarak işaretler.
 * Böylece ilk kurulumda geçmiş kayıtlar hedefe toplu hâlde kopyalanmaz.
 * ------------------------------------------------------------------------- */

function readBaselineKeys_(targetSs) {
  const sheet = targetSs.getSheetByName(SYNC.BASELINE_SHEET_NAME);
  const keys = {};
  if (!sheet || sheet.getLastRow() < 2) return keys;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getDisplayValues().forEach(function (row) {
    const k = String(row[0] || '').trim().toUpperCase();
    if (k) keys[k] = true;
  });
  return keys;
}

/** Anahtar değeri aktarım için geçerli mi? (boş / TBD / N-A değil) */
function isUsableKey_(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  return SYNC.IGNORED_KEY_VALUES.indexOf(v.toUpperCase()) === -1;
}

/**
 * KURULUM ADIMI — kaynak dosyadaki mevcut tüm kayıtları baseline'a yazar.
 * Bu andan sonra yalnızca YENİ eklenen satırlar hedefe aktarılır.
 * Hedef sayfaya hiçbir veri satırı eklemez.
 */
function markSyncBaseline() {
  const sourceSs = SpreadsheetApp.openById(SYNC.SOURCE_ID);
  const sourceSheet = resolveSheet_(sourceSs, SYNC.SOURCE_SHEET_NAME, SYNC.SOURCE_GID);
  if (!sourceSheet) { Logger.log('HATA: Kaynak sekme bulunamadi.'); return; }

  const targetSs = SpreadsheetApp.openByUrl(CONFIG.SHEET_URL);
  const targetSheet = targetSs.getSheetByName(SYNC.TARGET_SHEET_NAME);
  if (!targetSheet) { Logger.log('HATA: Hedef sekme bulunamadi.'); return; }

  const sourceValues = sourceSheet.getDataRange().getDisplayValues();
  const targetHeaders = targetSheet.getRange(SYNC.TARGET_HEADER_ROW, 1, 1, targetSheet.getLastColumn())
      .getDisplayValues()[0].map(function (h) { return String(h || '').trim(); });

  const headerInfo = resolveSourceHeaderRow_(sourceValues, targetHeaders);
  const sourceHeaders = sourceValues[headerInfo.row - 1].map(function (h) { return String(h || '').trim(); });
  const mapping = buildSyncMapping_(targetHeaders, sourceHeaders);

  const keyTargetIndex = targetHeaders.map(normalizeHeader_).indexOf(normalizeHeader_(SYNC.KEY_TARGET_HEADER));
  let keySourceIndex = -1;
  if (SYNC.KEY_SOURCE_HEADER) {
    keySourceIndex = sourceHeaders.map(normalizeHeader_).indexOf(normalizeHeader_(SYNC.KEY_SOURCE_HEADER));
  } else if (keyTargetIndex !== -1) {
    const km = mapping.filter(function (m) { return m.targetIndex === keyTargetIndex; })[0];
    if (km) keySourceIndex = km.sourceIndex;
  }
  if (keySourceIndex === -1) {
    Logger.log('HATA: Anahtar kolon kaynakta bulunamadi. Baseline olusturulamadi.');
    return;
  }

  const keys = [];
  const seen = {};
  for (let i = headerInfo.row; i < sourceValues.length; i++) {
    const key = String(sourceValues[i][keySourceIndex] || '').trim();
    if (!isUsableKey_(key)) continue;
    const upper = key.toUpperCase();
    if (seen[upper]) continue;
    seen[upper] = true;
    keys.push([key]);
  }

  let sheet = targetSs.getSheetByName(SYNC.BASELINE_SHEET_NAME);
  if (!sheet) sheet = targetSs.insertSheet(SYNC.BASELINE_SHEET_NAME);
  sheet.clear();
  sheet.getRange(1, 1, 1, 2).setValues([[SYNC.KEY_TARGET_HEADER, 'Baseline tarihi: ' +
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd.MM.yyyy HH:mm')]])
      .setFontWeight('bold').setBackground('#002b49').setFontColor('#FFFFFF');
  sheet.setFrozenRows(1);
  if (keys.length) sheet.getRange(2, 1, keys.length, 1).setValues(keys);

  Logger.log('Baseline olusturuldu: ' + keys.length + ' mevcut kayit "bilinen" olarak isaretlendi.');
  Logger.log('Bundan sonra yalnizca YENI eklenen satirlar hedefe aktarilacak.');
  return { ok: true, count: keys.length };
}

/** Panelin "Yeni Kayıtları Al" butonu bu fonksiyonu çağırır. */
function runSyncFromDashboard() {
  const r = syncNewRows(true);
  return { ok: r.ok, added: r.added || 0, message: r.message || '', warning: r.warning || '' };
}

/**
 * KURULUM YARDIMCISI — kaynak sayfanın ilk satırlarını Logs'a döker.
 * Başlıkların hangi satırda olduğunu gözle görmek için kullanılır.
 * @param {number} rowCount Kaç satır gösterilsin (varsayılan 15).
 */
function debugSourceRows(rowCount) {
  try {
    const ss = SpreadsheetApp.openById(SYNC.SOURCE_ID);
    const sheet = resolveSheet_(ss, SYNC.SOURCE_SHEET_NAME, SYNC.SOURCE_GID);
    if (!sheet) {
      Logger.log('HATA: Kaynak sekme bulunamadi. Mevcut sekmeler: ' +
          ss.getSheets().map(function (x) { return x.getName() + ' (gid ' + x.getSheetId() + ')'; }).join(', '));
      return;
    }

    const n = Math.min(rowCount || 15, sheet.getLastRow());
    const values = sheet.getRange(1, 1, n, sheet.getLastColumn()).getDisplayValues();

    Logger.log('KAYNAK: ' + sheet.getName() + ' — ' + sheet.getLastRow() + ' satir x ' +
               sheet.getLastColumn() + ' kolon. Ilk ' + n + ' satir:');
    values.forEach(function (row, i) {
      const filled = [];
      row.forEach(function (cell, j) {
        const value = String(cell || '').trim();
        if (value) filled.push(columnLetter_(j + 1) + ':' + value);
      });
      Logger.log('  Satir ' + (i + 1) + ' [' + filled.length + ' dolu] ' +
                 (filled.length ? filled.slice(0, 22).join('  |  ') : '(bos)'));
    });
    Logger.log('Basliklarin bulundugu satir numarasini SYNC.SOURCE_HEADER_ROW icine yazin ' +
               '(0 birakirsaniz otomatik bulunmaya calisilir).');
  } catch (e) {
    Logger.log('HATA: ' + e);
  }
}

/** 1 → A, 27 → AA gibi kolon harfi üretir (log okunurlugu icin). */
function columnLetter_(index) {
  let letter = '';
  let n = index;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

/**
 * TEŞHİS — belirli bir Bursa Ref neden aktarılmıyor?
 * Kaynakta, hedefte ve baseline'da arar; atlanma sebebini ve aktarılsaydı
 * hedefe yazılacak satırı raporlar. Hiçbir şey yazmaz.
 *
 * Kullanım: fonksiyonu duzenleyicide asagidaki gibi cagirin
 *   function bak() { debugKey('DENEME 123'); }
 * ya da ARANAN_REF sabitini degistirip debugKeyDefault() calistirin.
 */
function debugKey(key) {
  const wanted = String(key || '').trim().toUpperCase();
  if (!wanted) { Logger.log('HATA: Aranacak Bursa Ref bos.'); return; }

  Logger.log('=== TESHIS: "' + key + '" ===');

  const sourceSs = SpreadsheetApp.openById(SYNC.SOURCE_ID);
  const sourceSheet = resolveSheet_(sourceSs, SYNC.SOURCE_SHEET_NAME, SYNC.SOURCE_GID);
  const targetSs = SpreadsheetApp.openByUrl(CONFIG.SHEET_URL);
  const targetSheet = targetSs.getSheetByName(SYNC.TARGET_SHEET_NAME);
  if (!sourceSheet || !targetSheet) { Logger.log('HATA: Sekmeler acilamadi.'); return; }

  const sourceValues = sourceSheet.getDataRange().getDisplayValues();
  const targetValues = targetSheet.getDataRange().getDisplayValues();
  const targetHeaders = targetValues[SYNC.TARGET_HEADER_ROW - 1].map(function (h) { return String(h || '').trim(); });
  const headerInfo = resolveSourceHeaderRow_(sourceValues, targetHeaders);
  const sourceHeaders = sourceValues[headerInfo.row - 1].map(function (h) { return String(h || '').trim(); });
  const mapping = buildSyncMapping_(targetHeaders, sourceHeaders);

  const keyTargetIndex = targetHeaders.map(normalizeHeader_).indexOf(normalizeHeader_(SYNC.KEY_TARGET_HEADER));
  let keySourceIndex = -1;
  if (SYNC.KEY_SOURCE_HEADER) {
    keySourceIndex = sourceHeaders.map(normalizeHeader_).indexOf(normalizeHeader_(SYNC.KEY_SOURCE_HEADER));
  } else if (keyTargetIndex !== -1) {
    const km = mapping.filter(function (m) { return m.targetIndex === keyTargetIndex; })[0];
    if (km) keySourceIndex = km.sourceIndex;
  }
  if (keySourceIndex === -1) { Logger.log('HATA: Anahtar kolon kaynakta bulunamadi.'); return; }

  // --- Kaynakta ara ---
  let sourceRow = -1;
  for (let i = headerInfo.row; i < sourceValues.length; i++) {
    if (String(sourceValues[i][keySourceIndex] || '').trim().toUpperCase() === wanted) { sourceRow = i; break; }
  }
  Logger.log('1) KAYNAKTA : ' + (sourceRow === -1
      ? 'BULUNAMADI — kaynak sayfada bu Bursa Ref yok (yazim/bosluk farki olabilir).'
      : 'satir ' + (sourceRow + 1)));
  if (sourceRow === -1) return;

  // --- Hedefte ara ---
  let targetRow = -1;
  for (let i = SYNC.TARGET_HEADER_ROW; i < targetValues.length; i++) {
    if (String(targetValues[i][keyTargetIndex] || '').trim().toUpperCase() === wanted) { targetRow = i; break; }
  }
  Logger.log('2) HEDEFTE  : ' + (targetRow === -1 ? 'yok' : 'satir ' + (targetRow + 1) + ' — zaten aktarilmis'));

  // --- Baseline'da ara ---
  const baseline = readBaselineKeys_(targetSs);
  const inBaseline = !!baseline[wanted];
  Logger.log('3) BASELINE : ' + (inBaseline ? 'VAR — "bilinen" sayiliyor' : 'yok'));

  // --- Diğer filtreler ---
  const srcRow = sourceValues[sourceRow];
  const firstCell = String(srcRow[0] || '').trim().toUpperCase();
  const isTotal = (firstCell === 'TOTAL' || firstCell === 'TOPLAM' || firstCell === 'GENEL TOPLAM');
  Logger.log('4) OZET SATIRI MI : ' + (isTotal ? 'EVET — atlanir' : 'hayir'));
  Logger.log('5) ANAHTAR GECERLI MI : ' + (isUsableKey_(String(srcRow[keySourceIndex])) ? 'evet' : 'HAYIR (TBD/bos)'));

  // --- Sonuç ---
  Logger.log('');
  if (targetRow !== -1)      Logger.log('SONUC: Hedefte zaten var, tekrar eklenmez.');
  else if (inBaseline)       Logger.log('SONUC: BASELINE ENGELLIYOR. Bu kayit baseline alindiginda mevcuttu. ' +
                                        'Test icin Bursa Ref degerini degistirin (or. "' + key + ' 2") ya da ' +
                                        'Sync Baseline sekmesinden bu satiri silin.');
  else if (isTotal)          Logger.log('SONUC: Ozet satiri oldugu icin atlanir.');
  else if (!isUsableKey_(String(srcRow[keySourceIndex]))) Logger.log('SONUC: Anahtar gecersiz (TBD/bos).');
  else {
    Logger.log('SONUC: AKTARILABILIR. syncNewRows() calistirildiginda hedefe eklenecek satir:');
    const targetNorm = targetHeaders.map(normalizeHeader_);
    const out = new Array(targetHeaders.length).fill('');
    mapping.forEach(function (m) { out[m.targetIndex] = srcRow[m.sourceIndex]; });
    Object.keys(SYNC.DEFAULTS || {}).forEach(function (h) {
      const ti = targetNorm.indexOf(normalizeHeader_(h));
      if (ti !== -1) out[ti] = SYNC.DEFAULTS[h];
    });
    targetHeaders.forEach(function (h, i) {
      if (h) Logger.log('   ' + (h + '                                    ').substring(0, 36) + ' = ' + (out[i] === '' ? '(bos)' : out[i]));
    });
  }
}

/** debugKey icin hazir cagri — asagidaki degeri degistirip calistirin. */
function debugKeyDefault() {
  debugKey('DENEME 123');
}

/**
 * ============================================================================
 *  TEK TIKLIK KURULUM TESTİ — hiçbir şey yazmaz, sadece rapor eder.
 *  Fonksiyon seçicisinden bunu seçip Çalıştır demek yeterlidir.
 *  Sırasıyla: bağlantı → kolon algılama → sync eşleşmesi → prova aktarım.
 * ============================================================================
 */
function KURULUM_TESTI() {
  Logger.log('==================================================');
  Logger.log(' IS VALIDATION DASHBOARD — KURULUM TESTI');
  Logger.log('==================================================');

  // --- 1. Panel veri kaynağı ---
  Logger.log('');
  Logger.log('[1/4] PANEL VERI KAYNAGI');
  const payload = getDashboardData(true);
  if (!payload.ok) {
    Logger.log('  HATA: ' + payload.error.message + ' — ' + payload.error.detail);
    Logger.log('  Devam edilemiyor. CONFIG.SHEET_URL ve CONFIG.SHEET_NAME degerlerini kontrol edin.');
    return;
  }
  Logger.log('  OK — ' + payload.meta.totalRows + ' satir okundu (' + payload.meta.sheetName + ').');
  Logger.log('  Basliklar: ' + payload.meta.headers.join(' | '));

  // --- 2. Kolon algılama ---
  Logger.log('');
  Logger.log('[2/4] PANEL KOLON ESLESMESI');
  const map = payload.meta.columnMap;
  Object.keys(map).forEach(function (field) {
    Logger.log('  ' + (field + '                ').substring(0, 15) + ' : ' + (map[field] || '(bulunamadi)'));
  });
  Logger.log('  Yorum kolonlari: ' + ((payload.meta.commentHeaders || []).join(', ') || '(yok)'));

  // --- 3. Sync eşleşmesi ---
  Logger.log('');
  Logger.log('[3/4] SALES TURNOVER -> IS VALIDATION ESLESMESI');
  debugSyncMapping();

  // --- 3b. Baseline durumu ---
  Logger.log('');
  Logger.log('[3b] BASELINE DURUMU');
  try {
    const baseline = readBaselineKeys_(SpreadsheetApp.openByUrl(CONFIG.SHEET_URL));
    const count = Object.keys(baseline).length;
    if (count) {
      Logger.log('  OK — ' + count + ' kayit "bilinen" olarak isaretli. Sadece yeni satirlar aktarilacak.');
    } else {
      Logger.log('  KURULMAMIS! Once markSyncBaseline() calistirin.');
      Logger.log('  Aksi halde kaynaktaki tum gecmis kayitlar hedefe eklenir.');
    }
  } catch (e) {
    Logger.log('  Baseline okunamadi: ' + e);
  }

  // --- 4. Prova aktarım ---
  Logger.log('');
  Logger.log('[4/4] PROVA AKTARIM (yazma yapilmaz)');
  const dry = syncDryRun();
  Logger.log('  ' + (dry && dry.message ? dry.message : 'Sonuc alinamadi.'));

  // Eşleşme kurulamadıysa kaynak sayfanın yapısını da göster.
  if (dry && dry.ok === false) {
    Logger.log('');
    Logger.log('[EK] KAYNAK SAYFA YAPISI (baslik satirini bulmak icin)');
    debugSourceRows(15);
  }

  Logger.log('');
  Logger.log('==================================================');
  Logger.log(' TEST BITTI. Sonuc dogruysa sirasiyla calistirin:');
  Logger.log('   syncNewRows()        -> gercek aktarim');
  Logger.log('   installSyncTrigger() -> 15 dakikalik otomatik tetikleyici');
  Logger.log('==================================================');
}

/**
 * TEST YARDIMCISI — hiçbir şey yazmaz.
 * SYNC.DRY_RUN ayarına dokunmadan bir prova çalıştırır; kaç satırın ve hangi
 * Bursa Ref'lerin aktarılacağını Logs'a yazar.
 */
function syncDryRun() {
  const previous = SYNC.DRY_RUN;
  SYNC.DRY_RUN = true;
  try {
    const result = syncNewRows(true);
    if (result.skipped) Logger.log('Atlanan satir: ' + result.skipped +
        ' (hedefte zaten var veya Bursa Ref bos).');
    return result;
  } finally {
    SYNC.DRY_RUN = previous;
  }
}

/* ============================================================================
 *  YENİ KAYIT BİLDİRİMİ
 *  Aktarım yeni satır eklediğinde ilgili kişilere kart görünümlü e-posta gider.
 * ========================================================================== */

function notifyNewRecords_(targetHeaders, newRows) {
  if (!SYNC.NOTIFY_ENABLED) return;
  const recipients = (SYNC.NOTIFY_RECIPIENTS || []).filter(String);
  if (!recipients.length || !newRows.length) return;

  const tz = Session.getScriptTimeZone() || 'Europe/Istanbul';
  const now = new Date();
  const stamp = Utilities.formatDate(now, tz, 'dd.MM.yyyy');
  const clock = Utilities.formatDate(now, tz, 'HH:mm');

  const norm = targetHeaders.map(normalizeHeader_);
  const refIndex = norm.indexOf(normalizeHeader_(SYNC.KEY_TARGET_HEADER));
  const projectIndex = norm.indexOf(normalizeHeader_('Project Name'));

  // Kartlarda IS Status'a kadar olan alanlar gösterilir (aktarımın doldurdukları).
  let lastIndex = norm.indexOf(normalizeHeader_('IS Status'));
  if (lastIndex === -1) lastIndex = targetHeaders.length - 1;

  const subject = newRows.length === 1
      ? 'IS Validation — Yeni kayit: ' + String(newRows[0][refIndex] || '').trim()
      : 'IS Validation — ' + newRows.length + ' yeni kayit eklendi';

  MailApp.sendEmail({
    to: recipients.join(','),
    subject: subject,
    htmlBody: buildNewRecordsHtml_(targetHeaders, newRows, lastIndex, refIndex, projectIndex, stamp, clock),
    name: 'IS Validation Dashboard'
  });

  Logger.log('Bildirim gonderildi: ' + recipients.join(', '));
}

function buildNewRecordsHtml_(headers, rows, lastIndex, refIndex, projectIndex, stamp, clock) {
  let dashboardUrl = '';
  try { dashboardUrl = ScriptApp.getService().getUrl() || ''; } catch (e) { dashboardUrl = ''; }

  const owner = SYNC.NOTIFY_ACTION_OWNER || '';
  const esc = function (v) {
    return String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };

  let html = '<div style="font-family:Segoe UI,Arial,sans-serif;background:#f4f7f6;padding:22px 12px;">';
  html += '<div style="max-width:680px;margin:0 auto;">';

  // --- Başlık ---
  html += '<div style="background:#002b49;border-radius:12px 12px 0 0;padding:20px 24px;">' +
          '<div style="font-size:11px;font-weight:800;letter-spacing:.14em;color:#78c800;">' +
          'IS VALIDATION DASHBOARD</div>' +
          '<div style="font-size:20px;font-weight:700;color:#ffffff;margin-top:6px;">' +
          rows.length + ' yeni kayit eklendi</div>' +
          '<div style="font-size:12px;color:#a9b6c4;margin-top:8px;">' +
          'IAM Projects Sales &amp; Turnovers &rarr; Bursa Follow Up' +
          '</div></div>';

  // --- Eklenme zamanı ---
  html += '<div style="background:#0d2f4f;padding:11px 24px;color:#dbe4ec;font-size:12.5px;">' +
          '<b style="color:#ffffff;">Eklenme tarihi:</b> ' + esc(stamp) +
          ' &nbsp;&nbsp;<b style="color:#ffffff;">Saat:</b> ' + esc(clock) + '</div>';

  // --- Aksiyon uyarısı ---
  html += '<div style="background:#fff8e6;border-left:4px solid #ffc107;padding:15px 20px;font-size:13.5px;color:#5c4708;">' +
          '<b>Aksiyon gerekiyor.</b> Yeni kayitlar <b>Not in Liberation</b> statusuyle acilmistir. ' +
          (owner ? 'IS Validation sureci icin <b>' + esc(owner) + '</b>\'dan aksiyonlarin takip edilmesini rica ederiz. ' : '') +
          'Order, First Shipment ve EDI bilgileri takip sayfasindan tamamlanmalidir.' +
          '</div>';

  // --- Kartlar ---
  const limit = Math.min(rows.length, SYNC.NOTIFY_MAX_CARDS || 20);
  for (let r = 0; r < limit; r++) {
    const row = rows[r];
    const ref = String(row[refIndex] || '').trim() || '—';
    const project = projectIndex !== -1 ? String(row[projectIndex] || '').trim() : '';

    html += '<div style="background:#ffffff;margin-top:14px;border:1px solid #e3e8ee;border-radius:10px;overflow:hidden;">';
    html += '<div style="background:#0d2f4f;color:#ffffff;padding:11px 16px;font-size:14px;font-weight:700;">' +
            esc(ref) + (project ? ' &middot; ' + esc(project) : '') + '</div>';
    html += '<table style="width:100%;border-collapse:collapse;font-size:12.5px;">';

    let printed = 0;
    for (let c = 0; c <= lastIndex && c < headers.length; c++) {
      if (!headers[c]) continue;
      const value = String(row[c] == null ? '' : row[c]).trim();
      const bg = printed % 2 ? '#f7f9fb' : '#ffffff';
      const isStatusCell = normalizeHeader_(headers[c]) === normalizeHeader_('IS Status');
      html += '<tr style="background:' + bg + ';">' +
              '<td style="padding:8px 16px;color:#002b49;font-weight:600;width:42%;border-bottom:1px solid #eef2f5;">' +
              esc(headers[c]) + '</td>' +
              '<td style="padding:8px 16px;border-bottom:1px solid #eef2f5;' +
              (isStatusCell ? 'color:#b26a00;font-weight:700;' : 'color:#333;') + '">' +
              (value === '' ? '<span style="color:#9aa5b1;">&mdash;</span>' : esc(value)) + '</td></tr>';
      printed++;
    }
    html += '</table></div>';
  }

  if (rows.length > limit) {
    html += '<div style="background:#ffffff;margin-top:12px;padding:12px 16px;border:1px solid #e3e8ee;' +
            'border-radius:10px;font-size:12.5px;color:#6c757d;">ve ' + (rows.length - limit) +
            ' kayit daha. Tamamini panelde goruntuleyebilirsiniz.</div>';
  }

  // --- Buton ve dipnot ---
  if (dashboardUrl) {
    html += '<div style="text-align:center;margin-top:20px;">' +
            '<a href="' + dashboardUrl + '" style="background:#78c800;color:#ffffff;padding:12px 26px;' +
            'border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;display:inline-block;">' +
            'Panele Git</a></div>';
  }
  html += '<div style="text-align:center;color:#9aa5b1;font-size:11px;margin-top:18px;line-height:1.6;">' +
          'Bu e-posta IS Validation Dashboard tarafindan otomatik uretilmistir.<br>' +
          'Kaynak dosya ' + (SYNC.TRIGGER_MINUTES || 15) + ' dakikada bir kontrol edilmektedir.</div>';

  html += '</div></div>';
  return html;
}

/** TEST — bildirim e-postasinin gorunumunu ornek kayitla gonderir. */
function testNotificationMail() {
  const headers = ['Year', 'Project Name', 'Type', 'Region', 'Customer', 'Extension or SK',
                   'Bursa Ref', 'VS/OES Ref', 'IS Status'];
  const rows = [['2028', 'DENEME KITI', 'DENEME', '', 'DENEME SERVICE', 'NO',
                 'DENEME 999', 'DENEME 234', 'Not in Liberation']];
  notifyNewRecords_(headers, rows);
  Logger.log('Test bildirimi gonderildi: ' + SYNC.NOTIFY_RECIPIENTS.join(', '));
}

/** Senkronizasyonu düzenli aralıkla çalıştıran tetikleyiciyi kurar. */
function installSyncTrigger() {
  removeSyncTrigger();
  const minutes = SYNC.TRIGGER_MINUTES || 15;
  ScriptApp.newTrigger('syncNewRows').timeBased().everyMinutes(minutes).create();
  const message = 'Senkronizasyon tetikleyicisi kuruldu (' + minutes + ' dakikada bir).';
  Logger.log(message);
  return message;
}

function removeSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncNewRows') ScriptApp.deleteTrigger(t);
  });
  return 'Senkronizasyon tetikleyicileri kaldirildi.';
}

/**
 * KURULUM YARDIMCISI — hiçbir şey yazmaz.
 * Kaynak ve hedef başlıklarını ve otomatik kurulan eşleşmeyi Logs'a yazar.
 * Eşleşmeyen kolonlar için SYNC.MAP'e satır eklenir.
 */
function debugSyncMapping() {
  try {
    const sourceSs = SpreadsheetApp.openById(SYNC.SOURCE_ID);
    const sourceSheet = resolveSheet_(sourceSs, SYNC.SOURCE_SHEET_NAME, SYNC.SOURCE_GID);
    if (!sourceSheet) { Logger.log('HATA: Kaynak sekme bulunamadi. Mevcut sekmeler: ' +
        sourceSs.getSheets().map(function (s) { return s.getName() + ' (gid ' + s.getSheetId() + ')'; }).join(', ')); return; }

    const targetSs = SpreadsheetApp.openByUrl(CONFIG.SHEET_URL);
    const targetSheet = targetSs.getSheetByName(SYNC.TARGET_SHEET_NAME);
    if (!targetSheet) { Logger.log('HATA: Hedef sekme bulunamadi: ' + SYNC.TARGET_SHEET_NAME); return; }

    const targetHeaders = targetSheet.getRange(SYNC.TARGET_HEADER_ROW, 1, 1, targetSheet.getLastColumn())
        .getDisplayValues()[0].map(function (h) { return String(h || '').trim(); });

    const scanRows = Math.min(sourceSheet.getLastRow(), SYNC.SOURCE_HEADER_SCAN_ROWS || 25);
    const scan = sourceSheet.getRange(1, 1, scanRows, sourceSheet.getLastColumn()).getDisplayValues();
    const headerInfo = resolveSourceHeaderRow_(scan, targetHeaders);
    const sourceHeaders = scan[headerInfo.row - 1].map(function (h) { return String(h || '').trim(); });

    Logger.log('KAYNAK sekme : ' + sourceSheet.getName() + ' (gid ' + sourceSheet.getSheetId() + ')');
    Logger.log('KAYNAK baslik satiri: ' + headerInfo.row +
               (headerInfo.manual ? ' (elle ayarlandi)' : ' (otomatik bulundu, puan ' + headerInfo.score + ')'));
    Logger.log('KAYNAK basliklari (' + sourceHeaders.filter(String).length + ' dolu): ' +
               sourceHeaders.filter(String).join(' | '));
    Logger.log('HEDEF  basliklari (' + targetHeaders.length + '): ' + targetHeaders.join(' | '));

    const mapping = buildSyncMapping_(targetHeaders, sourceHeaders);
    Logger.log('--- OTOMATIK ESLESME (' + mapping.length + ' kolon) ---');
    mapping.forEach(function (m) { Logger.log('  ' + m.sourceHeader + '  ->  ' + m.targetHeader); });

    const matched = {};
    mapping.forEach(function (m) { matched[m.targetHeader] = true; });
    const unmatched = targetHeaders.filter(function (h) {
      return h && !matched[h] && SYNC.EXCLUDE_TARGET_HEADERS.map(normalizeHeader_).indexOf(normalizeHeader_(h)) === -1;
    });
    Logger.log('--- ESLESMEYEN HEDEF KOLONLARI ---');
    Logger.log(unmatched.length ? unmatched.join(' | ') : '(yok)');

    // --- Anahtar kolonu iki tarafta da doğrula ---
    const keyIdx = targetHeaders.map(normalizeHeader_).indexOf(normalizeHeader_(SYNC.KEY_TARGET_HEADER));
    let keySrc = -1;
    if (SYNC.KEY_SOURCE_HEADER) {
      keySrc = sourceHeaders.map(normalizeHeader_).indexOf(normalizeHeader_(SYNC.KEY_SOURCE_HEADER));
    } else if (keyIdx !== -1) {
      const km = mapping.filter(function (m) { return m.targetIndex === keyIdx; })[0];
      if (km) keySrc = km.sourceIndex;
    }

    Logger.log('--- ANAHTAR KOLON: "' + SYNC.KEY_TARGET_HEADER + '" ---');
    Logger.log('  Hedefte : ' + (keyIdx === -1 ? 'BULUNAMADI' : 'bulundu (' + targetHeaders[keyIdx] + ')'));
    Logger.log('  Kaynakta: ' + (keySrc === -1 ? 'BULUNAMADI' : 'bulundu (' + sourceHeaders[keySrc] + ')'));
    if (keyIdx !== -1 && keySrc !== -1) {
      Logger.log('  SONUC: Mukerrer korumasi AKTIF — ayni Bursa Ref iki kez eklenmez.');
    } else {
      Logger.log('  SONUC: Mukerrer korumasi PASIF — satir numarasi takibine dusulecek. ' +
                 'Kaynaktaki anahtar kolonun adini SYNC.KEY_SOURCE_HEADER icine yazin.');
    }
  } catch (e) {
    Logger.log('HATA: ' + e);
  }
}
