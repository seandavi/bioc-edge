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

  // Extensionless: /help/faq -> help/faq.html, then help/faq/index.html
  return [p + ".html", p + "/index.html"];
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
 * Content only changes when rclone syncs, so the edge (`s-maxage`) holds
 * everything effectively forever and freshness comes from an explicit purge
 * of the changed URLs after each sync. Browser TTL (`max-age`) stays short so
 * clients pick that purge up without their own stale copy in the way.
 */
export function cacheControl(contentType: string | null): string {
  return contentType?.startsWith("text/html")
    ? "public, max-age=300, s-maxage=31536000"
    : "public, max-age=86400, s-maxage=31536000, immutable";
}
