# Inventory

Cached listings of the two upstream trees feeding the R2 / Worker migration.
Crawling either one takes ~10 min, so snapshot it once and query the file.

`./refresh.sh` writes a timestamped pair to `$OUT`
(default `/data/davsean/bioc-cloudflare/inventory`, outside the repo — the
snapshots are ~40 MB gzipped) and repoints the `-latest` symlinks.

| File | Source | Format |
|---|---|---|
| `docroot-<ts>.txt.gz` | `$RSYNC_SRC` (= `the live docroot`, the live docroot) | raw `rsync --list-only`: perms, size, date, time, path |
| `osn-archive-<ts>.tsv.gz` | `osn-bioc:bir190004-bucket01/archive.bioconductor.org/packages` | `size<TAB>path` |
| `r2-listing-<ts>.tsv.gz` | `r2:$BUCKET` (the live bucket, ~15 min at 1.65M objects — see the comment in `refresh.sh`) | `path<TAB>size<TAB>md5` |

Findings drawn from these snapshots live in `../MIGRATION.md` (§Upstream shape).
Keep the numbers there, not here — one place to update after a refresh.

## Query layer

`./db.sh` (or `./db.sh "SELECT ..."`) answers questions across all four
sources — these snapshots, the live local mirror, and the published manifest
— in one query instead of a pipeline of separately-run awk. `views.sql` is
the view layer; its header documents four specific mistakes it exists to
make structurally impossible (the size `-1` directory row, `du -sh` vs `du
-sb`, rsync itemize codes read as file counts, rclone's "Transferred: N"
summary read as `find | wc -l`). Nothing is stored: every view reads a source
artifact fresh, so if a number looks wrong the fix is re-running `refresh.sh`
or checking the artifact, never patching a view.

`test-inventory-views.sh` (repo root) pins the parsing logic against
fixtures, no network required.

## Querying (raw)

The recipes below still work, and are the reference for what each snapshot's
columns mean — but for anything that reconciles more than one source (what's
upstream but not local, what's an orphan in R2, ...) use `./db.sh` instead:
that used to be three bespoke awk scripts run by hand, which is exactly how
the size `-1` and GiB/GB mistakes documented in `views.sql` happened.

`rsync --list-only` columns are perms, size, date, time, path. Size is
comma-grouped, and paths can contain spaces, so rebuild the path from `$5..NF`
rather than indexing a single field.

```sh
cd /data/davsean/bioc-cloudflare/inventory

# totals by type: - files, d dirs, l symlinks
zcat docroot-latest.txt.gz | awk '
  $1 ~ /^-/ {gsub(",","",$2); f++; b+=$2} $1 ~ /^d/ {d++} $1 ~ /^l/ {l++}
  END {printf "files=%d dirs=%d symlinks=%d %.1f GB\n", f, d, l, b/1e9}'

# size and file count per top-level directory
zcat docroot-latest.txt.gz | awk '
  $1 ~ /^-/ {gsub(",","",$2); p=$5; for(i=6;i<=NF;i++) p=p" "$i
             split(p,a,"/"); n[a[1]]++; b[a[1]]+=$2}
  END {for (t in n) printf "%10.1f GB %9d  %s\n", b[t]/1e9, n[t], t}' | sort -rn

# every symlink and its target
zcat docroot-latest.txt.gz | awk '$1 ~ /^l/ {$1=$2=$3=$4=""; sub(/^ +/,""); print}'

# OSN archive totals, and per-release breakdown
zcat osn-archive-latest.tsv.gz | awk -F'\t' '{n++; b+=$1} END {print n, b}'
zcat osn-archive-latest.tsv.gz | awk -F'\t' \
  '{split($2,p,"/"); s[p[1]]+=$1} END {for (v in s) print v, s[v]}' | sort -V
```

## Access notes

- **the upstream docroot host** is locked to `rrsync` via `ForceCommand`. No shell, no sftp (exit 255).
  rsync-over-ssh only — which is why rclone cannot talk to it and every sync has to
  stage through a local mirror. See §Incremental sync in `../MIGRATION.md`.
- **OSN** is anonymous S3 at `https://mghp.osn.xsede.org/`. Bucket-root `lsd` **does**
  list -- an earlier note here claimed otherwise, which was wrong. 68 top-level prefixes,
  of which `archive.bioconductor.org/` is the only one this migration touches.
  `refresh.sh` snapshots that prefix alone.

  The bucket is much larger than this migration's scope, and worth knowing about before
  anyone reasons from "the OSN bucket" as if it meant the archive:

  | Prefix | Objects | Size |
  |---|---|---|
  | `AnnotationHub` | 98,443 | 10.12 TiB |
  | `ExperimentHub` | 8,722 | 593 GiB |
  | `archive.bioconductor.org` | 301,217 | 4.24 TiB |

  The two hubs are served by a separate Bioconductor service and fetched by the
  `AnnotationHub`/`ExperimentHub` R packages via a metadata database -- nothing under
  `bioconductor.org`'s docroot, the crawl, or `.htaccess` refers to them. They are out of
  scope, and are recorded here only so the scope boundary is a decision rather than an
  oversight.
- Paths in the docroot are well behaved: across 4,620,887 entries, zero contain a tab,
  pipe, backslash, or control character. Delimiter-splitting `rsync --out-format`
  output is safe — `sync.sh` relies on this.
