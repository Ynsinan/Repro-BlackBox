/*
 * viewer.js
 *
 * IndexedDB'den session kaydını + video Blob'unu okur, üç sekmede sunar:
 *   - Video: HTML5 <video> ile webm oynatma
 *   - Console: log listesi
 *   - Network: request detayları
 *
 * Hassas anahtarlar JSON gövdelerinde recursive olarak [REDACTED] ile
 * değiştirilir.
 */

(function () {
  'use strict';

  // === Hassas veri filtresi ================================================
  const SENSITIVE_KEYS = [
    'password', 'pass', 'pwd',
    'token', 'access_token', 'refresh_token',
    'authorization', 'auth',
    'cookie', 'set-cookie',
    'apikey', 'api_key', 'x-api-key',
    'secret', 'client_secret',
    'session', 'sessionid', 'jsessionid'
  ];

  function isSensitiveKey(k) {
    if (!k) return false;
    const lk = String(k).toLowerCase();
    return SENSITIVE_KEYS.some((s) => lk === s || lk.includes(s));
  }

  function redactObject(obj) {
    if (obj == null) return obj;
    if (Array.isArray(obj)) return obj.map(redactObject);
    if (typeof obj === 'object') {
      const out = {};
      for (const k of Object.keys(obj)) {
        out[k] = isSensitiveKey(k) ? '[REDACTED]' : redactObject(obj[k]);
      }
      return out;
    }
    return obj;
  }

  function redactHeaders(headers) {
    if (!headers || typeof headers !== 'object') return headers;
    const out = {};
    for (const k of Object.keys(headers)) {
      out[k] = isSensitiveKey(k) ? '[REDACTED]' : headers[k];
    }
    return out;
  }

  function redactBodyString(str) {
    if (str == null) return str;
    if (typeof str !== 'string') return str;
    const trimmed = str.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.stringify(redactObject(JSON.parse(trimmed)), null, 2);
      } catch (_) {}
    }
    return str.replace(
      /([?&]?)([^=&\s]+)=([^&\s]+)/g,
      (m, sep, key) => (isSensitiveKey(key) ? `${sep}${key}=[REDACTED]` : m)
    );
  }

  // Export için: gövde JSON ise gerçek obje olarak döner (escaped string değil),
  // değilse redacted string döner. ZIP içindeki network.json'un okunaklı olması
  // için kullanılır.
  function parseAndRedactBody(str) {
    if (str == null) return null;
    if (typeof str !== 'string') return str;
    const trimmed = str.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return redactObject(JSON.parse(trimmed));
      } catch (_) {}
    }
    return redactBodyString(str);
  }

  // === IndexedDB ===========================================================

  const DB_NAME = 'reproBlackbox';
  const DB_VERSION = 1;

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('videos')) db.createObjectStore('videos');
        if (!db.objectStoreNames.contains('sessions'))
          db.createObjectStore('sessions', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getSession(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('sessions', 'readonly');
      const req = tx.objectStore('sessions').get(id);
      req.onsuccess = () => {
        db.close();
        resolve(req.result || null);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  }

  async function getVideo(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('videos', 'readonly');
      const req = tx.objectStore('videos').get(id);
      req.onsuccess = () => {
        db.close();
        resolve(req.result || null);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  }

  // === Yükleme =============================================================

  let session = null;
  let videoBlob = null;

  async function loadSession() {
    const params = new URLSearchParams(location.search);
    let id = params.get('id');
    if (!id) {
      const obj = await chrome.storage.local.get('repro:lastSessionId');
      id = obj['repro:lastSessionId'];
    }
    if (!id) {
      document.getElementById('videoEmpty').textContent = 'Session bulunamadı.';
      return null;
    }
    const sess = await getSession(id);
    if (!sess) {
      document.getElementById('videoEmpty').textContent =
        'IndexedDB\'de session bulunamadı (id=' + id + ').';
      return null;
    }
    return sess;
  }

  // === Render ==============================================================

  function fmtDuration(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function fmtSize(bytes) {
    if (!bytes) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < u.length - 1) {
      n /= 1024;
      i++;
    }
    return n.toFixed(n >= 100 ? 0 : 1) + ' ' + u[i];
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtTs(t) {
    if (!t) return '';
    const d = new Date(t);
    return (
      String(d.getHours()).padStart(2, '0') +
      ':' +
      String(d.getMinutes()).padStart(2, '0') +
      ':' +
      String(d.getSeconds()).padStart(2, '0')
    );
  }

  function renderMeta() {
    const m = session.meta;
    const bar = document.getElementById('metaBar');
    const host = (() => {
      try {
        return new URL(m.url).host;
      } catch (_) {
        return m.url || '—';
      }
    })();
    bar.innerHTML = `
      <span><b>Site</b> ${escapeHtml(host)}</span>
      <span><b>Süre</b> ${fmtDuration(m.duration || 0)}</span>
      <span><b>Tarih</b> ${new Date(m.startedAt).toLocaleString()}</span>
      <span><b>Viewport</b> ${m.viewport ? m.viewport.width + '×' + m.viewport.height : '—'}</span>
      ${m.video ? `<span><b>Video</b> ${fmtSize(m.video.size)}</span>` : ''}
    `;

    const errors = session.events.console.filter((c) => c.level === 'error').length;
    const warnings = session.events.console.filter((c) => c.level === 'warn').length;
    const failed = session.events.network.filter(
      (n) => !n.ok || n.status === 0 || n.status >= 400
    ).length;

    const summary = document.getElementById('summary');
    summary.innerHTML = `
      <div class="card"><div class="k">Console logs</div><div class="v">${session.events.console.length}</div></div>
      <div class="card"><div class="k">Errors</div><div class="v ${errors ? 'danger' : ''}">${errors}</div></div>
      <div class="card"><div class="k">Warnings</div><div class="v ${warnings ? 'warn' : ''}">${warnings}</div></div>
      <div class="card"><div class="k">Network</div><div class="v">${session.events.network.length}</div></div>
      <div class="card"><div class="k">Başarısız</div><div class="v ${failed ? 'danger' : ''}">${failed}</div></div>
    `;
  }

  function renderVideo() {
    const mount = document.getElementById('videoMount');
    if (!videoBlob) {
      mount.innerHTML = '<div class="video-empty">Video bu session için kaydedilmemiş.</div>';
      return;
    }
    const url = URL.createObjectURL(videoBlob);
    mount.innerHTML = '';
    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    video.autoplay = false;
    mount.appendChild(video);
  }

  function renderConsole() {
    const list = document.getElementById('consoleList');
    const logs = session.events.console;
    document.getElementById('badgeConsole').textContent = logs.length;
    if (!logs.length) {
      list.innerHTML = '<div class="empty">Hiç log yok.</div>';
      return;
    }
    list.innerHTML = logs
      .map((log) => {
        const argsText = log.args
          .map((a) => {
            if (a == null) return String(a);
            if (typeof a === 'object') {
              try {
                return JSON.stringify(redactObject(a), null, 2);
              } catch (_) {
                return String(a);
              }
            }
            return String(a);
          })
          .join(' ');
        return `<div class="log-row">
          <span class="lvl ${log.level}">${log.level}</span>
          <span class="ts">${fmtTs(log.t)}</span>
          <span class="msg">${escapeHtml(argsText)}</span>
        </div>`;
      })
      .join('');
  }

  function statusClass(s) {
    if (!s) return 's0';
    if (s >= 500) return 's5';
    if (s >= 400) return 's4';
    if (s >= 300) return 's3';
    return 's2';
  }

  function renderNetwork() {
    const list = document.getElementById('netList');
    const items = session.events.network;
    document.getElementById('badgeNetwork').textContent = items.length;
    if (!items.length) {
      list.innerHTML = '<div class="empty">Hiç istek yakalanmadı.</div>';
      return;
    }
    list.innerHTML = items
      .map((n, i) => {
        const sCls = statusClass(n.status);
        const url = n.url || '';
        const reqHeaders = JSON.stringify(redactHeaders(n.requestHeaders || {}), null, 2);
        const resHeaders = JSON.stringify(redactHeaders(n.responseHeaders || {}), null, 2);
        const reqBody = redactBodyString(n.requestBody) || '(boş)';
        const resBody = redactBodyString(n.responseBody) || '(boş)';
        return `<div class="net-row" data-idx="${i}">
          <div class="net-head">
            <span class="method">${escapeHtml(n.method)}</span>
            <span class="status ${sCls}">${n.status || '—'}</span>
            <span class="url" title="${escapeHtml(url)}">${escapeHtml(url)}</span>
            <span class="dur">${n.duration || 0} ms</span>
            <span class="dur">${escapeHtml(n.kind || '')}</span>
          </div>
          <div class="net-detail">
            <h4>Request Headers</h4><pre>${escapeHtml(reqHeaders)}</pre>
            <h4>Request Body</h4><pre>${escapeHtml(reqBody)}</pre>
            <h4>Response Headers</h4><pre>${escapeHtml(resHeaders)}</pre>
            <h4>Response Body</h4><pre>${escapeHtml(resBody)}</pre>
            ${n.error ? `<h4>Error</h4><pre>${escapeHtml(n.error)}</pre>` : ''}
          </div>
        </div>`;
      })
      .join('');

    list.querySelectorAll('.net-head').forEach((h) =>
      h.addEventListener('click', () => h.parentElement.classList.toggle('open'))
    );
  }

  // === Sockets =============================================================

  function arrowFor(kind) {
    switch (kind) {
      case 'send':
        return '↑';
      case 'recv':
      case 'sse-msg':
        return '↓';
      case 'open':
      case 'sse-open':
        return '◯';
      case 'close':
        return '✕';
      case 'error':
        return '!';
      default:
        return '·';
    }
  }

  function renderSockets() {
    const list = document.getElementById('wsList');
    const items = session.events.ws || [];
    document.getElementById('badgeSockets').textContent = items.length;
    if (!items.length) {
      list.innerHTML = '<div class="empty">Hiç socket trafiği yok.</div>';
      return;
    }
    list.innerHTML = items
      .map((w) => {
        const kind = w.kind || '';
        const arrow = arrowFor(kind);
        let body = '';
        if (kind === 'send' || kind === 'recv' || kind === 'sse-msg') {
          const parsed = parseAndRedactBody(w.data);
          body =
            typeof parsed === 'object' && parsed !== null
              ? JSON.stringify(parsed, null, 2)
              : String(parsed == null ? '' : parsed);
        } else if (kind === 'close') {
          body = `code=${w.code || '—'}${w.reason ? ' reason=' + w.reason : ''}`;
        } else if (kind === 'open') {
          body = w.protocols ? 'protocols=' + JSON.stringify(w.protocols) : '(opened)';
        } else if (kind === 'sse-open') {
          body = '(SSE opened)';
        } else if (kind === 'error') {
          body = '(socket error)';
        }
        return `<div class="ws-row ${escapeHtml(kind)}">
          <span class="arrow">${arrow}</span>
          <span class="ts">${fmtTs(w.t)}<br/><span style="opacity:.5">${escapeHtml(kind)}</span></span>
          <div>
            <div class="url">${escapeHtml(w.url || '')}</div>
            <div class="body">${escapeHtml(body)}</div>
          </div>
        </div>`;
      })
      .join('');

    list.querySelectorAll('.ws-row').forEach((r) =>
      r.addEventListener('click', () => r.classList.toggle('expanded'))
    );
  }

  // === Sekmeler ============================================================

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('panel-' + tab.dataset.panel).classList.add('active');
    });
  });

  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 1800);
  }

  // === Markdown rapor ======================================================

  function buildMarkdown() {
    const m = session.meta;
    const errors = session.events.console.filter((c) => c.level === 'error');
    const warns = session.events.console.filter((c) => c.level === 'warn');
    const failed = session.events.network.filter(
      (n) => !n.ok || n.status === 0 || n.status >= 400
    );

    const lines = [];
    lines.push('## 🐛 Repro Blackbox Report');
    lines.push('');
    lines.push(`**URL:** ${m.url || '—'}`);
    lines.push(`**Tarih:** ${new Date(m.startedAt).toISOString()}`);
    lines.push(`**Tarayıcı:** ${m.userAgent || '—'}`);
    lines.push(
      `**Viewport:** ${m.viewport ? m.viewport.width + '×' + m.viewport.height : '—'}`
    );
    lines.push(`**Kayıt Süresi:** ${fmtDuration(m.duration || 0)}`);
    if (m.video) {
      lines.push(`**Video:** ${fmtSize(m.video.size)} (${m.video.mimeType})`);
    }
    lines.push('');
    lines.push('### Özet');
    lines.push(`- ${errors.length} console error · ${warns.length} warning`);
    lines.push(
      `- ${failed.length} başarısız istek · ${session.events.network.length} toplam istek`
    );
    lines.push('');

    if (errors.length) {
      lines.push('### Console Errors');
      errors.slice(0, 20).forEach((e) => {
        const text = e.args
          .map((a) =>
            typeof a === 'object' ? JSON.stringify(redactObject(a)) : String(a)
          )
          .join(' ');
        lines.push('```');
        lines.push(text);
        if (e.stack) lines.push('  ' + String(e.stack).split('\n').slice(0, 3).join('\n  '));
        lines.push('```');
      });
      lines.push('');
    }

    if (failed.length) {
      lines.push('### Network — Başarısız İstekler');
      failed.slice(0, 15).forEach((n) => {
        lines.push(`#### ❌ ${n.method} ${n.url} → ${n.status || 'ERR'}`);
        lines.push('**Request Body:**');
        lines.push('```');
        lines.push(redactBodyString(n.requestBody) || '(boş)');
        lines.push('```');
        lines.push('**Response Body:**');
        lines.push('```');
        lines.push(redactBodyString(n.responseBody) || '(boş)');
        lines.push('```');
        lines.push(`**Duration:** ${n.duration || 0}ms`);
        if (n.error) lines.push(`**Error:** ${n.error}`);
        lines.push('');
      });
    }

    lines.push('### Ekler');
    lines.push(`Sekme videosu için ZIP içindeki \`recording.${videoExt()}\` dosyasını oynatın.`);
    return lines.join('\n');
  }

  // === Çıktılar ============================================================

  function tsForFile() {
    return new Date(session.meta.startedAt || Date.now())
      .toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, 19);
  }

  function videoExt() {
    const t = (videoBlob && videoBlob.type) || (session.meta.video && session.meta.video.mimeType) || '';
    return t.startsWith('video/mp4') ? 'mp4' : 'webm';
  }

  async function downloadVideo() {
    if (!videoBlob) {
      toast('Video bulunamadı');
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(videoBlob);
    a.download = `repro-blackbox-${tsForFile()}.${videoExt()}`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
    toast('Video indiriliyor…');
  }

  async function downloadZip() {
    if (typeof JSZip === 'undefined') {
      toast('JSZip yüklü değil — lib/jszip.min.js ekleyin.');
      return;
    }
    const zip = new JSZip();

    // Logical sırayla yeniden inşa et + JSON gövdeleri parse et
    const cleanedNetwork = session.events.network.map((n) => ({
      timestamp: n.startedAt ? new Date(n.startedAt).toISOString() : null,
      method: n.method,
      url: n.url,
      status: n.status,
      statusText: n.statusText,
      ok: n.ok,
      duration: n.duration,
      kind: n.kind,
      requestHeaders: redactHeaders(n.requestHeaders),
      requestBody: parseAndRedactBody(n.requestBody),
      responseHeaders: redactHeaders(n.responseHeaders),
      responseBody: parseAndRedactBody(n.responseBody),
      error: n.error,
      id: n.id
    }));
    const cleanedConsole = session.events.console.map((c) => ({
      ...c,
      args: c.args.map((a) =>
        typeof a === 'object' && a !== null ? redactObject(a) : a
      )
    }));

    const cleanedSockets = (session.events.ws || []).map((w) => {
      const out = {
        timestamp: w.t ? new Date(w.t).toISOString() : null,
        kind: w.kind,
        url: w.url,
        wsId: w.wsId
      };
      if (w.kind === 'send' || w.kind === 'recv' || w.kind === 'sse-msg') {
        out.data = parseAndRedactBody(w.data);
      }
      if (w.kind === 'open') out.protocols = w.protocols;
      if (w.kind === 'close') {
        out.code = w.code;
        out.reason = w.reason;
      }
      return out;
    });

    if (videoBlob) {
      zip.file(`recording.${videoExt()}`, videoBlob);
    }
    zip.file('console.json', JSON.stringify(cleanedConsole, null, 2));
    zip.file('network.json', JSON.stringify(cleanedNetwork, null, 2));
    zip.file('sockets.json', JSON.stringify(cleanedSockets, null, 2));
    zip.file('meta.json', JSON.stringify(session.meta, null, 2));
    zip.file('REPORT.md', buildMarkdown());

    const blob = await zip.generateAsync({ type: 'blob' });

    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `repro-blackbox-${tsForFile()}.zip`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
    toast('ZIP indiriliyor…');
  }

  async function copyMarkdown() {
    const md = buildMarkdown();
    try {
      await navigator.clipboard.writeText(md);
      toast('Markdown panoya kopyalandı');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = md;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('Markdown kopyalandı');
    }
  }

  // === Init ================================================================

  (async function init() {
    session = await loadSession();
    if (!session) return;
    if (session.meta.video) {
      try {
        videoBlob = await getVideo(session.id);
      } catch (e) {
        console.warn('[Repro] video okunamadı', e);
      }
    }
    renderMeta();
    renderVideo();
    renderConsole();
    renderNetwork();
    renderSockets();

    document.getElementById('btnZip').addEventListener('click', downloadZip);
    document.getElementById('btnVideo').addEventListener('click', downloadVideo);
    document.getElementById('btnCopyMd').addEventListener('click', copyMarkdown);
  })();
})();
