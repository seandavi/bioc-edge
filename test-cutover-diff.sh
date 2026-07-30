#!/usr/bin/env bash
#
# Pins classify_pair() -- the only non-obvious logic in cutover-diff.sh --
# against fixtures. No network: sources the script under a guard that skips
# main(), then calls the pure function directly with fabricated
# status/content-type/hash tuples standing in for what fetch_side() would
# have returned from the two origins.
#
#   ./test-cutover-diff.sh
set -euo pipefail

# shellcheck source=cutover-diff.sh
source "$(dirname "$(readlink -f "$0")")/cutover-diff.sh"

fail=0
check() { # check <label> <expect> <classify_pair args...>
  local label=$1 expect=$2; shift 2
  local got; got=$(classify_pair "$@")
  if [[ $got != "$expect" ]]; then
    echo "FAIL $label: expected $expect, got $got"
    fail=1
  fi
}

h=aaa...  p=aaa...   # same digest, stand-in hashes
h2=bbb...

# Both sides identical and small: ok.
check "identical html"        ok \
  200 200 "text/html" "text/html" 1 1 "$h" "$p"

# Worker sends a charset param Apache doesn't -- must not count as a diff.
# This is the exact live pair: `curl -I` on the dev host returns
# "text/html; charset=utf-8", bioconductor.org returns "text/html".
check "charset param ignored" ok \
  200 200 "text/html; charset=utf-8" "text/html" 1 1 "$h" "$p"

# The bug this gate exists to catch: identical status, wrong bytes-serving
# behavior surfaces as a content-type mismatch (application/octet-stream vs
# text/html), the exact failure already hit on /packages/plyranges.
check "wrong content-type"    content_type_mismatch \
  200 200 "application/octet-stream" "text/html" 1 1 "$h" "$p"

# Same status, same type, different bytes.
check "hash differs"          hash_mismatch \
  200 200 "text/html" "text/html" 1 1 "$h" "$h2"

# Present on dev, 404 on prod (or vice versa).
check "missing on prod"       missing \
  200 404 "text/html" "text/html" 1 0 "$h" NONE
check "missing on dev"        missing \
  404 200 "text/html" "text/html" 0 1 NONE "$p"

# Both 404: agreement, not a diff.
check "both 404"              ok \
  404 404 "text/html" "text/html" 0 0 NONE NONE

# Neither 404, but different codes (e.g. redirect flattened to 200 on one
# side -- see MIGRATION.md "Redirects -- unresolved").
check "500 vs 200"            status_mismatch \
  200 500 "text/html" "text/html" 1 0 "$h" NONE

# Both origins over MAX_HASH_BYTES: media, not hashed, not a failure --
# reported separately so it's excluded on purpose, not silently.
check "both oversized"        size_skipped \
  200 200 "video/mp4" "video/mp4" 0 0 "SKIPPED>5000000B" "SKIPPED>5000000B"

# Oversized on one side only: can't confirm a match, so this does NOT get
# the size_skipped pass -- asymmetric size is itself worth a human looking.
check "oversized one side"    hash_mismatch \
  200 200 "video/mp4" "video/mp4" 1 0 "$h" "SKIPPED>5000000B"

# A transport failure (DNS/connect/timeout) must never read as "ok", even
# if it coincidentally produced the same ERR* status string on both sides --
# that would silently pass a simultaneous outage as a match.
check "both transport errors" status_mismatch \
  ERR6 ERR6 "" "" 0 0 NONE NONE
check "one transport error"   status_mismatch \
  200 ERR28 "text/html" "" 1 0 "$h" NONE

# norm_ctype is exercised above via the charset case; also pin it directly
# for the whitespace/case variant a proxy could plausibly introduce.
[[ $(norm_ctype "  TEXT/HTML ; charset=UTF-8") == "text/html" ]] ||
  { echo "FAIL norm_ctype whitespace/case"; fail=1; }

if [[ $fail == 0 ]]; then
  echo "ok"
else
  exit 1
fi
