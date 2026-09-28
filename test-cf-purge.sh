#!/usr/bin/env bash
#
# The non-obvious logic in cf-purge.sh: which failures are worth retrying, how
# many times, and that batching neither drops nor duplicates a URL. Stubs curl,
# so no network and no token.
#
#   ./test-cf-purge.sh
set -euo pipefail

CLOUDFLARE_API_TOKEN=test-token
. "$(dirname "$(readlink -f "$0")")/cf-purge.sh"
CF_PURGE_RETRIES=2

t=$(mktemp -d); trap 'rm -rf "$t"' EXIT

# cf_purge_body captures curl in a command substitution, so the stub runs in a
# subshell and cannot count calls in a variable -- files it is.
curl() {
  echo x >> "$t/calls"
  local prev="" a
  for a in "$@"; do
    [[ $prev == --data ]] && jq -r '.files // [] | length' <<<"$a" >> "$t/files"
    prev=$a
  done
  head -1 "$t/queue"
  tail -n +2 "$t/queue" > "$t/queue.rest"; mv "$t/queue.rest" "$t/queue"
}
# The backoff is real seconds and the test should not pay them. Overriding it
# also means the sleeps are not what is under test -- the branching is.
sleep() { :; }

RL='{"success":false,"errors":[{"code":1115,"message":"Unable to purge, rate limit reached. Please wait and consider throttling your request speed"}]}'
OK='{"success":true,"errors":[]}'
BAD='{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}'

# queue <response...> -- arms the stub and resets the counters.
queue() { printf '%s\n' "$@" > "$t/queue"; : > "$t/calls"; : > "$t/files"; }
calls() { wc -l < "$t/calls" | tr -d ' '; }
expect_calls() { # expect_calls <label> <n>
  [[ $(calls) == "$2" ]] || { echo "FAIL $1: expected $2 curl calls, got $(calls)"; exit 1; }
}

# 1. The bug this file exists for: a rate limit is transient, so it must be
#    waited out rather than aborting the run. Before this, the first 429 killed
#    sync.sh and left every later batch unpurged -- a stale edge nobody sees.
queue "$RL" "$OK"
cf_purge_body zone1 '{}' 2>/dev/null || { echo "FAIL rate limit was not retried"; exit 1; }
expect_calls "rate limit retried" 2

# 2. A real error must NOT be retried. A revoked token fails identically
#    forever; retrying it only delays the report and hides the cause behind a
#    minute of backoff.
queue "$BAD" "$OK"
! cf_purge_body zone1 '{}' 2>/dev/null || { echo "FAIL auth error was treated as success"; exit 1; }
expect_calls "auth error not retried" 1

# 3. Retries are bounded. An unbounded loop against a rate limit that is not
#    clearing would hang the sync until systemd's 6h TimeoutStartSec.
queue "$RL" "$RL" "$RL" "$RL" "$RL"
! cf_purge_body zone1 '{}' 2>/dev/null || { echo "FAIL gave up too late (or not at all)"; exit 1; }
expect_calls "retries bounded" $((CF_PURGE_RETRIES + 1))

# 4. Batching covers every URL exactly once. The slice arithmetic over "$@" is
#    the kind of off-by-one that silently under-purges: the run reports success
#    and the missed URLs stay stale for a year, since cacheControl() gives every
#    key s-maxage=31536000 and freshness comes only from purge-on-publish.
CF_PURGE_BATCH=100
urls=(); for i in $(seq 1 250); do urls+=("https://h/$i"); done
queue "$OK" "$OK" "$OK"
cf_purge_urls zone1 "${urls[@]}" || { echo "FAIL batched purge failed"; exit 1; }
expect_calls "250 urls in batches of 100" 3
sent=$(paste -sd+ "$t/files" | bc)
[[ $sent == 250 ]] || { echo "FAIL sent $sent of 250 urls"; exit 1; }
[[ $(sort -n "$t/files" | tail -1) -le $CF_PURGE_BATCH ]] ||
  { echo "FAIL a batch exceeded CF_PURGE_BATCH=$CF_PURGE_BATCH"; exit 1; }

# 5. A batch that cannot be recovered stops the loop instead of charging on.
#    Carrying on would report "purged N urls" while an unknown slice of the
#    edge is stale -- worse than failing, because it looks fine.
queue "$OK" "$BAD" "$OK"
! cf_purge_urls zone1 "${urls[@]}" 2>/dev/null || { echo "FAIL kept purging past a hard error"; exit 1; }
expect_calls "stops on hard error" 2

# 6. Every served host is purged, each in its own zone (issue #15). The edge
#    caches per hostname, so a key purged only on the dev host stays stale on
#    bioconductor.org for a year. A zone the token cannot see must not stop
#    the other zones from being purged -- but the run still has to fail.
PURGE_TARGETS="dev.example:example.net a.example:example.org b.example:example.org"
PURGE_MAX=10
cf_zone_id() { [[ $1 == example.org ]] && echo zid-org || echo zid-net; }
cf_purge_urls() { echo "$1 ${*:2}" >> "$t/purged"; }
cf_purge_everything() { echo "$1 EVERYTHING" >> "$t/purged"; }
: > "$t/purged"
cf_purge_keys k1 k2 >/dev/null || { echo "FAIL per-zone purge reported failure"; exit 1; }
[[ $(sort "$t/purged") == "$(printf '%s\n' \
  "zid-net https://dev.example/k1 https://dev.example/k2" \
  "zid-org https://a.example/k1 https://a.example/k2 https://b.example/k1 https://b.example/k2")" ]] ||
  { echo "FAIL wrong hosts or zones purged:"; cat "$t/purged"; exit 1; }

: > "$t/purged"
cf_purge_keys $(seq 1 11) >/dev/null || { echo "FAIL zone purge reported failure"; exit 1; }
[[ $(sort "$t/purged") == "$(printf 'zid-net EVERYTHING\nzid-org EVERYTHING')" ]] ||
  { echo "FAIL PURGE_MAX did not fall back to a purge per zone:"; cat "$t/purged"; exit 1; }

cf_zone_id() { [[ $1 == example.net ]] && echo zid-net; }
: > "$t/purged"
! cf_purge_keys k1 >/dev/null 2>&1 || { echo "FAIL unresolvable zone was reported as success"; exit 1; }
[[ $(cat "$t/purged") == "zid-net https://dev.example/k1" ]] ||
  { echo "FAIL one bad zone stopped the others"; exit 1; }

echo "ok"
