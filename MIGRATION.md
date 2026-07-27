# Bioconductor.org → Cloudflare R2 migration plan

Status: prototype plan. Target for the prototype is `bioconductordev.org`; production
cutover to `bioconductor.org` is a later decision.

## Why

Repeated outages traced to EBS IOPS exhaustion on the content volume, amplified by
crawler traffic on `/help/course-materials/` (500k+ requests/day) and by rsync mirrors
pulling directly from master. Static content served from object storage behind a CDN
removes the IOPS ceiling entirely; R2 was chosen over plain S3 because egress is free.

Raising EBS IOPS (Vincent's track) is the stopgap. This is the replacement.

## Constraint: the live site is the only source

No staging or master filesystem access. Everything is sourced by crawling
`https://bioconductor.org` over HTTP. What that costs us, measured against the live site
on 2026-07-27:

| Finding | Consequence |
|---|---|
| `sitemap.xml` returns the literal string `<%= xml_sitemap %>` | Template bug — no sitemap. Crawl must follow links from seed URLs. **Report this upstream.** |
| Directory autoindex is off (`/packages/release/bioc/html/` → 403) | rclone's `:http:` backend cannot enumerate. Requires `wget --mirror` to disk, then `rclone sync` to R2. |
| `robots.txt` disallows `/packages/release/`, `/packages/devel/`, all `/packages/N.N/`, `/checkResults/`, `/biocViews/`, `/stats/`, `/data/`, `/repository/` | A robots-respecting crawl gets the non-package site only. Phase 2 needs `-e robots=off`, which is defensible for a first-party mirror but should be a stated decision. |
| `/help/` is *not* disallowed | Explains the crawler concentration on course materials: it is the largest robots-allowed section. |
| CloudFront returns `X-Cache: Miss` on the homepage and on `/help/course-materials/`; HTML is `Cache-Control: max-age=600` | CloudFront is not absorbing crawler load today. Our crawl reaches master, so it must be rate-limited and run off-peak. |
| Origin sends `ETag` and `Last-Modified` on every response | Incremental re-crawls can use `wget -N` / conditional GETs — cheap after the first pass. |

The weak CloudFront hit ratio is worth noting on its own: it is part of why master melts,
and it is fixable today independent of this migration.

## Scope, in phases

Phase 1 fixes the outage. Phase 3 is the large, risky one and is deliberately last.

| Phase | Content | Crawlable? | Notes |
|---|---|---|---|
| 1 | Non-package site: `/about/`, `/help/`, `/install/`, `/developers/`, `/news/`, assets | Yes, robots-clean | Includes `/help/course-materials/` — the actual outage driver |
| 2 | Package landing pages + vignettes | Yes, needs `robots=off` | Seed from `/packages/release/bioc/`, which lists every package |
| 3 | Package repo: `src/contrib`, `bin/**` | Yes but multi-TB | `BiocManager` depends on these URLs. Separate decision. |

Phase 1 alone should relieve the IOPS pressure. Measure before committing to phase 3.

## Bucket layout

R2 key = URL path with the leading `/` stripped. No prefix, no transformation.

```
/help/course-materials/index.html  →  key: help/course-materials/index.html
```

`wget` already writes `/help/` as `help/index.html`, so the on-disk mirror maps to keys
one-to-one and rclone stays a plain sync. One bucket per phase (`bioc-site`,
`bioc-packages`) so they sync, cache, and roll back independently.

## Crawl

`./crawl.sh site` (phase 1) and `./crawl.sh packages` (phase 2). `SPIDER=1` counts and
sizes without filling disk — but note it still transfers every page, since wget has to
read the HTML to follow links. It saves disk, not load on master.

- **No `--convert-links` and no `--adjust-extension`.** Both rewrite paths; we need keys
  identical to the live URLs.
- `--wait` / `--limit-rate` are not politeness theatre — the crawl hits master. Start
  conservative, run off-peak, watch CloudWatch EBS metrics during the first pass. `RATE`
  and `WAIT` are the knobs.
- `--mirror` implies `--timestamping`, so re-crawls issue conditional requests against
  `Last-Modified` and incremental passes are cheap.
- The crawl sends a distinctive user agent, so it is attributable in master's access logs
  and can be excluded when counting bot traffic.
- Phase 2 adds `-e robots=off`, seeds from `/packages/release/bioc/`, and rejects `/src/`
  and `/bin/` to stay out of the phase 3 repo.
- URLs with query strings are rejected — wget would write them as literal `?` filenames,
  which make poor keys.
- The first run is a survey: count objects and total bytes before sizing anything else.

**The mirror must not be indexed.** wget copies production's `robots.txt` into the
mirror; served from the prototype host that invites search engines to index a full
duplicate of bioconductor.org, which would compete with the real site in results. The
script overwrites it with `Disallow: /`. Remove that only if this mirror is ever promoted
to production.

## Sync

`rclone sync ./mirror r2:bioc-site` on the same cadence the site rebuilds (hourly).

- rclone compares size + modtime, falling back to MD5; R2 ETags are MD5 for single-part
  uploads, so unchanged objects are skipped. Do not use `--size-only` — HTML edits often
  preserve byte length.
- `--dry-run` for the initial load and any layout change.
- Use `copy` for the first runs, confirm object counts match, then switch to `sync`
  (which deletes destination objects absent from the source).
- rclone sets `Content-Type` from the file extension. Verify `.html`, `.css`, `.js`,
  `.svg`, `.tar.gz`, `.tgz`, `.zip` before the first public sync — a wrong type here
  serves the whole site as `application/octet-stream`.

## Serving

Custom domain on the bucket, not `r2.dev` — `r2.dev` is rate-limited, non-production, and
excludes WAF, bot management, and cache rules.

**A Worker with an R2 binding, not a public bucket.** See `worker/`. The bucket has no
public access at all; it is reachable only through the binding. That is the deciding
reason — a public bucket is world-readable by URL whether or not anyone advertises it,
and the rewrite-rule alternative below cannot fix that.

Public R2 buckets have no directory-index behavior either: a request for `/help/` 404s
unless an object is literally keyed `help/`. Transform Rules can paper over that for free
(append `index.html` to `/`-terminated paths), but they are static rewrites with no
fallback chain, no real 404 page, and no per-request logging. Worth knowing as the
fallback if the Worker ever has to come out of the path.

What the binding costs us, and what `worker/src/index.ts` therefore has to do:

- **Binding reads bypass the edge HTTP cache.** There is no `fetch()` to a cacheable URL,
  so nothing populates the cache implicitly and every request bills a Class B op. The
  Worker uses `caches.default` explicitly. This is not an optimization; skipping it
  inverts the cost table below.
- **Range requests must be handled manually.** `bucket.get(key, { range: request.headers })`
  plus a `Content-Range` header and a 206. Phase 3 depends on this — package tarball
  downloads and resumable installs use ranges.
- **Conditional requests must be handled manually.** `onlyIf: request.headers` returns an
  object with no body when a precondition fails; the Worker maps
  If-None-Match/If-Modified-Since to 304 and If-Match/If-Unmodified-Since to 412. Getting
  this wrong silently defeats client and edge caching.

None of this is hard — it is about 80 lines — but all three are free with a public bucket
and must be written correctly with a binding. `worker/test.ts` covers the key-mapping
logic (`node --test worker/test.ts`, no framework, no build step).

## Cache

The whole site is static and changes only when rclone syncs. So: **cache at the edge
effectively forever and invalidate explicitly**, rather than expiring on a timer and
paying for the re-fetch. Time-based TTLs are the wrong tool when you know exactly when
content changed.

Note that with a Worker + binding, **zone Cache Rules do not govern these reads** — they
apply to `fetch()` against an origin, and a binding read is not that. `caches.default`
inside the Worker is the entire cache story, and the TTL comes from the headers the
Worker sets before `cache.put`.

| | Browser (`max-age`) | Edge (`s-maxage`) |
|---|---|---|
| HTML | 5 min | 1 year |
| Assets, tarballs, binaries | 1 day | 1 year, `immutable` |

Freshness comes from purging the changed URLs after each sync, not from expiry. rclone
already reports exactly which keys it wrote (`--log-level INFO`), so the sync job pipes
that list into the Cloudflare purge API.

**Purge granularity is plan-dependent and worth checking early:** purge-by-prefix and
purge-by-tag are Enterprise features. On lower plans you get purge-by-URL in batches of
30, plus purge-everything. An hourly sync touching a handful of files is fine with
batched URL purges; a full rebuild that rewrites thousands means purge-everything and
re-warming from R2 — which is cheap, since egress is free and Class B is $0.36/million.

Also enable Tiered Cache so edge misses coalesce through an upper tier instead of each
data centre pulling from R2 independently. Confirm which tiered-cache topology the plan
includes; Smart Tiered Cache is an Argo add-on.

Given that CloudFront is currently returning `Miss` on the site's hottest paths, this
section is the one most likely to be skipped and most costly to skip.

## Instrumentation

Open question this prototype should answer: is the bot traffic legitimate, accidental, or
malicious? Zone analytics gives volume and cache-hit ratio but not per-request detail;
Logpush is Enterprise. Per-path/per-ASN attribution needs a Worker logging to Workers
Analytics Engine — path, status, cache status, country, ASN, user-agent.

This is the only thing forcing a Worker into the request path. If the bot question gets
answered another way, the rewrite rules alone serve the site.

## Cost (Strides does not cover this)

R2, current list price:

| | Price | Free tier / month |
|---|---|---|
| Standard storage | $0.015 / GB-month | 10 GB |
| Class A (writes, from sync) | $4.50 / million | 1 million |
| Class B (reads, cache misses only) | $0.36 / million | 10 million |
| Egress | free | — |

Storage is negligible at any plausible site size — 500 GB is $7.50/month. Class B is
charged only on Cloudflare cache misses, so a correct cache rule keeps it near zero.
Class A spikes once during the initial load; batch it rather than syncing hourly while
still tuning.

The Cloudflare zone itself can sit on the Free plan. The real variable is Workers: the
free tier is 100k requests/day, well under current traffic, so instrumentation means
Workers Paid at $5/month plus $0.30/million beyond 10M.

Expect single-digit to low-tens of dollars per month. **Confirm against a measured object
count and total size from the phase 1 survey crawl before quoting a number to anyone.**

## Mirrors

Official rsync mirrors currently pull from master, bypassing CloudFront and adding
backend load. Once phases 1 and 2 are validated, ask mirrors to sync from R2 instead. R2
speaks S3, so mirrors switch to `rclone`/`aws s3 sync` rather than `rsync` — a change on
the operators' side needing lead time and a written runbook.

## Cutover

1. Survey crawl of phase 1. Record object count and total bytes.
2. Sync to R2, serve on `bioconductordev.org`, no production traffic.
3. Diff a crawl of `bioconductordev.org` against `bioconductor.org` — status codes and
   content hashes for every URL. Zero unexplained diffs is the gate. (No sitemap, so the
   URL list comes from the phase 1 crawl itself.)
4. Load-test and measure cache hit ratio under the course-materials access pattern.
5. Production: DNS `bioconductor.org` → Cloudflare, origin R2. Keep master running and
   reachable internally.
6. Rollback = DNS back to CloudFront. Keep TTL low for the first week.

**Open:** whether to block direct `master.bioconductor.org` access afterward. Today it
[redacted before publication]
migration unless closed separately.

## Things this plan does not solve

- Anything genuinely dynamic (search, BiocViews-driven queries, build reports updating
  mid-run). These stay on master or move to Workers separately.
- Package landing page freshness. Nightly re-crawl is the near-term answer; sub-daily
  depends on the Our Universe API integration.
- The build itself. staging still builds hourly; this plan only changes where the output
  is published.
- Content that no page links to. Without a sitemap, an unlinked file is invisible to the
  crawl. Fixing `sitemap.xml` upstream would close this gap.
