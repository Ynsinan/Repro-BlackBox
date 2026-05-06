# Repro Blackbox

QA ve geliştiriciler için **tek tıklama bug yakalama kara kutusu**. Sekme videosu, console log'ları ve network çağrıları (request + response body dahil) tek bir pakette.

Görsel kayıt için harici kütüphane yok — Chrome'un native `chrome.tabCapture` + `MediaRecorder` API'leri kullanılır. Çıktı: gerçek `.webm` videosu.

## Özellikler

- 🔴 **Tek tıklama kayıt** — popup'tan başlat, popup'tan durdur
- 🎥 **Gerçek video** — sekmenin `.webm` videosu (VS Code, QuickTime, Slack, Jira preview ile oynanır)
- 🪵 **Console hijack** — `log/info/warn/error/debug` + uncaught error + unhandled rejection
- 🌐 **Network yakalama** — `fetch` ve `XMLHttpRequest` request/response body dahil
- 🔒 **Hassas veri filtresi** — `password`, `token`, `authorization`, `cookie`, `apiKey` vb. otomatik `[REDACTED]`
- 📦 **ZIP çıktı** — video + JSON dosyaları + Markdown rapor
- 📋 **Markdown rapor** — Jira/Linear'a tek tıkla yapıştırılabilir
- 🚫 **rrweb yok, fork hissi yok** — özgün araç

## Kurulum

### 1) JSZip'i indir (sadece ZIP çıktısı için, ~95 KB)

```bash
bash lib/download-libs.sh
```

JSZip kullanmak istemiyorsan: viewer'da "ZIP İndir" butonu hata verir, ama Video İndir ve Markdown Kopyala çalışmaya devam eder.

### 2) Chrome'a yükle

1. `chrome://extensions` adresini aç
2. Sağ üstten **Geliştirici Modu**'nu aç
3. **"Paketlenmemiş öğe yükle"** → bu klasörü seç
4. Araç çubuğunda kara kutu ikonu görünmeli

## Kullanım

1. Bug'ı tetikleyeceğin sayfaya git
2. Repro Blackbox ikonuna tıkla → **"Kaydı Başlat"**
3. Chrome bir capture göstergesi (kırmızı nokta üst barda) gösterir
4. Bug'ı tetikleyen adımları gerçekleştir
5. Popup'ı tekrar aç → **"Kaydı Durdur"**
6. Otomatik açılan viewer sekmesinde:
   - **Video** sekmesinde sekme videosunu izle
   - **Console** sekmesinde log'ları gör
   - **Network** sekmesinde istek detaylarına bak
   - **Videoyu İndir** / **ZIP İndir** / **Markdown Kopyala**

## Mimari

```
popup.js  ─ getMediaStreamId(targetTabId)
   │            (user-gesture içinde alınmalı)
   ▼
background.js (service worker)
   │  ├─ chrome.offscreen.createDocument()
   │  ▼
   │  offscreen.js
   │    ├─ getUserMedia({ chromeMediaSource: 'tab' })
   │    └─ MediaRecorder → chunks → IndexedDB(videos)
   │
   │  inject.js (sayfanın MAIN world'ünde)
   │    ├─ fetch / XHR / WS / EventSource hijack
   │    └─ console.* + uncaught + unhandledrejection hijack
   ▼
   content.js (köprü)
   ▼
   chrome.storage.local (event tamponu)
   ▼
   stop → IndexedDB(sessions) ← video Blob ile birleşir
   ▼
   viewer.html — video tag + tablar
```

## Çıktı

### ZIP içeriği

```
repro-blackbox-2026-05-06T14-23-11.zip
├── recording.webm     # gerçek video (VP9 / VP8)
├── console.json       # tüm log'lar (redacted)
├── network.json       # tüm fetch/XHR (redacted)
├── meta.json          # URL, UA, viewport, ekran, süre, video bilgisi, WS
└── REPORT.md          # Markdown rapor
```

### Markdown rapor

URL, tarayıcı, viewport, süre, video boyutu + özet (error/warning/başarısız istek sayıları) + console error blokları + başarısız istekler.

## Gizlilik

- **Tüm veri yerel** — `chrome.storage.local` ve IndexedDB; hiçbir sunucuya gönderilmez
- Hassas başlıklar/anahtarlar (`authorization`, `cookie`, `token`, `password`, `apiKey`, vb.) JSON gövdelerinde recursive olarak `[REDACTED]` ile değiştirilir
- Form-urlencoded gövdelerde de aynı pattern temizliği uygulanır
- Kayıt sırasında Chrome'un capture göstergesi her zaman görünür — gizli kayıt yok

## Kısıtlamalar

- **Sadece sekme görüntüsü** — `tabCapture` sadece görsel; webcam/audio kaydetmez (manifest izni de yok)
- **chrome://, chrome-extension://, edge://, mağaza** sayfalarında çalışmaz
- **Maksimum kayıt süresi: 5 dakika** — sonra otomatik durur
- **Body boyut limiti: 100 KB** — üzeri `[truncated]`
- **Service Worker'dan giden** fetch çağrıları yakalanmaz (sayfa fetch/XHR'i yakalanır)
- Cross-origin iframe'lerin **görüntüsü video'ya dahildir** ama içeriklerinin fetch/console'u yakalanmaz

## İzinler ve Neden

| İzin | Sebep |
|---|---|
| `activeTab` | Aktif sekmeyi öğrenmek için |
| `tabs` | Sekme URL/title bilgisi ve sekme kapanışını dinlemek için |
| `tabCapture` | Sekme videosunu MediaStream olarak almak için |
| `offscreen` | Service worker'da olmayan MediaRecorder'ı çalıştırmak için |
| `scripting` | Sayfaya viewport/UA bilgisi sorgusu |
| `storage` | Olay tamponu ve son session id |
| `host_permissions: <all_urls>` | Tüm sitelerde content script çalışsın |

## Klasör Yapısı

```
repro-blackbox/
├── manifest.json          # MV3 manifest
├── background.js          # service worker — orkestrasyon, IndexedDB
├── content.js             # isolated world köprü
├── inject.js              # MAIN world — fetch/XHR/console hijack
├── offscreen.html         # offscreen doc shell
├── offscreen.js           # MediaRecorder + IndexedDB(videos)
├── popup.html / .css / .js
├── viewer.html / .js      # session viewer
├── lib/
│   ├── jszip.min.js       # ZIP üretimi (opsiyonel)
│   └── download-libs.sh
├── icons/
└── README.md
```

## Geliştirme

Build step yok — vanilla JS. Düzenle, `chrome://extensions` üzerinden **Yenile**, popup'ı tekrar aç. Background SW logları için `chrome://extensions` → bu uzantı → "service worker" linki.

## Sorun Giderme

| Belirti | Çözüm |
|---|---|
| "Capture izni alınamadı" | Sayfayı yenileyip tekrar dene; chrome:// olmadığından emin ol |
| Video boş geliyor | Offscreen doc düzgün açılmamış olabilir; `chrome://extensions` üzerinden uzantıyı yenile |
| Network sekmesi boş | Service Worker'dan giden istekler yakalanmaz; sayfa fetch/XHR'i mı? |
| ZIP butonu hata veriyor | `lib/download-libs.sh` çalıştırıldı mı? |
| Kayıt 5 dk'dan önce kesildi | Sekme kapatıldı, başka tab'a geçildi veya Chrome bellek darlığı |

## Lisans

MIT
