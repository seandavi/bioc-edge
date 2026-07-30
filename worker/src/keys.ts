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
  const resolved = out.map((k) => resolveLinks(k, links));
  const archived = resolved
    .map((k) => archiveFallback(k, links))
    .filter((k): k is string => k !== null);
  return [...new Set([...resolved, ...archived])];
}

/**
 * Prefix the OSN archive lands under in R2. Contingent on the transfer in the
 * "migrate the OSN archive" issue, which has not run -- until it does, this
 * fallback costs one extra R2 lookup on a request that was going to 404
 * anyway, and returns nothing. Mirrors the source layout
 * (`<bucket>/archive.bioconductor.org/packages/...`) so the copy is a
 * straight prefix map rather than a rename.
 */
const ARCHIVE_PREFIX = "archive.bioconductor.org";

/**
 * Source tarballs for releases 1.8-3.22 live in the archive, not the docroot;
 * upstream .htaccess 302s out to OSN for them. Since the archive is being
 * migrated into R2 rather than redirected to, that becomes a key mapping: try
 * the archive prefix as a last-resort candidate.
 *
 * Which versions count as "current" comes from the symlink map, not a
 * constant. `packages/release` and `packages/devel` are entries in
 * _symlinks.json precisely so a release roll is data, not a deploy -- and
 * hardcoding the pair here would reintroduce exactly the coupling that map
 * exists to remove, then misroute every request for the newly-current release
 * until someone shipped a code change.
 *
 * With no map we cannot tell current from archived, so we add no candidate at
 * all. A wrong archive key is a silently wrong 200 if that object exists;
 * a missing one is only a 404 we were already going to serve.
 */
export function archiveFallback(key: string, links: Links = {}): string | null {
  const m = key.match(/^packages\/(\d+\.\d+)\//);
  if (!m) return null;
  const current = new Set(
    ["packages/release", "packages/devel"]
      .map((k) => links[k])
      .filter((v): v is string => typeof v === "string"),
  );
  if (current.size === 0 || current.has(m[1])) return null;
  return `${ARCHIVE_PREFIX}/${key}`;
}

/** Shape of worker/src/redirects.json -- see worker/gen-redirects.ts. */
export interface Redirects {
  exact: Record<string, string>;
  prefix: { from: string; to: string; keepSuffix: boolean }[];
}

/**
 * Path -> redirect target, or null to fall through to R2.
 *
 * `exact` first because it is O(1) and the common case (an old bookmark for
 * one specific URL). Among `prefix` entries, the longest `from` wins -- a
 * specific rule ("/overview/coredevs") over a catch-all it is also a prefix
 * of ("/overview") -- the same result Apache's first-matching-RewriteRule-
 * wins produced, since `[R]` ends rule processing at the first match. Found
 * by scanning rather than trusting array order: the generator emits `prefix`
 * longest-first for a readable diff, but correctness shouldn't depend on a
 * second file keeping that sort intact.
 */
export function redirectFor(path: string, redirects: Redirects): string | null {
  const exact = redirects.exact[path];
  if (exact) return exact;
  let best: Redirects["prefix"][number] | null = null;
  for (const rule of redirects.prefix) {
    if (path.startsWith(rule.from) && (!best || rule.from.length > best.from.length)) best = rule;
  }
  if (!best) return null;
  return best.keepSuffix ? best.to + path.slice(best.from.length) : best.to;
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
 * Query string for logging: no leading `?`, and bounded.
 *
 * Bounded is the load-bearing part. Analytics Engine caps the total size of a
 * datapoint's blobs, and an oversized write is rejected -- the same silent
 * data loss that cost us the whole IP-range field on the v1 dataset. A query
 * string is attacker-controlled and unbounded, so without a cap one crawler
 * sending a multi-kilobyte query would stop the *entire request* from being
 * logged, blinding exactly the analysis this field exists to support.
 *
 * The documented cap is 16 KB across all blobs in a data point, so 256 is not
 * near it -- the bound is chosen for signal, not headroom. A real UTM set runs
 * ~100 chars, so 256 keeps every legitimate query intact while making a
 * deliberately huge one cheap to store and obvious in the data. Truncation is
 * marked so a clipped value is never mistaken for a complete one.
 */
export function logQuery(search: string, max = 256): string {
  const q = search.startsWith("?") ? search.slice(1) : search;
  return q.length <= max ? q : q.slice(0, max) + "...[truncated]";
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

// .htaccess <FilesMatch> Cache-Control overrides (inventory/htaccess-
// 20260730.conf:18-44) for files the build regenerates faster than the
// default browser TTL would reveal -- PACKAGES/VIEWS drive `install.
// packages()`, gitlog.xml and config.yaml are build metadata. Checked
// against the basename only, first match wins, same as contentType().
// Not ported: the blanket `ExpiresByType text/html A600` -- this repo
// already decided HTML's browser TTL deliberately (5 min, MIGRATION.md
// §Cache), and that decision predates and overrides this port.
const SHORT_LIVED: [(name: string) => boolean, number][] = [
  [(n) => ["PACKAGES", "PACKAGES.gz", "PACKAGES.rds", "VIEWS"].includes(n), 30],
  [(n) => n === "BiocInstaller.dcf", 60],
  [(n) => n === "config.yaml", 30],
  [(n) => n.endsWith("gitlog.xml"), 30],
  [(n) => n.endsWith(".rss"), 300],
  [(n) => n.endsWith(".svg"), 30],
  [(n) => n.endsWith(".csv"), 30],
];

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
 * purge-on-sync, so the browser TTL stays short for anything mutable --
 * SHORT_LIVED narrows that further for files that regenerate faster than
 * the 5 min default (PACKAGES on every build, not just every sync).
 */
export function cacheControl(key: string): string {
  if (/\.(tar\.gz|tgz|tar\.bz2|zip)$/.test(key)) {
    return "public, max-age=31536000, s-maxage=31536000, immutable";
  }
  const name = key.slice(key.lastIndexOf("/") + 1);
  const short = SHORT_LIVED.find(([test]) => test(name));
  return `public, max-age=${short ? short[1] : 300}, s-maxage=31536000`;
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
