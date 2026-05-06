/*
 * inject.js
 * MAIN world içine enjekte edilir. Görevi:
 *   - window.fetch ve XMLHttpRequest çağrılarını sarmalayıp
 *     request/response gövdelerini yakalamak.
 *   - WebSocket / EventSource bağlantı kurulumlarını yakalamak.
 *   - console hijack ve uncaught error/rejection yakalamak.
 *   - Yakalanan veriyi window.postMessage ile content.js'e iletmek.
 *
 * Görsel kayıt için rrweb KULLANMIYORUZ; onu chrome.tabCapture +
 * MediaRecorder ile native olarak yapıyoruz (offscreen.js içinde).
 */

(function () {
  'use strict';

  if (window.__REPRO_BLACKBOX_INJECTED__) return;
  window.__REPRO_BLACKBOX_INJECTED__ = true;

  const CHANNEL = 'REPRO_BLACKBOX';
  const MAX_BODY_BYTES = 100 * 1024; // 100 KB
  const SKIP_CONTENT_TYPES = ['image/', 'video/', 'audio/', 'font/'];

  function send(type, payload) {
    try {
      window.postMessage(
        { source: CHANNEL, type, payload, t: Date.now() },
        '*'
      );
    } catch (_) {
      /* sayfa CSP'si engelleyebilir, sessiz geç */
    }
  }

  function shouldSkipBody(contentType) {
    if (!contentType) return false;
    const ct = String(contentType).toLowerCase();
    return SKIP_CONTENT_TYPES.some((p) => ct.startsWith(p));
  }

  function truncate(text) {
    if (text == null) return text;
    const str = typeof text === 'string' ? text : String(text);
    if (str.length <= MAX_BODY_BYTES) return str;
    return str.slice(0, MAX_BODY_BYTES) + '\n[truncated]';
  }

  function headersToObject(headers) {
    const out = {};
    if (!headers) return out;
    try {
      if (typeof headers.forEach === 'function') {
        headers.forEach((value, key) => {
          out[key] = value;
        });
      } else if (Array.isArray(headers)) {
        for (const [k, v] of headers) out[k] = v;
      } else if (typeof headers === 'object') {
        for (const k of Object.keys(headers)) out[k] = headers[k];
      }
    } catch (_) {}
    return out;
  }

  function parseRawHeaders(rawHeaders) {
    const out = {};
    if (!rawHeaders) return out;
    rawHeaders
      .trim()
      .split(/[\r\n]+/)
      .forEach((line) => {
        const idx = line.indexOf(':');
        if (idx > -1) out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      });
    return out;
  }

  async function readRequestBody(input) {
    if (input == null) return null;
    try {
      if (typeof input === 'string') return truncate(input);
      if (input instanceof URLSearchParams) return truncate(input.toString());
      if (input instanceof FormData) {
        const obj = {};
        for (const [k, v] of input.entries()) {
          obj[k] = v instanceof File ? `[File ${v.name} (${v.size}b)]` : String(v);
        }
        return truncate(JSON.stringify(obj));
      }
      if (input instanceof Blob) {
        if (shouldSkipBody(input.type)) {
          return `[${input.type || 'blob'} — ${input.size}b]`;
        }
        const text = await input.slice(0, MAX_BODY_BYTES).text();
        return truncate(text);
      }
      if (input instanceof ArrayBuffer) {
        return `[ArrayBuffer ${input.byteLength}b]`;
      }
      return truncate(JSON.stringify(input));
    } catch (e) {
      return `[unreadable body: ${e && e.message}]`;
    }
  }

  // === fetch wrap ==========================================================

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function reproFetch(resource, init) {
      const id = `f_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const startedAt = performance.now();

      let url = '';
      let method = 'GET';
      let reqHeaders = {};
      let reqBodyPromise = Promise.resolve(null);

      try {
        if (resource instanceof Request) {
          url = resource.url;
          method = resource.method || 'GET';
          reqHeaders = headersToObject(resource.headers);
          if (init && init.body != null) {
            reqBodyPromise = readRequestBody(init.body);
          } else {
            try {
              const clone = resource.clone();
              reqBodyPromise = clone.text().then(truncate).catch(() => null);
            } catch (_) {
              reqBodyPromise = Promise.resolve(null);
            }
          }
        } else {
          url = String(resource);
          method = (init && init.method) || 'GET';
          reqHeaders = headersToObject(init && init.headers);
          if (init && init.body != null) {
            reqBodyPromise = readRequestBody(init.body);
          }
        }
      } catch (_) {}

      const fetchPromise = origFetch.apply(this, arguments);

      fetchPromise.then(
        async (response) => {
          const duration = performance.now() - startedAt;
          let respBody = null;
          let respHeaders = {};
          let status = 0;
          let statusText = '';
          try {
            status = response.status;
            statusText = response.statusText;
            respHeaders = headersToObject(response.headers);
            const ct = respHeaders['content-type'] || '';
            if (shouldSkipBody(ct)) {
              const len = respHeaders['content-length'];
              respBody = `[${ct} — ${len ? len + 'b' : 'unknown size'}]`;
            } else {
              const cloned = response.clone();
              const text = await cloned.text();
              respBody = truncate(text);
            }
          } catch (e) {
            respBody = `[unreadable response: ${e && e.message}]`;
          }

          const reqBody = await reqBodyPromise.catch(() => null);

          send('network', {
            id,
            kind: 'fetch',
            url,
            method,
            requestHeaders: reqHeaders,
            requestBody: reqBody,
            status,
            statusText,
            responseHeaders: respHeaders,
            responseBody: respBody,
            duration: Math.round(duration),
            startedAt: Date.now() - Math.round(duration),
            ok: response.ok,
            error: null
          });
        },
        async (err) => {
          const duration = performance.now() - startedAt;
          const reqBody = await reqBodyPromise.catch(() => null);
          send('network', {
            id,
            kind: 'fetch',
            url,
            method,
            requestHeaders: reqHeaders,
            requestBody: reqBody,
            status: 0,
            statusText: '',
            responseHeaders: {},
            responseBody: null,
            duration: Math.round(duration),
            startedAt: Date.now() - Math.round(duration),
            ok: false,
            error: (err && (err.message || String(err))) || 'fetch error'
          });
        }
      );

      return fetchPromise;
    };
  }

  // === XMLHttpRequest wrap =================================================

  const OrigXHR = window.XMLHttpRequest;
  if (typeof OrigXHR === 'function') {
    const origOpen = OrigXHR.prototype.open;
    const origSend = OrigXHR.prototype.send;
    const origSetRequestHeader = OrigXHR.prototype.setRequestHeader;

    OrigXHR.prototype.open = function (method, url) {
      this.__repro = {
        id: `x_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        method: String(method || 'GET'),
        url: String(url || ''),
        requestHeaders: {},
        requestBody: null,
        startedAt: 0
      };
      return origOpen.apply(this, arguments);
    };

    OrigXHR.prototype.setRequestHeader = function (name, value) {
      try {
        if (this.__repro) this.__repro.requestHeaders[name] = value;
      } catch (_) {}
      return origSetRequestHeader.apply(this, arguments);
    };

    OrigXHR.prototype.send = function (body) {
      const xhr = this;
      const meta = xhr.__repro;

      if (meta) {
        meta.startedAt = performance.now();
        readRequestBody(body).then((b) => {
          meta.requestBody = b;
        });

        const onDone = () => {
          const duration = performance.now() - meta.startedAt;
          let respHeaders = {};
          let respBody = null;
          try {
            respHeaders = parseRawHeaders(xhr.getAllResponseHeaders());
          } catch (_) {}

          try {
            const ct = respHeaders['content-type'] || '';
            if (shouldSkipBody(ct)) {
              respBody = `[${ct}]`;
            } else if (xhr.responseType === '' || xhr.responseType === 'text') {
              respBody = truncate(xhr.responseText || '');
            } else if (xhr.responseType === 'json') {
              respBody = truncate(JSON.stringify(xhr.response));
            } else if (xhr.responseType === 'blob' && xhr.response) {
              respBody = `[blob ${xhr.response.size}b]`;
            } else if (xhr.responseType === 'arraybuffer' && xhr.response) {
              respBody = `[arraybuffer ${xhr.response.byteLength}b]`;
            } else {
              respBody = `[${xhr.responseType || 'unknown'} response]`;
            }
          } catch (e) {
            respBody = `[unreadable: ${e && e.message}]`;
          }

          send('network', {
            id: meta.id,
            kind: 'xhr',
            url: meta.url,
            method: meta.method,
            requestHeaders: meta.requestHeaders,
            requestBody: meta.requestBody,
            status: xhr.status,
            statusText: xhr.statusText,
            responseHeaders: respHeaders,
            responseBody: respBody,
            duration: Math.round(duration),
            startedAt: Date.now() - Math.round(duration),
            ok: xhr.status >= 200 && xhr.status < 400,
            error: null
          });
        };

        const onError = () => {
          const duration = performance.now() - meta.startedAt;
          send('network', {
            id: meta.id,
            kind: 'xhr',
            url: meta.url,
            method: meta.method,
            requestHeaders: meta.requestHeaders,
            requestBody: meta.requestBody,
            status: xhr.status || 0,
            statusText: xhr.statusText || '',
            responseHeaders: {},
            responseBody: null,
            duration: Math.round(duration),
            startedAt: Date.now() - Math.round(duration),
            ok: false,
            error: 'xhr error'
          });
        };

        xhr.addEventListener('loadend', () => {
          if (xhr.readyState === 4) onDone();
        });
        xhr.addEventListener('error', onError);
        xhr.addEventListener('abort', onError);
        xhr.addEventListener('timeout', onError);
      }

      return origSend.apply(this, arguments);
    };
  }

  // === Socket payload helper ==============================================
  function serializeSocketData(data) {
    if (data == null) return null;
    try {
      if (typeof data === 'string') return truncate(data);
      if (typeof Blob !== 'undefined' && data instanceof Blob) {
        return `[Blob ${data.size}b ${data.type || ''}]`;
      }
      if (data instanceof ArrayBuffer) {
        return `[ArrayBuffer ${data.byteLength}b]`;
      }
      if (ArrayBuffer.isView(data)) {
        return `[${data.constructor.name} ${data.byteLength}b]`;
      }
      return truncate(JSON.stringify(data));
    } catch (_) {
      return String(data);
    }
  }

  // === WebSocket — kuruluş + mesaj akışı ==================================

  const OrigWS = window.WebSocket;
  if (typeof OrigWS === 'function') {
    function ReproWS(url, protocols) {
      const wsId = `ws_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const urlStr = String(url);
      send('ws', { wsId, url: urlStr, protocols: protocols || null, kind: 'open' });

      const ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);

      // Outgoing frames — instance düzeyinde wrap
      try {
        const origSend = ws.send.bind(ws);
        ws.send = function (data) {
          try {
            send('ws', {
              wsId,
              url: urlStr,
              kind: 'send',
              data: serializeSocketData(data)
            });
          } catch (_) {}
          return origSend(data);
        };
      } catch (_) {}

      // Incoming frames
      try {
        ws.addEventListener('message', (ev) => {
          send('ws', {
            wsId,
            url: urlStr,
            kind: 'recv',
            data: serializeSocketData(ev.data)
          });
        });
        ws.addEventListener('error', () =>
          send('ws', { wsId, url: urlStr, kind: 'error' })
        );
        ws.addEventListener('close', (e) =>
          send('ws', {
            wsId,
            url: urlStr,
            kind: 'close',
            code: e.code,
            reason: e.reason
          })
        );
      } catch (_) {}
      return ws;
    }
    ReproWS.prototype = OrigWS.prototype;
    ReproWS.CONNECTING = OrigWS.CONNECTING;
    ReproWS.OPEN = OrigWS.OPEN;
    ReproWS.CLOSING = OrigWS.CLOSING;
    ReproWS.CLOSED = OrigWS.CLOSED;
    try {
      window.WebSocket = ReproWS;
    } catch (_) {}
  }

  // === EventSource — kuruluş + 'message' eventi ===========================

  const OrigES = window.EventSource;
  if (typeof OrigES === 'function') {
    function ReproES(url, init) {
      const wsId = `es_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const urlStr = String(url);
      send('ws', { wsId, url: urlStr, kind: 'sse-open' });
      const es = init !== undefined ? new OrigES(url, init) : new OrigES(url);
      try {
        es.addEventListener('message', (ev) => {
          send('ws', {
            wsId,
            url: urlStr,
            kind: 'sse-msg',
            data: serializeSocketData(ev.data)
          });
        });
        es.addEventListener('error', () =>
          send('ws', { wsId, url: urlStr, kind: 'error' })
        );
      } catch (_) {}
      return es;
    }
    ReproES.prototype = OrigES.prototype;
    try {
      window.EventSource = ReproES;
    } catch (_) {}
  }

  // === console hijack ======================================================

  const consoleLevels = ['log', 'warn', 'error', 'info', 'debug'];
  consoleLevels.forEach((level) => {
    const orig = console[level];
    if (typeof orig !== 'function') return;
    console[level] = function (...args) {
      try {
        const serialized = args.map((a) => {
          try {
            if (a instanceof Error) {
              return { __type: 'Error', name: a.name, message: a.message, stack: a.stack };
            }
            if (typeof a === 'object') return JSON.parse(JSON.stringify(a));
            return a;
          } catch (_) {
            return String(a);
          }
        });
        let stack = null;
        if (level === 'error' || level === 'warn') {
          stack = new Error().stack;
        }
        send('console', { level, args: serialized, stack });
      } catch (_) {}
      return orig.apply(this, args);
    };
  });

  window.addEventListener('error', (e) => {
    send('console', {
      level: 'error',
      args: [
        {
          __type: 'UncaughtError',
          message: e.message,
          filename: e.filename,
          lineno: e.lineno,
          colno: e.colno,
          stack: e.error && e.error.stack
        }
      ],
      stack: e.error && e.error.stack
    });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    send('console', {
      level: 'error',
      args: [
        {
          __type: 'UnhandledRejection',
          message: (reason && reason.message) || String(reason),
          stack: reason && reason.stack
        }
      ],
      stack: reason && reason.stack
    });
  });

  send('inject-ready', { url: location.href });
})();
