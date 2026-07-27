import { candidates, cacheControl, cacheUrl, contentType, decodePath } from "./keys.ts";
import redirects from "./redirects.json";

interface Env {
  BUCKET: R2Bucket;
  LOGS?: AnalyticsEngineDataset;
  NOT_FOUND_KEY?: string;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    }

    const url = new URL(req.url);
    const path = decodePath(url.pathname);
    if (path === null) return new Response("Bad Request", { status: 400 });

    // Production answers these with a four-hop chain that twice downgrades to
    // plaintext http. One relative hop instead: same destination, no downgrade.
    const target = (redirects as Record<string, string>)[path];
    if (target) {
      log(env, ctx, req, 301, "REDIRECT");
      return new Response(null, {
        status: 301,
        headers: { location: target, "cache-control": "public, max-age=3600" },
      });
    }

    // Bindings bypass the edge HTTP cache entirely, so without this every
    // request is a billed Class B op against R2. Range requests skip the
    // cache to keep the 206 path simple.
    const ranged = req.headers.has("range");
    const cache = caches.default;
    const keys = candidates(path);

    // Entries are keyed by resolved object, not request URL, so at most a
    // couple of local lookups -- and /help/, /help and /help/index.html all
    // land on the same one.
    if (!ranged) {
      for (const key of keys) {
        const hit = await cache.match(cacheUrl(url.origin, key));
        if (hit) {
          log(env, ctx, req, hit.status, "HIT");
          return req.method === "HEAD"
            ? new Response(null, { status: hit.status, headers: hit.headers })
            : hit;
        }
      }
    }

    const { res, key } = await fromR2(req, env, keys);

    if (key && res.status === 200 && req.method === "GET" && !ranged) {
      ctx.waitUntil(cache.put(cacheUrl(url.origin, key), res.clone()));
    }
    log(env, ctx, req, res.status, ranged ? "RANGE" : "MISS");
    return res;
  },
};

async function fromR2(
  req: Request,
  env: Env,
  keys: string[],
): Promise<{ res: Response; key: string | null }> {
  for (const key of keys) {
    const obj = await env.BUCKET.get(key, {
      onlyIf: req.headers,
      range: req.headers,
    });
    if (!obj) continue;

    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    // R2 returns no Content-Type at all when the object was stored without
    // one, so derive it rather than letting the browser sniff.
    if (!headers.get("content-type")) headers.set("content-type", contentType(key));
    headers.set("etag", obj.httpEtag);
    headers.set("accept-ranges", "bytes");
    headers.set("cache-control", cacheControl(headers.get("content-type")));

    // No body means a precondition failed. If-None-Match/If-Modified-Since
    // failing means "unchanged" (304); If-Match/If-Unmodified-Since failing
    // is a real conflict (412).
    if (!("body" in obj)) {
      const unchanged =
        req.headers.has("if-none-match") || req.headers.has("if-modified-since");
      return { res: new Response(null, { status: unchanged ? 304 : 412, headers }), key };
    }

    if (obj.range && req.headers.has("range")) {
      const r = obj.range as { offset?: number; length?: number; suffix?: number };
      const offset = r.suffix !== undefined ? obj.size - r.suffix : r.offset ?? 0;
      const length = r.suffix !== undefined ? r.suffix : r.length ?? obj.size - offset;
      headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
      return { res: new Response(obj.body, { status: 206, headers }), key };
    }

    const body = req.method === "HEAD" ? null : obj.body;
    return { res: new Response(body, { status: 200, headers }), key };
  }

  return { res: await notFound(env), key: null };
}

async function notFound(env: Env): Promise<Response> {
  const page = env.NOT_FOUND_KEY && (await env.BUCKET.get(env.NOT_FOUND_KEY));
  const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
  return new Response(page ? page.body : "Not Found", { status: 404, headers });
}

/**
 * Per-request detail the zone dashboard cannot give us: which paths, which
 * crawlers, which ASNs. This is the open "is the bot traffic legitimate?"
 * question, and the only reason a Worker sits in the request path.
 */
function log(env: Env, ctx: ExecutionContext, req: Request, status: number, cacheStatus: string) {
  if (!env.LOGS) return;
  const cf = req.cf as IncomingRequestCfProperties | undefined;
  ctx.waitUntil(
    Promise.resolve(
      env.LOGS.writeDataPoint({
        blobs: [
          new URL(req.url).pathname,
          req.headers.get("user-agent") ?? "",
          cf?.country ?? "",
          String(cf?.asn ?? ""),
          cacheStatus,
        ],
        doubles: [status],
        indexes: [String(cf?.asn ?? "")],
      }),
    ),
  );
}
