import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  /** Upstream Walrus aggregator base URL, e.g. https://aggregator.walrus.example */
  WALRUS_AGGREGATOR_URL: string
}

// 1 year fresh + 30 day stale-while-revalidate + immutable. Walrus content
// is cryptographically content-addressed, so the bytes are valid forever.
// The aggregator's defaults are conservative because it serves unknown
// clients; kori knows it's serving cacheable content. Blob expirations
// still propagate within ~1 SWR window: after max-age elapses, the next
// request serves stale, fires a background refresh, and if upstream
// returns 404 the entry is evicted for the request after that.
const IMMUTABLE_CACHE = 'public, max-age=31536000, stale-while-revalidate=2592000, immutable'

// Shorter TTL for routes whose response bytes are NOT pure content-hash
// outputs (e.g. blob attributes set on a Sui object can be mutated).
const MUTABLE_CACHE = 'public, max-age=300'

const app = new Hono<{ Bindings: Bindings }>()

app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'HEAD', 'OPTIONS'],
    allowHeaders: ['content-type', 'range', 'accept'],
    exposeHeaders: ['content-type', 'content-length', 'etag', 'x-kori-cache'],
  }),
)

app.get('/', (c) => c.text('kori — Walrus aggregator proxy\n'))

// ── Cacheable, content-addressed reads ────────────────────────────────────
//
// All of these resolve to bytes that are determined by the URL's content-hash
// path segments. Cache the response for IMMUTABLE_CACHE.
//
// Hono router matches first-listed wins; specific routes go before catch-alls.

const CACHEABLE_PATTERNS: RegExp[] = [
  /^\/v1\/blobs\/[^/]+\/byte-range\/?$/,         // includes ?start=&length= in cache key
  /^\/v1\/blobs\/by-quilt-patch-id\/[^/]+\/?$/,
  /^\/v1\/blobs\/by-quilt-id\/[^/]+\/[^/]+\/?$/,
  /^\/v1\/quilts\/[^/]+\/patches\/?$/,
  /^\/v1alpha\/blobs\/concat\/?$/,                // ids list in query string is part of key
  /^\/v1\/blobs\/[^/]+\/?$/,                      // bare blob — keep last so above patterns match first
]

const SHORT_CACHE_PATTERNS: RegExp[] = [
  /^\/v1\/blobs\/by-object-id\/[^/]+\/?$/,        // attrs mutable; short TTL
]

const PASSTHROUGH_PATTERNS: RegExp[] = [
  /^\/v1alpha\/blobs\/[^/]+\/stream\/?$/,         // streaming, no cache
  /^\/status\/?$/,
]

const BLOCKED_WRITE_PATHS = new Set<string>([
  '/v1/blobs',
  '/v1/quilts',
])

// ── Reject writes ─────────────────────────────────────────────────────────

app.put('*', (c) => {
  const path = new URL(c.req.url).pathname
  if (BLOCKED_WRITE_PATHS.has(path)) {
    return c.text('kori is read-only — use a Walrus publisher directly\n', 403)
  }
  return c.text('Not found\n', 404)
})
app.post('*', (c) => c.text('Not found\n', 404))
app.delete('*', (c) => c.text('Not found\n', 404))
app.patch('*', (c) => c.text('Not found\n', 404))

// ── GET dispatcher ─────────────────────────────────────────────────────────

app.get('*', async (c) => {
  const url = new URL(c.req.url)
  const path = url.pathname

  if (CACHEABLE_PATTERNS.some((r) => r.test(path))) {
    return cachedFetch(c, IMMUTABLE_CACHE)
  }
  if (SHORT_CACHE_PATTERNS.some((r) => r.test(path))) {
    return cachedFetch(c, MUTABLE_CACHE)
  }
  if (PASSTHROUGH_PATTERNS.some((r) => r.test(path))) {
    return passthrough(c, 'no-store')
  }

  return c.text('Not found\n', 404)
})

// ── Cache + fetch helpers ─────────────────────────────────────────────────

/**
 * Edge-cached fetch with manual stale-while-revalidate.
 *
 * Lookup order:
 *   1. CF Cache API hit and fresh → serve immediately, mark x-kori-cache: HIT
 *   2. CF Cache API hit but stale → serve cached, fire background revalidation
 *   3. Miss → fetch upstream, store, serve
 *
 * Range-bearing requests bypass the cache (we'd otherwise have one cache
 * entry per unique Range header). Walrus's `/byte-range` endpoint already
 * lets callers ask for partial bytes via a content-addressable URL, so
 * Range-on-full-blob is rarely the common path; this can be revisited if
 * traffic shows it matters.
 */
async function cachedFetch(
  c: { req: { url: string; raw: Request; header: (k: string) => string | undefined }; env: Bindings; executionCtx: ExecutionContext },
  cacheControl: string,
): Promise<Response> {
  if (c.req.header('range')) {
    return passthrough(c, cacheControl)
  }

  const upstream = upstreamUrl(c.env, c.req.url)
  const cacheKey = new Request(upstream, { method: 'GET' })
  const cache = caches.default

  const cached = await cache.match(cacheKey)
  if (cached) {
    const fresh = isFresh(cached)
    if (fresh) {
      return withMarker(cached, 'HIT')
    }
    // Stale-while-revalidate: serve stale immediately, refetch in background.
    c.executionCtx.waitUntil(refresh(cache, cacheKey, upstream, cacheControl))
    return withMarker(cached, 'STALE')
  }

  const upstreamRes = await fetch(upstream)
  const cacheable = upstreamRes.ok ? rewriteForCache(upstreamRes, cacheControl) : upstreamRes
  if (upstreamRes.ok) {
    c.executionCtx.waitUntil(cache.put(cacheKey, cacheable.clone()))
  }
  return withMarker(cacheable, 'MISS')
}

/** No-cache passthrough — used for /status and streaming. */
async function passthrough(
  c: { req: { url: string; raw: Request; header: (k: string) => string | undefined }; env: Bindings },
  cacheControl: string,
): Promise<Response> {
  const upstream = upstreamUrl(c.env, c.req.url)
  const headers = new Headers()
  const range = c.req.header('range')
  if (range) headers.set('range', range)
  const upstreamRes = await fetch(upstream, { headers })
  const out = new Response(upstreamRes.body, upstreamRes)
  out.headers.set('cache-control', cacheControl)
  out.headers.set('x-kori-cache', 'PASS')
  return out
}

function upstreamUrl(env: Bindings, reqUrl: string): string {
  const u = new URL(reqUrl)
  return `${env.WALRUS_AGGREGATOR_URL}${u.pathname}${u.search}`
}

function rewriteForCache(res: Response, cacheControl: string): Response {
  // Clone headers so we can override cache-control and stamp our marker.
  const headers = new Headers(res.headers)
  headers.set('cache-control', cacheControl)
  // Preserve upstream ETag if present; otherwise stamp synthesised one based on
  // the URL (CF derives URL keys from the request, ETag is for downstream
  // browser/clients).
  return new Response(res.body, { status: res.status, headers })
}

function withMarker(res: Response, marker: 'HIT' | 'MISS' | 'STALE'): Response {
  const headers = new Headers(res.headers)
  headers.set('x-kori-cache', marker)
  return new Response(res.body, { status: res.status, headers })
}

function isFresh(res: Response): boolean {
  // CF-injected Age header tells us how long the entry has been in cache.
  const age = Number(res.headers.get('age') ?? 0)
  const cc = res.headers.get('cache-control') ?? ''
  const m = cc.match(/max-age=(\d+)/)
  const maxAge = m ? Number(m[1]) : 0
  return age <= maxAge
}

async function refresh(cache: Cache, cacheKey: Request, upstreamUrl: string, cacheControl: string): Promise<void> {
  try {
    const fresh = await fetch(upstreamUrl)
    if (fresh.ok) {
      await cache.put(cacheKey, rewriteForCache(fresh, cacheControl))
    } else if (fresh.status === 404 || fresh.status === 410) {
      // Upstream says the blob is gone — evict so the next user gets the truth.
      await cache.delete(cacheKey)
    }
  } catch {
    // Network blip during background refresh; keep the stale entry.
  }
}

export default app
