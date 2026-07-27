// node --test worker/test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  candidates,
  cacheControl,
  contentType,
  decodePath,
  notModified,
} from "./src/keys.ts";

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
