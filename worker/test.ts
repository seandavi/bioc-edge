// node --test worker/test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  candidates,
  cacheControl,
  contentType,
  decodePath,
  notModified,
  resolveLinks,
  archiveFallback,
  redirectFor,
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
    "the live docroot/packages/3.18/data/annotation/VIEWS",
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
