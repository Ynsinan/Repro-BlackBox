/*
 * popup.js
 *
 * Önemli not: chrome.tabCapture.getMediaStreamId user-gesture gerektirir.
 * Bu yüzden streamId'yi POPUP içinde, butona basıldıktan hemen sonra alıp
 * SW'ye iletiyoruz. SW bunu offscreen doc'a forward eder.
 */

const recBtn = document.getElementById('recBtn');
const recLabel = recBtn.querySelector('.rec-label');
const statusBox = document.getElementById('status');
const statusText = document.getElementById('statusText');
const elapsedEl = document.getElementById('elapsed');
const countsBox = document.getElementById('counts');
const chipConsole = document.getElementById('chip-console');
const chipNetwork = document.getElementById('chip-network');
const chipAudio = document.getElementById('chip-audio');
const hint = document.getElementById('hint');
const audioToggle = document.getElementById('audioToggle');
const audioCheck = document.getElementById('audioCheck');
const limitToggle = document.getElementById('limitToggle');
const limitCheck = document.getElementById('limitCheck');
const qualityRow = document.getElementById('qualityRow');
const qualitySelect = document.getElementById('qualitySelect');

const PREFS_KEY = 'repro:prefs';
const MAX_DURATION_MS = 5 * 60 * 1000;
let pollTimer = null;

async function loadPrefs() {
  const obj = await chrome.storage.local.get(PREFS_KEY);
  const defaults = { withAudio: false, quality: 'normal', timeLimit: true };
  return { ...defaults, ...(obj[PREFS_KEY] || {}) };
}

async function savePrefs(prefs) {
  await chrome.storage.local.set({ [PREFS_KEY]: prefs });
}

function fmtElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => resolve(resp || {}));
  });
}

function getStreamId(targetTabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId }, (streamId) => {
      const err = chrome.runtime.lastError;
      if (err || !streamId) reject(err || new Error('streamId alınamadı'));
      else resolve(streamId);
    });
  });
}

async function refresh() {
  const s = await send({ kind: 'popup-status' });
  if (s.recording) {
    statusBox.classList.add('recording');
    recBtn.classList.add('recording');
    recLabel.textContent = 'Kaydı Durdur';
    statusText.textContent = 'Kaydediliyor';
    countsBox.hidden = false;
    audioToggle.classList.add('disabled');
    audioCheck.disabled = true;
    limitToggle.classList.add('disabled');
    limitCheck.disabled = true;
    qualityRow.classList.add('disabled');
    qualitySelect.disabled = true;
    if (s.withAudio && s.audioTracks > 0) {
      chipAudio.textContent = '🔊 Sesli';
    } else if (s.withAudio && s.audioTracks === 0) {
      chipAudio.textContent = '⚠️ Ses track yok';
    } else {
      chipAudio.textContent = '🔇 Sessiz';
    }
    const elapsed = Date.now() - s.startedAt;
    elapsedEl.textContent = fmtElapsed(elapsed);
    chipConsole.textContent = `${s.counts.console} log`;
    chipNetwork.textContent = `${s.counts.network} istek`;

    if (s.timeLimit === false) {
      hint.textContent = 'Süre sınırı kapalı — kayıt elle durdurulana kadar sürer.';
      hint.classList.remove('warn');
    } else {
      const remain = MAX_DURATION_MS - elapsed;
      if (remain < 30000) {
        hint.textContent = `Süre sınırı: ${Math.max(0, Math.ceil(remain / 1000))} sn kaldı.`;
        hint.classList.add('warn');
      } else {
        hint.textContent = 'Kayıt sürüyor — sayfayı normal şekilde kullanın.';
        hint.classList.remove('warn');
      }
    }
  } else {
    statusBox.classList.remove('recording');
    recBtn.classList.remove('recording');
    recLabel.textContent = 'Kaydı Başlat';
    statusText.textContent = 'Hazır';
    elapsedEl.textContent = '00:00';
    countsBox.hidden = true;
    audioToggle.classList.remove('disabled');
    audioCheck.disabled = false;
    limitToggle.classList.remove('disabled');
    limitCheck.disabled = false;
    qualityRow.classList.remove('disabled');
    qualitySelect.disabled = false;
    setIdleHint();
    hint.classList.remove('warn');
  }
}

function setIdleHint() {
  if (limitCheck.checked) {
    hint.textContent = 'Sekme videosu kaydedilir. Süre 5 dakika ile sınırlıdır.';
  } else {
    hint.textContent = 'Sekme videosu kaydedilir. Süre sınırı yok.';
  }
}

async function startFlow(tab) {
  // 1) Sayfada bir capture göstergesi olduğunu zorlamak için kullanıcı meta bilgilerini topla
  let clientMeta = null;
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => ({
        userAgent: navigator.userAgent,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        screen: { width: screen.width, height: screen.height },
        language: navigator.language,
        platform: navigator.platform
      })
    });
    if (result) clientMeta = result;
  } catch (_) {}

  // 2) streamId user-gesture içinde alınmalı
  let streamId;
  try {
    streamId = await getStreamId(tab.id);
  } catch (e) {
    statusText.textContent = 'Capture izni alınamadı';
    hint.textContent = String(e && e.message ? e.message : e);
    hint.classList.add('warn');
    return;
  }

  // 3) Background'a ilet — offscreen doc burada ayağa kalkar
  const prefs = await loadPrefs();
  const r = await send({
    kind: 'popup-start',
    tabId: tab.id,
    streamId,
    meta: clientMeta,
    withAudio: !!prefs.withAudio,
    quality: prefs.quality || 'normal',
    timeLimit: prefs.timeLimit !== false
  });

  if (!r.ok) {
    statusText.textContent = 'Başlatılamadı';
    hint.textContent = r.error || 'Bilinmeyen hata';
    hint.classList.add('warn');
    return;
  }
  await refresh();
}

recBtn.addEventListener('click', async () => {
  recBtn.disabled = true;
  try {
    const s = await send({ kind: 'popup-status' });
    if (s.recording) {
      await send({ kind: 'popup-stop' });
      window.close();
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) {
        statusText.textContent = 'Sekme bulunamadı';
        return;
      }
      const url = tab.url || '';
      if (
        url.startsWith('chrome://') ||
        url.startsWith('chrome-extension://') ||
        url.startsWith('edge://') ||
        url.startsWith('about:') ||
        url.startsWith('https://chrome.google.com/webstore')
      ) {
        statusText.textContent = 'Bu sayfada çalışmaz';
        hint.textContent = 'chrome:// ve mağaza sayfalarında uzantı çalışmaz.';
        hint.classList.add('warn');
        return;
      }
      await startFlow(tab);
    }
  } finally {
    recBtn.disabled = false;
  }
});

audioCheck.addEventListener('change', async () => {
  const prefs = await loadPrefs();
  prefs.withAudio = audioCheck.checked;
  await savePrefs(prefs);
});

limitCheck.addEventListener('change', async () => {
  const prefs = await loadPrefs();
  prefs.timeLimit = limitCheck.checked;
  await savePrefs(prefs);
  if (!statusBox.classList.contains('recording')) setIdleHint();
});

qualitySelect.addEventListener('change', async () => {
  const prefs = await loadPrefs();
  prefs.quality = qualitySelect.value;
  await savePrefs(prefs);
});

(async function init() {
  const prefs = await loadPrefs();
  audioCheck.checked = !!prefs.withAudio;
  limitCheck.checked = prefs.timeLimit !== false;
  qualitySelect.value = prefs.quality || 'normal';
  await refresh();
  pollTimer = setInterval(refresh, 1000);
})();

window.addEventListener('unload', () => {
  if (pollTimer) clearInterval(pollTimer);
});
