#!/usr/bin/env bash
#
# Snapshot the two upstream trees, plus the R2 bucket. Re-run whenever you
# need fresh numbers. The docroot and OSN listings take ~10 min; the R2
# listing adds ~15 more (see its own comment below) -- snapshots are large,
# so they live outside the repo.
set -eu

OUT=${OUT:-/data/davsean/bioc-cloudflare/inventory}
SRC=${SRC:-${RSYNC_SRC:?set RSYNC_SRC (see .env) or pass SRC=}}
mkdir -p "$OUT"
cd "$OUT"
TS=$(date -u +%Y%m%dT%H%M%SZ)

# The upstream docroot host is rrsync-restricted (ForceCommand, no shell, no sftp), so
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

# R2 bucket: path<TAB>size<TAB>md5, one line per object. This is the slow one
# (~15 min at 1.65M objects) and the only reason it is a snapshot at all
# rather than a live query -- the local mirror and upstream docroot don't need
# credentials or a network round trip per object, this does. --fast-list
# trades memory for far fewer LIST calls, which is the difference between
# this finishing in minutes rather than tens of minutes on a bucket this
# size. --files-only is load-bearing for the reason gen-manifest.sh documents:
# without it, directory marker rows (size -1, no hash) come back as if they
# were fetchable objects.
BUCKET=${BUCKET:-bioc-site}
rclone lsf -R --fast-list --files-only --format "psh" --separator $'\t' --hash md5 \
  "r2:$BUCKET" | gzip > "r2-listing-$TS.tsv.gz"
ln -sf "r2-listing-$TS.tsv.gz" r2-listing-latest.tsv.gz

# .htaccess is the de-facto Worker spec -- 92 RewriteRule, 51 RedirectMatch,
# plus the Cache-Control and Expires directives. Snapshot it next to the repo
# copy so a drift is visible as a diff rather than a surprise at cutover.
rsync -a "${SRC%.}.htaccess" "$OUT/htaccess-$TS.conf" 2>/dev/null &&
  ln -sf "htaccess-$TS.conf" htaccess-latest.conf

echo "wrote $OUT/docroot-$TS.txt.gz $OUT/osn-archive-$TS.tsv.gz $OUT/r2-listing-$TS.tsv.gz $OUT/htaccess-$TS.conf"
