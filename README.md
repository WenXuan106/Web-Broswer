# web-proxy

A Cloudflare Worker that acts as a general-purpose web proxy: visit the
worker with no parameters to get a simple address bar, type in any
`http(s)://` URL, and it fetches that page and rewrites its links,
forms, and resources so that clicking around keeps flowing back
through the proxy.

## Deploy

1. Install wrangler if you don't have it: `npm install -g wrangler`
2. `wrangler login`
3. `wrangler deploy` from this folder (uses `wrangler.toml`)

## KV cache (optional)

`wrangler.toml` references a KV namespace binding (`CACHE_KV`) used to
cache GET responses for 60 seconds. Create your own namespace and
replace the `id` in `wrangler.toml`, or remove the `kv_namespaces`
block entirely if you don't want caching (the worker still works
without it — caching is skipped automatically when `env.CACHE_KV` is
absent).

## Notes / limits

- Only `http://` and `https://` targets are proxied; a few private/
  reserved hostnames (localhost, 127.0.0.1, 10.x, 192.168.x, etc.) are
  blocked as a basic safeguard.
- Link rewriting covers `<a href>`, `<link href>`, `<img src>`,
  `<script src>`, `<iframe src>`, `<form action>`, and `<meta
  http-equiv="refresh">`. It does not rewrite JavaScript that builds
  URLs at runtime (e.g. `fetch()` calls inside a page's own scripts),
  so some heavily dynamic sites (single-page apps, sites with a lot of
  client-side routing) may partially break.
- Site owners can still detect and block proxy traffic; this doesn't
  make requests anonymous or undetectable, and some sites' terms of
  service prohibit proxied access.
