/*
 * background.js (service worker, type: module)
 *
 * Kayıt orkestrasyonu:
 *   1. popup "start" der → SW offscreen doc oluşturur.
 *   2. popup chrome.tabCapture.getMediaStreamId çağırıp streamId alır
 *      (popup user-gesture'a sahip olduğu için bu çağrı orada yapılır).
 *   3. popup streamId'yi SW'ye iletir; SW bunu offscreen'e forward eder.
 *   4. offscreen MediaRecorder'ı başlatır.
 *   5. Kayıt sırasında inject.js'ten gelen network/console event'leri
 *      bellek tamponuna toplanır, periyodik olarak chrome.storage.local'e
 *      flush edilir.
 *   6. "stop" → SW offscreen'e durdur der → blob IndexedDB'ye yazılır.
 *      SW olay tamponunu da aynı IndexedDB session kaydına yazar.
 *      Viewer açılır.
 */

const STATE_KEY = 'repro:state';
const BUFFER_KEY = 'repro:buffer';
const MAX_DURATION_MS = 5 * 60 * 1000;
const OFFSCREEN_PATH = 'offscreen.html';

// === IndexedDB =============================================================

const DB_NAME = 'reproBlackbox';
const DB_VERSION = 1;
const SESSIONS = 'sessions';
const VIDEOS = 'videos';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(VIDEOS)) db.createObjectStore(VIDEOS);
      if (!db.objectStoreNames.contains(SESSIONS))
        db.createObjectStore(SESSIONS, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putSession(session) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SESSIONS, 'readwrite');
    tx.objectStore(SESSIONS).put(session);
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

// === State =================================================================

async function getState() {
  const obj = await chrome.storage.local.get(STATE_KEY);
  return (
    obj[STATE_KEY] || {
      recording: false,
      tabId: null,
      sessionId: null,
      startedAt: 0,
      meta: null
    }
  );
}

async function setState(state) {
  await chrome.storage.local.set({ [STATE_KEY]: state });
}

async function getBuffer() {
  const obj = await chrome.storage.local.get(BUFFER_KEY);
  return (
    obj[BUFFER_KEY] || { console: [], network: [], ws: [] }
  );
}

async function setBuffer(buf) {
  await chrome.storage.local.set({ [BUFFER_KEY]: buf });
}

async function clearBuffer() {
  await chrome.storage.local.set({
    [BUFFER_KEY]: { console: [], network: [], ws: [] }
  });
}

const memBuffer = { console: [], network: [], ws: [] };
let flushTimer = null;
let stopTimer = null;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    if (
      !memBuffer.console.length &&
      !memBuffer.network.length &&
      !memBuffer.ws.length
    ) {
      return;
    }
    const persisted = await getBuffer();
    persisted.console.push(...memBuffer.console);
    persisted.network.push(...memBuffer.network);
    persisted.ws.push(...memBuffer.ws);
    memBuffer.console.length = 0;
    memBuffer.network.length = 0;
    memBuffer.ws.length = 0;
    await setBuffer(persisted);
  }, 1000);
}

async function appendEvent(type, payload, t) {
  if (type === 'console') memBuffer.console.push({ ...payload, t });
  else if (type === 'network') memBuffer.network.push(payload);
  else if (type === 'ws') memBuffer.ws.push({ ...payload, t });
  scheduleFlush();
}

// === Offscreen =============================================================

let creatingOffscreen = null;

async function ensureOffscreen() {
  // Var mı kontrol et
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
  });
  if (existing && existing.length > 0) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA'],
    justification: 'Sekme videosunu MediaRecorder ile kaydetmek için.'
  });
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function closeOffscreen() {
  try {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
    });
    if (existing && existing.length > 0) {
      await chrome.offscreen.closeDocument();
    }
  } catch (_) {}
}

async function offscreenMessage(msg) {
  return await chrome.runtime.sendMessage({ ...msg, target: 'offscreen' });
}

// === Kayıt başlat/durdur ===================================================

async function startRecording({ tabId, streamId, meta: clientMeta, withAudio, quality, timeLimit }) {
  await clearBuffer();

  const sessionId = `repro_${Date.now()}`;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const meta = {
    sessionId,
    url: (tab && tab.url) || '',
    title: (tab && tab.title) || '',
    userAgent: (clientMeta && clientMeta.userAgent) || '',
    viewport: (clientMeta && clientMeta.viewport) || null,
    screen: (clientMeta && clientMeta.screen) || null,
    language: (clientMeta && clientMeta.language) || '',
    platform: (clientMeta && clientMeta.platform) || '',
    startedAt: Date.now()
  };

  await ensureOffscreen();

  // Offscreen'e başla komutu — streamId burada anında tüketilmeli
  const r = await offscreenMessage({
    kind: 'start',
    streamId,
    sessionId,
    withAudio: !!withAudio,
    quality: quality || 'normal'
  });
  if (!r || !r.ok) {
    await closeOffscreen();
    throw new Error((r && r.error) || 'Offscreen başlatılamadı');
  }
  meta.videoMimeType = r.mimeType || 'video/webm';
  meta.withAudio = !!withAudio;
  meta.audioTracks = r.audioTracks || 0;
  meta.quality = quality || 'normal';
  meta.timeLimit = timeLimit !== false;
  console.log(
    `[Repro] kayıt başladı — quality=${quality} withAudio=${!!withAudio} timeLimit=${meta.timeLimit} audioTracks=${r.audioTracks} mime=${r.mimeType}`
  );

  await setState({
    recording: true,
    tabId,
    sessionId,
    startedAt: meta.startedAt,
    meta
  });

  // Content script'e kayıt aktif olduğunu bildir
  try {
    await chrome.tabs.sendMessage(tabId, {
      kind: 'cmd-set-recording',
      recording: true
    });
  } catch (_) {}

  if (stopTimer) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
  if (timeLimit !== false) {
    stopTimer = setTimeout(() => {
      stopRecording({ autoStopped: true }).catch((e) =>
        console.warn('[Repro] auto-stop failed', e)
      );
    }, MAX_DURATION_MS);
  }

  return { ok: true, sessionId };
}

async function stopRecording(opts = {}) {
  const state = await getState();
  if (!state.recording) return null;

  if (stopTimer) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }

  // Offscreen'e durdur de, blob'u IndexedDB'ye yazmasını bekle
  let videoInfo = null;
  try {
    videoInfo = await offscreenMessage({ kind: 'stop' });
  } catch (e) {
    console.warn('[Repro] offscreen stop hatası', e);
  }

  // Bellekteki olayları flush et
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const persisted = await getBuffer();
  persisted.console.push(...memBuffer.console);
  persisted.network.push(...memBuffer.network);
  persisted.ws.push(...memBuffer.ws);
  memBuffer.console.length = 0;
  memBuffer.network.length = 0;
  memBuffer.ws.length = 0;

  // Sayfaya kayıt durdu bilgisi
  if (state.tabId != null) {
    try {
      await chrome.tabs.sendMessage(state.tabId, {
        kind: 'cmd-set-recording',
        recording: false
      });
    } catch (_) {}
  }

  const finishedAt = Date.now();
  const session = {
    id: state.sessionId,
    meta: {
      ...state.meta,
      finishedAt,
      duration: finishedAt - state.startedAt,
      autoStopped: !!opts.autoStopped,
      video: videoInfo && videoInfo.ok
        ? {
            sessionId: videoInfo.sessionId,
            size: videoInfo.size,
            mimeType: videoInfo.mimeType
          }
        : null
    },
    events: persisted
  };

  await putSession(session);

  // Son sessionId'yi quick-access için storage'a yaz (viewer query string ile alır)
  await chrome.storage.local.set({ 'repro:lastSessionId': session.id });

  await setState({
    recording: false,
    tabId: null,
    sessionId: null,
    startedAt: 0,
    meta: null
  });
  await clearBuffer();
  await closeOffscreen();

  try {
    await chrome.tabs.create({
      url: chrome.runtime.getURL('viewer.html') + `?id=${encodeURIComponent(session.id)}`
    });
  } catch (_) {}

  return session;
}

// === Mesajlar =============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || !msg.kind) return sendResponse({ ok: false });
    // offscreen'e yönelik mesajları buradan ele almıyoruz
    if (msg.target === 'offscreen') return;

    if (msg.kind === 'event') {
      const state = await getState();
      if (!state.recording) return sendResponse({ ok: false, reason: 'not-recording' });
      if (sender.tab && sender.tab.id !== state.tabId) {
        return sendResponse({ ok: false, reason: 'wrong-tab' });
      }
      await appendEvent(msg.type, msg.payload, msg.t);
      sendResponse({ ok: true });
      return;
    }

    if (msg.kind === 'cmd-handshake') {
      const state = await getState();
      const recording = state.recording && sender.tab && sender.tab.id === state.tabId;
      sendResponse({ ok: true, recording });
      return;
    }

    if (msg.kind === 'popup-status') {
      const state = await getState();
      const buf = await getBuffer();
      sendResponse({
        ok: true,
        recording: state.recording,
        startedAt: state.startedAt,
        tabId: state.tabId,
        withAudio: !!(state.meta && state.meta.withAudio),
        audioTracks: (state.meta && state.meta.audioTracks) || 0,
        timeLimit: !state.meta || state.meta.timeLimit !== false,
        counts: {
          console: buf.console.length + memBuffer.console.length,
          network: buf.network.length + memBuffer.network.length
        }
      });
      return;
    }

    if (msg.kind === 'popup-start') {
      try {
        const r = await startRecording(msg);
        sendResponse(r);
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || String(e) });
      }
      return;
    }

    if (msg.kind === 'popup-stop') {
      const session = await stopRecording();
      sendResponse({ ok: true, sessionId: session && session.id });
      return;
    }

    sendResponse({ ok: false, reason: 'unknown' });
  })().catch((e) => {
    sendResponse({ ok: false, error: (e && e.message) || String(e) });
  });

  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  await setState({
    recording: false,
    tabId: null,
    sessionId: null,
    startedAt: 0,
    meta: null
  });
  await clearBuffer();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  if (state.recording && state.tabId === tabId) {
    await stopRecording({ autoStopped: true }).catch(() => {});
  }
});
