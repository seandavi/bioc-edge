# bioc-cloudflare

Serving bioconductor.org from primary sources, on Cloudflare R2 behind a Worker, without the
staging and master hosts in the loop. See `docs/` (a Quarto site) for the current-state
architecture and the migration plan.

## Access-log analytics

The CloudFront access-log mirror — 7.1B rows, raw gzip plus Parquet plus an Iceberg table in
R2 — and how to query it with Trino, DuckDB, StarRocks or ClickHouse is documented in
`ANALYTICS.md`. That file is **root-level and deliberately not part of the public site**: it
carries internal paths, account-specific catalog URIs and secret names. The public account of
the same work is the `download-stats` page in the `bioconductor-infrastructure` repo.

## Publishing

The Quarto docs site that used to live in `docs/` has been extracted to its own public
repository, `bioconductor-infrastructure`. Documentation about the estate belongs there,
not here.

What stays here is operational: `MIGRATION.md`, `MIRRORS.md`, `ANALYTICS.md`,
`DATAPLANE.md`, `inventory/`, `systemd/`. This repo is on its way to being public too, so
the same rule now applies to every tracked file rather than to `docs/**` alone:
credentials, the paths and secret names that point at them, internal host addresses, and
named attribution of people's informal remarks must not be committed. The upstream rsync
source is `RSYNC_SRC`, read from the gitignored `.env` -- never write the value into a
tracked file.

## Version control

Plain git. (This repo was briefly jj-colocated; that is gone, along with the
`refs/jj/*` bookkeeping refs.)

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`seandavi/bioc-cloudflare`), via the `gh` CLI.
External pull requests are **not** treated as a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles are used unchanged: `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, `wontfix`. All five now exist in the repo. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and one `docs/adr/` at the repo root, neither created yet.
Not to be confused with the Quarto site also under `docs/`. See `docs/agents/domain.md`.
