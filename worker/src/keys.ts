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

/**
 * Directories the origin autoindexes, as an R2 prefix -- or null.
 *
 * Almost nothing in the docroot lists: `citations/`, `html/`, `style/`,
 * `bin/windows/contrib/4.6/`, even `src/contrib/` itself all 403. Probing
 * production found only these on (the vhost that sets it is not in
 * `inventory/`, so this is measured rather than ported):
 *
 *   packages/<ver>/<repo>/src/contrib/Archive/         172 package dirs in 3.23
 *   packages/<ver>/<repo>/src/contrib/Archive/<pkg>/   the archived tarballs
 *   rss/
 *
 * The tarballs under Archive/ were always mirrored -- only the generated page
 * was missing, so the directory 404'd while the file under it served fine
 * (issue #59). `<repo>` is one segment (`bioc`) or two (`data/annotation`).
 *
 * Scoped deliberately, not generalised to "any directory that misses": the
 * docroot has ~1.35M of them, and listing all of them would publish that many
 * crawlable pages the origin does not serve.
 */
const LISTABLE = [
  /^(?:archive\.bioconductor\.org\/)?packages\/[^/]+\/[^/]+(?:\/[^/]+)?\/src\/contrib\/Archive\/(?:[^/]+\/)?$/,
  /^rss\/$/,
];

export function listablePrefix(key: string): string | null {
  if (!key.endsWith("index.html")) return null;
  const prefix = key.slice(0, -"index.html".length);
  return LISTABLE.some((re) => re.test(prefix)) ? prefix : null;
}

const escape = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * mod_autoindex's output, near enough: a heading and a list of links.
 *
 * Links are absolute where Apache's are relative, because this page also
 * answers the no-trailing-slash form of the URL -- Apache 301s that to the
 * slash form first, and relative hrefs would resolve one directory too high
 * without the redirect.
 *
 * Size but no date. R2 knows when an object was *uploaded*, which is when this
 * mirror copied it, not when the builder wrote it -- and a listing of 2019
 * tarballs all dated last month is worse than one dated not at all.
 */
export function renderIndex(
  prefix: string,
  dirs: string[],
  files: { name: string; size: number }[],
): string {
  const parent = prefix.replace(/[^/]+\/$/, "");
  const row = (name: string, href: string, right = "") =>
    `<li><a href="/${href}">${escape(name)}</a>${right}</li>`;
  return [
    "<!DOCTYPE html>",
    `<html><head><title>Index of /${escape(prefix)}</title></head><body>`,
    `<h1>Index of /${escape(prefix)}</h1><ul>`,
    parent ? row("Parent Directory", parent) : "",
    ...[...dirs].sort().map((d) => row(d + "/", prefix + encodeURIComponent(d) + "/")),
    ...[...files]
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((f) => row(f.name, prefix + encodeURIComponent(f.name), `  ${f.size}`)),
    "</ul></body></html>",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The four repos master probes when resolving a package short URL, in an
 * order that cannot matter: a package name exists in one repo per release.
 */
export const PKG_REPOS = ["bioc", "data/annotation", "data/experiment", "workflows"];

/**
 * Package short URLs -- /packages/<pkg> and /packages/<ver>/<pkg> -- are
 * Apache rewrites on master, and they are NOT in the captured .htaccess:
 * the rule lives elsewhere in the vhost config, so gen-redirects.ts can
 * never emit it (issue #74). Measured on production (2026-08-08):
 *
 *   /packages/DECIPHER        302 -> /packages/release/bioc/html/DECIPHER.html
 *   /packages/3.23/DECIPHER   302 -> /packages/3.23/bioc/html/DECIPHER.html
 *   /packages/affydata        302 -> .../data/experiment/html/affydata.html
 *   /packages/rnaseqGene      302 -> .../workflows/html/rnaseqGene.html
 *   /packages/OSCA.intro      302 -> /about/removed-packages/   (books too)
 *
 * The version segment stays literal in the target (`release`, `devel`, or
 * numeric), exactly as master emits it; the symlink map resolves it on the
 * next request. The package pattern is R's own (letters, digits, dots,
 * letter first), so paths this never matched keep 404ing as before.
 */
const SHORT_URL = /^packages\/(?:(\d+\.\d+|release|devel)\/)?([A-Za-z][A-Za-z0-9.]*)\/?$/;

export function packageShortUrl(pathname: string): { ver: string; pkg: string } | null {
  const m = SHORT_URL.exec(pathname.replace(/^\/+/, ""));
  return m ? { ver: m[1] ?? "release", pkg: m[2] } : null;
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

/**
 * Wire bytes, where we can know them without changing what we send.
 *
 * Deliberately does not set Content-Length anywhere to make this easier: the
 * zone compresses text/html at the edge, downstream of us, so a length we
 * derived here would be wrong on exactly the responses it is hardest to notice
 * on. Unknown is recorded as null rather than guessed -- a fabricated zero
 * would silently understate transfer volume forever.
 */
function bytesOf(res: Response | null, size: number | null): number | null {
  if (!res) return null;
  const len = res.headers.get("content-length");
  if (len) return Number(len);
  const r = rangeOf(res);
  if (r) return r.end - r.start + 1;
  // A streamed R2 body carries no Content-Length, so a full 200 GET -- every
  // tarball download, i.e. the thing the statistics are actually about -- would
  // otherwise record null forever. The object size is the body length for that
  // case and only that case: a HEAD sends no body, and anything else either
  // set a length above or genuinely has none.
  if (size !== null && res.status === 200 && res.body !== null) return size;
  return null;
}

/**
 * PR preview builds: bioconductor-website CI publishes each pull request's
 * Astro build under `preview/pr-<n>/` and deletes it when the PR closes.
 * `/_pr/<n>/...` serves that prefix. Pages are real `.html` files (Astro
 * `build.format: 'file'`), so an extensionless segment is a directory URL:
 * try `<path>.html` first, then `<path>/index.html`.
 *
 * ponytail: path-based previews; internal root-absolute links escape to the
 * mirrored legacy site. Wildcard-subdomain previews when a DNS-capable token
 * exists (bioconductor-website issue tracker).
 */
export function previewKeys(path: string, links: Links = {}): string[] | null {
  const m = /^\/_pr\/(\d{1,6})(\/.*)?$/.exec(path);
  if (!m) return null;
  return buildKeys(m[2] ?? "/", `preview/pr-${m[1]}/`, links);
}

/**
 * URL path (site-root form, leading slash) -> candidate keys inside an Astro
 * build prefix (`preview/pr-<n>/` or `site/<sha>/`). Pages are real `.html`
 * files (Astro `build.format: 'file'`), so an extensionless segment is a
 * directory URL: try `<path>.html` first, then `<path>/index.html`.
 */
export function buildKeys(rest: string, base: string, links: Links = {}): string[] | null {
  const r = rest.replace(/^\//, "");
  // R2 keys are literal so `..` cannot traverse, but reject it anyway: a key
  // containing dot segments can only be a probe, never a build artifact.
  if (r.split("/").some((s) => s === "." || s === "..")) return null;
  const cands =
    r === "" || r.endsWith("/")
      ? [`${r}index.html`, ...(r ? [`${r.slice(0, -1)}.html`] : [])]
      : /\.[A-Za-z0-9_-]+$/.test(r.split("/").pop()!)
        ? [r]
        : [`${r}.html`, `${r}/index.html`];
  // Builds emit real versions (packages/3.23/...), never the release/devel
  // aliases, so resolve the symlink map before looking in the build prefix.
  return cands.map((c) => base + resolveLinks(c, links));
}

/** The site-root path inside a preview URL: "/_pr/5/news/" -> "/news/". */
export function previewRest(path: string): string {
  return /^\/(?:_pr\/\d{1,6}|_latest)(\/.*)?$/.exec(path)?.[1] ?? "/";
}

/**
 * The staging view: `/_latest/...` serves the build `site/latest` points at,
 * through the same serving path as a PR preview (link rewriting, no-cache,
 * mirror fallthrough). The whole new site is browsable at its final URLs
 * before any prefix is flipped to it — previews/staging via prefix pointers,
 * no new infra (docs/adr/0008).
 */
export function stagingPath(path: string): boolean {
  return /^\/_latest(\/|$)/.test(path);
}

/**
 * The strangler route table (docs/adr/0008): which URL prefixes the Astro
 * build owns, everything else stays on the mirror. Data in R2, not code, so a
 * flip — or a rollback — is an object write, never a deploy.
 *
 *   { "build": "latest", "prefixes": ["/help/", "/about/"] }
 *
 * `build` is `"latest"` (follow the `site/latest` pointer CI moves on every
 * main push) or a pinned sha — pinning is the one-line rollback when a bad
 * build lands in `latest`. No table object, or an empty prefix list, means
 * nothing is flipped: the mirror serves everything, which is the safe default.
 */
export const ROUTES_KEY = "_routes.json";
export const LATEST_KEY = "site/latest";

export interface Routes {
  build?: string;
  prefixes: string[];
}

/**
 * Candidate keys inside `site/<sha>/` when the path is under a flipped
 * prefix, else null. A table prefix owns everything beneath it; `/help/`
 * also claims the slashless `/help`, which the mirror answers with the same
 * page. Prepended to the mirror candidates rather than replacing them, so a
 * page the build does not contain falls through to production resolution —
 * a flip never has to wait for full coverage of its prefix.
 */
export function routedKeys(
  path: string,
  routes: Routes,
  sha: string,
  links: Links = {},
): string[] | null {
  if (!sha || !routes.prefixes.some((p) => path.startsWith(p) || path + "/" === p)) return null;
  return buildKeys(path, `site/${sha}/`, links);
}

/**
 * Rewrite one URL attribute for a preview page: root-absolute paths get the
 * preview prefix so navigation stays inside the PR's build instead of
 * escaping onto the mirrored legacy site. Everything else — external,
 * protocol-relative, fragments, already-prefixed — returns null (leave as is).
 */
export function previewHref(value: string, prefix: string): string | null {
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (value === prefix || value.startsWith(`${prefix}/`)) return null;
  return prefix + value;
}

/**
 * The client address, keyed-hashed so the raw value never leaves the edge.
 *
 * Pseudonymous, not anonymous: the same client maps to the same id, which is
 * what makes distinct-client counts meaningful and is also the residual risk.
 * An unsalted SHA-256 of an IPv4 address is trivially reversible -- only four
 * billion candidates -- so the salt is what does the work here, not the digest.
 *
 * `salt` is the 64-character lowercase hex *string* from `bioc-logs-ip-salt`,
 * used as text and not decoded to its 32 bytes. That choice is load-bearing:
 * the CloudFront-era backfill hashes with DuckDB's `sha256(salt || c_ip)`, and
 * the two eras must land in one id space or distinct-client counts silently
 * split at the cutover. Verified identical across DuckDB, node crypto and
 * WebCrypto. **The GSM copy carries a trailing newline -- trim it.** A stray
 * `\n` here reads as a working system and produces two disjoint id spaces.
 *
 * Null rather than raw on any missing input: no salt, or no address, means no
 * id. A null is visible in the data as a gap; a raw address would be a
 * permanent one-way leak into an archive that cannot be rewritten.
 */
export async function hashIp(salt: string | undefined, ip: string | null): Promise<string | null> {
  if (!salt || !ip) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + ip));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `Content-Range: bytes 0-99/1234` -> the CloudFront sc_range_start/end pair. */
export function rangeOf(res: Response | null): { start: number; end: number } | null {
  const m = /^bytes (\d+)-(\d+)\//.exec(res?.headers.get("content-range") ?? "");
  return m ? { start: Number(m[1]), end: Number(m[2]) } : null;
}

/**
 * The record, as a plain object so it can be asserted on.
 *
 * Field names are CloudFront's, verbatim, from FIELDS in
 * cloudfront-logs-to-parquet.py. Calibrating the two series across the cutover
 * overlap is then a column-for-column comparison rather than a mapping
 * exercise -- and the mapping is the part that would rot.
 *
 * `null` means "this edge cannot know it", never zero. A fabricated zero in
 * sc_bytes or time_taken would understate transfer and latency forever, and
 * would look like real data while doing it.
 */
export async function accessRecord(
  salt: string | undefined,
  req: Request,
  status: number,
  cacheStatus: string,
  res: Response | null,
  t0: number | null,
  size: number | null = null,
) {
  const cf = req.cf as IncomingRequestCfProperties | undefined;
  const url = new URL(req.url);
  const now = Date.now();
  const contentRange = rangeOf(res);
  return {
      type: "access",
      // v2 de-identifies at the edge: c_ip became client_id and
      // x_forwarded_for stopped being collected. Column parity with CloudFront
      // is deliberately broken in exactly those two places and nowhere else,
      // which is what the version is for -- ingest branches on it.
      v: 2,

      // date and time are deliberately not split out: they are derivable from
      // ts, and splitting here would be a derived column at ingest (ADR 0002).
      ts: now,
      x_edge_location: cf?.colo ?? null,
      // Body bytes. CloudFront counts headers too, so this runs slightly low
      // against sc_bytes -- a known, constant-ish offset rather than a gap.
      sc_bytes: bytesOf(res, size),
      // Sits in c_ip's slot so the record stays column-recognisable against
      // CloudFront; ingest maps it to the same position. See hashIp.
      client_id: await hashIp(salt, req.headers.get("cf-connecting-ip")),
      cs_method: req.method,
      cs_host: url.host,
      cs_uri_stem: url.pathname,
      sc_status: status,
      cs_referer: req.headers.get("referer"),
      cs_user_agent: req.headers.get("user-agent"),
      cs_uri_query: url.search,
      // Deliberately not collected. CloudFront logs cookies, but this is a
      // static site that sets none, and starting to retain them would put
      // third-party tokens into a permanent archive for no analytical gain.
      // Collection is a separate act from filtering a copy -- see #69.
      cs_cookie: null,
      x_edge_result_type: cacheStatus,
      x_edge_request_id: req.headers.get("cf-ray"),
      x_host_header: req.headers.get("host"),
      cs_protocol: url.protocol.replace(":", ""),
      // Request bytes are not exposed to a Worker.
      cs_bytes: null,
      time_taken: t0 === null ? null : now - t0,
      // Deliberately not collected, as of v2. This carries a *chain* of raw
      // client addresses, so hashing c_ip while still writing this one would
      // de-identify nothing -- the address would land in the archive anyway,
      // one field over. Measured at 0.5% populated across the CloudFront era,
      // so the analytic loss is negligible and the same drop is applied to the
      // historical backfill. Kept as an explicit null rather than removed, so
      // the CloudFront column set stays intact.
      x_forwarded_for: null,
      ssl_protocol: cf?.tlsVersion ?? null,
      ssl_cipher: cf?.tlsCipher ?? null,
      x_edge_response_result_type: cacheStatus,
      cs_protocol_version: cf?.httpProtocol ?? null,
      // CloudFront field-level encryption. No analogue, kept for column parity.
      fle_status: null,
      fle_encrypted_fields: null,
      c_port: null,
      // Not separable from time_taken at the edge.
      time_to_first_byte: null,
      x_edge_detailed_result_type: cacheStatus,
      sc_content_type: res?.headers.get("content-type") ?? null,
      sc_content_len: res?.headers.get("content-length") ?? null,
      sc_range_start: contentRange?.start ?? null,
      sc_range_end: contentRange?.end ?? null,

      // Beyond CloudFront -- things Cloudflare hands us for nothing. Kept in a
      // separate block so the parity set above stays recognisable.
      cf_country: cf?.country ?? null,
      cf_continent: cf?.continent ?? null,
      cf_asn: cf?.asn ?? null,
      cf_as_organization: cf?.asOrganization ?? null,
      cf_client_tcp_rtt: cf?.clientTcpRtt ?? null,
      cf_client_accept_encoding: cf?.clientAcceptEncoding ?? null,

      // And then the whole thing, verbatim.
      //
      // We get one shot at this: a field not written here is not recoverable
      // later, and enumerating what we think Cloudflare exposes guarantees we
      // miss whatever it adds next. So do not enumerate -- keep the object.
      // Costs a few hundred bytes per request and removes the entire class of
      // "we should have logged that".
      //
      // Named fields above are kept anyway: they are the calibration surface
      // against CloudFront and should not move if Cloudflare renames something
      // in here. This is deliberate duplication.
      //
      // Only Cloudflare's own inferences about the connection go in. Request
      // headers do not: those carry user-supplied secrets (cookies,
      // authorization) that have no business in a permanent archive.
      cf: (cf as unknown as Record<string, unknown>) ?? null,
  };
}
