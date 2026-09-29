#!/usr/bin/env bash
# Pins routed() and overlay() in gen-manifest.sh. No network, no credentials.
#   ./test-gen-manifest.sh
set -euo pipefail
source "$(dirname "$(readlink -f "$0")")/gen-manifest.sh"
fail=0
check() { local label=$1 expect=$2; shift 2; local got; got=$("$@") || true
  [[ $got == "$expect" ]] || { echo "FAIL $label: expected [$expect], got [$got]"; fail=1; }; }
yes_no() { if "$@"; then echo yes; else echo no; fi; }

check "root route covers packages"   yes yes_no routed packages/3.23/bioc /
check "packages route covers repo"   yes yes_no routed packages/3.23/bioc /help/ /packages/
check "unrelated route doesn't"      no  yes_no routed packages/3.23/bioc /help/ /about/
check "prefix must match at a /"     no  yes_no routed packages/3.23/bioc /packages/3.2/

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
printf 'p/html/a.html\t10\tmirrorA\np/src/contrib/a_1.0.tar.gz\t99\ttar\np/html/old.html\t5\tmirrorOld\n' > "$T/m"
printf 'p/html/a.html\t12\tbuildA\np/html/new.html\t7\tbuildNew\n' > "$T/b"
check "build wins, build-only added, mirror-only kept" \
  "$(printf 'p/html/a.html\t12\tbuildA\np/html/new.html\t7\tbuildNew\np/html/old.html\t5\tmirrorOld\np/src/contrib/a_1.0.tar.gz\t99\ttar')" \
  overlay "$T/m" "$T/b"
: > "$T/empty"
check "no build objects: mirror unchanged" "$(LC_ALL=C sort "$T/m")" overlay "$T/m" "$T/empty"
[[ $fail == 0 ]] && echo "gen-manifest: all checks pass"
exit $fail
