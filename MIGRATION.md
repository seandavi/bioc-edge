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

## The outage driver is media, not pages

Measured from the crawl, on reaching `/help/course-materials/`:

| | Size | Files |
|---|---|---|
| `.mp4` | 711 MB | 3 |
| `.pptx` | 138 MB | 1 |
| `.pdf` | 21 MB | 3 |
| **all HTML** | **2 MB** | 65 |

Single files run to 308 MB, 269 MB, 129 MB. That is roughly 400:1 media to pages, from
two years of course materials alone — and materials go back much further.

This sharpens the diagnosis. "500k requests/day to course materials" reads like a page-view
problem; it is actually crawlers pulling hundred-megabyte lecture videos off an EBS volume.
That explains IOPS exhaustion far better than HTML serving does, and it makes the migration
case stronger rather than weaker: large static media behind a CDN with free egress is
exactly what R2 is for.

It also splits phase 1 in two, because the halves have nothing in common:

- **The site** — every HTML page, 2 MB. Crawls in minutes, syncs instantly, and is all
  that is needed to demonstrate the architecture.
- **The media** — many GB. Pulling it over HTTP means dragging it off the box we are
  protecting, at crawl speed. It should move once, directly, ideally by rsync rather than
  by crawl. `crawl.sh site` now excludes media by default; `MEDIA=1` opts in.

**Do not run a media crawl against master to make a point.** The first 0.8 GB was pulled
before this was noticed.

## Upstream shape

We now have rsync access to the docroot (`$RSYNC_SRC` = `the live docroot`),
which replaces guesses with a listing. `inventory/refresh.sh` snapshots it; numbers below
are from 2026-07-30, taken **without** `-L`, so `release`/`devel` are counted once.

**3,710,600 files, 910,039 directories, 248 symlinks, 488.5 GB.**

That corrects the earlier "809 GB / 1.28M files" for `packages/`, which was measured with
`-L` and double-counted 3.23/3.24 through the symlinks. Bytes went down; file count went
up a lot, because that figure only covered `packages/`.

| Top level | Size | Files |
|---|---|---|
| `packages/` | 417.5 GB | 1,016,510 |
| `checkResults/` | 38.3 GB | **2,607,459** |
| `help/` | 22.0 GB | 8,439 |
| `LoriTempToRemove/` | 6.1 GB | 2,701 |
| `course-packages/` | 2.6 GB | 116 |
| `books/` | 1.5 GB | 11,267 |
| `shields/` | 0.0 GB | 43,773 |
| everything else | 0.6 GB | ~20,000 |

Two things fall out of this that were not visible from the HTTP crawl:

- **`checkResults/` is 70% of all objects for 8% of the bytes**, and it regenerates
  nightly. R2 bills per operation, so object count — not size — is what a build-driven
  sync costs. **Decided: keep the current release and devel only** (`rsync-filter`).
  That is 251,078 files / 3.04 GB kept and 2,356,377 dropped, taking the whole docroot
  from 3.71M objects to 1.35M — a 64% cut in the thing that actually drives cost.

  Worth knowing how that breaks down, because the intuitive version of this decision is
  wrong. Dated historical snapshots are only 618,420 files; the bulk is each *past
  release's own* `*-LATEST`, 1.65M files across 3.13–3.22. So "drop the old dated
  snapshots, keep every LATEST" sounds like the moderate option but saves just 24% and
  leaves 1.9M objects. The saving only arrives by dropping past releases' current
  reports too.

  Consequence to accept deliberately: a build report for BioC 3.19 will 404. `robots.txt`
  already disallows `/checkResults/` so nothing is de-indexed, but maintainers do follow
  these links. Widening scope is a one-line edit to `rsync-filter` if that proves wrong.
- **`LoriTempToRemove/`** is 6.1 GB of abandoned staging sitting in the live docroot. The
  name is upstream's. Excluded in `rsync-filter`; worth reporting alongside the
  `sitemap.xml` bug.

### The OSN archive moves too

**Decided: migrate, not redirect.** 301,217 objects / 4.66 TB at
`osn-bioc:bir190004-bucket01/archive.bioconductor.org/packages`, holding the source
tarballs for releases 1.8–3.22 — those releases have HTML, vignettes and manuals on
the upstream docroot host but no tarballs, and `.htaccess:66-83` 302s out to OSN for them.

This is the expensive call: $69.88/month, 91% of the total bill, for content that is
already hosted and already free to serve. What it buys is that the migration stops
depending on an external bucket staying available and staying anonymous-readable. A
302 to someone else's grant-funded storage is a dependency the redirect makes invisible
and the migration would inherit permanently.

Two consequences that are easy to miss:

- **The `.htaccess` OSN rules stop being redirects and become ordinary keys.** They still
  have to be handled — the URL layout under `/packages/N.N/bioc/src/contrib/` must map
  onto wherever these land in the bucket — but as key mapping, not as 302s. That changes
  the shape of the redirect port, so it is not simply 18 fewer rules.
- **The transfer is 4.66 TB through this host.** OSN and R2 are different providers, so
  rclone streams rather than doing a server-side copy. This is a one-time job to plan
  deliberately, not something to kick off inside a sync run.

**Content-Type does not survive the copy.** rclone propagates the *source* object's MIME
on a cross-remote copy rather than deriving it from the extension, and OSN stores
everything as `application/octet-stream`. Harmless for the 297,685 tarballs and zips --
browsers download them either way, and `install.packages()` never looks -- but the archive
also holds 1,340 `.html` files and 605 extensionless text files (`PACKAGES`, `VIEWS`,
`TIMESTAMP`), which would download instead of render. Those 1,945 are uploaded first with
explicit types so the bulk copy sees them as current and leaves them alone; the same
ordering trick the docroot sync uses, for the same reason -- `contentType()` in the Worker
only fires when the type is *missing*, never when it is wrong.

Note also that `rclone lsf -R` reports directory entries with size `-1`, so the archive's
listed 340,036 lines are 301,217 real objects plus 38,819 directory markers. rclone does
not recreate the markers, which is correct: R2 has no directories, and 38,819 empty
objects would be 38,819 pointless Class A writes and 38,819 keys that resolve to nothing.

Unlike the docroot, this content is genuinely immutable — version-stamped archive
tarballs that never change — so after the initial load it needs no ongoing sync, and
`cacheControl()` already marks version-stamped archives `immutable`.

### Symlinks are broader than assumed

The plan so far accounted for `packages/release` and `packages/devel`. The listing shows
248, and the shapes differ:

- **Release aliases**, the known case: `packages/release → 3.23`, `packages/devel → 3.24`,
  and the same pair under `books/` and `checkResults/`.
- **R-version aliases** inside `contrib/`, ~150 of them:
  `packages/3.23/bioc/bin/windows/contrib/4.7 → 4.6`, `bin/windows64 → windows`,
  `bin/macosx/i386 → universal`. These are how one build serves two R versions and they
  are load-bearing for `install.packages()` — dropping them breaks installs on the aliased
  R version.
- **Dated build aliases**: `checkResults/3.10/bioc-LATEST → bioc-20200415`, and several
  pointing the *other* way (`bioc-20120924 → bioc-LATEST/`).
- **Absolute targets** that escape the docroot, e.g.
  `LoriTempToRemove/data/annotation/VIEWS → the live docroot/packages/3.18/data/annotation/VIEWS`.
  Any resolver has to reject these rather than follow them.

Object storage has no symlinks, so each is either a prefix rewrite in the Worker or a
duplicated object. Duplication is out for the big ones — `packages/release → 3.23` would
store 188 GB twice — so it is rewrites, in `resolveLinks()`.

**The map is generated, not authored.** Look at the change rates above: `bioc-LATEST`
moves nightly and `contrib/` aliases appear whenever an R version rolls, unannounced. A
map checked into this repo would mean a commit and a `wrangler deploy` per upstream
change, with the Worker wrong until someone noticed. So it is upstream state, in the same
category as the tree itself: `sync.sh` regenerates it from the mirror on every pull
(`find -type l`, which rsync has already recreated locally) and publishes it to
`_symlinks.json`. The Worker reads that object and memoises it per isolate for 5 minutes.
Algorithm in code, data in the bucket — the same split `/bioc-version` already uses.

Consequence worth noting: `release`/`devel` stop being a special case. They are two
ordinary entries in the map, so the version-file lookup the plan called for is not needed.

What `resolveLinks()` has to handle, all of it drawn from the real listing:

- **Longest prefix wins, then repeat**, because links chain up to three deep:
  `packages/lindsey/index.html` → `packages/lindsey/release/index.html` →
  `packages/release/lindsey/index.html` → `packages/3.23/lindsey/index.html`.
- **Targets are relative to the link's own directory**, not to the docroot —
  `../release/lindsey` from `packages/lindsey/` is `packages/release/lindsey`.
- **Resolution runs after the `index.html` expansion**, because links land on both sides
  of it: `packages/release` is a directory link visible only in the prefix, while
  `packages/lindsey/index.html` is a link on the file the expansion just produced.
- **`stable → .` makes no progress** and **cycles make progress forever**
  (`bioc-20120924 → bioc-LATEST/` pointing back). A hop limit is load-bearing here, not
  defensive padding.
- **Absolute targets and climbs above root are left unresolved**, which 404s. That is
  correct rather than a compromise: the unresolved key is a symlink, and symlinks are
  never uploaded, so there is no object either way.

The `contrib/` aliases are the ones to get right first — they are the install path, not
the browse path, so losing them breaks `install.packages()` on the aliased R version
while every browse URL keeps working. `worker/test.ts` pins each case above against real
entries from the listing.

Paths themselves are well behaved: across all 4,620,887 entries, none contains a tab,
pipe, backslash, or control character. `sync.sh` relies on this when it splits rsync's
`--out-format` output.

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

## Redirects

### .htaccess rules — ported

`inventory/htaccess-20260730.conf` (289 lines: 92 `RewriteRule`, 51 `RedirectMatch`, 1
`Redirect`) is upstream's actual redirect behaviour; `worker/src/redirects.json` was `{}`
before this. `worker/gen-redirects.ts` parses the snapshot and regenerates it —
`node worker/gen-redirects.ts inventory/htaccess-20260730.conf worker/src/redirects.json`
— rather than hand-transcribing ~150 target URLs, which is exactly how a typo survives
review. Commit both the generator and its output; re-run the generator (not a hand edit)
when the snapshot is refreshed.

The rules split into three kinds, and only two of them are redirects at all:

- **36 exact matches** (`redirects.json.exact`) — one specific old URL, one target.
- **115 prefix rules** (`redirects.json.prefix`) — an old path prefix, either collapsed
  onto one fixed target (`/docs/papers*` → `/help/publications/`) or rewritten with the
  remainder kept (`/pub(.*)$` → `/help/publications$1`). 30 of the 115 are the
  `container-binaries` rule expanded per BioC version (3.10–3.24) rather than parsed as a
  backreference — see "Found wrong upstream" below for why 3.0–3.9 are absent.
  `redirectFor()` in `worker/src/keys.ts` checks `exact` first, then the longest matching
  `prefix.from` — the same result Apache's first-matching-`RewriteRule`-wins gave, since
  `[R]` stops rule processing at the first match. It scans for the longest match itself
  rather than trusting the generator's sort order, so a hand-edited `redirects.json`
  can't silently misorder itself into the wrong rule.
- **The OSN block (15 rules, `.htaccess:65–83`) is not a redirect port at all.** Per "The
  OSN archive moves too" above, that content is migrating into this bucket, so
  `/packages/<old-version>/...` needs a **key**, not a 301. `archiveFallback()` in
  `keys.ts` appends `archive.bioconductor.org/<key>` as a last-resort R2 candidate
  whenever the version segment isn't the current release/devel pair (hardcoded
  `"3.23"`/`"3.24"`, same convention `rsync-filter` already uses for `checkResults/`).
  It's gated on version only, not on the specific subpath each `.htaccess` rule names
  (`bioc/src/contrib`, `data/annotation/{src,bin}`, `workflows/*`, …) — the OSN mirror is
  the whole `packages/<version>/` tree for those releases, and trying the archive key
  after every other candidate has already missed costs one extra R2 op on a genuine 404
  and nothing on a hit. Simpler and more complete than replicating each subpath.

All ported redirects answer 301 regardless of the original status (301 or 302) — the
existing single-hop-301 decision below, applied uniformly, not something new.

**Not ported**, each for a specific reason:

| Rule(s) | Why not |
|---|---|
| `%{ENV:proto}` setup (`.htaccess:6–10`) | Cloudflare always terminates TLS; the Worker never sees http. Every surviving target that used `%{ENV:proto}` or literal `http://` was rewritten to `https://` instead — see "Found wrong upstream." |
| `www.` → apex (`.htaccess:52–53`) | Host-based, not path-based — out of scope for a map keyed on pathname. A zone-level Cloudflare Redirect Rule is the right home if this is still wanted; see "Found wrong upstream," it may already be dead. |
| `(.*)/index_html$` (`.htaccess:54`) | Legacy Drupal artifact, open-ended pattern, no enumerable path list, no known live links. |
| Directory-slash rules (`DirectorySlash On`, `.htaccess:48`; the `REQUEST_FILENAME -d` block, `.htaccess:60–63`; the "Is this valid?" block, `.htaccess:202–205`) | Both need a filesystem/existence check per request, which the Worker can't do without an extra R2 op per path segment. Superseded anyway: `candidates()` already serves `/help/faq` directly via `.html`, then `/index.html`, then bare, instead of 301-redirecting to add a slash — simpler, and one round trip cheaper. |
| `help/workflows/annotation/(.*)/$`, `help/workflows/(.*)/$` (`.htaccess:133–134`) | The capture lands mid-target (`.../annotation/$1/index.html`), not at the end — not a plain prefix rewrite. Two rules, both legacy `/help/workflows/` links superseded by `/packages/release/workflows/` pages; not worth a template matcher for two rows. |
| `ExpiresByType text/html A600`, `text/javascript A600` (`.htaccess:15–16`) | **Deliberately not adopted.** This repo already decided the browser TTL for unhashed assets, and 600s contradicts it: purging clears the edge, never browsers, so a longer browser TTL is precisely how a fix stays hidden from returning visitors. `style/base/colors.css` and `js/bioconductor.js` carry no content hash, so both stay on the 5-minute default — see §Cache. Adopting upstream's number here would have quietly reversed a tested decision as a side effect of a redirect port. |

The `<FilesMatch>` `Cache-Control` overrides (`.htaccess:18–44`) and the checkResults
concern are **not** in `redirects.json` at all, per the reasoning above that these are a
different kind of rule:

- `cacheControl()` in `keys.ts` now special-cases `PACKAGES`/`PACKAGES.gz`/`PACKAGES.rds`/
  `VIEWS` (30s — these drive `install.packages()`, so staleness is a broken install, not
  a stale page), `BiocInstaller.dcf` (60s), `config.yaml`/`gitlog.xml`/`.svg`/`.csv` (30s),
  and `config.yaml`/`gitlog.xml`/`.svg`/`.csv` (30s). Every entry *shortens* the
  default, which is the table's whole purpose — anything wanting a **longer** browser
  TTL than 300s is rejected on the reasoning in §Cache, so `.js`/`.json` fall through
  to the default rather than taking upstream's 600s. Everything else keeps the existing
  binary immutable-archive-vs-300s split; that reasoning is unchanged.
- `checkResults/` has **no rule in `.htaccess` at all** — nothing redirects or rewrites
  it, so a request for a dropped old-version report (`rsync-filter` keeps only 3.23/3.24)
  simply misses R2 and 404s through the existing `notFound()` path. Confirmed by
  inspection, not new code: there was nothing to port.

**Found wrong upstream**, worth reporting on their own:

- The `www.` → apex rule (`.htaccess:52–53`) contradicts the live crawl in "Absolute
  URLs" above, which found `www.bioconductor.org` serving 200 directly. Either the rule
  doesn't fire in production or something upstream of it intercepts first — worth
  checking before assuming it's still wanted.
- `RedirectMatch`'s `(3.[0-9][0-9])` for `container-binaries` (`.htaccess:112–113`)
  requires *exactly two* digits after "3." — it does not match single-digit minors
  (3.0–3.9). The port is faithful to what the rule actually matches (3.10–3.24
  generated), not to what was probably intended.
- `docs/techreports/TR1/relProjTR.pdf$` and `.../TR2/currProgTR.pdf$` (`.htaccess:173–174`)
  target `.../relProjTR.pdf$1` — a literal `$1` with no capturing group in the pattern to
  supply it. `gen-redirects.ts` drops the dead reference; upstream likely never noticed
  because the file being one-off downloads makes it low-traffic.
- The `workflows/webvigs` OSN rule (`.htaccess:82–83`) is byte-identical, twice — a
  copy-paste duplicate. Doesn't affect the port (OSN rules aren't parsed as redirects at
  all) but is worth flagging alongside the other upstream findings in this doc.
- `BioC2015/` (`.htaccess:223`) and `developers/package-guidelines*` (`.htaccess:240`)
  target plaintext `http://`, the same downgrade bug already flagged for `/books/` below
  — not isolated to one section of the file.

### /books/ redirects — still unresolved

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
That is the phase-1 path and it is fine at ~500 objects. It does not survive contact with
3.7M — see §Incremental sync below.

- rclone compares size + modtime, falling back to MD5; R2 ETags are MD5 for single-part
  uploads, so unchanged objects are skipped. Do not use `--size-only` — HTML edits often
  preserve byte length.
- `--dry-run` for the initial load and any layout change.
- Use `copy` for the first runs, confirm object counts match, then switch to `sync`
  (which deletes destination objects absent from the source).
- rclone sets `Content-Type` from the file extension, so the 362 extensionless keys
  (flattened redirects — package landing pages, mostly) upload as
  `application/octet-stream` and download instead of rendering. Confirmed live on
  `/packages/plyranges`. `sync.sh` uploads those with an explicit `text/html` **before**
  the main sync, so rclone then treats them as current and never overwrites the type.
  Note the Worker's `contentType()` fallback does not save you here — it only fires when
  the type is *missing*, not when it is wrong.
- **Cache purge permission is required, not optional.** Now granted and verified: a
  purge corrected `/packages/plyranges` from `octet-stream` to `text/html`. Before it was
  granted the consequence was visible: `/packages/plyranges` was cached as
  `octet-stream` before the fix and still serves that, while never-requested pages like
  `/packages/DESeq2` serve `text/html` correctly. With `s-maxage=31536000` a wrong cached
  entry persists for a year unless purged.

## Incremental sync

At phase-3 scale, `rclone sync` is the wrong tool for deciding *what* changed, for a
specific reason: R2's `ListObjectsV2` returns size, ETag, and LastModified, but not user
metadata — and rclone keeps mtime in user metadata. Its default size+modtime comparison
therefore forces a `HEAD` per object. 3.7M Class B ops every run, and hours of listing
before a byte moves.

`--checksum` sidesteps that (ETag is the MD5 for single-part uploads, so both sides come
from the LIST), but it has to read all 488 GB locally to hash it. Fine weekly, not hourly.

rsync already knows the answer, and it has to run anyway — `rrsync` is the only way into
the upstream docroot host at all, so every sync stages through a local mirror regardless. Let the pull
compute the delta:

```sh
RSYNC_SRC=$RSYNC_SRC ./sync.sh
```

`sync.sh` then does three things:

1. `rsync -a --delete --out-format='%i|%n'` — pull, and itemize. `>f` lines are the
   candidate keys, `*deleting` lines the removals (minus directories, which have a
   trailing slash and do not exist in object storage).
2. `rclone copy --files-from <candidates> --no-traverse --checksum` — upload. `--files-from`
   makes rclone stat only the named keys instead of listing the bucket; `--no-traverse` is
   correct *here* precisely because the list is short, and would be the disaster it avoids
   if used on a full sync.
3. Purge the URLs rclone reports as `Copied`/`Updated`, plus the deletions.

**The `--checksum` in step 2 is load-bearing, not tidiness.** rsync's quick check is
size+mtime, so a file the builder rewrote with identical bytes itemizes `>f..t......` and
enters the candidate list. Across `checkResults/`'s 2.6M nightly-regenerated files that
would be millions of pointless uploads and a full-zone purge every night. rsync cuts 3.7M
to thousands cheaply; the checksum pass cuts thousands to what actually moved, precisely.
Hence also step 3 keying on rclone's log rather than rsync's candidates — otherwise the
purge list is the pre-filter list and `PURGE_MAX` trips most nights.
`test-itemize.sh` pins this behavior so the checksum pass does not get optimized away.

**Trade: rsync becomes the sole authority on bucket state.** Nothing reads R2 to confirm,
so a failed upload or a hand-edited object diverges silently and permanently. That is
what makes reconciliation mandatory rather than nice-to-have:

```sh
RECONCILE=1 ./sync.sh      # rclone check --checksum, reports missing and differing
```

Weekly is the intent. It is the expensive full comparison — just not the hourly one.

### The first load is not a delta

The delta path computes what changed *since the last pull*. On an empty or stale bucket
there is no such baseline, and — more importantly — it can only ever add and update. It
learns about deletions from rsync's `*deleting` lines, which describe changes to the
local mirror, not objects already sitting in R2 that no longer correspond to anything.

The bucket currently holds 507 objects from the phase-1 wget crawl. Some share keys with
the docroot and get overwritten; the rest are orphans. `packages/plyranges` is the clear
case: wget saved a redirect body under the requested path, so it exists as an
extensionless object, while the real docroot has no such file. Left in place it would
keep serving crawl-era content indefinitely.

So the initial load is a plain `rclone sync`, which the delta-path reasoning does not
argue against. The HEAD-per-object problem is about comparing millions of *existing*
destination objects; against a near-empty bucket the destination listing is 507 entries
and the comparison is free. It also deletes the orphans, which is the point.

**But the obvious command is dangerous, and this plan originally contained it.** The
docroot lives at the bucket root, so `rclone sync ./mirror r2:bioc-site` treats every key
not present locally as an orphan — including the whole `archive.bioconductor.org/` prefix,
4.66 TB copied from OSN, which has no local counterpart by design. That one command
deletes it.

That is the same failure MIRRORS.md warns operators about, written into our own runbook:
`sync` is delete-by-default, and a prefix absent from the source is not "nothing to do",
it is "delete everything on the other side".

So the initial load is `finish-load.sh`, which encodes the guards rather than trusting
anyone to remember them: it refuses while rsync is still running, refuses if the mirror is
below 95% of the file count the dry run predicted, excludes everything R2 owns from the
delete scope, dry-runs first and aborts if the deletion count exceeds what the phase-1
crawl's orphans can explain, types extensionless keys before the sync, and publishes the
symlink map last.

```sh
./finish-load.sh                            # dry run, changes nothing
APPLY=1 ./finish-load.sh                    # once, after the first pull
RSYNC_SRC=$RSYNC_SRC ./sync.sh   # every run after that
```

**Not yet settled:** whether the hourly pull should walk the whole docroot at all. rsync
still stats 3.7M local files per run to build the delta, which is cheap per file but not
free. If that proves too slow, the split is by cadence — `packages/` hourly,
`checkResults/` (if included at all) nightly, the static site on its own — via separate
`RSYNC_SRC` invocations against subtrees.

## Building the site from source

Everything above treats master's docroot as the source. The static half of it is
*generated*, from `github.com/Bioconductor/bioconductor.org` — a nanoc site built by
`rake`. So: could CI build that and push straight to R2, making the site reproducible from
git rather than "whatever Apache happens to be serving"?

**Worth doing for the static site alone, as a second source alongside the rsync pull. Not
a replacement for any part of it.** Findings from reading the upstream repo, 2026-07-30:

- **The shape already exists and is switched off.** `.github/workflows/staging.yaml` is
  `setup-ruby 2.6.5 → bundle install → rake → push output/ to S3`, and R2 speaks S3, so
  the deploy step is a swap. But all four workflows (`staging`, `pr_deploy`, `linter`,
  `pr_close`) are `disabled_manually` and report **zero runs**; `staging.yaml` only
  triggers on branch `redesign2023` regardless. This is a leftover from the 2023 redesign,
  not a pipeline in service — assume it does not build until it has. First thing to check
  is the pinned Ruby 2.6.5 on `ubuntu-latest`; the repo's `Dockerfile` (`ruby:2.6.5`, with
  apt sources rewritten to archived Debian buster) sidesteps that if setup-ruby dropped it.
- **It covers ~1% of the bytes.** The repo is ~100 MB; a `rake` produces site HTML, assets,
  and package landing pages. Not `packages/` (417.5 GB), not `checkResults/` (38.3 GB),
  not the course-material media under `help/` (22.0 GB), not `books/`, not the OSN archive
  — all build-system output that only ever arrives by rsync. This complements `sync.sh`;
  it does not shrink its scope.
- **`rake` on its own does not build the package pages either.** `assets/packages/json` is
  not committed. Regenerating it (`rake get_json`) pulls
  `master.bioconductor.org/packages/<version>/<repo>/VIEWS` over HTTP *and* runs
  `git archive --remote=ssh://git@git.bioconductor.org/packages/biocViews` for
  `biocViewsVocab.sqlite`. Separately, `lib/helpers.rb` reads a `../manifest` sibling
  checkout (`git.bioconductor.org/admin/manifest`) for the latest-packages listings. So a
  CI build still reaches into Bioconductor infrastructure — it trades rsync credentials
  for SSH credentials rather than removing a dependency. (The upstream README says this
  step runs R against biocViews and rjson; the current `scripts/get_json.rb` is pure Ruby
  over HTTP + git. The README is stale.)
- **The build is not hermetic, and it fails soft.** `rake` fetches live from
  support.bioconductor.org, NCBI eutils, cran.rstudio.com, `bioconductor.org/checkResults/`,
  the SPB on staging, and the GitHub API (needs `GITHUB_TOKEN`). `lib/helpers.rb` rescues
  those failures and logs them rather than failing the build, so a degraded run emits a
  smaller, quietly incomplete site. Publishing that overwrites good content with bad.
  Any CI push needs a byte/file-count floor before it is allowed to touch the bucket —
  the same gate `finish-load.sh` applies to the initial load.
- **Never `rclone sync` from a CI runner at the bucket root.** The runner's `output/` is a
  strict subset of the bucket *by construction, on every run* — it has no local
  counterpart for `packages/`, `checkResults/`, or `archive.bioconductor.org/`. That is
  §The first load is not a delta again, except structural rather than one-off. Use `copy`,
  or a `sync` scoped to the prefixes nanoc actually owns.
- **Symlinks still have to be published.** `post_compile` creates `packages/release` and
  `packages/devel` as symlinks; R2 has none and the Worker resolves `_symlinks.json`. A CI
  upload has to merge into that map, not ignore it.

If built, this is the "static site on its own" leg of the cadence split left open in
§Incremental sync — a separate path with its own guards, not another `RSYNC_SRC`.

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
Logpush is Enterprise. Per-request attribution needs the Worker logging to Workers
Analytics Engine. Working now — `./query.sh` runs the canned queries.

Fields logged: path, user-agent, country, ASN, cache status, and the client IP **/24**
(or /48). The open question is about *ranges* of crawler traffic, not individuals, so the
prefix answers it without retaining full addresses.

Three things learned the hard way:

- **Always weight by `sum(_sample_interval)`, never `count()`.** Analytics Engine samples,
  and visibly so even at trivial volume — 338 raw rows represented 607 requests. At
  500k/day a naive `count()` will be badly wrong.
- **A dataset's schema is fixed at creation.** The original dataset was created with 5
  blobs; adding a 6th silently dropped it — no error, just an empty column. Hence
  `bioc_site_requests_v2`. **Adding a field means a new dataset name**, which is a trap
  worth remembering when this gets extended.
- Ingestion lags roughly a minute, so a query straight after a request returns nothing.

Already visible in the data: sustained credential scanning against the prototype —
`/.env`, `/.env.backup`, `/config/.env`, `/.git/HEAD` and around a dozen variants, mostly
from AS202412 and AS210976, within hours of the hostname going live. Not the crawler
traffic we set out to investigate, but a working demonstration that the instrumentation
answers exactly this class of question.

## Zone settings and HTML validators — both resolved

The rule that was disabling caching is gone — HTML now returns `cf-cache-status: HIT`.
Two things remain, both isolated with a controlled probe: the same bytes uploaded to
`etag-probe.html`, `.css` and `.txt`, then fetched.

| Key | ETag returned |
|---|---|
| `etag-probe.css` | `"5609a31e…"` |
| `etag-probe.txt` | `"5609a31e…"` |
| `etag-probe.html` | **absent** |

Identical bytes, same bucket, same request. So:

1. **Cloudflare strips `ETag` from `text/html` — confirmed, and worked around.**

   Proven by mirroring the same value into a non-standard header. On a fresh,
   never-cached request:

   | Key | `etag` | `x-r2-etag` |
   |---|---|---|
   | `diag2.html` | absent | `"2f06d0ad…"` |
   | `diag2.css` | `"2f06d0ad…"` | `"2f06d0ad…"` |

   Same bytes, same code path. The Worker sets the value correctly — the mirror header
   carries it — and Cloudflare removes the standard header on `text/html` only. Not the
   Worker, not the Cache API, not compression, not a transform rule (the zone has no
   `http_response_headers_transform` ruleset), and not Email Obfuscation or Rocket Loader,
   both of which were off. Treat it as platform behaviour.

   **The workaround makes it moot.** The Worker sets `Last-Modified` from `obj.uploaded`,
   which Cloudflare does *not* strip, and the edge honours `If-Modified-Since` against it.
   Verified after a purge:

   ```
   /install/               conditional -> 304 (0 bytes)
   /packages/DESeq2        conditional -> 304 (0 bytes)
   /style/base/colors.css  conditional -> 304 (0 bytes)
   ```

   Revalidation is cheap again on HTML and assets alike. `x-r2-etag` is kept deliberately:
   it costs one line and it is how anyone re-verifies this, including at production
   cutover where the same behaviour will appear.

   Note this only works on entries cached *after* the Worker began sending
   `Last-Modified`. An earlier test showed 200 because the cached copy predated it — purge
   after deploying a header change, or the old copies keep answering.

2. ~~Browser Cache TTL overrides `max-age` on cache hits.~~ **Fixed.** Setting Browser
   Cache TTL to *Respect Existing Headers* restored the Worker's `max-age=300` on cached
   HTML. The override was applied at serve time rather than at store time, so entries
   cached before the change picked it up without a purge.

Fixes, on `cancerdatasci.org` and again at production cutover:

- Scrape Shield → **Email Address Obfuscation: off**; Speed → Optimization → **Rocket
  Loader: off**. Still outstanding. Re-run the probe; the ETag should return on `.html`.
- ~~Caching → Configuration → Browser Cache TTL: Respect Existing Headers.~~ Done, verified.

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

Class B is charged only on Cloudflare cache misses, so a correct cache rule keeps it near
zero. Class A spikes once during the initial load; batch it rather than syncing hourly
while still tuning.

Now measurable rather than estimated, from the 2026-07-30 inventory and the scope
decisions below:

| Source | Objects | Size | Storage / month |
|---|---|---|---|
| Docroot, after `rsync-filter` | 1,354,223 | 453 GB | $6.80 |
| OSN archive (decision: migrate) | 301,217 | 4,658 GB | $69.88 |
| **Total** | **1,655,440** | **5,111 GB** | **$76.68** |

One-time Class A on initial load: ~1.66M writes, $7.45.

The Cloudflare zone itself can sit on the Free plan. The real variable is Workers: the
free tier is 100k requests/day, well under current traffic, so instrumentation means
Workers Paid at $5/month plus $0.30/million beyond 10M.

**So roughly $80–85/month**, and the OSN archive is 91% of it. That is the number to
sanity-check against what the current EBS volume and CloudFront actually cost, because
this migration is being argued on reliability rather than price.

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
operators re-point every 6 months at release. Storing 188 GB twice under both prefixes is
the alternative, so it is a prefix rewrite — now built, and generalised to all 248 links
rather than these two. See §Upstream shape. It also means an HTTP crawl of both
`/packages/release/` and `/packages/3.24/` would fetch the same bytes twice under two
paths, which is a further argument for the rsync path over crawling.

## Behavioural equality, not byte identity

The gate asks whether the new site *behaves* like the old one, not whether it emits
identical bytes. Those come apart in a specific way, and the distinction has to be written
down or the gate slowly becomes noise.

Production emits some things that are wrong or legacy:

| Path | Production | Here |
|---|---|---|
| `*.tar.gz` | `application/x-gzip` | `application/gzip` (RFC 6713) |
| `/bioc-version`, `/config.yaml` | *no `Content-Type` at all* | `text/plain`, `application/yaml` |

**We emit the correct answer and the gate treats that as passing.** Forcing byte identity
would mean reproducing a bug in order to satisfy our own check — and a check that fails
forever on a known-good difference is a check nobody reads.

The policy is asymmetric on purpose, in `ctype_ok()`:

- Documented aliases fold together (`x-gzip` ≡ `gzip`, `application/javascript` ≡
  `text/javascript`, and so on). Each entry cites the RFC that registered it; the table is
  not a place to silence a difference nobody has explained.
- **We supply a type where production supplies none → pass.** That is an improvement.
- **We supply none where production supplies one → fail.** That is a regression.
- A genuinely wrong type still fails. `application/octet-stream` against `text/html` is the
  bug this project already shipped once, and normalising it away would hide the next one.

The same reasoning governs `NORMALIZE_HOST`, which stays **off** by default: absolute URLs
pointing at the origin hostname are byte differences that may or may not be behavioural
ones, and switching normalisation on by default would swallow a genuinely wrong link.

Content that legitimately churns — `checkResults/` regenerates continuously — will differ
between any two snapshots taken minutes apart. That is not drift, and it is why the gate
reports by kind rather than as a single pass/fail number.

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
  is published. Building the static site in CI instead is scoped in §Building the site
  from source — an addition, not a replacement.
- Content that no page links to. Without a sitemap, an unlinked file is invisible to the
  crawl. Fixing `sitemap.xml` upstream would close this gap.
