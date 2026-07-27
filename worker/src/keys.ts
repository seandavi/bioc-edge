/**
 * URL path -> candidate R2 keys, in priority order.
 *
 * Keys mirror live URLs exactly (leading slash stripped), which is what
 * `wget --mirror` writes to disk and `rclone sync` uploads unchanged.
 */
export function candidates(pathname: string): string[] {
  const p = pathname.replace(/^\/+/, "");

  // Directory-style: /help/ -> help/index.html
  if (p === "" || p.endsWith("/")) return [p + "index.html"];

  // Has a file extension: serve it directly.
  const last = p.slice(p.lastIndexOf("/") + 1);
  if (last.includes(".")) return [p];

  // Extensionless: /help/faq -> help/faq.html, then help/faq/index.html,
  // then the bare key. The bare form is last but necessary: wget saves a
  // redirect's body under the *requested* path, so shortcuts like
  // /books/OSCA land in the mirror as extensionless HTML files.
  return [p + ".html", p + "/index.html", p];
}

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  ico: "image/x-icon",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml",
  gz: "application/gzip",
  tgz: "application/gzip",
  zip: "application/zip",
  woff2: "font/woff2",
};

/**
 * Fallback for objects stored without Content-Type. R2 returns no type at
 * all in that case, so the browser sniffs or downloads. Extensionless keys
 * default to HTML because that is what they are -- flattened redirects.
 */
export function contentType(key: string): string {
  const last = key.slice(key.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  return TYPES[dot > 0 ? last.slice(dot + 1).toLowerCase() : ""] ?? "text/html; charset=utf-8";
}

/**
 * Cache key for a resolved R2 key, rather than for the request URL.
 *
 * /help/, /help and /help/index.html all resolve to one object, so keying on
 * the object gives them one shared cache entry instead of three. It also
 * makes cache purging 1:1 with the keys rclone reports as changed -- keying
 * on request URLs would mean guessing every URL form that maps to an object.
 */
export function cacheUrl(origin: string, key: string): string {
  return `${origin}/${key}`;
}

/**
 * ponytail: R2 is a flat keyspace, so "a/../b" is a literal key that simply
 * misses rather than escaping anything. Decode only to reject malformed
 * percent-escapes early; no path normalization needed.
 */
export function decodePath(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

/**
 * Only version-stamped archives are safe to mark `immutable`.
 *
 * This site's CSS and JS carry no content hash (`style/base/colors.css`, not
 * `colors.a1b2c3.css`), so `immutable` would hide a fix from returning
 * visitors for the whole browser TTL -- and purging clears the edge, never
 * browsers. Package archives are version-stamped in the filename, so they
 * genuinely never change.
 *
 * The edge holds everything for a year regardless; freshness comes from
 * purge-on-sync, so the browser TTL stays short for anything mutable.
 */
export function cacheControl(key: string): string {
  return /\.(tar\.gz|tgz|tar\.bz2|zip)$/.test(key)
    ? "public, max-age=31536000, s-maxage=31536000, immutable"
    : "public, max-age=300, s-maxage=31536000";
}

/**
 * Does a cached response satisfy the client's validators?
 *
 * A cache hit returns a stored Response, so nothing revalidates it against
 * the request -- without this every revalidation after max-age transfers the
 * whole body again. Last-Modified carries this for HTML, whose ETag the zone
 * strips before it reaches the client.
 */
export function notModified(req: Request, res: Response): boolean {
  const strip = (t: string) => t.trim().replace(/^W\//, "");
  const inm = req.headers.get("if-none-match");
  const etag = res.headers.get("etag");
  if (inm && etag) {
    if (inm === "*" || inm.split(",").some((t) => strip(t) === strip(etag))) return true;
  }
  const ims = req.headers.get("if-modified-since");
  const lm = res.headers.get("last-modified");
  if (ims && lm) {
    const a = Date.parse(lm);
    const b = Date.parse(ims);
    if (!Number.isNaN(a) && !Number.isNaN(b) && a <= b) return true;
  }
  return false;
}
