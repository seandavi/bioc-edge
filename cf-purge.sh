#!/usr/bin/env bash
#
# Cloudflare cache-purge helpers, sourced by sync.sh and gen-manifest.sh:
#
#   . "$(dirname "$0")/cf-purge.sh"
#   zone_id=$(cf_zone_id "$ZONE") || ...     # callers differ on whether fatal
#   cf_purge_urls "$zone_id" "${urls[@]}"
#
# Shared rather than copied because both callers spend the same account-wide
# rate budget and both need the same backoff -- two copies would have drifted
# the first time one of them was tuned.
#
# Purge-by-URL is the only targeted option below Enterprise. Cloudflare allows
# 100 URLs per request and 800 URLs/second account-wide on Free. That budget
# reads as generous and is not: a serial loop of 100-URL requests moves roughly
# 1000 URLs/s, so it trips a few seconds in. Two sync runs on 2026-08-04 died
# exactly there -- 2863 URLs after 4s, 5320 after 15s -- and because the
# failure aborted the batch loop, most of each run's changed URLs stayed stale
# at the edge while the upload itself had succeeded. That is the worse half of
# the bug: a failed run is visible, a silently unpurged edge is not.
CF_PURGE_BATCH=${CF_PURGE_BATCH:-100}
# Paces the batches to ~500 URLs/s at the defaults, comfortably under 800.
# Costs ~11s on a 5000-URL run, against a 20-minute rsync.
CF_PURGE_SLEEP=${CF_PURGE_SLEEP:-0.2}
# The budget is per account, not per zone, so pacing alone cannot guarantee we
# stay inside it -- anything else holding this token spends from the same
# bucket. Retry rather than drop the remaining batches on the floor.
CF_PURGE_RETRIES=${CF_PURGE_RETRIES:-4}

CF_API=${CF_API:-https://api.cloudflare.com/client/v4}

# Built per call, not once at source time: both callers check the token after
# sourcing, and baking an empty one in here would send unauthenticated
# requests that fail for a reason nobody would recognise.
_cf_auth() {
  printf '%s\n' -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H "Content-Type: application/json"
}

# Resolve a zone name to its id. Quiet and non-zero when it cannot; the callers
# disagree about whether that is fatal.
cf_zone_id() {
  local auth id
  mapfile -t auth < <(_cf_auth)
  id=$(curl -sS "${auth[@]}" "$CF_API/zones?name=$1" | jq -r '.result[0].id // empty')
  [[ -n $id ]] || return 1
  printf '%s\n' "$id"
}

# POST one purge body, retrying a rate limit and nothing else.
cf_purge_body() {
  local zone_id=$1 body=$2 auth resp try=0
  mapfile -t auth < <(_cf_auth)
  while :; do
    resp=$(curl -sS -X POST "${auth[@]}" --data "$body" "$CF_API/zones/$zone_id/purge_cache")
    if [[ $(jq -r '.success' <<<"$resp") == true ]]; then return 0; fi
    # Only a rate limit is worth waiting out. A revoked token or a URL outside
    # the zone fails identically forever, and retrying those just delays the
    # report by a minute. Matched on the message Cloudflare actually returned
    # ("Unable to purge, rate limit reached"), not on an error code read off
    # the docs -- we have the former in the logs and not the latter.
    if ! grep -qi 'rate limit' <<<"$resp"; then
      echo "purge failed: $(jq -c '.errors // .' <<<"$resp")" >&2
      return 1
    fi
    try=$((try + 1))
    if ((try > CF_PURGE_RETRIES)); then
      echo "purge still rate-limited after $CF_PURGE_RETRIES retries" >&2
      return 1
    fi
    echo "purge rate-limited; retry $try in $((try * 5))s" >&2
    sleep $((try * 5))
  done
}

cf_purge_everything() { cf_purge_body "$1" '{"purge_everything":true}'; }

# Purge URLs in paced batches. Returns non-zero on the first batch that cannot
# be recovered, with the remaining batches unsent -- the caller knows how much
# of its edge is now stale, which is better than pretending it succeeded.
cf_purge_urls() {
  local zone_id=$1; shift
  local i
  for ((i = 0; i < $#; i += CF_PURGE_BATCH)); do
    cf_purge_body "$zone_id" \
      "$(jq -nc --args '{files: $ARGS.positional}' "${@:i+1:CF_PURGE_BATCH}")" || return 1
    sleep "$CF_PURGE_SLEEP"
  done
}
