// node --test worker/test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { candidates, cacheControl, decodePath } from "./src/keys.ts";

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
  assert.deepEqual(candidates("/help/faq"), ["help/faq.html", "help/faq/index.html"]);
});

test("a dot in a parent directory does not count as an extension", () => {
  // /packages/3.24/bioc must not be mistaken for a file named "3.24"
  assert.deepEqual(candidates("/packages/3.24/bioc"), [
    "packages/3.24/bioc.html",
    "packages/3.24/bioc/index.html",
  ]);
});

test("malformed percent-escapes are rejected, valid ones decoded", () => {
  assert.equal(decodePath("/help/%ZZ"), null);
  assert.equal(decodePath("/help/a%20b.html"), "/help/a b.html");
});

test("browsers recheck often, the edge holds everything ~forever", () => {
  const html = cacheControl("text/html; charset=utf-8");
  assert.match(html, /max-age=300/);
  assert.match(html, /s-maxage=31536000/);

  // Edge TTL is uniform; freshness comes from purge-on-sync, not expiry.
  for (const t of ["application/gzip", null]) {
    assert.match(cacheControl(t), /s-maxage=31536000/);
    assert.match(cacheControl(t), /immutable/);
  }
});
