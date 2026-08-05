# bioc-cloudflare

Serving bioconductor.org from primary sources, on Cloudflare R2 behind a Worker, without the
staging and master hosts in the loop. See `docs/` (a Quarto site) for the current-state
architecture and the migration plan.

## Access-log analytics

The CloudFront access-log mirror — 7.1B rows, raw gzip plus Parquet plus an Iceberg table in
R2 — and how to query it with Trino, DuckDB, StarRocks or ClickHouse is documented in
`ANALYTICS.md`. That file is **root-level and deliberately not part of the public site**: it
carries internal paths, account-specific catalog URIs and secret names. The public account of
the same work is `docs/download-stats.qmd`.

## Publishing

`docs/*.qmd` is a **public** Quarto site — GitHub Pages, deployed on every push to `main` that
touches `docs/**`, readable without a GitHub account even though this repo is private. Writing
there is publishing.

Credentials, the paths of files containing them, internal host addresses, and named attribution
of people's informal remarks must not reach `docs/`. Put them in session memory or a private
channel instead. See `docs/adr/0001-public-docs-site-with-a-publication-boundary.md`.

`docs/agents/` and `docs/adr/` are excluded from the site by the `project.render` list in
`docs/_quarto.yml`. That exclusion is load-bearing — Quarto publishes every input file by
default.

## Version control

This repo is **jj (Jujutsu) colocated with git** — `.jj/` and `.git/` both sit at the root. jj is
the primary interface. Plain `git` commands still work and jj imports them on its next invocation,
so a session that reaches for git will not break anything, but prefer jj.

What differs from git, in the order it will bite you:

- There is no staging area, and the working copy is itself a commit (`@`). Edits are snapshotted
  automatically — nothing to `git add`.
- Branches are **bookmarks**, and they do not follow new commits. After committing, move one
  forward explicitly: `jj bookmark set <name> -r @-`.
- `jj op log` and `jj undo` reverse *any* previous operation, including a bad rebase or an edit a
  session got wrong. Reach for that before doing reflog archaeology.

`main` is the default branch, and pushing `docs/**` there deploys the public site — see Publishing.

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
