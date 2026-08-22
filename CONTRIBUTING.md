# Contributing

Thanks for helping. This is the serving side of the bioconductor.org
replacement: a Cloudflare Worker, an R2 bucket, and the shell scripts that keep
them in sync with upstream. Start with the [README](README.md) for the
architecture, and [MIGRATION.md](MIGRATION.md) for why it is shaped this way.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
Contributions are accepted under the [Apache License 2.0](LICENSE).

## Getting set up

```bash
git clone https://github.com/seandavi/bioc-edge
cd bioc-edge
./test-itemize.sh          # sync itemize logic
./test-cutover-diff.sh     # diff tooling
node --test worker/test.ts # the Worker (Node 22+, native TS)
cd worker && npm install && npm run typecheck
```

CI runs all four. No Cloudflare credentials are needed to contribute — deploys
are manual and maintainer-only, and `./make-env.sh` exists so that credentials
never live in the repo.

## What a good change looks like

- **Small.** A fix that touches one file beats a refactor that touches six.
- **Tested where the logic is real.** Path resolution, symlink handling, range
  and conditional GETs live in `worker/src/` and are covered by
  `worker/test.ts` — if your change adds a branch, add the one assertion that
  fails when it breaks.
- **Safe for operators.** The manifest API and MIRRORS.md are a public
  contract for mirror operators; changes to either need a note in the PR about
  what an operator would notice.

## Findings about upstream

This repo measures the live bioconductor.org estate, and measurement sometimes
turns up problems. Anything that looks like a security issue in the *upstream*
infrastructure goes to the Bioconductor team privately first — email the
maintainer (<seandavi@gmail.com>) rather than opening an issue. See the
`upstream` label for the public tail of that process.

## Reporting bugs

Open an [issue](https://github.com/seandavi/bioc-edge/issues). Useful things to
include: the URL you hit, what you expected, what you got, and the response
headers (`curl -sI`) if it looks like a caching or routing problem — see the
[edge cache page](https://seandavi.github.io/bioc-infrastructure/cache.html)
for how to read them.
