# Bioconductor.org → Cloudflare R2 migration plan

Status: prototype plan. Target for the prototype is `bioc-dev.cancerdatasci.org`; production
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
| Origin sends `ETag` and `Last-Modified` on every response | Conditional GETs work, but only in a non-recursive refresh pass — see Crawl. |

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
one-to-one and rclone stays a plain sync.

**One bucket, `bioc-site`.** Keys already mirror URL paths, which are unique across the
whole site, so splitting phases into separate buckets fights that design for nothing:
phases are just key prefixes (`help/…`, `packages/…`). `rclone sync` scoped to a prefix
already syncs and rolls back a phase independently, and purge is by URL either way. One
bucket means one binding and no prefix routing in the Worker.

Named for content rather than environment on purpose. R2 buckets cannot be renamed, so a
`-dev` suffix would turn promotion into a full copy of the site instead of a Worker route
change. Environment lives in DNS and the route.

Note the account already has a `bioconductor` bucket — 11k objects, 67 GB of build
reports and checkResults, unrelated to this work. Do not sync into it.

Phase 3, if it happens, is the one case for a second bucket: 188 GB with different
lifecycle needs (Infrequent Access for superseded versions) than the live site.

## Crawl

`./crawl.sh site` (phase 1) and `./crawl.sh packages` (phase 2). `SPIDER=1` counts and
sizes without filling disk — but note it still transfers every page, since wget has to
read the HTML to follow links. It saves disk, not load on master.

- **No `--convert-links` and no `--adjust-extension`.** Both rewrite paths; we need keys
  identical to the live URLs.
- `--wait` / `--limit-rate` are not politeness theatre — the crawl hits master. Start
  conservative, run off-peak, watch CloudWatch EBS metrics during the first pass. `RATE`
  and `WAIT` are the knobs.
- **Discovery and refresh are separate passes, and must be.** `--mirror` implies `-N`,
  and on a 304 wget has no body to extract links from, so a recursive re-crawl dies at
  the first unchanged page. Measured: a resumed crawl made exactly one request, took a
  304 on the root, and walked nothing — silently. Discovery therefore recurses *without*
  `-N` (and needs a clean destination, since wget suffixes rather than overwrites);
  `./crawl.sh refresh` re-fetches the recorded URL list with `-N` and no recursion.
- Only discovery finds new pages, so it has to run on its own schedule — a refresh-only
  cadence would never notice a page that did not exist at the last discovery.
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

## Redirects — unresolved

`/books/OSCA`, `/books/SingleRBook` and friends are redirects. Production answers them
with a **four-hop chain that twice bounces through plaintext `http://`**:

```
/books/SingleRBook          302 -> http://…/books/release/SingleRBook
                            301 -> https://…/books/release/SingleRBook
                            302 -> http://…/books/release/SingleRBook/
                            301 -> https://…/books/release/SingleRBook/
```

Worth reporting upstream on its own — the http hops are a live downgrade on every one of
these URLs.

This breaks the crawl in two ways:

1. wget saves the body under the **requested** path, not the final one, so the mirror
   gets an extensionless `books/SingleRBook` file. `--trust-server-names` does not fix
   it — it collapses the whole path to `index.html`.
2. The canonical `/books/release/SingleRBook/` is never stored at all, because nothing in
   the link graph points at it. Anyone following the real URL would 404 on the mirror.

Two consequences already handled defensively in the Worker: `candidates()` falls back to
the bare extensionless key, and `contentType()` supplies a type for objects stored
without one. That second one matters more than it looks — `cacheControl()` keys off
content type, so a missing type made HTML cache as `immutable` for a year.

**Still to do:** capture the redirect map. `wget -S` logs the chains and survives
`--no-verbose`, so a crawl pass can emit source → final-https-target pairs. Serve those
as single-hop 301s from the Worker and seed the crawl with the targets so canonical paths
are actually stored. Until then the mirror flattens redirects into 200s, which will fail
the byte-identity diff gate.

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

## Two zone settings still degrade HTML

The rule that was disabling caching is gone — HTML now returns `cf-cache-status: HIT`.
Two things remain, both isolated with a controlled probe: the same bytes uploaded to
`etag-probe.html`, `.css` and `.txt`, then fetched.

| Key | ETag returned |
|---|---|
| `etag-probe.css` | `"5609a31e…"` |
| `etag-probe.txt` | `"5609a31e…"` |
| `etag-probe.html` | **absent** |

Identical bytes, same bucket, same request. So:

1. **Something strips `ETag` from `text/html` responses.** It is content-type driven, not
   caused by the Worker, the Cache API, or compression. This is what an HTML
   post-processing feature does — Email Address Obfuscation or Rocket Loader — and it
   strips the validator whenever the feature is *enabled*, whether or not it actually
   rewrites that particular page. An earlier check here was misleading: served bytes were
   byte-identical to R2, but that only means those pages had no email address to rewrite.
   Without an ETag, no conditional request can ever 304, so every browser revalidation is
   a full transfer.

2. **Browser Cache TTL overrides `max-age` on cache hits.** A fresh HTML response carries
   the Worker's `max-age=300`; the same URL once cached returns `max-age=86400`. CSS is
   unaffected only because its own value is already 86400. Freshness here comes from
   purge-on-sync, and purging clears the edge but not browsers — so a one-day browser TTL
   means readers hold stale HTML for a day after a successful purge.

Fixes, on `cancerdatasci.org` and again at production cutover:

- Scrape Shield → **Email Address Obfuscation: off**; Speed → Optimization → **Rocket
  Loader: off**. Re-run the probe; the ETag should return on `.html`.
- Caching → Configuration → **Browser Cache TTL: Respect Existing Headers**.

## Credentials

`./make-env.sh` pulls from Google Secret Manager (project `cdsci-infra`) into a
gitignored `.env`. Nothing secret lives in this repo.

The two existing Cloudflare tokens are exactly complementary, and **neither can deploy
this Worker**:

| | `cdsci-cloudflare-workers-token` | `cdsci-cloudflare-api-token` |
|---|---|---|
| Workers scripts | yes | no |
| R2 | no | yes |
| DNS | no | yes |
| Workers routes | yes | no |

A Worker with an R2 binding needs both at once — wrangler verifies the bucket before
uploading the script. **Blocked until one token exists with:** Account → Workers Scripts
(Edit), Account → Workers R2 Storage (Edit), Zone → Workers Routes (Edit), Zone → DNS
(Edit, for the custom domain record), Zone → Cache Purge (Purge, for `sync.sh`).

R2 bucket administration works today via rclone's S3 credentials, which is how
`bioc-site` was created.

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

## Absolute URLs

Site chrome and navigation are root-relative (`href="/..."`), so they follow whatever
host serves them and need no handling. Hand-written body content is the exception:
`/help/course-materials/` carries 7 absolute `bioconductor.org` links, one of them
`http://` (which 301s to https). Course materials are contributed, so assume more of
this throughout that section.

Consequence: on `bioc-dev.cancerdatasci.org` those few links walk the visitor back to
production. The prototype is not fully self-contained. For the production cutover they
are already correct and need nothing.

**Do not fix this with `--convert-links`.** It rewrites the HTML bytes, so the mirror
stops matching production and the byte-identity diff in the cutover gate becomes
useless. If the prototype ever needs to be genuinely self-contained, rewrite at request
time with `HTMLRewriter` in the Worker, conditional on the prototype hostname — the
stored objects stay byte-identical and the rewrite disappears at cutover. Until then,
normalize the hostname when diffing rather than changing any content.

Note `www.bioconductor.org` serves 200 directly rather than redirecting to the apex, so
the site answers on two hostnames. wget does not follow cross-host links without
`--span-hosts`, so the crawl stays on the apex on its own; `--domains` in `crawl.sh` is
belt-and-braces only.

## Mirrors

The [mirror instructions](https://www.bioconductor.org/about/mirrors/mirror-how-to/)
change the picture here — the meeting's "redirect mirrors to sync from R2" is downstream
of phase 3, not phases 1 and 2.

What mirrors actually do:

```
rsync -e "ssh" -zrtlv --delete bioc-rsync@master.bioconductor.org:release /dest/packages/release
```

- They pull the **package repository over SSH**, not the website over HTTP. Phase 1 and 2
  content is not what mirrors serve, so validating those phases does not unblock anything
  for mirrors.
- 188 GB for BioC 3.24. This is squarely phase 3.
- Recommended cadence is once or twice a month for release, at most weekly for devel. So
  mirror load on master is periodic bursts, not sustained — worth tempering the meeting's
  claim that mirrors are a significant contributor. Nothing enforces the cadence, though,
  so a misconfigured mirror could sync far more often; check the access logs before
  ruling it in or out.
- **R2 speaks S3, not rsync/SSH.** Repointing mirrors means every operator switches to
  `rclone` or `aws s3 sync` and needs credentials, since our bucket is private behind the
  Worker. That is a coordinated change across independent operators — long lead time, a
  written runbook, and a decision about scoped read-only R2 tokens.

**`release` and `devel` are symlinks** to version directories (`3.24`, etc.), which
operators re-point every 6 months at release. Object storage has no symlinks. On R2 that
means either storing 188 GB twice under both prefixes, or resolving `packages/release/`
→ `packages/3.24/` as a prefix rewrite in the Worker. The rewrite is obviously right and
cheap, but it has to be designed into phase 3 rather than discovered during it. It also
means an HTTP crawl of both `/packages/release/` and `/packages/3.24/` would fetch the
same bytes twice under two paths.

## Cutover

1. Survey crawl of phase 1. Record object count and total bytes.
2. Sync to R2, serve on `bioc-dev.cancerdatasci.org`, no production traffic.
3. Diff a crawl of `bioc-dev.cancerdatasci.org` against `bioconductor.org` — status codes and
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
