// node --test worker/test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  candidates,
  cacheControl,
  contentType,
  decodePath,
  notModified,
  logQuery,
  resolveLinks,
  archiveFallback,
  redirectFor,
  listablePrefix,
  packageShortUrl,
  previewKeys,
  previewHref,
  previewRest,
  buildKeys,
  routedKeys,
  stagingPath,
  renderIndex,
  accessRecord,
} from "./src/keys.ts";
import redirects from "./src/redirects.json" with { type: "json" };

// Real entries from the 2026-07-30 docroot listing, not invented ones.
// `find mirror -type l -printf '%P\t%l\n'` is what sync.sh publishes.
const LINKS = {
  "packages/release": "3.23",
  "packages/devel": "3.24",
  "books/release": "3.23",
  "packages/3.23/bioc/bin/windows/contrib/4.7": "4.6",
  "packages/2.10/extra/bin/windows64": "windows",
  "packages/1.8/lindsey/bin/macosx/i386": "universal",
  "packages/lindsey/release": "../release/lindsey",
  "packages/lindsey/index.html": "release/index.html",
  "packages/lindsey/stable": ".",
  "packages/omegahat/1.6/src/contrib/Source": ".",
  "checkResults/3.10/bioc-LATEST": "bioc-20200415",
  "checkResults/2.10/bioc-20120924": "bioc-LATEST/",
  "LoriTempToRemove/data/annotation/VIEWS":
    "/the/live/docroot/packages/3.18/data/annotation/VIEWS",
};

test("directory paths get index.html", () => {
  assert.deepEqual(candidates("/"), ["index.html"]);
  assert.deepEqual(candidates("/help/"), ["help/index.html"]);
  assert.deepEqual(candidates("/help/course-materials/"), [
    "help/course-materials/index.html",
  ]);
});

test("paths with extensions are served as-is", () => {
  assert.deepEqual(candidates("/help/index.html"), ["help/index.html"]);
  assert.deepEqual(candidates("/packages/release/bioc/src/contrib/DESeq2_1.0.tar.gz"), [
    "packages/release/bioc/src/contrib/DESeq2_1.0.tar.gz",
  ]);
});

test("extensionless paths try .html then /index.html", () => {
  assert.deepEqual(candidates("/help/faq"), [
    "help/faq.html",
    "help/faq/index.html",
    "help/faq",
  ]);
});

test("a dot in a parent directory does not count as an extension", () => {
  // /packages/3.24/bioc must not be mistaken for a file named "3.24"
  assert.deepEqual(candidates("/packages/3.24/bioc"), [
    "packages/3.24/bioc.html",
    "packages/3.24/bioc/index.html",
    "packages/3.24/bioc",
  ]);
});

test("malformed percent-escapes are rejected, valid ones decoded", () => {
  assert.equal(decodePath("/help/%ZZ"), null);
  assert.equal(decodePath("/help/a%20b.html"), "/help/a b.html");
});

test("immutable only for version-stamped archives", () => {
  // Unhashed asset names: a fix must not be hidden from returning visitors,
  // and purge cannot reach browsers.
  for (const k of ["style/base/colors.css", "js/bioconductor.js", "help/index.html"]) {
    assert.match(cacheControl(k), /max-age=300/);
    assert.doesNotMatch(cacheControl(k), /immutable/);
  }
  // Version is in the filename, so these really never change.
  assert.match(cacheControl("packages/DESeq2_1.44.0.tar.gz"), /immutable/);
  assert.match(cacheControl("packages/x_1.0.tgz"), /immutable/);
  // Edge TTL is uniform; freshness comes from purge-on-sync.
  for (const k of ["a/b.css", "a/b.tar.gz"]) assert.match(cacheControl(k), /s-maxage=31536000/);
});

test("short-lived filetypes get the .htaccess FilesMatch browser TTL", () => {
  // These regenerate on every build, not just every sync -- PACKAGES/VIEWS
  // drive install.packages(), so a stale copy is a broken install, not just
  // a stale page. .htaccess (inventory/htaccess-20260730.conf:18-44).
  assert.match(cacheControl("packages/3.24/bioc/src/contrib/PACKAGES"), /max-age=30(?!\d)/);
  assert.match(cacheControl("packages/3.24/bioc/VIEWS"), /max-age=30(?!\d)/);
  assert.match(cacheControl("BiocInstaller.dcf"), /max-age=60(?!\d)/);
  // .js/.json: the one case where the port gives a *longer* browser TTL
  // than this repo's own 5 min default -- js/bioconductor.js is not
  // immutable (unhashed name), but it does regenerate slower than HTML.
  // Unhashed JS stays on the short default even though upstream .htaccess
  // says A600: purge clears the edge, never browsers, so a longer browser
  // TTL is exactly how a fix stays hidden from returning visitors.
  assert.match(cacheControl("js/bioconductor.js"), /max-age=300(?!\d)/);
  assert.match(cacheControl("shields/foo.svg"), /max-age=30(?!\d)/);
  // Not a FilesMatch type: falls through to the ordinary 5 min default.
  assert.match(cacheControl("style/base/colors.css"), /max-age=300(?!\d)/);
});

test("extensionless keys stay reachable (flattened redirects)", () => {
  // wget saves a redirect body under the requested path, so /books/OSCA is
  // stored as an extensionless HTML file and must still resolve.
  assert.deepEqual(candidates("/books/OSCA"), [
    "books/OSCA.html",
    "books/OSCA/index.html",
    "books/OSCA",
  ]);
});

test("content type falls back rather than serving none", () => {
  assert.match(contentType("style/base/colors.css"), /^text\/css/);
  assert.equal(contentType("packages/x_1.0.tar.gz"), "application/gzip");
  assert.match(contentType("books/OSCA"), /^text\/html/); // extensionless
  assert.match(contentType("packages/3.24/bioc"), /^text\/html/); // dot is a dir
});

test("release and devel resolve as prefixes, not just as whole paths", () => {
  assert.equal(
    resolveLinks("packages/release/bioc/html/DESeq2.html", LINKS),
    "packages/3.23/bioc/html/DESeq2.html",
  );
  assert.equal(resolveLinks("packages/devel/bioc/VIEWS", LINKS), "packages/3.24/bioc/VIEWS");
  assert.equal(resolveLinks("packages/release", LINKS), "packages/3.23");
  assert.equal(resolveLinks("books/release/OSCA/index.html", LINKS), "books/3.23/OSCA/index.html");
});

test("contrib R-version aliases resolve -- the install.packages() path", () => {
  // One build serves two R versions. Losing this 404s installs on 4.7 while
  // every browse URL keeps working, so it fails quietly.
  assert.equal(
    resolveLinks("packages/3.23/bioc/bin/windows/contrib/4.7/DESeq2_1.44.0.zip", LINKS),
    "packages/3.23/bioc/bin/windows/contrib/4.6/DESeq2_1.44.0.zip",
  );
  assert.equal(
    resolveLinks("packages/2.10/extra/bin/windows64/contrib/x.zip", LINKS),
    "packages/2.10/extra/bin/windows/contrib/x.zip",
  );
  assert.equal(
    resolveLinks("packages/1.8/lindsey/bin/macosx/i386/contrib/y.tgz", LINKS),
    "packages/1.8/lindsey/bin/macosx/universal/contrib/y.tgz",
  );
});

test("relative targets resolve against the link's own directory, and chain", () => {
  // lindsey/release -> ../release/lindsey, then packages/release -> 3.23
  assert.equal(
    resolveLinks("packages/lindsey/release/html/index.html", LINKS),
    "packages/3.23/lindsey/html/index.html",
  );
  // Three hops, starting from a link on a file rather than a directory:
  //   packages/lindsey/index.html  (-> release/index.html)
  //   packages/lindsey/release/index.html  (-> ../release/lindsey)
  //   packages/release/lindsey/index.html  (-> 3.23)
  //   packages/3.23/lindsey/index.html
  // The lindsey repo's landing page, which is what that path means.
  assert.equal(
    resolveLinks("packages/lindsey/index.html", LINKS),
    "packages/3.23/lindsey/index.html",
  );
});

test("self-referential links collapse instead of looping", () => {
  // `stable -> .` means packages/lindsey/stable/X is packages/lindsey/X.
  assert.equal(resolveLinks("packages/lindsey/stable/src", LINKS), "packages/lindsey/src");
  assert.equal(
    resolveLinks("packages/omegahat/1.6/src/contrib/Source/pkg_1.0.tar.gz", LINKS),
    "packages/omegahat/1.6/src/contrib/pkg_1.0.tar.gz",
  );
});

test("cycles and escapes stop rather than hang or leave the docroot", () => {
  // bioc-20120924 -> bioc-LATEST/ -> bioc-20200415 is fine, but a map where
  // the two point at each other must still terminate.
  const cyclic = { "a/x": "y", "a/y": "x" };
  assert.doesNotThrow(() => resolveLinks("a/x/f.html", cyclic));

  // Absolute target escapes the mirror. Left unresolved, so it 404s -- which
  // is right: the unresolved key is a symlink and was never uploaded.
  assert.equal(
    resolveLinks("LoriTempToRemove/data/annotation/VIEWS", LINKS),
    "LoriTempToRemove/data/annotation/VIEWS",
  );
  // Climbing above the docroot is refused the same way.
  assert.equal(resolveLinks("a/b/c.html", { "a/b": "../../../etc" }), "a/b/c.html");
});

test("candidates resolves links on both sides of the index.html expansion", () => {
  // Directory link: only visible in the prefix, before expansion.
  assert.deepEqual(candidates("/packages/release/bioc/", LINKS), [
    "packages/3.23/bioc/index.html",
  ]);
  // File link: only visible after the expansion produced index.html.
  assert.deepEqual(candidates("/packages/lindsey/", LINKS), ["packages/3.23/lindsey/index.html"]);
  // Extensionless expansion, each candidate resolved, duplicates collapsed.
  assert.deepEqual(candidates("/packages/release/bioc", LINKS), [
    "packages/3.23/bioc.html",
    "packages/3.23/bioc/index.html",
    "packages/3.23/bioc",
  ]);
});

test("no link map means unchanged behaviour", () => {
  // The map is loaded from R2 at runtime; if it is missing the Worker must
  // still serve every non-symlinked path exactly as before.
  assert.deepEqual(candidates("/help/faq"), ["help/faq.html", "help/faq/index.html", "help/faq"]);
  assert.equal(resolveLinks("packages/release/bioc", {}), "packages/release/bioc");
});

test("listablePrefix matches only the directories the origin autoindexes", () => {
  // Measured against production, not guessed: within packages/ only Archive/
  // and its per-package subdirectories return 200 on a directory URL.
  assert.equal(
    listablePrefix("packages/3.23/bioc/src/contrib/Archive/index.html"),
    "packages/3.23/bioc/src/contrib/Archive/",
  );
  assert.equal(
    listablePrefix("packages/3.23/bioc/src/contrib/Archive/DelayedArray/index.html"),
    "packages/3.23/bioc/src/contrib/Archive/DelayedArray/",
  );
  // Two-segment repos, and the archive prefix archiveFallback() produces.
  assert.equal(
    listablePrefix("packages/3.23/data/annotation/src/contrib/Archive/index.html"),
    "packages/3.23/data/annotation/src/contrib/Archive/",
  );
  assert.equal(
    listablePrefix("archive.bioconductor.org/packages/3.15/bioc/src/contrib/Archive/index.html"),
    "archive.bioconductor.org/packages/3.15/bioc/src/contrib/Archive/",
  );
  assert.equal(listablePrefix("rss/index.html"), "rss/");

  // Everything else 403s on the origin and must keep 404ing here -- listing
  // them would publish ~1.35M crawlable pages bioconductor.org does not serve.
  assert.equal(listablePrefix("packages/3.23/bioc/src/contrib/index.html"), null);
  assert.equal(listablePrefix("packages/3.23/bioc/citations/bedbaser/index.html"), null);
  assert.equal(listablePrefix("packages/3.23/bioc/bin/windows/contrib/4.6/index.html"), null);
  assert.equal(listablePrefix("style/index.html"), null);
  // A file under a listable directory is a file, not a listing.
  assert.equal(
    listablePrefix("packages/3.23/bioc/src/contrib/Archive/DelayedArray/DelayedArray_0.38.0.tar.gz"),
    null,
  );
});

test("renderIndex links absolutely and sorts", () => {
  const html = renderIndex(
    "packages/3.23/bioc/src/contrib/Archive/DelayedArray/",
    [],
    [
      { name: "DelayedArray_0.38.1.tar.gz", size: 2 },
      { name: "DelayedArray_0.38.0.tar.gz", size: 1 },
    ],
  );
  // Absolute, because this page also answers the URL without the trailing
  // slash -- Apache 301s that first, and relative hrefs would resolve a
  // directory too high without the redirect.
  assert.match(
    html,
    /href="\/packages\/3\.23\/bioc\/src\/contrib\/Archive\/DelayedArray\/DelayedArray_0\.38\.0\.tar\.gz"/,
  );
  assert.ok(html.indexOf("0.38.0") < html.indexOf("0.38.1"));
  assert.match(html, /href="\/packages\/3\.23\/bioc\/src\/contrib\/Archive\/">Parent Directory/);
  // Subdirectories keep their trailing slash, or the link lands on the
  // extensionless-file candidate instead of the directory.
  assert.match(renderIndex("rss/", ["build"], []), /href="\/rss\/build\/">build\/</);
});

test("archiveFallback keys archived packages onto the migrated OSN layout", () => {
  // Real shape from .htaccess:65-83 -- versions before the current
  // release/devel pair had their src/contrib tarballs 302'd to OSN.
  assert.equal(
    archiveFallback("packages/2.10/bioc/src/contrib/DESeq_1.0.tar.gz", LINKS),
    "archive.bioconductor.org/packages/2.10/bioc/src/contrib/DESeq_1.0.tar.gz",
  );
  // The "Archive/" subpath (old versions-of-versions) is not special-cased
  // in the port -- same version gate, same key shape.
  assert.equal(
    archiveFallback("packages/3.15/bioc/src/contrib/Archive/DESeq2/DESeq2_1.20.0.tar.gz", LINKS),
    "archive.bioconductor.org/packages/3.15/bioc/src/contrib/Archive/DESeq2/DESeq2_1.20.0.tar.gz",
  );
  // Current release/devel are never archived -- their tarballs live in the
  // ordinary docroot mirror, same as everything else under packages/3.23/.
  assert.equal(archiveFallback("packages/3.23/bioc/html/DESeq2.html", LINKS), null);
  assert.equal(archiveFallback("packages/3.24/bioc/src/contrib/PACKAGES", LINKS), null);
  // Not a "packages/<version>/" path at all -- named repos (lindsey,
  // omegahat) and non-package prefixes (help/, checkResults/) don't match.
  assert.equal(archiveFallback("packages/lindsey/release/index.html", LINKS), null);
  assert.equal(archiveFallback("checkResults/3.10/bioc-LATEST/index.html", LINKS), null);

  // Which versions are current is read from the symlink map, not compiled
  // in. Roll release to 3.25 and 3.23 becomes archivable with no deploy --
  // the case a hardcoded pair would have got wrong until someone shipped.
  const rolled = { "packages/release": "3.25", "packages/devel": "3.26" };
  assert.equal(
    archiveFallback("packages/3.23/bioc/src/contrib/x.tar.gz", rolled),
    "archive.bioconductor.org/packages/3.23/bioc/src/contrib/x.tar.gz",
  );
  assert.equal(archiveFallback("packages/3.25/bioc/src/contrib/x.tar.gz", rolled), null);

  // No map means we cannot tell current from archived. Add nothing: a wrong
  // archive key would be a silently wrong 200, a missing one only the 404
  // we were already serving.
  assert.equal(archiveFallback("packages/2.10/bioc/src/contrib/x.tar.gz", {}), null);
});

test("package short URLs parse: bare, versioned, release/devel, trailing slash", () => {
  // Measured production behaviour, 2026-08-08 (issue #74).
  assert.deepEqual(packageShortUrl("/packages/DECIPHER"), { ver: "release", pkg: "DECIPHER" });
  assert.deepEqual(packageShortUrl("/packages/3.23/DECIPHER"), { ver: "3.23", pkg: "DECIPHER" });
  assert.deepEqual(packageShortUrl("/packages/3.23/DECIPHER/"), { ver: "3.23", pkg: "DECIPHER" });
  assert.deepEqual(packageShortUrl("/packages/devel/DECIPHER"), { ver: "devel", pkg: "DECIPHER" });
  // Dotted names are the case candidates() cannot help with: the last
  // segment reads as having an extension, so only the bare key was tried.
  assert.deepEqual(packageShortUrl("/packages/BSgenome.Hsapiens.UCSC.hg38"), {
    ver: "release",
    pkg: "BSgenome.Hsapiens.UCSC.hg38",
  });
});

test("package short URLs do not swallow real paths", () => {
  // Canonical landing pages and deeper paths pass through untouched.
  assert.equal(packageShortUrl("/packages/3.23/bioc/html/DECIPHER.html"), null);
  assert.equal(packageShortUrl("/packages/release/bioc/src/contrib/x_1.0.tar.gz"), null);
  // /packages itself is a real page, and a version alone is not a package.
  assert.equal(packageShortUrl("/packages"), null);
  assert.equal(packageShortUrl("/packages/3.23/"), null);
  // Names R forbids (hyphens, leading digit) stay 404s rather than probing.
  assert.equal(packageShortUrl("/packages/foo-bar"), null);
  assert.equal(packageShortUrl("/packages/3.23/2ndPkg"), null);
  assert.equal(packageShortUrl("/help/faq"), null);
});

test("candidates tries the archive fallback last, only for old versions", () => {
  // No archive fallback for the current pair -- resolveLinks already
  // produced the real key.
  assert.deepEqual(candidates("/packages/release/bioc/", LINKS), [
    "packages/3.23/bioc/index.html",
  ]);
  // Old version, extensionless: the archive fallback is appended after
  // every ordinary candidate form, not instead of them -- a docroot hit
  // (the html/vignette pages, which upstream never redirected) still wins.
  assert.deepEqual(candidates("/packages/2.10/bioc/vignettes/x", LINKS), [
    "packages/2.10/bioc/vignettes/x.html",
    "packages/2.10/bioc/vignettes/x/index.html",
    "packages/2.10/bioc/vignettes/x",
    "archive.bioconductor.org/packages/2.10/bioc/vignettes/x.html",
    "archive.bioconductor.org/packages/2.10/bioc/vignettes/x/index.html",
    "archive.bioconductor.org/packages/2.10/bioc/vignettes/x",
  ]);
});

test("redirectFor: exact wins over prefix, longest prefix wins over shorter", () => {
  const rs = {
    exact: { "/overview/acks.html": "/about/" },
    prefix: [
      // Deliberately out of length order, to prove redirectFor doesn't
      // depend on caller-supplied ordering the way the generator's own
      // sort guarantees for the real file.
      { from: "/overview", to: "/about", keepSuffix: true },
      { from: "/overview/coredevs", to: "/about/core-team/", keepSuffix: false },
    ],
  };
  // Exact beats prefix even though "/overview" is also a textual prefix of
  // "/overview/acks.html".
  assert.equal(redirectFor("/overview/acks.html", rs), "/about/");
  // Both prefixes match "/overview/coredevs/x"; the shorter one would win
  // if length weren't respected, giving the wrong (catch-all) target.
  assert.equal(redirectFor("/overview/coredevs/x", rs), "/about/core-team/");
  // Suffix-preserving: "/overview$1" behaviour from .htaccess:193.
  assert.equal(redirectFor("/overview/related", rs), "/about/related");
  assert.equal(redirectFor("/unrelated", rs), null);
});

test("redirectFor against the generated redirects.json: real .htaccess rules", () => {
  const rs = redirects as { exact: Record<string, string>; prefix: { from: string; to: string; keepSuffix: boolean }[] };
  // .htaccess:117 docs/papers.*$ -> fixed target, suffix dropped.
  assert.equal(redirectFor("/docs/papers/some/old/thing", rs), "/help/publications/");
  // .htaccess:170 pub(.*)$ -> /help/publications$1, suffix kept.
  assert.equal(redirectFor("/pub/RBioinf/foo.pdf", rs), "/help/publications/books/r-programming-for-bioinformatics/foo.pdf");
  // .htaccess:55+253 -- PT rewrite collapsed with the prefix rule it fed
  // into, into one direct redirect.
  assert.equal(redirectFor("/developers/how-to/git-mirror/", rs), "/about/mirrors/mirror-how-to.html");
  // .htaccess:287, bare `Redirect` -- prefix match, suffix appended, by the
  // directive's own semantics rather than a wildcard in the pattern.
  assert.equal(redirectFor("/bioc2013/schedule", rs), "https://secure.bioconductor.org/BioC2013/schedule");
  // .htaccess:112-113 container-binaries -- version reused verbatim in the
  // target, expanded per-version by the generator rather than parsed as a
  // backreference.
  assert.equal(
    redirectFor("/packages/3.20/container-binaries/src/foo.tar.gz", rs),
    "https://storage.googleapis.com/bioconductor-packages/3.20/container-binaries/bioconductor_docker/src/foo.tar.gz",
  );
  // OSN rules never appear as redirects at all -- they became
  // archiveFallback() key mapping instead.
  assert.equal(redirectFor("/packages/2.10/bioc/src/contrib/foo.tar.gz", rs), null);
});

test("query strings are logged bounded, so one crawler cannot blind the log", () => {
  assert.equal(logQuery("?utm_source=twitter&utm_medium=social"), "utm_source=twitter&utm_medium=social");
  assert.equal(logQuery(""), "");
  assert.equal(logQuery("?"), "");
  // No leading ? whichever form arrives.
  assert.equal(logQuery("a=1"), "a=1");

  // The one that matters. Analytics Engine rejects an oversized datapoint,
  // and a rejected write loses the WHOLE row -- path, UA, ASN, everything --
  // not just this field. An unbounded attacker-controlled string here would
  // let a single crawler switch off the logging that exists to catch it.
  const huge = "?x=" + "a".repeat(10000);
  const got = logQuery(huge);
  assert.ok(got.length < 300, `expected bounded, got ${got.length}`);
  assert.match(got, /\.\.\.\[truncated\]$/);
  // Marked, so a clipped value is never read as a complete one.
  assert.notEqual(got, huge.slice(1));
});

test("cache hits honour client validators", () => {
  const res = (h: Record<string, string>) => new Response("x", { headers: h });
  const req = (h: Record<string, string>) => new Request("https://x/", { headers: h });
  const lm = "Mon, 27 Jul 2026 21:42:10 GMT";

  assert.equal(notModified(req({ "if-none-match": '"abc"' }), res({ etag: '"abc"' })), true);
  // Cloudflare weakens ETags when compressing; W/ must still match.
  assert.equal(notModified(req({ "if-none-match": 'W/"abc"' }), res({ etag: '"abc"' })), true);
  assert.equal(notModified(req({ "if-none-match": '"other"' }), res({ etag: '"abc"' })), false);
  assert.equal(notModified(req({ "if-modified-since": lm }), res({ "last-modified": lm })), true);
  assert.equal(
    notModified(req({ "if-modified-since": "Mon, 27 Jul 2026 21:00:00 GMT" }), res({ "last-modified": lm })),
    false,
  );
  assert.equal(notModified(req({}), res({ etag: '"abc"', "last-modified": lm })), false);
});

// ---------------------------------------------------------------------------
// The access record. This exists because the failure mode is not a crash: a
// Logpush job can run for months emitting records that look healthy and are
// missing the one field download statistics needed, and nothing can backfill
// it. See seandavi/bioc-cloudflare#69.

// FIELDS from cloudfront-logs-to-parquet.py, minus date/time -- those are
// derivable from ts and are deliberately not split at ingest.
const CLOUDFRONT_FIELDS = [
  "x_edge_location", "sc_bytes", "c_ip", "cs_method", "cs_host", "cs_uri_stem",
  "sc_status", "cs_referer", "cs_user_agent", "cs_uri_query", "cs_cookie",
  "x_edge_result_type", "x_edge_request_id", "x_host_header", "cs_protocol",
  "cs_bytes", "time_taken", "x_forwarded_for", "ssl_protocol", "ssl_cipher",
  "x_edge_response_result_type", "cs_protocol_version", "fle_status",
  "fle_encrypted_fields", "c_port", "time_to_first_byte",
  "x_edge_detailed_result_type", "sc_content_type", "sc_content_len",
  "sc_range_start", "sc_range_end",
];

const REQ = () =>
  new Request("https://bioconductor.org/packages/3.23/bioc/src/contrib/limma_3.69.2.tar.gz?x=1", {
    headers: {
      "cf-connecting-ip": "203.0.113.7",
      "user-agent": "R (4.6.1 x86_64-pc-linux-gnu)",
      referer: "https://bioconductor.org/packages/limma/",
      cookie: "session=should-not-be-logged",
      "cf-ray": "9a1b2c3d4e5f6789",
      host: "bioconductor.org",
    },
  });

test("the record carries every CloudFront column", () => {
  const rec = accessRecord(REQ(), 200, "MISS", null, null) as Record<string, unknown>;
  const missing = CLOUDFRONT_FIELDS.filter((f) => !(f in rec));
  assert.deepEqual(missing, [], `dropped CloudFront columns: ${missing.join(", ")}`);
});

test("the fields statistics depend on are populated, not null", () => {
  const rec = accessRecord(REQ(), 200, "MISS", null, 1000) as Record<string, unknown>;
  assert.equal(rec.c_ip, "203.0.113.7");
  assert.equal(rec.cs_user_agent, "R (4.6.1 x86_64-pc-linux-gnu)");
  assert.equal(rec.cs_referer, "https://bioconductor.org/packages/limma/");
  assert.equal(rec.cs_uri_stem, "/packages/3.23/bioc/src/contrib/limma_3.69.2.tar.gz");
  assert.equal(rec.cs_uri_query, "?x=1");
  assert.equal(rec.sc_status, 200);
  assert.equal(rec.x_edge_request_id, "9a1b2c3d4e5f6789");
  assert.ok(typeof rec.time_taken === "number");
});

test("cookies are not collected even when sent", () => {
  const rec = accessRecord(REQ(), 200, "MISS", null, null) as Record<string, unknown>;
  assert.equal(rec.cs_cookie, null);
});

test("byte counts come from the response, and null means unknown", () => {
  const sized = new Response(null, { headers: { "content-length": "611924" } });
  assert.equal((accessRecord(REQ(), 200, "MISS", sized, null) as Record<string, unknown>).sc_bytes, 611924);
  // A streamed R2 body carries no Content-Length. Unknown, not zero.
  assert.equal((accessRecord(REQ(), 200, "MISS", new Response(null), null) as Record<string, unknown>).sc_bytes, null);
});

test("range responses record their span", () => {
  const partial = new Response(null, {
    status: 206,
    headers: { "content-range": "bytes 0-65535/611924" },
  });
  const rec = accessRecord(REQ(), 206, "RANGE", partial, null) as Record<string, unknown>;
  assert.equal(rec.sc_range_start, 0);
  assert.equal(rec.sc_range_end, 65535);
  assert.equal(rec.sc_bytes, 65536);
});

test("a full GET records the object size, since R2 bodies carry no length", () => {
  const streamed = new Response("body", { status: 200 });
  const rec = accessRecord(REQ(), 200, "MISS", streamed, null, 611924) as Record<string, unknown>;
  assert.equal(rec.sc_bytes, 611924);
  // HEAD sends no body: charging it the object size would overstate transfer.
  const head = new Response(null, { status: 200 });
  assert.equal((accessRecord(REQ(), 200, "MISS", head, null, 611924) as Record<string, unknown>).sc_bytes, null);
});

test("preview paths map onto the PR's build prefix", () => {
  assert.deepEqual(previewKeys("/_pr/5/"), ["preview/pr-5/index.html"]);
  assert.deepEqual(previewKeys("/_pr/5"), ["preview/pr-5/index.html"]);
  assert.deepEqual(previewKeys("/_pr/5/packages/3.24/bioc/html/limma.html"), [
    "preview/pr-5/packages/3.24/bioc/html/limma.html",
  ]);
  // Extensionless segment = directory URL: page file first, then index.
  assert.deepEqual(previewKeys("/_pr/12/next"), [
    "preview/pr-12/next.html",
    "preview/pr-12/next/index.html",
  ]);
  // Pagefind's index files have underscores in their extensions.
  assert.deepEqual(previewKeys("/_pr/9/pagefind/pagefind.en_869797bfe1.pf_meta"), [
    "preview/pr-9/pagefind/pagefind.en_869797bfe1.pf_meta",
  ]);
  assert.deepEqual(previewKeys("/_pr/12/next/"), [
    "preview/pr-12/next/index.html",
    "preview/pr-12/next.html",
  ]);
  // Not previews: no traversal out of the prefix, no non-numeric ids.
  assert.equal(previewKeys("/packages/3.24/"), null);
  assert.equal(previewKeys("/_pr/abc/x"), null);
  assert.equal(previewKeys("/_pr/5/../secret"), null);
});

test("preview link rewriting: root-absolute only, idempotent", () => {
  assert.equal(previewHref("/packages/3.24/bioc/html/limma.html", "/_pr/1"), "/_pr/1/packages/3.24/bioc/html/limma.html");
  assert.equal(previewHref("/", "/_pr/1"), "/_pr/1/");
  assert.equal(previewHref("//cdn.example.org/x.js", "/_pr/1"), null);
  assert.equal(previewHref("https://bioconductor.org/x", "/_pr/1"), null);
  assert.equal(previewHref("#section", "/_pr/1"), null);
  assert.equal(previewHref("relative/page.html", "/_pr/1"), null);
  assert.equal(previewHref("/_pr/1/already.html", "/_pr/1"), null);
  assert.equal(previewHref("/_pr/1", "/_pr/1"), null);
  assert.equal(previewHref("/_pr/12/other.html", "/_pr/1"), "/_pr/1/_pr/12/other.html");
});

test("preview keys resolve symlink aliases; previewRest strips the prefix", () => {
  assert.deepEqual(
    previewKeys("/_pr/5/packages/release/bioc/html/limma.html", LINKS),
    ["preview/pr-5/packages/3.23/bioc/html/limma.html"],
  );
  assert.equal(previewRest("/_pr/5/news/"), "/news/");
  assert.equal(previewRest("/_pr/5"), "/");
  assert.equal(previewRest("/_pr/5/checkResults/"), "/checkResults/");
});

test("route table: flipped prefixes map onto the build, everything else stays null", () => {
  const routes = { prefixes: ["/help/", "/about/"] };
  assert.deepEqual(routedKeys("/help/", routes, "abc123"), ["site/abc123/help/index.html", "site/abc123/help.html"]);
  // A prefix owns everything beneath it, and the slashless directory form.
  assert.deepEqual(routedKeys("/help/faq", routes, "abc123"), [
    "site/abc123/help/faq.html",
    "site/abc123/help/faq/index.html",
  ]);
  assert.deepEqual(routedKeys("/help", routes, "abc123"), ["site/abc123/help.html", "site/abc123/help/index.html"]);
  // Not flipped: the mirror keeps it.
  assert.equal(routedKeys("/packages/release/", routes, "abc123"), null);
  assert.equal(routedKeys("/helpless", routes, "abc123"), null);
  // No sha, or nothing flipped: nothing routed.
  assert.equal(routedKeys("/help/", routes, ""), null);
  assert.equal(routedKeys("/help/", { prefixes: [] }, "abc123"), null);
  // Symlink aliases resolve before the build prefix, same as previews.
  assert.deepEqual(
    routedKeys("/packages/release/bioc/html/limma.html", { prefixes: ["/packages/"] }, "abc123", LINKS),
    ["site/abc123/packages/3.23/bioc/html/limma.html"],
  );
});

test("staging: /_latest rides the preview machinery", () => {
  assert.equal(stagingPath("/_latest/"), true);
  assert.equal(stagingPath("/_latest"), true);
  assert.equal(stagingPath("/_latest/news/"), true);
  assert.equal(stagingPath("/_latests"), false);
  assert.equal(previewRest("/_latest/news/"), "/news/");
  assert.equal(previewRest("/_latest"), "/");
  assert.deepEqual(buildKeys("/news/", "site/abc123/", {}), [
    "site/abc123/news/index.html",
    "site/abc123/news.html",
  ]);
  assert.equal(buildKeys("/../secret", "site/abc123/", {}), null);
});
