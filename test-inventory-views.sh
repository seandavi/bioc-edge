#!/usr/bin/env bash
#
# Pins the parsing logic in inventory/views.sql against fixtures built to the
# same shapes as the real artifacts -- a directory-marker row (size -1, the
# trap that has bitten this project twice already), a path with a space, and
# a symlink line. No network, no credentials: runs only the prefix of
# views.sql above its "network boundary" marker (see that file's header),
# against a tiny fixture tree instead of the real inventory/mirror/R2.
#
#   ./test-inventory-views.sh
set -euo pipefail

here=$(dirname "$(readlink -f "$0")")
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
inv=$t/inventory mirror=$t/mirror
mkdir -p "$inv" "$mirror/packages/3.23/bioc/html"

# --- fixture: upstream docroot listing (rsync --list-only shape) -----------
# One dir, one file, a file whose path contains a space (86 of these exist in
# the real tree -- the reason path parsing rebuilds from field 5, not $5),
# two symlinks (one plain, one that only exists to prove the top-level regex
# in trend_upstream_by_top doesn't choke on a symlink's "-> target" text).
cat > "$inv/docroot-latest.raw.txt" <<'EOF'
drwxrwxr-x          4,096 2026/07/30 09:17:32 .
-rw-rw-r--          6,309 2026/07/30 09:17:32 BioC_mirrors.csv
-rw-r--r--         81,671 2026/04/29 08:34:35 books/3.23/OMA/figure-html/6.2 - plot ROC and PRC-1.png
lrwxrwxrwx             25 2008/03/03 17:20:22 checkResults/release -> 3.23
lrwxrwxrwx             12 2008/03/03 17:20:22 escape -> ../../outside
-rw-r--r--          1,234 2026/07/30 09:17:32 packages/3.23/bioc/html/DESeq2.html
EOF
gzip -c "$inv/docroot-latest.raw.txt" > "$inv/docroot-20260730T000000Z.txt.gz"
ln -s docroot-20260730T000000Z.txt.gz "$inv/docroot-latest.txt.gz"

# --- fixture: OSN archive listing, size<TAB>path --- the size -1 directory-
# marker rows are the exact shape that inflated a real object count by
# 38,819; osn_archive_objects must filter them, not just the raw view.
cat > "$inv/osn-archive-latest.raw.tsv" <<'EOF'
-1	1.8/
-1	1.8/bioc/
489832	1.8/bioc/Foo_1.0.tgz
1000	1.8/bioc/Bar_2.0.tgz
EOF
gzip -c "$inv/osn-archive-latest.raw.tsv" > "$inv/osn-archive-20260730T000000Z.tsv.gz"
ln -s osn-archive-20260730T000000Z.tsv.gz "$inv/osn-archive-latest.tsv.gz"

# --- fixture: R2 listing, path<TAB>size<TAB>md5 -- one object with no usable
# hash (a real minority case, gen-manifest.sh's own caveat) and one object
# that exists only in R2 (an orphan reconcile_r2_orphans must catch).
{
  printf 'BioC_mirrors.csv\t6309\td41d8cd98f00b204e9800998ecf8427e\n'
  printf 'packages/3.23/bioc/html/DESeq2.html\t1234\te4dccb0d73c1f2016a8042ed1a0dba0a\n'
  # Trailing tab, no hash: the real minority case (composite ETag, not an
  # MD5) rclone reports for some multipart uploads -- gen-manifest.sh's own
  # awk always emits the third field even when blank; a fixture without it
  # is not the real shape.
  printf 'packages/3.23/bioc/html/onlyInR2.html\t99\t\n'
} > "$inv/r2-listing-latest.raw.tsv"
gzip -c "$inv/r2-listing-latest.raw.tsv" > "$inv/r2-listing-20260730T000000Z.tsv.gz"
ln -s r2-listing-20260730T000000Z.tsv.gz "$inv/r2-listing-latest.tsv.gz"

# --- fixture: local mirror -- only DESeq2.html made it down, not the other
# two upstream/R2 objects, so the three-way reconciliation has something to
# report in every direction (upstream-not-local, local-not-r2 is empty here,
# r2-not-upstream).
echo hi > "$mirror/packages/3.23/bioc/html/DESeq2.html"

# Only the offline prefix of views.sql -- everything above the network-
# boundary marker. If that marker ever stops existing, this must fail loudly
# rather than silently testing nothing.
grep -q 'network-boundary' "$here/inventory/views.sql" ||
  { echo "FAIL: inventory/views.sql no longer documents a network boundary"; exit 1; }
offline=$t/offline.sql
awk '/OFFLINE_BOUNDARY/{exit} {print}' "$here/inventory/views.sql" > "$offline"
grep -q 'CREATE OR REPLACE VIEW upstream_docroot' "$offline" ||
  { echo "FAIL: offline prefix of views.sql is empty -- boundary marker moved?"; exit 1; }

q() { INVENTORY_DIR=$inv MIRROR_DIR=$mirror duckdb -init "$offline" -csv -noheader -c "$1"; }

fail=0
check() { # check <label> <expect> <sql>
  local label=$1 expect=$2 sql=$3 got
  got=$(q "$sql")
  [[ $got == "$expect" ]] ||
    { echo "FAIL $label: expected [$expect], got [$got]"; fail=1; }
}

# Trap 1: rclone/rsync-shaped directory-marker rows (size -1) must never be
# summed as objects. osn_archive keeps them (2 dirs); osn_archive_objects
# does not (2 real objects, 490832 bytes).
check "osn raw includes dir markers"   "4" "SELECT count(*) FROM osn_archive"
check "osn_archive_objects excludes them" "2,490832" \
  "SELECT count(*), sum(size) FROM osn_archive_objects"

# Field-5-to-EOL path parsing, including the space and the symlink split.
check "upstream file count"  "3" "SELECT count(*) FROM upstream_docroot WHERE kind = '-'"
check "path with space parses whole"  "1" \
  "SELECT count(*) FROM upstream_docroot WHERE path = 'books/3.23/OMA/figure-html/6.2 - plot ROC and PRC-1.png'"
check "symlink path/target split"  "checkResults/release,3.23" \
  "SELECT path, link_target FROM upstream_docroot WHERE kind = 'l' AND path = 'checkResults/release'"

# Trap: sizes are comma-grouped in the raw listing; must come out as a plain
# integer, not "6,309".
check "comma-grouped size parses"  "6309" \
  "SELECT size FROM upstream_docroot WHERE path = 'BioC_mirrors.csv'"

# R2's blank/non-hex hash must come out NULL, not the empty string, so a join
# on md5 doesn't spuriously "match" two blanks against each other.
check "blank r2 hash is NULL, not ''"  "is_null" \
  "SELECT CASE WHEN md5 IS NULL THEN 'is_null' ELSE md5 END
   FROM r2_objects WHERE path = 'packages/3.23/bioc/html/onlyInR2.html'"

# The three-way reconciliation: DESeq2.html is everywhere, BioC_mirrors.csv
# is upstream+R2 but never made it to the local mirror, onlyInR2.html is an
# R2-only orphan.
check "in all three sources"  "true,true,true" \
  "SELECT in_upstream, in_local, in_r2 FROM reconcile_docroot WHERE path = 'packages/3.23/bioc/html/DESeq2.html'"
check "upstream-not-local"  "1" \
  "SELECT count(*) FROM reconcile_upstream_not_local WHERE path = 'BioC_mirrors.csv'"
check "r2 orphan"  "1" \
  "SELECT count(*) FROM reconcile_r2_orphans WHERE path = 'packages/3.23/bioc/html/onlyInR2.html'"

# OSN reconciliation builds the R2 key with the archive prefix, not a raw
# path compare -- neither OSN object made it into this fixture's R2 listing.
check "osn path remapped to archive prefix"  "2" \
  "SELECT count(*) FROM reconcile_osn_r2 WHERE in_osn AND NOT in_r2"

# normalize_rel_path: the macro symlink_resolution depends on. Deepest real
# case (4 "../" segments) and the spurious ".." vs ".." collapse this exists
# to avoid (see the macro's own comment).
check "normalize: simple version bump"  "checkResults/3.23" \
  "SELECT normalize_rel_path('checkResults', '3.23')"
check "normalize: four dotdot segments"  "packages/lindsey/1.7/bin/macosx/i686/contrib/2.2" \
  "SELECT normalize_rel_path('packages/lindsey/bin/macosx/i686/contrib', '../../../../1.7/bin/macosx/i686/contrib/2.2')"

# Trend: the trend views must not choke on a directory or symlink row, and
# must not manufacture a bogus top-level group from a symlink's "-> target"
# text (regressed once while writing this file -- see trend_upstream_by_top's
# own comment).
check "trend excludes dir/symlink rows from file counts"  "3" \
  "SELECT sum(files) FROM trend_upstream_by_top"
check "trend has no group from symlink text"  "0" \
  "SELECT count(*) FROM trend_upstream_by_top WHERE top LIKE '%->%'"

if [[ $fail == 0 ]]; then
  echo "ok"
else
  exit 1
fi
