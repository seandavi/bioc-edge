#!/usr/bin/env bash
#
# The initial load: local mirror -> R2, once the first rsync pull completes.
#
#   ./finish-load.sh              dry run: report, change nothing
#   APPLY=1 ./finish-load.sh      do it
#
# This exists because the obvious command is dangerous.
#
# The docroot lives at the bucket root, so `rclone sync ./mirror r2:bioc-site`
# treats every key not in ./mirror as an orphan to delete -- including the
# whole `archive.bioconductor.org/` prefix, which is 4.66 TB copied from OSN
# and has no local counterpart by design. That single command would delete it.
#
# It is the same failure MIRRORS.md warns operators about: sync is delete-by-
# default, and a prefix absent from the source is not "nothing to do", it is
# "delete everything on the other side". Easy to write, expensive to undo.
#
# `sync` and not `copy` is still right for the *first* load: the bucket holds
# ~507 objects from the phase-1 wget crawl that have no docroot counterpart
# (`packages/plyranges` is the clear case -- wget saved a redirect body under
# the requested path). Those must go, or they serve crawl-era content forever.
# Later runs use `RSYNC_SRC=... ./sync.sh`, which is delta-based and never
# needs a bucket-wide comparison.
set -euo pipefail

BUCKET=${BUCKET:-bioc-site}
DEST=${DEST:-/data/davsean/bioc-cloudflare/mirror}
HOST=${HOST:-bioc-dev.cancerdatasci.org}
# Everything the docroot does not own. Excluded from the delete scope, not
# just from upload -- that is the whole point.
PROTECT=(--exclude 'archive.bioconductor.org/**' --exclude '_symlinks.json' --exclude 'api/**')
# Expected orphans are the phase-1 crawl's ~507 objects, minus those whose keys
# also exist in the real docroot. Anything far above that means the mirror is
# incomplete and we are about to delete real content.
MAX_DELETES=${MAX_DELETES:-2000}
# From the validated dry run. A mirror much smaller than this is a partial
# pull, and syncing a partial mirror deletes whatever is missing from it.
EXPECT_FILES=${EXPECT_FILES:-1351518}
MIN_FRACTION=${MIN_FRACTION:-95}

: "${CLOUDFLARE_API_TOKEN:?run: ./make-env.sh && set -a && . ./.env && set +a}"
[[ -d $DEST ]] || { echo "no mirror at $DEST" >&2; exit 1; }

# --- guard: is the pull actually finished? -----------------------------------
if pgrep -x rsync >/dev/null; then
  echo "rsync is still running -- the mirror is incomplete." >&2
  echo "Syncing now would delete every object whose file has not arrived yet." >&2
  exit 1
fi

have=$(find "$DEST" -type f | wc -l)
pct=$(( have * 100 / EXPECT_FILES ))
echo "mirror: $have files (${pct}% of the $EXPECT_FILES the dry run predicted)"
if (( pct < MIN_FRACTION )); then
  echo "below ${MIN_FRACTION}% -- refusing. Re-run the pull, or override EXPECT_FILES." >&2
  exit 1
fi

# --- extensionless keys, before the sync -------------------------------------
# rclone types by extension, so these upload as octet-stream and download
# rather than render, and the Worker cannot repair a *wrong* type -- only a
# missing one. Uploaded first so the sync below sees them as current.
extless=$(mktemp); trap 'rm -f "$extless"' EXIT
(cd "$DEST" && find . -type f ! -name '*.*' -printf '%P\n') > "$extless"
echo "extensionless keys to type as text/plain: $(wc -l < "$extless")"

# --- the sync ----------------------------------------------------------------
log=finish-load-$(date +%Y%m%dT%H%M%S).log
echo "--- dry run"
rclone sync "$DEST" "r2:$BUCKET" "${PROTECT[@]}" --checksum --dry-run \
  --log-level INFO --log-file "$log" --transfers 16 --checkers 32
# rclone words a dry run differently from a real one -- uploads log as
# "Skipped copy as --dry-run is set", not "Copied" -- so matching only the
# real-run wording reports zero uploads for a run that would transfer
# everything. Count both, and prefer rclone's own summary line when present.
dels=$(grep -c 'Skipped delete' "$log" 2>/dev/null || true)
ups=$(grep -cE ': (Copied|Updated)|Skipped copy as' "$log" 2>/dev/null || true)
summary=$(grep -oE 'Transferred:[[:space:]]+[0-9]+ / [0-9]+' "$log" | tail -1 || true)
echo "would upload $ups, delete $dels (log: $log)"
[[ -n $summary ]] && echo "  rclone summary: $summary"

if (( dels > MAX_DELETES )); then
  echo "refusing: $dels deletions exceeds MAX_DELETES=$MAX_DELETES." >&2
  echo "Expected only the phase-1 crawl's orphans. Check the mirror is complete" >&2
  echo "and that the protect list still covers everything R2 owns:" >&2
  printf '  %s\n' "${PROTECT[@]}" >&2
  exit 1
fi

[[ ${APPLY:-} == 1 ]] || { echo "dry run only. APPLY=1 to proceed."; exit 0; }

[[ -s $extless ]] && rclone copy "$DEST" "r2:$BUCKET" --files-from "$extless" \
  --no-traverse --transfers 16 \
  --header-upload "Content-Type: text/plain; charset=utf-8"

rclone sync "$DEST" "r2:$BUCKET" "${PROTECT[@]}" --checksum \
  --log-level INFO --log-file "$log" --transfers 16 --checkers 32

# --- publish the symlink map, last -------------------------------------------
# After the objects, never before: a map naming keys that do not exist yet
# resolves requests onto 404s.
find "$DEST" -type l -printf '%P\t%l\n' | LC_ALL=C sort |
  jq -R -s 'split("\n") | map(select(length > 0) | split("\t") | {(.[0]): .[1]}) | add // {}' |
  rclone rcat "r2:$BUCKET/_symlinks.json" --header-upload "Content-Type: application/json"
echo "published _symlinks.json ($(find "$DEST" -type l | wc -l) entries)"

# --- publish the mirror manifest ---------------------------------------------
# After the symlink map, because gen-manifest.sh reads release/devel from it,
# and after the objects, because the manifest names keys that must exist.
"$(dirname "$0")/gen-manifest.sh"

# --- smoke test --------------------------------------------------------------
# The contrib aliases are the install.packages() path and fail quietly when the
# map is wrong: the browse URLs keep working, so nothing looks broken.
echo "--- smoke test"
for p in / /help/ /packages/release/bioc/html/ /packages/devel/bioc/; do
  printf '  %-40s %s\n' "$p" "$(curl -sS -o /dev/null -w '%{http_code}' "https://$HOST$p" --max-time 20)"
done
