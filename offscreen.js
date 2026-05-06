/*
 * offscreen.js
 * Offscreen document'ta koşar. Görevi:
 *   - background'dan streamId al
 *   - getUserMedia ile MediaStream oluştur (chromeMediaSource: 'tab')
 *   - MediaRecorder ile WebM video kaydet
 *   - Stop'ta blob'u IndexedDB'ye yaz, anahtarla geri dön
 *
 * Service worker MediaRecorder'a sahip olmadığı için bu mantık burada.
 */

(function () {
  'use strict';

  let stream = null;
  let recorder = null;
  let chunks = [];
  let recordingId = null;
  let audioCtx = null; // sekme sesini hoparlöre geri yönlendirmek için

  // Kalite preset'leri — popup'taki dropdown ile eşleşir
  const QUALITY_PRESETS = {
    low: {
      maxWidth: 1280,
      maxHeight: 720,
      maxFrameRate: 15,
      videoBps: 750_000,
      audioBps: 64_000
    },
    normal: {
      maxWidth: 1920,
      maxHeight: 1080,
      maxFrameRate: 30,
      videoBps: 1_500_000,
      audioBps: 128_000
    },
    high: {
      maxWidth: 1920,
      maxHeight: 1080,
      maxFrameRate: 60,
      videoBps: 4_000_000,
      audioBps: 192_000
    },
    ultra: {
      maxWidth: 2560,
      maxHeight: 1440,
      maxFrameRate: 60,
      videoBps: 8_000_000,
      audioBps: 256_000
    }
  };

  // === IndexedDB yardımcıları =============================================

  const DB_NAME = 'reproBlackbox';
  const DB_VERSION = 1;
  const STORE = 'videos';

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
        if (!db.objectStoreNames.contains('sessions')) {
          db.createObjectStore('sessions', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveBlob(key, blob) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(blob, key);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  }

  // === Recorder ============================================================

  function pickMimeType(withAudio) {
    // MP4 öncelikli — Chromium 130+ MediaRecorder'da H.264/AAC üretimi destekli.
    // Desteklenmezse WebM'e düşeriz.
    const candidates = withAudio
      ? [
          'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
          'video/mp4;codecs=avc1,mp4a.40.2',
          'video/mp4',
          'video/webm;codecs=vp9,opus',
          'video/webm;codecs=vp8,opus',
          'video/webm'
        ]
      : [
          'video/mp4;codecs=avc1.42E01E',
          'video/mp4;codecs=avc1',
          'video/mp4',
          'video/webm;codecs=vp9',
          'video/webm;codecs=vp8',
          'video/webm'
        ];
    for (const m of candidates) {
      if (MediaRecorder.isTypeSupported(m)) {
        console.log('[Repro] seçilen mime:', m);
        return m;
      }
    }
    console.warn('[Repro] hiçbir mime desteklenmiyor, varsayılan');
    return '';
  }

  async function startRecording({ streamId, sessionId, withAudio, quality }) {
    if (recorder) {
      throw new Error('Zaten kayıt yapılıyor');
    }

    recordingId = sessionId;
    chunks = [];

    const preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS.normal;

    const constraints = {
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
          maxWidth: preset.maxWidth,
          maxHeight: preset.maxHeight,
          maxFrameRate: preset.maxFrameRate
        }
      }
    };
    if (withAudio) {
      constraints.audio = {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      };
    } else {
      constraints.audio = false;
    }
    console.log('[Repro] getUserMedia constraint:', JSON.stringify(constraints));
    stream = await navigator.mediaDevices.getUserMedia(constraints);

    const audioTracks = stream.getAudioTracks();
    const videoTracks = stream.getVideoTracks();
    console.log(
      `[Repro] stream tracks — video:${videoTracks.length} audio:${audioTracks.length} (withAudio=${!!withAudio})`
    );

    // Sekme sesi yakalanınca varsayılan olarak hoparlöre gitmez. Kullanıcı
    // izlerken sayfayı duyabilsin diye sesi AudioContext üzerinden geri yolla.
    if (withAudio && audioTracks.length > 0) {
      try {
        audioCtx = new AudioContext();
        const src = audioCtx.createMediaStreamSource(stream);
        src.connect(audioCtx.destination);
        console.log('[Repro] ses hoparlöre geri pipe edildi');
      } catch (e) {
        console.warn('[Repro] ses geri yönlendirilemedi', e);
      }
    } else if (withAudio && audioTracks.length === 0) {
      console.warn('[Repro] withAudio=true ama ses track\'i yok!');
    }

    const mimeType = pickMimeType(!!withAudio);
    const opts = mimeType
      ? {
          mimeType,
          videoBitsPerSecond: preset.videoBps,
          audioBitsPerSecond: preset.audioBps
        }
      : undefined;
    recorder = new MediaRecorder(stream, opts);
    console.log(
      `[Repro] kalite=${quality} ${preset.maxWidth}x${preset.maxHeight}@${preset.maxFrameRate} video=${preset.videoBps / 1000}kbps audio=${preset.audioBps / 1000}kbps`
    );

    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunks.push(ev.data);
    };

    recorder.onerror = (ev) => {
      // MediaRecorder hata verirse logla; stop'ta yine ne varsa yazılır
      console.warn('[Repro] MediaRecorder error', ev);
    };

    // Tab kapanır veya kullanıcı capture'ı durdurursa stream biter
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      if (recorder && recorder.state !== 'inactive') {
        recorder.stop();
      }
    });

    recorder.start(1000); // her saniye chunk emit et — service worker uyusa da kayıp az olur
    return {
      ok: true,
      mimeType: recorder.mimeType,
      audioTracks: audioTracks.length,
      videoTracks: videoTracks.length,
      withAudio: !!withAudio
    };
  }

  function stopRecording() {
    return new Promise(async (resolve, reject) => {
      if (!recorder) return reject(new Error('Aktif kayıt yok'));

      const finalize = async () => {
        try {
          const mimeType = recorder.mimeType || 'video/webm';
          const blob = new Blob(chunks, { type: mimeType });
          await saveBlob(recordingId, blob);
          const result = {
            ok: true,
            sessionId: recordingId,
            size: blob.size,
            mimeType,
            durationHint: blob.size > 0 ? null : 0
          };
          // Temizlik
          try {
            stream.getTracks().forEach((t) => t.stop());
          } catch (_) {}
          if (audioCtx) {
            try {
              await audioCtx.close();
            } catch (_) {}
            audioCtx = null;
          }
          stream = null;
          recorder = null;
          chunks = [];
          recordingId = null;
          resolve(result);
        } catch (e) {
          reject(e);
        }
      };

      if (recorder.state === 'inactive') {
        await finalize();
      } else {
        recorder.addEventListener('stop', finalize, { once: true });
        try {
          recorder.requestData();
        } catch (_) {}
        recorder.stop();
      }
    });
  }

  // === Mesajlaşma =========================================================

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.target !== 'offscreen') return;

    (async () => {
      try {
        if (msg.kind === 'start') {
          const r = await startRecording(msg);
          sendResponse(r);
        } else if (msg.kind === 'stop') {
          const r = await stopRecording();
          sendResponse(r);
        } else if (msg.kind === 'ping') {
          sendResponse({ ok: true, recording: !!recorder });
        } else {
          sendResponse({ ok: false, error: 'unknown' });
        }
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || String(e) });
      }
    })();

    return true; // async response
  });
})();
