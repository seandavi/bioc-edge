#!/usr/bin/env bash
#
# MIGRATION.md Cutover step 3: diff bioc-dev.cancerdatasci.org against
# bioconductor.org for every URL the phase-1 crawl found -- status code,
# content-type, and a content hash -- and require zero unexplained diffs
# before any DNS change. A status-only check would pass the exact bug this
# project already hit once: /packages/plyranges served 200 as
# application/octet-stream instead of text/html.
#
#   ./cutover-diff.sh                  diff every URL in mirror.urls
#   URLS=mirror.urls ./cutover-diff.sh
#   NORMALIZE_HOST=1 ./cutover-diff.sh see "Absolute URLs" below
#
# There is no sitemap (upstream's is a broken template), so the URL list is
# whatever ./crawl.sh site already recorded in $DEST.urls -- content nothing
# links to is invisible to the crawl and therefore to this gate too.
#
# Rate limiting: bioconductor.org is the production box this whole project
# exists to stop paging on, and this script is meant to be run repeatedly
# against it. Only the prod leg is throttled (--limit-rate, WAIT between
# requests) -- the dev leg is our own Cloudflare infra and costs it nothing.
#
# Media: fetch bodies are hard-capped at MAX_HASH_BYTES by piping curl
# through `head -c`, not by trusting Content-Length. Confirmed necessary:
# the dev host (Cloudflare Worker + R2 binding) never sends Content-Length on
# HTML at all -- HTTP/2 streams it -- so curl's own --max-filesize (which
# only checks the header) enforces nothing on that side and would silently
# pull an entire multi-hundred-MB course-materials video. `head -c` bounds
# the actual bytes read off the wire regardless of what headers say. Anything
# that hits the cap is reported as size_skipped rather than hashed: compared
# by status + content-type only, listed explicitly, not silently dropped.
set -euo pipefail

DEV_HOST=${DEV_HOST:-bioc-dev.cancerdatasci.org}
PROD_HOST=${PROD_HOST:-bioconductor.org}
DEST=${DEST:-mirror}
URLS=${URLS:-$DEST.urls}
RATE=${RATE:-2M}          # curl --limit-rate syntax (K/M/G), not wget's
WAIT=${WAIT:-0.5}
TIMEOUT=${TIMEOUT:-30}
# Above this, don't trust the byte count enough to hash -- see the media
# comment above. 5 MB comfortably covers every real HTML page (measured
# whole-site HTML is 2 MB across 65 pages) with headroom for CSS/JS/images.
MAX_HASH_BYTES=${MAX_HASH_BYTES:-5000000}
# Known, permanent, by-design divergence: crawl.sh overwrites the mirror's
# robots.txt with `Disallow: /` so the prototype host is never indexed (see
# MIGRATION.md "The mirror must not be indexed"). Diffing it would fail the
# gate forever for a reason that has nothing to do with cutover readiness.
EXCLUDE_REGEX=${EXCLUDE_REGEX:-'^/robots\.txt$'}
# See MIGRATION.md "Absolute URLs": course-materials pages carry a handful of
# hand-written bioconductor.org links, stored byte-identical on both origins
# today (no --convert-links), so they don't currently cause diffs. The knob
# exists for later, if/when the Worker starts rewriting them at request time
# via HTMLRewriter -- turn this on then, not before. Off by default and not
# silent about it: normalizing away every hostname mention by default would
# also swallow a genuinely wrong absolute link, which is exactly the kind of
# bug this gate exists to catch.
NORMALIZE_HOST=${NORMALIZE_HOST:-0}
# Attributable on purpose: this hits production bioconductor.org repeatedly,
# and whoever reads those logs should be able to tell what it is and who to
# ask. No +URL -- the repo is private, so a link there is a dead end, and
# pointing at the Bioconductor org would imply a sanction this does not have.
UA=${UA:-"bioc-r2-migration/0.1 cutover-diff (seandavi@gmail.com)"}
OUTDIR=${OUTDIR:-cutover-diff-$(date +%Y%m%dT%H%M%S)}

# The gate tests **behavioural equality, not byte identity**. Where this
# project has deliberately chosen a more correct answer than production, the
# gate must not report it forever as a failure -- a check that always fails is
# a check nobody reads. What it must still catch is a regression: us being
# *worse* than production, or genuinely serving the wrong thing.
#
# norm_ctype: drop parameters (charset etc.) and case, then fold documented
# aliases onto one spelling. Confirmed live: the Worker sends
# "text/html; charset=utf-8", Apache sends "text/html" -- same content,
# different header. A real content-type bug looks like text/html vs
# application/octet-stream, not a charset param or a legacy alias.
#
# Every pair below is a genuine synonym with a citation, not a convenience.
# Do not extend this table to silence a difference you have not explained.
norm_ctype() {
  local c=${1%%;*}
  c=$(printf '%s' "$c" | tr '[:upper:]' '[:lower:]')
  c="${c#"${c%%[![:space:]]*}"}"
  c="${c%"${c##*[![:space:]]}"}"
  case $c in
    # RFC 6713 registered application/gzip; x-gzip is the pre-registration
    # spelling Apache still emits. R and every browser accept both.
    application/x-gzip|application/gzip)          c=application/gzip ;;
    # RFC 9239 made text/javascript the standard; application/javascript and
    # the x- form are both legacy.
    application/javascript|application/x-javascript|text/javascript)
                                                  c=text/javascript ;;
    # RFC 9512 registered application/yaml.
    application/x-yaml|text/yaml|text/x-yaml|application/yaml)
                                                  c=application/yaml ;;
    # RFC 2361 / IANA: vnd.microsoft.icon is registered, x-icon is the
    # de facto spelling almost everything sends.
    image/x-icon|image/vnd.microsoft.icon)        c=image/x-icon ;;
    application/x-tar|application/tar)            c=application/x-tar ;;
  esac
  printf '%s' "$c"
}

# ctype_ok: is the pair acceptable, given that we may legitimately be better?
#
# Asymmetric on purpose. Production sends *no* Content-Type at all for
# /bioc-version, /bioc-devel-version and /config.yaml; we send correct ones.
# That is an improvement, and forcing byte-identity there would mean
# reproducing a bug to pass our own gate.
#
# The reverse is not acceptable: if we send nothing where production sends a
# type, we have regressed and the gate must say so.
ctype_ok() {
  local dev prod
  dev=$(norm_ctype "$1"); prod=$(norm_ctype "$2")
  [[ $dev == "$prod" ]] && return 0
  # We supply a type where production supplies none: better, not different.
  [[ $prod == none && $dev != none ]] && return 0
  return 1
}

# classify_pair: pure, no I/O -- given what was observed on both origins for
# one URL, name the failure kind (or "ok"). Split out so test-cutover-diff.sh
# can pin it against fixtures with no network. Four buckets, matching issue
# #7 / MIGRATION.md Cutover step 3 verbatim: status mismatch, hash mismatch,
# content-type mismatch, missing on one side. size_skipped and the
# transport-error case are additions this script needs to stay honest, not
# extra scope -- see the comments below each.
classify_pair() {
  local dev_status=$1 prod_status=$2 dev_ctype=$3 prod_ctype=$4
  local dev_hashed=$5 prod_hashed=$6 dev_digest=$7 prod_digest=$8

  # A transport-level failure (DNS/connect/timeout, see fetch_side) is never
  # "ok", even if both sides failed with the same curl exit code -- that
  # would silently pass a total outage on one side as a match.
  if [[ $dev_status == ERR* || $prod_status == ERR* ]]; then
    echo status_mismatch; return
  fi

  if [[ $dev_status != "$prod_status" ]]; then
    if [[ ( $dev_status == 404 && $prod_status == 2* ) || \
          ( $prod_status == 404 && $dev_status == 2* ) ]]; then
      echo missing; return
    fi
    echo status_mismatch; return
  fi

  # Equal status but not success: both redirecting or both erroring the same
  # way is as far as this gate goes. Comparing 3xx targets is separate,
  # not-yet-built work -- see MIGRATION.md "Redirects -- unresolved", which
  # says outright that today's mirror flattens redirects into 200s and *will*
  # fail this gate until the canonical-URL pass lands. That failure is
  # correct, not a bug in this script.
  [[ $dev_status == 2* ]] || { echo ok; return; }

  ctype_ok "$dev_ctype" "$prod_ctype" ||
    { echo content_type_mismatch; return; }

  if [[ $dev_hashed == 1 && $prod_hashed == 1 ]]; then
    [[ $dev_digest == "$prod_digest" ]] && echo ok || echo hash_mismatch
  elif [[ $dev_hashed == 0 && $prod_hashed == 0 ]]; then
    echo size_skipped
  else
    # One side hashed, the other didn't. Asymmetric size on the same URL is
    # itself suspicious, so treat it as a mismatch rather than passing it.
    echo hash_mismatch
  fi
}

# maybe_normalize: in place, only when NORMALIZE_HOST=1 and only on text-ish
# bodies -- substituting bytes inside an image or tarball would just corrupt
# the hash rather than compare it. See the NORMALIZE_HOST comment up top.
maybe_normalize() {
  local file=$1 ctype=$2
  [[ $NORMALIZE_HOST == 1 ]] || return 0
  case "$(norm_ctype "$ctype")" in
    text/html|text/css|text/plain|text/xml|text/javascript| \
      application/javascript|application/json|application/xml) ;;
    *) return 0 ;;
  esac
  sed -i -E "s#https?://(www\.)?(${DEV_HOST//./\\.}|${PROD_HOST//./\\.})#//__HOST__#g" "$file"
}

# fetch_side: GET one host, print "status<TAB>content-type<TAB>hashed<TAB>digest".
# throttle=1 rate-limits and is the only leg allowed to touch production.
fetch_side() {
  local host=$1 path=$2 throttle=$3
  local hdr body status ctype hashed=0 digest=NONE curl_rc len
  hdr=$(mktemp) body=$(mktemp)

  # Plain -s, not -sS: the report already renders every failure as ERR<rc> in
  # the tables below, and -S would print "Failure writing output to
  # destination" on stderr for every routine size_skipped media file, since
  # that message IS what head -c closing the pipe early looks like to curl.
  local opts=(-s -D "$hdr" --max-time "$TIMEOUT" -A "$UA" --retry 2 --retry-delay 1)
  [[ $throttle == 1 ]] && opts+=(--limit-rate "$RATE")

  # `head -c N+1` is the actual cap -- see the media comment up top for why
  # curl's own --max-filesize doesn't do this on the dev host. +1 so that a
  # body of exactly MAX_HASH_BYTES is distinguishable from one that got cut.
  curl "${opts[@]}" "https://$host$path" | head -c "$((MAX_HASH_BYTES + 1))" > "$body" || true
  curl_rc=${PIPESTATUS[0]}

  status=$(awk 'NR==1{print $2}' "$hdr")
  ctype=$(awk -F': ' 'tolower($1)=="content-type"{sub(/\r$/,"",$2); print $2}' "$hdr" | tail -1)
  len=$(wc -c < "$body")

  if (( len > MAX_HASH_BYTES )); then
    digest="SKIPPED>${MAX_HASH_BYTES}B"
  elif (( curl_rc == 0 )); then
    maybe_normalize "$body" "$ctype"
    hashed=1
    digest=$(sha256sum "$body" | cut -d' ' -f1)
  else
    # Not truncation (len is under the cap) and curl still failed: a real
    # transport error, not our own head -c pipe closing early.
    status="ERR$curl_rc"
  fi

  rm -f "$hdr" "$body"
  # Never emit an empty field. Tab counts as IFS *whitespace*, so bash `read`
  # collapses a doubled tab into one delimiter and every later field shifts
  # left -- an absent Content-Type silently turned `hashed` into the ctype and
  # produced nonsense mismatches like `prod=1`. Production genuinely sends no
  # Content-Type for /bioc-version, /bioc-devel-version and /config.yaml, so
  # this is the normal case, not an edge case. NONE also makes "neither side
  # sent one" compare equal, while "one side did" stays a real mismatch.
  printf '%s\t%s\t%s\t%s\n' "${status:-ERR_NO_RESPONSE}" "${ctype:-NONE}" "$hashed" "$digest"
}

main() {
  [[ -s $URLS ]] ||
    { echo "no $URLS -- run ./crawl.sh site first, or point URLS= at a crawl's .urls file" >&2; exit 1; }
  mkdir -p "$OUTDIR"

  local total=0 excluded=0
  declare -A counts=(
    [status_mismatch]=0 [content_type_mismatch]=0 [hash_mismatch]=0
    [missing]=0 [size_skipped]=0 [ok]=0
  )

  while IFS= read -r url; do
    [[ -n $url ]] || continue
    local path
    path=$(printf '%s' "$url" | sed -E 's#^https?://[^/]+##')
    [[ -n $path ]] || path=/
    ((++total))

    if [[ $path =~ $EXCLUDE_REGEX ]]; then
      ((++excluded))
      printf '%s\n' "$path" >> "$OUTDIR/excluded.tsv"
      continue
    fi

    local dline pline dstatus dctype dhashed ddigest pstatus pctype phashed pdigest
    dline=$(fetch_side "$DEV_HOST" "$path" 0)
    IFS=$'\t' read -r dstatus dctype dhashed ddigest <<<"$dline"

    sleep "$WAIT"
    pline=$(fetch_side "$PROD_HOST" "$path" 1)
    IFS=$'\t' read -r pstatus pctype phashed pdigest <<<"$pline"

    local cat
    cat=$(classify_pair "$dstatus" "$pstatus" "$dctype" "$pctype" \
                         "$dhashed" "$phashed" "$ddigest" "$pdigest")
    counts[$cat]=$(( ${counts[$cat]:-0} + 1 ))

    case "$cat" in
      status_mismatch)
        printf '%s\tdev=%s\tprod=%s\n' "$path" "$dstatus" "$pstatus" >> "$OUTDIR/status_mismatch.tsv" ;;
      content_type_mismatch)
        printf '%s\tdev=%s\tprod=%s\n' "$path" "$dctype" "$pctype" >> "$OUTDIR/content_type_mismatch.tsv" ;;
      hash_mismatch)
        printf '%s\tdev=%s(hashed=%s)\tprod=%s(hashed=%s)\n' \
          "$path" "$ddigest" "$dhashed" "$pdigest" "$phashed" >> "$OUTDIR/hash_mismatch.tsv" ;;
      missing)
        printf '%s\tdev=%s\tprod=%s\n' "$path" "$dstatus" "$pstatus" >> "$OUTDIR/missing.tsv" ;;
      size_skipped)
        printf '%s\tover MAX_HASH_BYTES=%s, compared status+content-type only\n' \
          "$path" "$MAX_HASH_BYTES" >> "$OUTDIR/size_skipped.tsv" ;;
    esac

    (( total % 50 == 0 )) && echo "…$total urls checked" >&2
  done < "$URLS"

  echo "checked $total urls ($excluded excluded, results in $OUTDIR/)"
  local fail=$(( counts[status_mismatch] + counts[content_type_mismatch] + \
                  counts[hash_mismatch] + counts[missing] ))
  echo "  ok:                   ${counts[ok]}"
  echo "  size_skipped (info):  ${counts[size_skipped]}  -- not hashed, status+content-type only"
  echo "  status_mismatch:      ${counts[status_mismatch]}"
  echo "  content_type_mismatch: ${counts[content_type_mismatch]}"
  echo "  hash_mismatch:        ${counts[hash_mismatch]}"
  echo "  missing (one side):   ${counts[missing]}"

  if (( fail > 0 )); then
    echo "FAIL: $fail unexplained diff(s) -- see $OUTDIR/*.tsv" >&2
    return 1
  fi
  echo "gate passed: zero unexplained diffs"
}

# Guarded so test-cutover-diff.sh can `source` this file and call
# classify_pair directly, with no network and no side effects.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
