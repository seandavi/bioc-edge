# bioc-cloudflare

Serving bioconductor.org from primary sources, on Cloudflare R2 behind a Worker, without the
staging and master hosts in the loop. See `docs/` (a Quarto site) for the current-state
architecture and the migration plan.

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

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`seandavi/bioc-cloudflare`), via the `gh` CLI.
External pull requests are **not** treated as a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles are used unchanged: `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, `wontfix`. Only `wontfix` exists in the repo so far — the other four still
need creating. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and one `docs/adr/` at the repo root, neither created yet.
Not to be confused with the Quarto site also under `docs/`. See `docs/agents/domain.md`.
