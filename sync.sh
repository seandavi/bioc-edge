#!/usr/bin/env bash
#
# rclone sync the mirror to R2, then purge exactly the objects that changed.
#
#   ./sync.sh              sync and purge
#   DRY_RUN=1 ./sync.sh    report what would change, upload and purge nothing
#
# Worker cache entries are keyed by resolved R2 object key (cacheUrl() in
# worker/src/keys.ts), so the keys rclone reports as changed map 1:1 onto the
# URLs to purge. Keying on request URLs instead would mean purging every URL
# form that resolves to an object -- /help/, /help and /help/index.html.
set -euo pipefail

BUCKET=${BUCKET:-bioc-site}
DEST=${DEST:-mirror}
HOST=${HOST:-bioc-dev.cancerdatasci.org}
ZONE=${ZONE:-cancerdatasci.org}
# Purge-by-URL takes 30 URLs per call and is the only targeted option below
# Enterprise. Past this many changes it is fewer API calls to purge the zone
# and let the edge refill from R2 -- egress is free and Class B is $0.36/M.
PURGE_MAX=${PURGE_MAX:-300}

[[ -d $DEST ]] || { echo "no mirror at $DEST -- run ./crawl.sh site first" >&2; exit 1; }
: "${CLOUDFLARE_API_TOKEN:?run: ./make-env.sh && set -a && . ./.env && set +a}"

log=sync-$(date +%Y%m%dT%H%M%S).log

# Deliberately `sync`, not `copy`: the mirror is authoritative and deletions
# have to propagate. Run DRY_RUN=1 first on any layout change.
rclone sync "$DEST" "r2:$BUCKET" \
  --log-level INFO --log-file "$log" \
  --transfers 16 --checkers 32 \
  ${DRY_RUN:+--dry-run}

# rclone logs `INFO  : <key>: Copied (new)` / `Updated` / `Deleted`.
mapfile -t changed < <(
  sed -n 's/.*INFO  : \(.*\): \(Copied\|Updated\|Deleted\|Moved\).*/\1/p' "$log" | sort -u
)
echo "${#changed[@]} objects changed (log: $log)"

if [[ ${DRY_RUN:-} == 1 ]]; then
  printf '%s\n' "${changed[@]:0:20}"
  exit 0
fi
[[ ${#changed[@]} -gt 0 ]] || exit 0

api="https://api.cloudflare.com/client/v4"
auth=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json")

zone_id=$(curl -sS "${auth[@]}" "$api/zones?name=$ZONE" | jq -r '.result[0].id // empty')
[[ -n $zone_id ]] || { echo "cannot resolve zone $ZONE; token may lack Zone:Read" >&2; exit 1; }

purge_body() {
  local ok
  ok=$(curl -sS -X POST "${auth[@]}" --data "$1" "$api/zones/$zone_id/purge_cache" |
    jq -r '.success, (.errors[]?.message)' | head -3)
  [[ $ok == true ]] || { echo "purge failed: $ok" >&2; return 1; }
}

if ((${#changed[@]} > PURGE_MAX)); then
  echo "purging entire zone (${#changed[@]} > PURGE_MAX=$PURGE_MAX)"
  purge_body '{"purge_everything":true}'
else
  urls=()
  for k in "${changed[@]}"; do urls+=("https://$HOST/$k"); done
  for ((i = 0; i < ${#urls[@]}; i += 30)); do
    purge_body "$(jq -nc --args '{files: $ARGS.positional}' "${urls[@]:i:30}")"
  done
  echo "purged ${#urls[@]} urls"
fi
