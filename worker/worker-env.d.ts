// @cloudflare/workers-types declares caches.default only in its `experimental`
// entrypoint, which does not resolve through tsconfig "types". The Workers
// runtime does expose it, and index.ts depends on it, so declare it here
// rather than casting at the use site.
declare global {
  interface CacheStorage {
    readonly default: Cache;
  }
}
export {};
