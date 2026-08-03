#!/usr/bin/env bash
# Compare a package's artifacts between bioconductor.org and r-universe.
#
#   ./compare-artifacts.sh GEOquery 3.23
#   ./compare-artifacts.sh limma 3.24
#
# Answers two questions the file sizes alone cannot: are the artifacts
# byte-identical, and if not, is the difference confined to build products
# (compiled objects, lazy-load databases, DESCRIPTION stamps) or does the
# package content itself differ?
set -uo pipefail

PKG="${1:?usage: compare-artifacts.sh <package> <bioc-version>}"
VER="${2:?usage: compare-artifacts.sh <package> <bioc-version>}"
UA='Mozilla/5.0 bioc-cloudflare'
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

# release maps to bioc-release.r-universe.dev, devel to bioc.r-universe.dev
REL=$(curl -sS --max-time 60 https://bioconductor.org/config.yaml | sed -n 's/^release_version: *"\(.*\)"/\1/p')
UNIVERSE=$([ "$VER" = "$REL" ] && echo bioc-release || echo bioc)

meta="$WORK/meta.json"
curl -sS -A "$UA" --max-time 120 "https://$UNIVERSE.r-universe.dev/api/packages/$PKG" -o "$meta" || exit 1
PV=$(python3 -c "import json;print(json.load(open('$meta'))['Version'])")
echo "== $PKG $PV   bioc $VER  vs  $UNIVERSE.r-universe.dev =="

# Which artifacts to compare: source, plus the R-4.6 windows/mac binaries.
python3 - "$meta" > "$WORK/urls" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))
print(f"src {p['_fileid']}")
# Packages with compiled code get one binary per architecture; pure-R packages
# get one per OS with arch=None, while Bioconductor still ships a separate
# tarball per Mac architecture. So an arch-less binary matches every variant.
want = {('win', 'x86_64'): ['win'], ('mac', 'x86_64'): ['mac_x86'],
        ('mac', 'aarch64'): ['mac_arm'],
        ('win', None): ['win'], ('mac', None): ['mac_x86', 'mac_arm']}
for b in p.get('_binaries') or []:
    tags = want.get((b.get('os'), b.get('arch')), [])
    if tags and str(b.get('r', '')).startswith('4.6'):
        for t in tags:
            print(f"{t} {b['fileid']}")
PY

B="https://bioconductor.org/packages/$VER/bioc"
declare -A BPATH=(
  [src]="src/contrib/${PKG}_${PV}.tar.gz"
  [win]="bin/windows/contrib/4.6/${PKG}_${PV}.zip"
  [mac_x86]="bin/macosx/big-sur-x86_64/contrib/4.6/${PKG}_${PV}.tgz"
  [mac_arm]="bin/macosx/sonoma-arm64/contrib/4.6/${PKG}_${PV}.tgz"
)

sums() {  # extract an archive and hash every file inside it
  local f=$1 d=$2; mkdir -p "$d"
  case "$f" in *.zip|*win*) unzip -qq "$f" -d "$d" 2>/dev/null;; *) tar xzf "$f" -C "$d" 2>/dev/null;; esac
  ( cd "$d" && find . -type f | sort | xargs sha256sum 2>/dev/null )
}

while read -r tag url; do
  bp="${BPATH[$tag]:-}"; [ -z "$bp" ] && continue
  bf="$WORK/b_$tag"; rf="$WORK/r_$tag"
  code=$(curl -sS --max-time 300 -o "$bf" -w '%{http_code}' "$B/$bp")
  [ "$code" != "200" ] && { printf '  %-8s bioc: HTTP %s (%s) — skipped\n' "$tag" "$code" "$bp"; continue; }
  curl -sS -A "$UA" -L --max-time 300 -o "$rf" "$url"

  bs=$(stat -c%s "$bf"); rs=$(stat -c%s "$rf")
  if [ "$(sha256sum <"$bf" | cut -d' ' -f1)" = "$(sha256sum <"$rf" | cut -d' ' -f1)" ]; then
    printf '  %-8s bioc=%-9s runi=%-9s IDENTICAL\n' "$tag" "$bs" "$rs"; continue
  fi

  sums "$bf" "$WORK/xb_$tag" > "$WORK/sb_$tag"
  sums "$rf" "$WORK/xr_$tag" > "$WORK/sr_$tag"
  join -j 2 <(sort -k2 "$WORK/sb_$tag") <(sort -k2 "$WORK/sr_$tag") -o 0,1.1,2.1 > "$WORK/j_$tag" 2>/dev/null
  common=$(wc -l < "$WORK/j_$tag"); ident=$(awk '$2==$3' "$WORK/j_$tag" | wc -l)
  # Content = everything except build products; this is the number that matters.
  csame=$(awk '$1 ~ /\/(R|man|src|inst)\// && $2==$3' "$WORK/j_$tag" | wc -l)
  ctot=$(awk '$1 ~ /\/(R|man|src|inst)\//' "$WORK/j_$tag" | wc -l)
  printf '  %-8s bioc=%-9s runi=%-9s differ | common=%s identical=%s | content %s/%s\n' \
    "$tag" "$bs" "$rs" "$common" "$ident" "$csame" "$ctot"
  awk '$2!=$3 {print "             ~ "$1}' "$WORK/j_$tag" | head -6
done < "$WORK/urls"
