# bioc-cloudflare

Prototype: serving `bioconductor.org` from Cloudflare R2 behind a Worker.

Live at `bioc-dev.cancerdatasci.org`. No production traffic.

**Start with [MIGRATION.md](MIGRATION.md)** — the plan, the measurements behind it, and
every decision with its reasoning. Everything here is a supporting artifact.

## Why this repo is private

`MIGRATION.md` and the `upstream`-labelled issues document defects in production
`bioconductor.org` that this project found but does not own, including one unpatched
security weakness. None of it has been reported to Bioconductor yet. Do not make this
public, or quote from it publicly, before that conversation happens.

## Layout

| Path | What |
|---|---|
| `MIGRATION.md` | The plan. Read first. |
| `MIRRORS.md` | Runbook for downstream mirror operators (phase 3, not yet actionable) |
| `crawl.sh` | HTTP crawl of the live site (phase 1) |
| `sync.sh` | Mirror → R2, plus purge. `RSYNC_SRC=…` for the delta path, `RECONCILE=1` for drift |
| `rsync-filter` | **What the mirror includes.** The scope decision, in one file |
| `cutover-diff.sh` | Cutover gate: diff bioc-dev against production |
| `query.sh` | Canned Analytics Engine queries |
| `inventory/` | Snapshots of the upstream trees, and how to query them |
| `systemd/` | Sync and reconcile timers. Committed, deliberately not enabled |
| `worker/` | The Worker. `node --test worker/test.ts`, no build step |

Tests: `./test-itemize.sh`, `./test-cutover-diff.sh`, `node --test worker/test.ts`. CI runs
all three.

## Scope boundaries

Worth stating, because two of these are easy to assume otherwise.

- **The website and the package repository** are in scope.
- **The OSN archive** (`archive.bioconductor.org`, 4.24 TiB) is in scope — decided to
  migrate rather than keep redirecting.
- **AnnotationHub (10.12 TiB) and ExperimentHub (593 GiB) are not.** They sit in the same
  OSN bucket, so "the OSN bucket" is easy to read as including them. It does not: they are
  served by a separate service and fetched by their R packages through a metadata
  database, and nothing in the docroot, the crawl, or `.htaccess` refers to them. The
  bucket holds ~25 TiB total; this project touches 4.24 of it.
- **Anything genuinely dynamic** — search, BiocViews queries, live build reports — stays
  where it is.

## Credentials

Never in the repo. `./make-env.sh` pulls them from Google Secret Manager into a
gitignored `.env`.
