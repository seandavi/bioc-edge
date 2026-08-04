# bioc-cloudflare

Serving bioconductor.org from primary sources, on Cloudflare R2 behind a Worker, without the
staging and master hosts in the loop. See `docs/` (a Quarto site) for the current-state
architecture and the migration plan.

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
