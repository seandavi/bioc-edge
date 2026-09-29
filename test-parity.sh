#!/usr/bin/env bash
# Pins compare() and known_reason() in parity.sh. No network.
#   ./test-parity.sh
set -euo pipefail
source "$(dirname "$(readlink -f "$0")")/parity.sh"
fail=0
check() { local label=$1 expect=$2; shift 2; local got; got=$("$@")
  [[ $got == "$expect" ]] || { echo "FAIL $label: expected [$expect], got [$got]"; fail=1; }; }

check "same 200 html"            same compare 200 "" text 200 "" text
check "status differs"           diff compare 404 "" text 200 "" text
check "master sent no ctype"     same compare 200 "" application 200 "" ""
check "ctype major differs"      diff compare 200 "" application 200 "" text
check "ctype ignored on 404"     same compare 404 "" text 404 "" application
check "same target, other host" same compare 302 "https://bioconductor.org/x/" "" 302 "https://master.bioconductor.org/x/" ""
check "301 vs 302 same target"   diff compare 301 "https://storage.googleapis.com/a" "" 302 "https://storage.googleapis.com/a" ""
check "different target"         diff compare 302 "/about/removed-packages/" "" 302 "/packages/release/BiocViews.html" ""

check "empty location keeps its slot" $'200\n\ntext' split_probe "200||text"

KNOWN=$(mktemp); trap 'rm -f "$KNOWN"' EXIT
printf '# comment\n/checkResults/.*/raw-results/?$\tbioc-edge#43\n^/packages/$\tbioc-edge#45\n' > "$KNOWN"
check "known: raw-results dir"   "bioc-edge#43" known_reason /checkResults/3.23/bioc-LATEST/limma/raw-results/
check "known: no slash too"      "bioc-edge#43" known_reason /checkResults/3.23/bioc-LATEST/limma/raw-results
check "not known: file inside"   "" known_reason /checkResults/3.23/bioc-LATEST/limma/raw-results/nebbiolo1/x.dcf
check "known: anchored"          "bioc-edge#45" known_reason /packages/
check "not known: comment line"  "" known_reason "# comment"
[[ $fail == 0 ]] && echo "parity: all checks pass"
exit $fail
