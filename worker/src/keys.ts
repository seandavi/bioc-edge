/** Symlink path (no leading slash) -> raw target, exactly as stored on disk. */
export type Links = Record<string, string>;

/** The generated map, published to R2 by `sync.sh` on every pull. */
export const LINKS_KEY = "_symlinks.json";

/**
 * Collapse "." and ".." against a flat keyspace. Returns null if the path
 * climbs above the docroot -- R2 has no such key, and following it would be
 * resolving a link that points outside the tree we mirror.
 */
function normalize(p: string): string | null {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!out.length) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

/**
 * Follow symlinks in a key, because object storage has none.
 *
 * The docroot has 248, and the load-bearing ones are not the two release
 * pointers: ~150 are R-version aliases inside `contrib/`
 * (`packages/3.23/bioc/bin/windows/contrib/4.7 -> 4.6`), which is how one
 * build serves two R versions. Those are the `install.packages()` path, so
 * dropping them breaks installs on the aliased version -- silently, since the
 * browse path keeps working.
 *
 * Longest prefix wins, then repeat, because links chain:
 *   packages/lindsey/release/html   (lindsey/release -> ../release/lindsey)
 *   -> packages/release/lindsey/html  (packages/release -> 3.23)
 *   -> packages/3.23/lindsey/html
 *
 * On anything it cannot follow -- an absolute target escaping the docroot, a
 * cycle (`bioc-20120924 -> bioc-LATEST/` where bioc-LATEST points back), a
 * climb above root -- it stops and returns what it has. That key then simply
 * misses and 404s, which is the right answer: the unresolved path is a
 * symlink, and symlinks are never uploaded, so nothing is there either way.
 */
export function resolveLinks(key: string, links: Links, maxHops = 8): string {
  let p = key;
  for (let hop = 0; hop < maxHops; hop++) {
    const segs = p.split("/");
    let at = -1;
    for (let i = segs.length; i > 0; i--) {
      if (segs.slice(0, i).join("/") in links) {
        at = i;
        break;
      }
    }
    if (at < 0) return p;

    const target = links[segs.slice(0, at).join("/")];
    if (target.startsWith("/")) return p; // absolute: outside the mirror
    const dir = segs.slice(0, at - 1).join("/");
    const next = normalize(`${dir}/${target}/${segs.slice(at).join("/")}`);
    // `stable -> .` resolves to its own parent and makes no progress; a cycle
    // makes progress but never terminates. maxHops covers the second.
    if (next === null || next === p) return p;
    p = next;
  }
  return p;
}

/**
 * URL path -> candidate R2 keys, in priority order.
 *
 * Keys mirror live URLs exactly (leading slash stripped), which is what
 * `wget --mirror` writes to disk and `rclone sync` uploads unchanged.
 *
 * Link resolution runs *after* the index.html expansion, not before, because
 * links land on both sides of it: `packages/release` is a directory link that
 * only shows up in the prefix, while `packages/lindsey/index.html` is a link
 * on the file the expansion just produced.
 */
export function candidates(pathname: string, links: Links = {}): string[] {
  const p = pathname.replace(/^\/+/, "");
  let out: string[];

  // Directory-style: /help/ -> help/index.html
  if (p === "" || p.endsWith("/")) out = [p + "index.html"];
  else {
    // Has a file extension: serve it directly.
    const last = p.slice(p.lastIndexOf("/") + 1);
    if (last.includes(".")) out = [p];
    // Extensionless: /help/faq -> help/faq.html, then help/faq/index.html,
    // then the bare key. The bare form is last but necessary: wget saves a
    // redirect's body under the *requested* path, so shortcuts like
    // /books/OSCA land in the mirror as extensionless HTML files.
    else out = [p + ".html", p + "/index.html", p];
  }

  // ponytail: resolved only. The unresolved key is never also worth trying --
  // if a path resolves, the original was a symlink and was never uploaded.
  return [...new Set(out.map((k) => resolveLinks(k, links)))];
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
