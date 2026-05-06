/*
 * content.js
 * Isolated world'de çalışır. Görevi:
 *   - inject.js'i sayfanın MAIN world'üne yerleştirmek
 *   - inject.js'ten gelen postMessage olaylarını background'a iletmek
 *
 * Görsel kayıt offscreen.js'te chrome.tabCapture ile yapıldığı için
 * burada artık rrweb start/stop akışı yok.
 */

(function () {
  'use strict';

  const CHANNEL = 'REPRO_BLACKBOX';

  // inject.js'i MAIN world'e yerleştir
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('inject.js');
    s.async = false;
    s.onload = function () {
      this.remove();
    };
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {
    // chrome:// gibi sayfalarda enjeksiyon başarısız olabilir
  }

  let recording = false;

  // Sayfadan gelen mesajları background'a aktar (sadece kayıt aktifken)
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!data || data.source !== CHANNEL) return;
    if (!recording && data.type !== 'inject-ready') return;

    try {
      chrome.runtime.sendMessage({
        kind: 'event',
        type: data.type,
        payload: data.payload,
        t: data.t
      });
    } catch (e) {
      // Service worker uykuda olabilir
    }
  });

  // Background'dan gelen kayıt durumu komutları
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.kind) return;
    if (msg.kind === 'cmd-set-recording') {
      recording = !!msg.recording;
      sendResponse({ ok: true });
    }
    return true;
  });

  // Sayfa yüklendiğinde mevcut kayıt durumunu öğren
  try {
    chrome.runtime.sendMessage({ kind: 'cmd-handshake', url: location.href }, (resp) => {
      if (resp && resp.recording) recording = true;
    });
  } catch (_) {}
})();
