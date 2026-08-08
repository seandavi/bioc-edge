import {
  candidates,
  cacheControl,
  cacheUrl,
  contentType,
  decodePath,
  notModified,
  redirectFor,
  logQuery,
  accessRecord,
  listablePrefix,
  packageShortUrl,
  PKG_REPOS,
  renderIndex,
  resolveLinks,
  LINKS_KEY,
  type Links,
  type Redirects,
} from "./keys.ts";
import redirects from "./redirects.json";

interface Env {
  BUCKET: R2Bucket;
  LOGS?: AnalyticsEngineDataset;
  NOT_FOUND_KEY?: string;
}

/**
 * The symlink map is upstream state, not configuration: `bioc-LATEST` links
 * move nightly and `contrib/` aliases appear whenever an R version rolls, so
 * checking it into the repo would mean a deploy per upstream change. sync.sh
 * regenerates it from the mirror on every pull and publishes it here.
 *
 * Memoised per isolate rather than per request. Isolates are reused across
 * many requests, so this is roughly one Class B op per isolate per TTL. The
 * TTL is the lag between a release roll landing in the bucket and the Worker
 * following it.
 */
const LINKS_TTL_MS = 300_000;
let linksCache: { at: number; map: Links } | null = null;

async function symlinks(env: Env): Promise<Links> {
  if (linksCache && Date.now() - linksCache.at < LINKS_TTL_MS) return linksCache.map;
  try {
    const obj = await env.BUCKET.get(LINKS_KEY);
    // Cache the *absence* of the map too. Storing only successes means a
    // missing object never populates the cache, so every subsequent request
    // re-fetches it -- and this runs before the cache lookup, so that is an
    // R2 round trip on the hot path of every request including cache hits.
    // Measured: 146-159ms TTFB against 44-50ms once the map resolves.
    linksCache = { at: Date.now(), map: obj ? await obj.json<Links>() : {} };
  } catch {
    // A read failure is different from a genuine absence: keep the last good
    // map rather than replacing it with an empty one, which would 404 every
    // /packages/release/ URL on the site. Only back off from retrying every
    // request if we have something to serve meanwhile.
    if (linksCache) linksCache = { at: Date.now(), map: linksCache.map };
  }
  return linksCache?.map ?? {};
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const t0 = Date.now();
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    }

    const url = new URL(req.url);
    const path = decodePath(url.pathname);
    if (path === null) return new Response("Bad Request", { status: 400 });

    // Production answers many of these with a multi-hop chain that downgrades
    // to plaintext http along the way (MIGRATION.md, "Redirects"). One hop
    // instead: same destination, no downgrade. worker/gen-redirects.ts is
    // what produced redirects.json from inventory/htaccess-20260730.conf.
    const target = redirectFor(path, redirects as Redirects);
    if (target) {
      log(env, ctx, req, 301, "REDIRECT", null, t0);
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
    const keys = candidates(path, await symlinks(env));

    // Entries are keyed by resolved object, not request URL, so at most a
    // couple of local lookups -- and /help/, /help and /help/index.html all
    // land on the same one.
    if (!ranged) {
      for (const key of keys) {
        const hit = await cache.match(cacheUrl(url.origin, key));
        if (hit) {
          if (notModified(req, hit)) {
            log(env, ctx, req, 304, "HIT", null, t0);
            return new Response(null, { status: 304, headers: hit.headers });
          }
          log(env, ctx, req, hit.status, "HIT", hit, t0);
          return req.method === "HEAD"
            ? new Response(null, { status: hit.status, headers: hit.headers })
            : hit;
        }
      }
    }

    let { res, key, size } = await fromR2(req, env, keys);
    if (res.status === 404) {
      const listed = await listing(env, keys);
      if (listed) ({ res, key } = listed);
      else {
        const redir = await packageRedirect(env, path, await symlinks(env));
        if (redir) {
          log(env, ctx, req, 302, "REDIRECT", null, t0);
          return redir;
        }
      }
    }

    if (key && res.status === 200 && req.method === "GET" && !ranged) {
      ctx.waitUntil(cache.put(cacheUrl(url.origin, key), res.clone()));
    }
    log(env, ctx, req, res.status, ranged ? "RANGE" : "MISS", res, t0, size ?? null);
    return res;
  },
};

async function fromR2(
  req: Request,
  env: Env,
  keys: string[],
): Promise<{ res: Response; key: string | null; size?: number }> {
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
    // Same value under a non-standard name. If this survives on text/html
    // while `etag` does not, the header is being removed downstream rather
    // than never set -- which is the whole question.
    headers.set("x-r2-etag", obj.httpEtag);
    // Second validator, because something in the zone strips ETag from
    // text/html. Last-Modified survives, and onlyIf already forwards
    // If-Modified-Since to R2, so conditional requests still 304.
    headers.set("last-modified", obj.uploaded.toUTCString());
    headers.set("accept-ranges", "bytes");
    headers.set("cache-control", cacheControl(key));

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
    // Workers derives Content-Length from the body, so a bodyless HEAD drops
    // it -- while Apache sends it. Worse than uniformly missing: a HEAD that
    // hits the edge cache inherits the cached GET's headers and does have it,
    // so the header appears or vanishes depending on cache state.
    if (!body) headers.set("content-length", String(obj.size));
    return { res: new Response(body, { status: 200, headers }), key, size: obj.size };
  }

  return { res: await notFound(env), key: null };
}

/**
 * The directory listings Apache generates and object storage has none of.
 *
 * Runs only after every candidate key has missed, so the R2 LIST it costs
 * falls on requests that were going to 404 anyway -- and only on the few
 * prefixes `listablePrefix()` recognises. Returned under the `index.html`
 * candidate key, which is the key the cache lookup above already checks, so a
 * PoP that has served this page once does not list again until it expires.
 */
async function listing(env: Env, keys: string[]): Promise<{ res: Response; key: string } | null> {
  for (const key of keys) {
    const prefix = listablePrefix(key);
    if (!prefix) continue;

    const dirs: string[] = [];
    const files: { name: string; size: number }[] = [];
    // R2 caps a page at 1000. Archive/ holds 172 package directories today, so
    // one page covers it -- but a truncated listing is silently incomplete
    // content rather than an error, which is the failure this file exists to
    // avoid elsewhere. Page through instead of trusting the margin to hold.
    let cursor: string | undefined;
    do {
      const page = await env.BUCKET.list({ prefix, delimiter: "/", cursor });
      for (const p of page.delimitedPrefixes) dirs.push(p.slice(prefix.length, -1));
      for (const o of page.objects) files.push({ name: o.key.slice(prefix.length), size: o.size });
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    // Nothing there is a real 404, not an empty page: every other prefix that
    // matches LISTABLE but holds nothing (devel before its first archived
    // build) should answer the way the origin does.
    if (!dirs.length && !files.length) continue;

    return {
      key,
      res: new Response(renderIndex(prefix, dirs, files), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          // The one page on the site whose freshness is a TTL rather than a
          // purge. sync.sh purges the keys rclone wrote, and archiving a
          // tarball writes the tarball -- this page's key never changes, so it
          // would never be purged and a year-long s-maxage would freeze it.
          "cache-control": "public, max-age=300, s-maxage=3600",
        },
      }),
    };
  }
  return null;
}

/**
 * Master's package short URLs, reimplemented (issue #74; see packageShortUrl
 * in keys.ts for the measured behaviour). Runs only after every candidate key
 * has missed, so the up-to-four R2 HEADs fall on requests that were going to
 * 404 anyway. 302 not 301, like master: which repo -- and whether the package
 * exists at all -- changes across releases. The probe resolves release/devel
 * through the symlink map, but the Location keeps the literal segment master
 * emits.
 */
async function packageRedirect(env: Env, path: string, links: Links): Promise<Response | null> {
  const short = packageShortUrl(path);
  if (!short) return null;
  for (const repo of PKG_REPOS) {
    const target = `packages/${short.ver}/${repo}/html/${short.pkg}.html`;
    if (await env.BUCKET.head(resolveLinks(target, links))) return found(`/${target}`);
  }
  return found("/about/removed-packages/");
}

/** 302 with master's TTL (Cache-Control: max-age=600, measured). */
function found(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location, "cache-control": "public, max-age=600" },
  });
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
 *
 * Two sinks, one capture, and they are not interchangeable:
 *
 *   1. `console.log` -> Workers Trace Events Logpush -> R2. The complete,
 *      unsampled record download statistics are computed from. The trace
 *      envelope Logpush ships carries only URL, method, status and timing --
 *      no client IP, no user agent, no size -- so anything not written here
 *      is gone permanently and cannot be backfilled (ADR 0003).
 *   2. Analytics Engine. A dashboard, never the record: it samples, and the
 *      /24 truncation below is deliberate for the ranges question it answers.
 *
 * Do not "unify" these. Pointing statistics at the Analytics Engine shape
 * yields distinct-IP counts that are wrong and look entirely plausible.
 * Do not filter or aggregate in this function either -- it writes the record,
 * not a view of it (ADR 0002).
 */
function log(
  env: Env,
  ctx: ExecutionContext,
  req: Request,
  status: number,
  cacheStatus: string,
  res: Response | null = null,
  t0: number | null = null,
  size: number | null = null,
) {
  console.log(JSON.stringify(accessRecord(req, status, cacheStatus, res, t0, size)));

  if (!env.LOGS) return;
  const cf = req.cf as IncomingRequestCfProperties | undefined;

  // The open question is "distributed crawler activity across similar IP
  // ranges", which is a question about ranges, not individuals. Logging the
  // /24 (or /48) answers it without retaining full addresses.
  const ip = req.headers.get("cf-connecting-ip") ?? "";
  const range = ip.includes(":")
    ? ip.split(":").slice(0, 3).join(":") + "::/48"
    : ip.split(".").slice(0, 3).join(".") + ".0/24";
  ctx.waitUntil(
    Promise.resolve(
      env.LOGS.writeDataPoint({
        // Order is the schema. Appending only -- inserting a field would
        // shift every blob after it, so blob5 would silently start returning
        // user agents to a query that asked for cache status. The dataset
        // cannot be altered, so a mistake here is permanent for that dataset.
        blobs: [
          new URL(req.url).pathname,
          req.headers.get("user-agent") ?? "",
          cf?.country ?? "",
          String(cf?.asn ?? ""),
          cacheStatus,
          range,
          // blob7, new in v3. Separate from the path deliberately: the path is
          // what the client asked for, this is how. Two uses -- UTM
          // attribution, and spotting cache-busting query strings, which are
          // otherwise invisible because our cache key ignores the query, so
          // every variant collapses onto one path and reads as normal traffic.
          logQuery(new URL(req.url).search),
        ],
        doubles: [status],
        indexes: [String(cf?.asn ?? "")],
      }),
    ),
  );
}
