/**
 * Reverse proxy Worker with a built-in tabbed "browser" shell.
 *
 * - Open  https://<your-worker-domain>/__browser  to use the tabbed browser.
 * - Every other path is proxied to baseHost, same as before.
 * - baseHost has NO trailing slash, because pathname already starts with "/".
 */
const baseHost = 'https://www.ytdwlr.lol'
const SHELL_PATH = '/__browser'

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
    <form id="urlform"><input id="url" type="text" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Enter a path or URL"></form>
  </div>
  <div id="view"></div>
</div>
<script>
(function () {
  var BASE = __BASE__;
  var tabsEl = document.getElementById('tabs');
  var newTabBtn = document.getElementById('newtab');
  var viewEl = document.getElementById('view');
  var urlEl = document.getElementById('url');
  var tabs = [];
  var active = null;
  var nextId = 1;
  var realOpen = window.open.bind(window);

  // Turn any URL into a path on this Worker, or null if it is a different site
  function toPath(input, base) {
    try {
      var u = new URL(input, base || location.href);
      if (u.origin === location.origin || u.origin === BASE) {
        return u.pathname + u.search + u.hash;
      }
    } catch (e) {}
    return null;
  }

  function newTab(path) {
    var tab = { id: nextId++, path: path || '/', title: 'New tab' };

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

    frame.addEventListener('load', function () { hook(tab); sync(tab); });

    tabsEl.insertBefore(el, newTabBtn);
    viewEl.appendChild(frame);
    tabs.push(tab);
    frame.src = tab.path;
    activate(tab);
    return tab;
  }

  function activate(tab) {
    active = tab;
    tabs.forEach(function (t) {
      t.el.classList.toggle('active', t === tab);
      t.frame.classList.toggle('active', t === tab);
    });
    urlEl.value = tab.path;
    document.title = tab.title;
  }

  function closeTab(tab) {
    var i = tabs.indexOf(tab);
    if (i === -1) return;
    tabs.splice(i, 1);
    tab.el.remove();
    tab.frame.remove();
    if (tabs.length === 0) { newTab('/'); return; }
    if (active === tab) activate(tabs[Math.min(i, tabs.length - 1)]);
  }

  function sync(tab) {
    try {
      var w = tab.frame.contentWindow;
      tab.path = w.location.pathname + w.location.search + w.location.hash;
      tab.title = w.document.title || tab.path;
    } catch (e) {}
    tab.label.textContent = tab.title;
    if (tab === active) {
      if (document.activeElement !== urlEl) urlEl.value = tab.path;
      document.title = tab.title;
    }
  }

  function openLink(url, base) {
    var p = toPath(url, base);
    if (p !== null) newTab(p);
    else realOpen(url, '_blank'); // other sites can't be proxied here
  }

  // Runs on every page load inside a tab: catch "open in new tab" behaviour
  function hook(tab) {
    var w, d;
    try { w = tab.frame.contentWindow; d = w.document; } catch (e) { return; }

    w.open = function (url) {
      if (url) openLink(url, w.location.href);
      return null;
    };

    function onLink(e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      var baseEl = d.querySelector('base[target]');
      var target = a.getAttribute('target') || (baseEl ? baseEl.getAttribute('target') : '');
      var named = target && target !== '_self' && target !== '_parent' && target !== '_top';
      var modifier = e.ctrlKey || e.metaKey || e.button === 1;
      if (!named && !modifier) return;
      if (e.type === 'auxclick' && e.button !== 1) return;
      e.preventDefault();
      openLink(a.href, w.location.href);
    }
    d.addEventListener('click', onLink, true);
    d.addEventListener('auxclick', onLink, true);

    // Forms that target a new window just submit in the current tab
    d.addEventListener('submit', function (e) {
      var f = e.target;
      var t = f.getAttribute && f.getAttribute('target');
      if (t && t !== '_self' && t !== '_parent' && t !== '_top') {
        f.setAttribute('target', '_self');
      }
    }, true);
  }

  function normalize(v) {
    if (/^https?:/i.test(v)) {
      return toPath(v);
    }
    return v.charAt(0) === '/' ? v : '/' + v;
  }

  document.getElementById('urlform').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = urlEl.value.trim();
    if (!v || !active) return;
    var p = normalize(v);
    if (p === null) { alert('Only ' + BASE + ' pages can be opened here.'); return; }
    active.frame.src = p;
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
  newTabBtn.addEventListener('click', function () { newTab('/'); });

  // Keep title/address bar fresh for single-page-app navigation
  setInterval(function () { if (active) sync(active); }, 500);

  var start = new URLSearchParams(location.search).get('start') || '/';
  newTab(start);
})();
</script>
</body>
</html>`

async function handleRequest (request) {
  const requestUrl = new URL(request.url)

  // The tabbed browser UI
  if (requestUrl.pathname === SHELL_PATH) {
    return new Response(SHELL_HTML.replace('__BASE__', JSON.stringify(baseHost)), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      }
    })
  }

  // Everything else is proxied to baseHost
  const targetUrl = baseHost + requestUrl.pathname + requestUrl.search
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'

  const proxyRequest = new Request(targetUrl, {
    method: request.method,
    headers: request.headers,
    body: hasBody ? request.body : undefined,
    redirect: 'manual', // don't silently follow redirects to the origin domain
    cf: request.method === 'GET'
      ? { cacheTtl: 10, cacheEverything: true }
      : undefined
  })

  const response = await fetch(proxyRequest)

  // Copy of the response with mutable headers
  const proxied = new Response(response.body, response)

  // Keep redirects on your own domain
  const location = proxied.headers.get('Location')
  if (location) {
    proxied.headers.set('Location', location.replace(baseHost, requestUrl.origin))
  }

  // Allow the site to be shown inside the browser shell's iframes
  proxied.headers.delete('X-Frame-Options')
  const csp = proxied.headers.get('Content-Security-Policy')
  if (csp) {
    const cleaned = csp.replace(/frame-ancestors[^;]*;?/gi, '').trim()
    if (cleaned) proxied.headers.set('Content-Security-Policy', cleaned)
    else proxied.headers.delete('Content-Security-Policy')
  }

  return proxied
}

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})
