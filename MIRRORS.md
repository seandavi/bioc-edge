# Mirroring the Bioconductor package repository

**Status: the endpoint is built and verified; the package repository is still loading.**
`gen-manifest.sh` publishes the manifest and `finish-load.sh` calls it. The whole operator
flow below has been walked end to end against `bioc-dev` — fetch, sync, verify — with no
credentials. What is not ready is the *content*: `packages/3.23` and `3.24` are still being
loaded into R2, so the manifests those commands fetch do not exist yet. **Do not commit
anyone to a cutover date from this document.**

The thing being replaced:

```sh
rsync -e "ssh" -zrtlv --delete bioc-rsync@master.bioconductor.org:release /dest/packages/release
```

## Recommendation, and why

**A published manifest, fetched over plain HTTPS. No credentials.**

Three approaches were considered.

| | Credentials | Verdict |
|---|---|---|
| **Manifest + HTTPS** | none | **Recommended** |
| Read-only R2 (S3) keys | per-operator token | Escape hatch, and only with a second bucket |
| Custom client | none | No |

### Why not S3 credentials

It is the obvious answer, and it is worse than it looks.

**R2 API tokens scope to buckets, not prefixes.** The docroot, the package repository and
the 4.66 TB OSN archive currently share one bucket. A token that lets an operator sync
`packages/` also lets them read everything else. Nothing there is secret — it is all
public content — but it hands a credential with far more reach than the task needs to
independent third parties, indefinitely. Prefix scoping would mean moving `packages/` to
its own bucket, which `MIGRATION.md` §Bucket layout flags as the one plausible case for a
second bucket but has not decided.

**Distribution and rotation become an ongoing programme.** Every operator needs issuing,
every operator needs re-issuing on rotation, and someone has to track who holds what.
`make-env.sh` keeps this project's single token in Secret Manager; there is no precedent
for handing tokens to outside parties.

**It bypasses the Worker**, so mirror traffic becomes invisible to us — unfortunate,
because whether mirrors contribute meaningfully to origin load is an open question, and
S3 access would keep it open permanently.

### Why not a custom client

Operators would have to install and trust a binary we maintain, to do a job standard tools
already do. It becomes our support burden and our security surface. The one scenario that
might justify it is air-gapped transfer, and a manifest plus any HTTP client covers that
without shipping software.

### Why the manifest works

The reason credentials looked necessary is **enumeration**: rclone's `:http:` backend
cannot list a directory when autoindex is off, and it is off. A manifest removes the need
to enumerate — `--files-from` names every object explicitly.

**Verified working** against `bioc-dev.cancerdatasci.org`, with no credentials:

```
rclone copy :http:/ ./out --http-url https://bioc-dev.cancerdatasci.org \
  --files-from files.txt --no-traverse

  packages/2.14/bioc/src/contrib/PACKAGES.gz           56,792 bytes
  packages/2.14/bioc/src/contrib/BADER_1.2.0.tar.gz   183,835 bytes
  packages/2.10/bioc/src/contrib/ABarray_1.24.0.tar.gz 582,985 bytes
```

What that buys:

- **No credential to issue, rotate or revoke.** The largest operational saving on offer.
- **Operators fetch through the CDN** — global PoPs, egress that costs us nothing, and
  very likely faster than today's rsync from a single loaded origin.
- **The Worker sees the traffic**, so mirror load becomes measurable for the first time.
- **It defuses the delete footgun below**, because a manifest is explicit and checkable
  where an empty prefix listing is silently indistinguishable from "nothing to do".
- **Air-gapped operators** can fetch the manifest and the files with any HTTP client.

## The delete footgun — read before writing any sync command

`packages/release` is a **symlink** on the origin. Object storage has none, so `sync.sh`
never uploads them; the Worker resolves them per request from `_symlinks.json`.

**There is no `packages/release/` prefix in the bucket.** A sync scoped to it lists zero
objects — not an error, not a 404, a silent empty listing. And since `rclone sync` deletes
by default (as does `aws s3 sync --delete`), an operator pointing a fresh command at
`packages/release/` is not getting nothing:

> **they are deleting their entire existing local mirror to match an empty remote.**

This is the sharpest hazard in the migration, and it is aimed at people who will not have
read this document. The manifest approach avoids it structurally: you sync a named list,
and a manifest that fails to fetch is an obvious error rather than a successful no-op.

Whatever tooling you use: **dry-run first, every time, and check the object count.**

## Choosing scope

Decide explicitly rather than mirroring everything:

| | Size | Notes |
|---|---|---|
| `bioc` source (`src/contrib`) | largest single piece | Every mirror needs it |
| `bioc` binaries (`bin/windows`, `bin/macosx/*`) | comparable to source | Skip if your users build from source |
| `data/annotation`, `data/experiment` | large, changes rarely | |
| `workflows`, `books` | small | |
| Releases 1.8–3.22 | | Almost certainly not wanted |
| The OSN archive | 4.66 TB | **Do not mirror.** Now in the bucket, never carried by any mirror before |

BioC 3.24 is ~159 GB in total; release and devel together ~322 GB.

## Procedure

### 1. Fetch the manifest

```sh
BASE=https://bioconductor.org           # bioc-dev.cancerdatasci.org while testing
VERSION=3.24
curl -fsSL "$BASE/api/v1/manifest/index.json" -o index.json
curl -fsSL "$BASE/api/v1/manifest/$VERSION/bioc.tsv.gz" | gunzip > bioc.tsv
```

`index.json` carries the available versions, which numeric version `release` and `devel`
point at today, the symlink map, per-manifest object counts, and a generation timestamp.
`bioc.tsv` is `path<TAB>size<TAB>md5`, one object per line.

The MD5 is a real MD5, not an S3 composite ETag — rclone stores `md5chksum` metadata on
multipart uploads, verified by matching a 783 MB object's hash against its OSN source. An
empty third column means no usable hash was available and the object should be checked by
size alone; in practice that column has been populated for every object measured so far.

**Check it before using it** — a truncated or empty manifest must stop you, not silently
produce an empty sync:

```sh
test -s bioc.tsv || { echo "empty manifest, aborting" >&2; exit 1; }
wc -l bioc.tsv
```

### 2. Sync

```sh
cut -f1 bioc.tsv > files.txt
rclone copy :http:/ /dest --http-url "$BASE" \
  --files-from files.txt --no-traverse --transfers 8 --checkers 16
```

`copy`, not `sync` — deliberately, per the footgun above. Removing departed objects is
step 4, done explicitly.

Any HTTP client works. `wget -i files.txt -x -nH -P /dest` is equivalent and needs nothing
installed.

### 3. Recreate the symlinks

The step with no analogue in the rsync world, and the one that fails **quietly** when
skipped: browse URLs keep working while `install.packages()` breaks.

```sh
jq -r '.symlinks | to_entries[] | "\(.key)\t\(.value)"' index.json |
  while IFS=$'\t' read -r link target; do
    case "$link" in packages/*) ;; *) continue ;; esac
    mkdir -p "$(dirname "/dest/$link")"
    ln -sfn "$target" "/dest/$link"
  done
```

There are roughly 150. Most are **not** `release`/`devel` — they are R-version aliases
inside `contrib/`, like `packages/3.23/bioc/bin/windows/contrib/4.7 -> 4.6`, which is how
one build serves two R versions. Those are the `install.packages()` path. Dropping them
404s installs on the aliased R version while every browse URL keeps working.

### 4. Remove what left the manifest

```sh
(cd /dest && find . -type f -printf '%P\n') | sort > have.txt
cut -f1 bioc.tsv | sort > want.txt
comm -23 have.txt want.txt > gone.txt
wc -l gone.txt          # sanity-check before deleting anything
# (cd /dest && xargs -a gone.txt rm -f)
```

Deliberately manual. A release roll legitimately removes a great many files, and that
should be a decision rather than something a cron job does at 3am.

### 5. Verify

```sh
# sizes against the manifest
awk -F'\t' '{ cmd = "stat -c%s /dest/" $1 " 2>/dev/null"; cmd | getline s; close(cmd)
              if (s != $2) print "SIZE MISMATCH", $1, $2, s }' bioc.tsv

# the check that actually matters
Rscript -e 'ap <- available.packages(repos="file:///dest/packages/3.24/bioc"); cat(nrow(ap), "packages\n")'
```

If `available.packages()` returns rows, metadata and layout are right. If
`install.packages()` then works for a package under `contrib/`, the symlinks are right too.

## Serving it

Apache and nginx both serve this tree as-is. Two things to get right:

- **Follow symlinks.** Apache needs `Options +FollowSymLinks` on the directory, or every
  `release/` URL 403s.
- **Do not copy `.htaccess` from the origin.** It contains redirects out to the OSN
  archive that no longer apply — that content is served directly now. Copying those rules
  would send your users away from your own mirror.

Content types come from your server's `mime.types`, not from the manifest, so extensionless
files like `PACKAGES` and `VIEWS` behave as they always have.

## Cadence and release rolls

Recommended practice is unchanged: **release once or twice a month, devel at most weekly.**

At a release, `release` and `devel` re-point to new numeric versions. Under rsync that
propagated by itself. Here it does not — the numeric version is data in `index.json`, and
your sync must re-read it rather than assume. Pin nothing.

## Open questions

Flagged rather than invented:

- **Which repos and versions the manifest should cover.** It currently emits release and
  devel for `bioc`, `data/annotation`, `data/experiment`, `workflows` and `books`. Older
  releases are not emitted; nobody has asked for them.
- **Manifest granularity.** Per-version-per-repo (`/api/v1/manifest/3.24/bioc.tsv.gz`) keeps files
  to tens of thousands of lines; a single whole-repository manifest would be ~1M.
- **Bucket name for package content.** `MIGRATION.md` §Bucket layout defaults to one bucket
  but calls phase 3 out as the one case for a second. Only matters if the S3 escape hatch
  is ever used.
- **Deprecation window.** Both paths should run in parallel; closing per-operator should be
  on explicit confirmation, not log silence — silence may mean an abandoned mirror rather
  than a migrated one. Six months, one release cycle, is a reasonable opening proposal.
- **Whether the mirror programme still serves its original purpose.** Mirrors exist because
  one origin could not serve the world's bandwidth, and a CDN with free egress removes most
  of that. The reasons that remain — sovereignty, restricted networks, resilience against a
  Cloudflare outage, regional latency — are real but different, and each implies a somewhat
  different design. Worth settling before building. See issue #33.

## What is tested and what is not

The `rclone :http: --files-from` mechanism is **verified working** against
`bioc-dev.cancerdatasci.org` — tested before this document recommended it. Everything that
depends on the endpoint is now **tested**, because the endpoint does not exist.
