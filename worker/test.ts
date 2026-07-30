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
} from "./src/keys.ts";

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
