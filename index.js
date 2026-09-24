/**
 * Generic web proxy / "browser" worker.
 *
 * Visit the worker with no params to get a simple address bar.
 * Enter any URL and the worker fetches it and rewrites the page's
 * links, forms, and resource references so that browsing (clicking
 * links, following redirects, loading images/css/js) all continues
 * to flow back through this proxy.
 *
 * Example: https://your-worker.workers.dev/?url=https://example.com
 */

/**
 * How long cached responses stay valid, in seconds.
 */
const CACHE_TTL_SECONDS = 60

/**
 * Chunk size used when converting bytes to base64, to avoid blowing the
 * call stack with String.fromCharCode(...bigArray) on large responses.
 */
const BASE64_CHUNK_SIZE = 8192

/**
 * Per the Fetch spec, responses with these statuses MUST have a null body.
 * Passing a non-null body alongside one of these statuses throws.
 */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

/**
 * Private / reserved IP ranges we refuse to proxy to, so this worker
 * can't be used to poke at internal infrastructure (basic SSRF guard).
 * This is a best-effort textual check on the hostname, not a full
 * DNS-resolution-based guard.
 */
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
 * Converts an ArrayBuffer to a base64 string without spreading the whole
 * array into function arguments (which crashes on large files).
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
 * Serializes a fetch Response into a JSON-friendly object we can store in KV.
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
  const bytes = base64ToUint8Array(parsed.body)

  return new Response(bytes, {
    status: parsed.status,
    statusText: parsed.statusText,
    headers: parsed.headers
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
 * Builds this worker's own base URL (scheme + host) from the incoming request.
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
 * own URL, and rewrites it into a proxied link. Leaves things like
 * mailto:, javascript:, tel:, and data: URIs untouched.
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
 * Simple address-bar landing page shown when no ?url= is given.
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
<title>Web Proxy</title>
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
 * Rewrites an outgoing HTML response so that navigation, forms, and
 * subresources keep flowing back through this proxy.
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

  return new HTMLRewriter()
    .on('a[href]', attributeRewriter)
    .on('link[href]', attributeRewriter)
    .on('img[src]', attributeRewriter)
    .on('script[src]', attributeRewriter)
    .on('iframe[src]', attributeRewriter)
    .on('form[action]', attributeRewriter)
    .on('meta[http-equiv]', metaRefreshRewriter)
    .transform(response)
}

async function handleRequest (request, env, ctx) {
  const requestUrl = new URL(request.url)
  const origin = proxyOrigin(requestUrl)
  const targetParam = requestUrl.searchParams.get('url')

  // No target URL given: show the address-bar landing page.
  if (!targetParam) {
    return new Response(renderHomePage(origin), {
      headers: { 'content-type': 'text/html; charset=utf-8' }
    })
  }

  let targetUrl
  try {
    targetUrl = new URL(targetParam.startsWith('http') ? targetParam : `https://${targetParam}`)
  } catch (err) {
    return new Response(renderHomePage(origin, 'That does not look like a valid URL.'), {
      status: 400,
      headers: { 'content-type': 'text/html; charset=utf-8' }
    })
  }

  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    return new Response(renderHomePage(origin, 'Only http:// and https:// URLs are supported.'), {
      status: 400,
      headers: { 'content-type': 'text/html; charset=utf-8' }
    })
  }

  if (isBlockedHostname(targetUrl.hostname)) {
    return new Response(renderHomePage(origin, 'That host cannot be proxied.'), {
      status: 403,
      headers: { 'content-type': 'text/html; charset=utf-8' }
    })
  }

  // WebSocket traffic bypasses all caching/rewriting — pass it through.
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
        const cachedResponse = deserializeResponse(cached)
        cachedResponse.headers.set('X-Cache-Status', 'HIT')
        const contentType = cachedResponse.headers.get('content-type') || ''
        if (contentType.includes('text/html')) {
          return rewriteHtml(cachedResponse, targetUrl.toString(), origin)
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
