#!/usr/bin/env bash
#
# Snapshot the two upstream trees. Re-run whenever you need fresh numbers.
# Takes ~10 min; snapshots are large, so they live outside the repo.
set -eu

OUT=${OUT:-/data/davsean/bioc-cloudflare/inventory}
SRC=${SRC:-$RSYNC_SRC}
mkdir -p "$OUT"
cd "$OUT"
TS=$(date -u +%Y%m%dT%H%M%SZ)

# the upstream docroot host is rrsync-restricted (ForceCommand, no shell, no sftp), so
# --list-only is the only way to enumerate it. No -L: release/devel stay
# symlinks instead of duplicating 3.23/3.24 into the byte count.
rsync -a --list-only --exclude=lost+found --exclude='.*.??????' \
  "$SRC" 2>/dev/null \
  | grep -Ev '^#|^$' | gzip > "docroot-$TS.txt.gz"
ln -sf "docroot-$TS.txt.gz" docroot-latest.txt.gz

# OSN archive: size<TAB>path, one line per object.
rclone lsf -R --fast-list --format sp --separator $'\t' \
  osn-bioc:bir190004-bucket01/archive.bioconductor.org/packages \
  | gzip > "osn-archive-$TS.tsv.gz"
ln -sf "osn-archive-$TS.tsv.gz" osn-archive-latest.tsv.gz

echo "wrote $OUT/docroot-$TS.txt.gz $OUT/osn-archive-$TS.tsv.gz"
