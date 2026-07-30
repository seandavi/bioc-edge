# Mirror operator migration runbook

Status: not actionable yet. This is a plan written ahead of the work it describes, so
operators have lead time before anything is asked of them. Nothing below can be run today
— the package repository is not in R2. The current POC has only phase 1 (the static site,
~639 MB) live on `bioc-site`; `packages/` (417.5 GB before `rsync-filter`, 188 GB for the
current release/devel pair alone) has not been synced. See `MIGRATION.md` §Scope in phases
and §Cost. **Do not commit any operator to a cutover date from this document.**

## Where this fits

This is downstream of phase 3, not phases 1 and 2. Mirrors pull the package repository —
`packages/release`, `packages/devel`, and their `bioc`/`data` subtrees — not the website.
An early project meeting framed "redirect mirrors to sync from R2" as a phase-1 concern;
it isn't. Validating the site migration proves nothing about mirrors, and this runbook
should not be read as a signal that phase 3 is close.

Cadence also weakens the case that mirrors are a significant driver of the outage this
project exists to fix (`MIGRATION.md` §Why). Recommended practice is release synced once
or twice a month, devel at most weekly — periodic bursts, not sustained load. Nothing
enforces that cadence, though; a misconfigured mirror could sync far more often, and that
should be checked against master's access logs before ruling mirrors in or out as a
contributor.

## What mirror operators do today

From the [public mirror how-to](https://www.bioconductor.org/about/mirrors/mirror-how-to/):

- **Access is gated by request.** A private mirror (rsync/SSH access only) requires
  submitting an SSH public key and source IP(s) via a Google Form. A public mirror
  (listed in R's `chooseBioCmirror()`) requires a second form and HTTPS support.
- **Local layout is operator-built**, not part of what's synced:
  ```
  mkdir -p /dest/packages
  mkdir /dest/packages/3.23 /dest/packages/3.24
  ln -s /dest/packages/3.23 /dest/packages/release
  ln -s /dest/packages/3.24 /dest/packages/devel
  ```
- **The pull:**
  ```
  rsync -e "ssh" -zrtlv --delete bioc-rsync@master.bioconductor.org:release /dest/packages/release
  rsync -e "ssh" -zrtlv --delete bioc-rsync@master.bioconductor.org:release/bioc /dest/packages/release/bioc
  rsync -e "ssh" -zrtlv --delete bioc-rsync@master.bioconductor.org:release/data /dest/packages/release/data
  rsync -e "ssh" -zrtlv --delete bioc-rsync@master.bioconductor.org:devel /dest/packages/devel
  rsync -e "ssh" -zrtlv --delete bioc-rsync@master.bioconductor.org:devel/bioc /dest/packages/devel/bioc
  rsync -e "ssh" -zrtlv --delete bioc-rsync@master.bioconductor.org:devel/data /dest/packages/devel/data
  ```
  `rsync -avn` (dry run) against the same source is the documented way to size a transfer
  before running it.
- Symlink targets get repointed by the operator at every Bioconductor release (every 6
  months), and that's the whole of the version-rollover procedure today: the *source* side
  (`:release` on master) resolves transparently — master's rsync module hands back whatever
  "release" currently means, no operator action needed there.

## Why rsync/SSH stops working

Two independent reasons, not one:

1. **The bucket has no public access at all — not even read.** `MIGRATION.md` §Serving is
   explicit that this is a deliberate security decision: a Worker with an R2 binding, no
   public bucket. `rsync`/`ssh` was never the transport for R2 regardless of privacy; R2
   speaks S3.
2. Even with credentials, plain S3 sync tools (`rclone`, `aws s3 sync`) don't go through
   the Worker. They authenticate straight to R2's S3-compatible endpoint and list/read
   objects directly. That's a different, and consequential, access path — see below.

So every operator has to switch tooling (to `rclone` or `aws s3 sync`) *and* get R2
credentials *and* account for the fact that direct S3 access sees a different, unresolved
version of the bucket than what the Worker serves over HTTP. That's three changes bundled
into one migration, for every independent mirror operator, which is why this needs a long
lead time and a real deprecation window, not a flag day.

## The `release`/`devel` symlink problem — read this before writing a sync command

This is the part most likely to bite, so it gets its own section rather than a footnote.

`MIGRATION.md` §Upstream shape documents 248 symlinks in the docroot, of which
`packages/release → 3.23` and `packages/devel → 3.24` are only the two best-known.
Object storage has no symlinks, so this project resolves them in exactly one place:
`resolveLinks()` in `worker/src/keys.ts`, run against a generated map (`_symlinks.json`,
published to the bucket root by `sync.sh` on every pull) — and it only runs on requests
that go through the Worker's HTTP path. `sync.sh` never uploads the symlinks themselves:
rsync's `--out-format` output excludes them from the candidate list (`>f` excludes `cL`),
and `rclone` would skip them anyway without `--links`. That's deliberate — see the comment
at `sync.sh:123-125` — but it means **the objects the Worker resolves paths onto are the
only ones that exist in the bucket.**

Consequence for an operator using `rclone`/`aws s3 sync` directly against R2's S3 API,
bypassing the Worker entirely: **`packages/release/` and `packages/devel/` are not keys
that exist.** A sync scoped to that prefix lists zero objects. That is not an error and
not a 404 — it's a silent empty listing. If the sync direction is `sync` (which mirrors
deletions) rather than `copy`, an operator who points a fresh sync command at
`packages/release/` without noticing the object count is not "getting nothing" — they are
**deleting their entire existing local release mirror** to match an empty remote. Treat
this as the primary hazard in this whole migration, not a corner case: dry-run first, on
every sync command, every time, exactly as `MIGRATION.md` §Sync already insists for this
project's own runs.

The fix is to sync from the resolved numeric prefix — `packages/3.24/`, not
`packages/release/` — which means the operator now needs a way to know what "release"
currently resolves to, since master's server-side indirection (rsync module aliasing) has
no S3 equivalent.

**`_symlinks.json` is that source of truth**, and it's the same file the Worker reads. It's
an ordinary JSON object at the bucket root, keys are link paths (no leading slash), values
are the raw symlink target exactly as stored on disk, relative to the link's own directory
(so `"packages/release": "3.23"` means "3.23", not "packages/3.23" — it's a sibling of
`packages/release`). Two ways to read it:

- **Via the public site, no R2 credentials needed:** `_symlinks.json` is an ordinary
  extension-bearing path, so the Worker serves it like any other object —
  `curl https://bioconductor.org/_symlinks.json`. This works today (verified by reading
  `candidates()` in `worker/src/keys.ts`: a `.json` path has no directory-index expansion
  and no matching prefix to resolve, so it passes through unchanged) but **is not a
  documented or committed external contract** — it exists because that's how the Worker
  happens to serve any bucket object, not because anyone decided to publish a mirror-facing
  manifest at that path. Don't build automation that assumes this path or shape is stable
  without the project committing to it first.
- **Via the S3 API, with the same read credentials as the sync itself:**
  `rclone cat r2:bioc-site/_symlinks.json` or `aws s3 cp s3://bioc-site/_symlinks.json -`.

Either way, this only gets an operator `release`/`devel`. It does **not** cover the rest of
the 248 symlinks, and that's the sharper edge: `MIGRATION.md` calls out ~150 R-version
aliases inside `contrib/` (`packages/3.24/bioc/bin/windows/contrib/4.7 → 4.6`, and similar
for `windows64`/`macosx`) as load-bearing for `install.packages()` on the aliased R
version — dropping them breaks installs on that R version *silently*, because the browse
path keeps working. A plain `rclone sync r2:bioc-site/packages/3.24/ /dest/packages/3.24/`
gets everything **except** these aliases, because they were never uploaded as objects in
the first place. An operator who syncs only the numeric prefix and stops has a mirror with
the same silent gap the Worker's own symlink resolution exists to close.

So the correct procedure has three steps, not one: sync the resolved numeric prefix,
re-point (or create) the local `release`/`devel` symlinks exactly as today, and **replay
every `_symlinks.json` entry under that prefix as a local symlink** — the same information
the Worker uses to paper over the gap at request time, applied once, locally, after sync.

## Replacement commands

**Untested.** No credentials exist for this bucket outside the project's own admin token,
and the bucket is private, so none of this has been run against real R2. Sanity-checked
for flag correctness only. Confirm object counts on a dry run before trusting any of it.

**Bucket name is not settled for package content.** `MIGRATION.md` §Bucket layout's default
is one bucket (`bioc-site`, phases are key prefixes), but the same section calls phase 3 out
as "the one case for a second bucket" — 188 GB with different lifecycle needs (Infrequent
Access for superseded versions) than the live site. The commands below assume `bioc-site`
because that's the current design and `sync.sh`'s default, but **this is an open decision,
not a fact** — confirm the actual bucket name before scripting anything against it.

### rclone

Config (R2's documented rclone remote shape — `type = s3`, `provider = Cloudflare`,
account-specific endpoint):

```
[r2]
type = s3
provider = Cloudflare
access_key_id = <scoped token access key>
secret_access_key = <scoped token secret>
endpoint = https://<ACCOUNT_ID>.r2.cloudflarestorage.com
```

```sh
# 1. Resolve current version numbers
release=$(rclone cat r2:bioc-site/_symlinks.json | jq -r '."packages/release"')
devel=$(rclone cat r2:bioc-site/_symlinks.json | jq -r '."packages/devel"')

# 2. Dry run first, always -- see the hazard above.
rclone sync "r2:bioc-site/packages/$release/" "/dest/packages/$release/" \
  --checksum --transfers 16 --checkers 32 --log-level INFO --dry-run

# 3. Real sync. `rclone sync` deletes destination extras unconditionally -- there
#    is no separate --delete flag, that IS what sync means. Use `rclone copy`
#    instead for an additive-only pull (MIGRATION.md's own advice for first runs).
rclone sync "r2:bioc-site/packages/$release/" "/dest/packages/$release/" \
  --checksum --transfers 16 --checkers 32 --log-level INFO

# 4. Local symlinks, exactly as the current setup instructions.
ln -sfn "/dest/packages/$release" /dest/packages/release
ln -sfn "/dest/packages/$devel" /dest/packages/devel

# 5. Replay the symlinks R2 doesn't store, scoped to what was just synced.
rclone cat r2:bioc-site/_symlinks.json | jq -r --arg v "$release" '
  to_entries[] | select(.key | startswith("packages/" + $v + "/")) |
  "\(.key)\t\(.value)"
' | while IFS=$'\t' read -r link target; do
  mkdir -p "/dest/$(dirname "$link")"
  ln -sfn "$target" "/dest/$link"
done
```

Software-only / data-only, matching today's split commands, is the same pattern scoped to
`packages/$release/bioc/` or `packages/$release/data/` — step 5's `startswith` filter
narrows the same way.

### aws s3 sync

```sh
export AWS_ACCESS_KEY_ID=<scoped token access key>
export AWS_SECRET_ACCESS_KEY=<scoped token secret>
endpoint=https://<ACCOUNT_ID>.r2.cloudflarestorage.com

release=$(aws s3 cp s3://bioc-site/_symlinks.json - --endpoint-url "$endpoint" | jq -r '."packages/release"')
devel=$(aws s3 cp s3://bioc-site/_symlinks.json - --endpoint-url "$endpoint" | jq -r '."packages/devel"')

aws s3 sync "s3://bioc-site/packages/$release/" "/dest/packages/$release/" \
  --endpoint-url "$endpoint" --dry-run

# aws s3 sync needs --delete explicitly -- unlike rclone sync, its default is
# additive-only, so this is the opposite default from rclone above.
aws s3 sync "s3://bioc-site/packages/$release/" "/dest/packages/$release/" \
  --endpoint-url "$endpoint" --delete

ln -sfn "/dest/packages/$release" /dest/packages/release
ln -sfn "/dest/packages/$devel" /dest/packages/devel

aws s3 cp s3://bioc-site/_symlinks.json - --endpoint-url "$endpoint" | jq -r --arg v "$release" '
  to_entries[] | select(.key | startswith("packages/" + $v + "/")) |
  "\(.key)\t\(.value)"
' | while IFS=$'\t' read -r link target; do
  mkdir -p "/dest/$(dirname "$link")"
  ln -sfn "$target" "/dest/$link"
done
```

`rclone sync` and `aws s3 sync --delete` have opposite defaults on deletion — worth calling
out explicitly since it's exactly the kind of flag that's easy to carry over wrong from one
tool's habits to the other's, and getting it backwards either silently never deletes
anything (stale mirror) or deletes on the first run before the operator has verified the
prefix is right (the hazard above).

## Credentials

**Decided:** Cloudflare R2 supports API tokens scoped to read-only ("Object Read only") and
to a specific set of buckets. That's an existing platform feature, not something this
project has to build.

**Open — not yet decided by this project, do not treat anything below as policy:**

- How an operator requests a token. The natural fit is extending the existing private-mirror
  request form (SSH key → R2 token, same "prove you operate a mirror" gate), but that's a
  proposal, not a decision.
- Whether every operator gets a token scoped to the whole bucket, or something narrower.
  R2 tokens scope to buckets, not to prefixes — there is no documented way to scope a token
  to just `packages/`, so if `packages/` and the live site end up in the same bucket, a
  mirror-operator token can read the site too. That may be acceptable (everything a mirror
  operator would read is already served to the public, just through the Worker instead of
  the S3 API) but it hasn't been decided as acceptable.
- Rotation policy and cadence. R2 tokens don't expire on their own — they're valid until
  revoked — so "rotation" here means a process this project has to run, not a platform
  default. `make-env.sh` currently pulls one long-lived Workers token from Secret Manager
  with no rotation cadence recorded either; extending that pattern to per-operator tokens is
  plausible but unconfirmed.
- Who can issue and revoke a token, and what happens to a mirror's access when a token is
  revoked (does the operator's cron job start failing loudly, or silently stop syncing?).

## Deprecation window

**Proposal, not policy** — nobody has committed to dates.

Given the cadence — release synced once or twice a month, devel at most weekly — the
overlap window should be long enough that every mirror gets at least one full ordinary sync
cycle on the new path before the old one closes, not just an announcement window. A single
release cycle (~6 months, matching the existing release schedule operators already track
for their local symlink rollover) is the natural unit to propose.

Signal to close the old path should be **operator confirmation, not silence.** Master's SSH
access logs going quiet for a known operator is consistent with either "they switched" or
"the mirror is abandoned," and those need different responses — one is done, the other is a
stale entry that should probably come off the public mirror list rather than be waited on
indefinitely. Cross-check log silence against the registered operator list from the mirror
request forms, and get an explicit acknowledgment from each active operator before
disabling `bioc-rsync` access for them individually, rather than closing the path for
everyone on a fixed date.

## Verification after switching

- **Count and size sanity check** against `MIGRATION.md`'s own numbers (188 GB for the
  3.24 pair) — `rclone size r2:bioc-site/packages/$release` compared to `du -sh
  /dest/packages/$release`, and to the equivalent for the mirror's previous rsync-based
  pull, before deleting anything.
- **Checksum reconciliation**, not just size/mtime: `rclone check --checksum` between the
  local mirror and the bucket prefix, the same tool and flag this project uses for its own
  weekly reconciliation pass (`MIGRATION.md` §Incremental sync). Weekly is a reasonable
  cadence here too — it's the expensive full comparison, not the routine sync.
- **Symlink count**, since that's the part most likely to go quietly wrong: `find
  /dest/packages/$release -type l | wc -l` should match the count of `_symlinks.json`
  entries under `packages/$release/` (`jq` the same filter used to build them, then
  `wc -l`). A mismatch means step 5 above didn't run, or ran against a stale
  `_symlinks.json`.
- **Functional test, not just file presence:** point R at the local mirror
  (`options(BioC_mirror = "file:///dest")` or serve it locally over HTTP) and run
  `available.packages(contriburl = contrib.url(getOption("BioC_mirror"), "source"))`,
  then actually install one small package through it. This is the check that would have
  caught a missing `contrib/4.7 → 4.6` alias before a user did.
- Run the new sync in parallel with the still-live rsync pull for at least one full cycle
  and diff object counts before treating the new path as authoritative for that mirror.
