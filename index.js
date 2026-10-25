/**
 * Generic web proxy with a built-in tabbed browser.
 *
 * - Open the worker's root (/) to use the browser: tabs, back/forward/reload,
 *   and an address bar. Links that would open a new tab (target="_blank",
 *   window.open(), Ctrl/Cmd/middle-click) open a new tab inside the browser.
 * - /?url=https://example.com proxies that page directly.
 *
 * Optional: bind a KV namespace named CACHE_KV to enable response caching.
 */

/** Alias for the browser UI (the root / with no ?url= also serves it). */
const SHELL_PATH = '/__browser'

/** Page shown in a brand-new tab. */
const NEWTAB_PATH = '/__newtab'

/** How long cached responses stay valid, in seconds. */
const CACHE_TTL_SECONDS = 60

/** Chunk size used when converting bytes to base64. */
const BASE64_CHUNK_SIZE = 8192

/** Statuses that MUST have a null body. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

/** Basic SSRF guard: hostnames we refuse to proxy to. */
const BLOCKED_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^\[?::1\]?$/,
  /^\[?fc[0-9a-f]{2}:/i,
  /^\[?fe80:/i,
  /\.internal$/i
]

/**
 * Script injected at the top of every proxied HTML page. When the page is
 * inside a browser tab, it tells the parent (the browser UI) to open a new
 * tab instead of a real browser tab. Because it runs before the page's own
 * scripts, early window.open() calls are caught too.
 * (No backticks or dollar-brace sequences allowed in here.)
 */
const INJECT_SCRIPT = `<script>
(function () {
  var O = location.origin;
  var framed = window.parent !== window;

  function realBase() {
    try { return new URL(location.href).searchParams.get('url') || location.href; }
    catch (e) { return location.href; }
  }

  function prox(raw) {
    try {
      var u = new URL(String(raw), realBase());
      if (u.origin === O) return u.searchParams.get('url') ? u.href : null;
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        return O + '/?url=' + encodeURIComponent(u.href);
      }
    } catch (e) {}
    return null;
  }

  function sendNewTab(raw) {
    var p = prox(raw);
    if (p) window.parent.postMessage({ __proxyNewTab: p }, O);
  }

  function isNewTarget(t) {
    return !!t && t !== '_self' && t !== '_parent' && t !== '_top';
  }

  if (framed) {
    window.open = function (url) {
      if (url) sendNewTab(url);
      return null;
    };

    function onLink(e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      if (e.type === 'auxclick' && e.button !== 1) return;
      var baseEl = document.querySelector('base[target]');
      var t = a.getAttribute('target') || (baseEl ? baseEl.getAttribute('target') : '');
      var modifier = e.ctrlKey || e.metaKey || e.button === 1;
      if (!isNewTarget(t) && !modifier) return;
      e.preventDefault();
      sendNewTab(a.href);
    }
    document.addEventListener('click', onLink, true);
    document.addEventListener('auxclick', onLink, true);
  }

  // Forms: a GET form would drop the ?url= part of its action, so rebuild it.
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || !f.getAttribute) return;
    var wantsNew = framed && isNewTarget(f.getAttribute('target'));
    var method = (f.getAttribute('method') || 'get').toLowerCase();

    if (method === 'get') {
      var real = '';
      try { real = new URL(f.action, location.href).searchParams.get('url') || ''; } catch (err) {}
      if (!real) return;
      e.preventDefault();
      var target = new URL(real);
      target.search = new URLSearchParams(new FormData(f)).toString();
      var proxied = O + '/?url=' + encodeURIComponent(target.href);
      if (wantsNew) window.parent.postMessage({ __proxyNewTab: proxied }, O);
      else location.href = proxied;
    } else if (isNewTarget(f.getAttribute('target'))) {
      f.setAttribute('target', '_self');
    }
  }, true);
})();
</script>`

/**
 * The tabbed browser page. Each tab is an iframe pointing at this worker.
 */
const SHELL_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Browser</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #1e1f22; color: #e6e6e6;
    font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  #app { display: flex; flex-direction: column; height: 100vh; height: 100dvh; }
  #tabs { display: flex; gap: 2px; padding: 6px 6px 0; background: #131416;
    overflow-x: auto; flex: none; }
  .tab { display: flex; align-items: center; gap: 6px; min-width: 120px; max-width: 200px;
    padding: 7px 8px 7px 12px; background: #2a2b2f; border-radius: 8px 8px 0 0;
    cursor: pointer; flex: none; }
  .tab.active { background: #3b3d42; }
  .tab .label { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .tab .close { border: 0; background: transparent; color: inherit; font-size: 16px;
    line-height: 1; padding: 2px 5px; border-radius: 4px; cursor: pointer; }
  .tab .close:hover { background: #555; }
  #newtab { border: 0; background: transparent; color: inherit; font-size: 20px;
    padding: 0 12px; cursor: pointer; flex: none; }
  #toolbar { display: flex; gap: 6px; padding: 6px; background: #3b3d42; flex: none; }
  #toolbar button { border: 0; background: #4a4c52; color: inherit; border-radius: 6px;
    padding: 6px 12px; font-size: 15px; cursor: pointer; }
  #toolbar button:hover { background: #5a5c63; }
  #urlform { flex: 1; display: flex; }
  #url { flex: 1; min-width: 0; border: 0; border-radius: 6px; padding: 7px 12px;
    background: #1e1f22; color: inherit; font-size: 14px; outline: none; }
  #view { flex: 1; position: relative; background: #fff; }
  #view iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0;
    background: #fff; display: none; }
  #view iframe.active { display: block; }
</style>
</head>
<body>
<div id="app">
  <div id="tabs"><button id="newtab" title="New tab">+</button></div>
  <div id="toolbar">
    <button id="back" title="Back">&#8592;</button>
    <button id="forward" title="Forward">&#8594;</button>
    <button id="reload" title="Reload">&#8635;</button>
    <form id="urlform"><input id="url" type="text" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Enter a URL or search"></form>
  </div>
  <div id="view"></div>
</div>
<script>
(function () {
  var NEWTAB = '/__newtab';
  var tabsEl = document.getElementById('tabs');
  var newTabBtn = document.getElementById('newtab');
  var viewEl = document.getElementById('view');
  var urlEl = document.getElementById('url');
  var tabs = [];
  var active = null;

  // The real (un-proxied) URL a proxied address points at
  function realUrlOf(href) {
    try { return new URL(href).searchParams.get('url') || ''; } catch (e) { return ''; }
  }

  // Address-bar text -> proxied path (URL, bare domain, or a search)
  function fromAddressBar(v) {
    var low = v.toLowerCase();
    var full;
    if (low.indexOf('http://') === 0 || low.indexOf('https://') === 0) {
      full = v;
    } else if (v.indexOf(' ') === -1 && v.indexOf('.') !== -1) {
      full = 'https://' + v;
    } else {
      full = 'https://duckduckgo.com/html/?q=' + encodeURIComponent(v);
    }
    return '/?url=' + encodeURIComponent(full);
  }

  function newTab(src) {
    var tab = { src: src || NEWTAB, real: '', title: 'New tab' };

    var frame = document.createElement('iframe');
    frame.setAttribute('allow', 'fullscreen');
    tab.frame = frame;

    var el = document.createElement('div');
    el.className = 'tab';
    var label = document.createElement('span');
    label.className = 'label';
    label.textContent = tab.title;
    var close = document.createElement('button');
    close.className = 'close';
    close.textContent = '\\u00d7';
    el.appendChild(label);
    el.appendChild(close);
    tab.el = el;
    tab.label = label;

    el.addEventListener('click', function () { activate(tab); });
    close.addEventListener('click', function (e) { e.stopPropagation(); closeTab(tab); });
    frame.addEventListener('load', function () { sync(tab); });

    tabsEl.insertBefore(el, newTabBtn);
    viewEl.appendChild(frame);
    tabs.push(tab);
    frame.src = tab.src;
    activate(tab);
    return tab;
  }

  function activate(tab) {
    active = tab;
    tabs.forEach(function (t) {
      t.el.classList.toggle('active', t === tab);
      t.frame.classList.toggle('active', t === tab);
    });
    urlEl.value = tab.real;
    document.title = tab.title;
  }

  function closeTab(tab) {
    var i = tabs.indexOf(tab);
    if (i === -1) return;
    tabs.splice(i, 1);
    tab.el.remove();
    tab.frame.remove();
    if (tabs.length === 0) { newTab(NEWTAB); return; }
    if (active === tab) activate(tabs[Math.min(i, tabs.length - 1)]);
  }

  function sync(tab) {
    try {
      var w = tab.frame.contentWindow;
      tab.real = realUrlOf(w.location.href);
      tab.title = w.document.title || tab.real || 'New tab';
    } catch (e) {}
    tab.label.textContent = tab.title;
    if (tab === active) {
      if (document.activeElement !== urlEl) urlEl.value = tab.real;
      document.title = tab.title;
    }
  }

  // Proxied pages ask for a new tab through postMessage
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin) return;
    var d = e.data;
    if (d && typeof d.__proxyNewTab === 'string') newTab(d.__proxyNewTab);
  });

  urlEl.form.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = urlEl.value.trim();
    if (!v || !active) return;
    active.frame.src = fromAddressBar(v);
    urlEl.blur();
  });

  document.getElementById('back').addEventListener('click', function () {
    try { active.frame.contentWindow.history.back(); } catch (e) {}
  });
  document.getElementById('forward').addEventListener('click', function () {
    try { active.frame.contentWindow.history.forward(); } catch (e) {}
  });
  document.getElementById('reload').addEventListener('click', function () {
    try { active.frame.contentWindow.location.reload(); }
    catch (e) { active.frame.src = active.frame.src; }
  });
  newTabBtn.addEventListener('click', function () { newTab(NEWTAB); });

  // Keep title/address bar fresh for single-page-app navigation
  setInterval(function () { if (active) sync(active); }, 500);

  var start = new URLSearchParams(location.search).get('start');
  newTab(start ? fromAddressBar(start) : NEWTAB);
})();
</script>
</body>
</html>`

/**
 * Converts an ArrayBuffer to a base64 string in chunks.
 * @param {ArrayBuffer} buffer
 */
function arrayBufferToBase64 (buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + BASE64_CHUNK_SIZE)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

/**
 * Converts a base64 string back into a Uint8Array.
 * @param {string} base64
 */
function base64ToUint8Array (base64) {
  const binaryString = atob(base64)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return bytes
}

/**
 * Serializes a fetch Response into a JSON string we can store in KV.
 * @param {Response} response
 */
async function serializeResponse (response) {
  const arrayBuffer = await response.arrayBuffer()

  return JSON.stringify({
    body: arrayBufferToBase64(arrayBuffer),
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()]
  })
}

/**
 * Rebuilds a Response object from a serialized KV entry.
 * @param {string} serialized
 */
function deserializeResponse (serialized) {
  const parsed = JSON.parse(serialized)
  const body = NULL_BODY_STATUSES.has(parsed.status)
    ? null
    : base64ToUint8Array(parsed.body)

  // The stored bytes are already decoded, so drop encoding/length headers.
  const headers = new Headers(parsed.headers)
  headers.delete('content-encoding')
  headers.delete('content-length')

  return new Response(body, {
    status: parsed.status,
    statusText: parsed.statusText,
    headers
  })
}

/**
 * WebSocket upgrade requests need to pass straight through, untouched.
 * @param {Request} request
 */
function isWebSocketUpgrade (request) {
  return request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
}

/**
 * Builds this worker's own base URL (scheme + host) from the request.
 * @param {URL} requestUrl
 */
function proxyOrigin (requestUrl) {
  return `${requestUrl.protocol}//${requestUrl.host}`
}

/**
 * Turns a target URL into a proxied "/?url=..." link on this worker.
 * @param {string} targetUrl
 * @param {string} origin
 */
function toProxied (targetUrl, origin) {
  return `${origin}/?url=${encodeURIComponent(targetUrl)}`
}

/**
 * Resolves a possibly-relative URL found in the page against the page's
 * own URL and rewrites it into a proxied link. Leaves mailto:, javascript:,
 * tel:, data: and #fragment links untouched.
 * @param {string} raw
 * @param {string} baseUrl
 * @param {string} origin
 */
function rewriteUrl (raw, baseUrl, origin) {
  if (!raw) return raw
  const trimmed = raw.trim()
  if (/^(mailto|javascript|tel|data|#)/i.test(trimmed)) return raw
  try {
    const resolved = new URL(trimmed, baseUrl).toString()
    return toProxied(resolved, origin)
  } catch (err) {
    return raw
  }
}

function isBlockedHostname (hostname) {
  return BLOCKED_HOSTNAME_PATTERNS.some(pattern => pattern.test(hostname))
}

/**
 * Page shown in a new tab (and for errors inside a tab).
 */
function renderHomePage (origin, errorMessage) {
  const safeError = errorMessage
    ? `<p class="error">${errorMessage.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p>`
    : ''

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>New tab</title>
<style>
  body { font-family: system-ui, sans-serif; background: #111; color: #eee; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  form { width: 100%; max-width: 560px; padding: 0 20px; }
  h1 { font-size: 1.3rem; margin-bottom: 1rem; }
  input[type=text] { width: 100%; box-sizing: border-box; padding: 12px 14px; font-size: 1rem; border-radius: 8px; border: 1px solid #444; background: #1c1c1c; color: #eee; }
  button { margin-top: 10px; width: 100%; padding: 12px; font-size: 1rem; border-radius: 8px; border: none; background: #4f7cff; color: white; cursor: pointer; }
  button:hover { background: #3a63e0; }
  .error { color: #ff6b6b; }
</style>
</head>
<body>
  <form action="${origin}/" method="get">
    <h1>Enter a URL to browse</h1>
    ${safeError}
    <input type="text" name="url" placeholder="https://example.com" autofocus>
    <button type="submit">Go</button>
  </form>
</body>
</html>`
}

/**
 * Rewrites an outgoing HTML response so navigation, forms and subresources
 * keep flowing back through this proxy, and injects the new-tab script.
 * @param {Response} response
 * @param {string} targetUrl the URL that was actually fetched
 * @param {string} origin this worker's own origin
 */
function rewriteHtml (response, targetUrl, origin) {
  const attributeRewriter = {
    element (element) {
      const attr = element.tagName === 'form' ? 'action' : (element.hasAttribute('src') ? 'src' : 'href')
      const value = element.getAttribute(attr)
      if (value) {
        element.setAttribute(attr, rewriteUrl(value, targetUrl, origin))
      }
    }
  }

  const metaRefreshRewriter = {
    element (element) {
      const httpEquiv = element.getAttribute('http-equiv')
      if (httpEquiv && httpEquiv.toLowerCase() === 'refresh') {
        const content = element.getAttribute('content') || ''
        const match = content.match(/url=(.+)$/i)
        if (match) {
          const rewritten = rewriteUrl(match[1], targetUrl, origin)
          element.setAttribute('content', content.slice(0, match.index) + 'url=' + rewritten)
        }
      }
    }
  }

  const headInjector = {
    element (element) {
      element.prepend(INJECT_SCRIPT, { html: true })
    }
  }

  return new HTMLRewriter()
    .on('head', headInjector)
    .on('a[href]', attributeRewriter)
    .on('link[href]', attributeRewriter)
    .on('img[src]', attributeRewriter)
    .on('script[src]', attributeRewriter)
    .on('iframe[src]', attributeRewriter)
    .on('form[action]', attributeRewriter)
    .on('meta[http-equiv]', metaRefreshRewriter)
    .transform(response)
}

function htmlResponse (body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store'
    }
  })
}

async function handleRequest (request, env, ctx) {
  const requestUrl = new URL(request.url)
  const origin = proxyOrigin(requestUrl)
  const targetParam = requestUrl.searchParams.get('url')

  // Page shown inside a brand-new tab.
  if (requestUrl.pathname === NEWTAB_PATH) {
    return htmlResponse(renderHomePage(origin))
  }

  // The browser itself: the root with no ?url=, or the /__browser alias.
  if (requestUrl.pathname === SHELL_PATH || !targetParam) {
    return htmlResponse(SHELL_HTML)
  }

  let targetUrl
  try {
    targetUrl = new URL(targetParam.startsWith('http') ? targetParam : `https://${targetParam}`)
  } catch (err) {
    return htmlResponse(renderHomePage(origin, 'That does not look like a valid URL.'), 400)
  }

  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    return htmlResponse(renderHomePage(origin, 'Only http:// and https:// URLs are supported.'), 400)
  }

  if (isBlockedHostname(targetUrl.hostname)) {
    return htmlResponse(renderHomePage(origin, 'That host cannot be proxied.'), 403)
  }

  // WebSocket traffic bypasses all caching/rewriting: pass it through.
  if (isWebSocketUpgrade(request)) {
    const wsHeaders = new Headers(request.headers)
    const wsRequest = new Request(targetUrl.toString(), {
      method: request.method,
      headers: wsHeaders
    })
    return fetch(wsRequest)
  }

  const cacheKey = `${request.method}:${targetUrl.toString()}`
  const isCacheable = request.method === 'GET'

  if (isCacheable && env.CACHE_KV) {
    try {
      const cached = await env.CACHE_KV.get(cacheKey)
      if (cached) {
        let cachedResponse = deserializeResponse(cached)
        cachedResponse.headers.set('X-Cache-Status', 'HIT')
        // Strip framing/CSP rules so cached pages can show inside tabs.
        cachedResponse.headers.delete('content-security-policy')
        cachedResponse.headers.delete('x-frame-options')
        const contentType = cachedResponse.headers.get('content-type') || ''
        if (contentType.includes('text/html')) {
          cachedResponse = rewriteHtml(cachedResponse, targetUrl.toString(), origin)
        }
        return cachedResponse
      }
    } catch (err) {
      console.error('KV read failed, falling back to origin:', err)
    }
  }

  const proxyHeaders = new Headers(request.headers)
  proxyHeaders.delete('if-none-match')
  proxyHeaders.delete('if-modified-since')
  proxyHeaders.set('host', targetUrl.host)
  // Don't leak the proxy's own address as the referer.
  proxyHeaders.delete('referer')

  const proxyRequest = new Request(targetUrl.toString(), {
    method: request.method,
    headers: proxyHeaders,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'manual'
  })

  let response = await fetch(proxyRequest)

  // Follow redirects ourselves so the browser stays pointed at the proxy.
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location')
    if (location) {
      const resolved = new URL(location, targetUrl).toString()
      return Response.redirect(toProxied(resolved, origin), response.status)
    }
  }

  let responseForCache = null
  if (isCacheable && env.CACHE_KV && response.ok) {
    try {
      responseForCache = response.clone()
    } catch (err) {
      console.error('Could not clone response for caching:', err)
    }
  }

  const bodyForClient = NULL_BODY_STATUSES.has(response.status) ? null : response.body
  let finalResponse = new Response(bodyForClient, response)
  finalResponse.headers.set('X-Cache-Status', 'MISS')
  // Frames of the proxied page shouldn't be blocked by the origin's own
  // framing/CSP rules, since we're serving it from our own origin anyway.
  finalResponse.headers.delete('content-security-policy')
  finalResponse.headers.delete('x-frame-options')

  if (responseForCache) {
    ctx.waitUntil(
      serializeResponse(responseForCache)
        .then(serialized =>
          env.CACHE_KV.put(cacheKey, serialized, { expirationTtl: CACHE_TTL_SECONDS })
        )
        .catch(err => console.error('KV write failed:', err))
    )
  }

  const contentType = finalResponse.headers.get('content-type') || ''
  if (contentType.includes('text/html')) {
    finalResponse = rewriteHtml(finalResponse, targetUrl.toString(), origin)
  }

  return finalResponse
}

export default {
  async fetch (request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx)
    } catch (err) {
      console.error('Unhandled error in worker:', err)
      return new Response('Something went wrong upstream. Please try again.', { status: 502 })
    }
  }
}
