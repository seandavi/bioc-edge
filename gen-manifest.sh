#!/usr/bin/env bash
#
# Publish the mirror manifest to /api/v1/manifest/.
#
#   ./gen-manifest.sh              generate and upload
#   DRY_RUN=1 ./gen-manifest.sh    write locally, upload nothing
#
# Mirror operators cannot enumerate the bucket: it is private behind the
# Worker, and rclone's :http: backend cannot list a directory when autoindex
# is off. The manifest removes the need to enumerate -- `--files-from` names
# every object -- which is what lets operators sync with no credentials at
# all. See MIRRORS.md for the reasoning and the verified client command.
#
# Generated from R2 rather than from the local mirror, deliberately: the
# manifest must describe what an operator can actually fetch, not what we
# intended to upload. Those agree only after a successful sync, and the gap
# between them is exactly the failure an operator would hit.
#
# Published under /api/v1/ rather than /manifest/ because the format has open
# questions (granularity, hashes) that will change it, operators will script
# against it, and a namespace gives later endpoints somewhere to live.
set -euo pipefail

BUCKET=${BUCKET:-bioc-site}
PREFIX=${PREFIX:-api/v1/manifest}
HOST=${HOST:-bioc-dev.cancerdatasci.org}
ZONE=${ZONE:-cancerdatasci.org}
# Repos a mirror would carry. Keys are bucket paths; the manifest filename
# flattens the slash so data/annotation becomes data-annotation.tsv.gz.
REPOS=${REPOS:-bioc data/annotation data/experiment workflows books}
# Key prefix the version trees live under. Overridable so the generator can be
# exercised against the archive prefix before the docroot is loaded, and so a
# future second bucket for package content does not need a code change.
ROOT=${ROOT:-packages}

: "${CLOUDFLARE_API_TOKEN:?run: ./make-env.sh && set -a && . ./.env && set +a}"

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT

# Which numeric versions release and devel point at. Read from the published
# symlink map, not from a constant -- that map exists so a release roll is
# data rather than a deploy, and hardcoding here would undo it.
links=$work/links.json
if ! rclone cat "r2:$BUCKET/_symlinks.json" > "$links" 2>/dev/null || ! jq -e . "$links" >/dev/null 2>&1; then
  echo "no usable _symlinks.json in the bucket -- run sync.sh or finish-load.sh first" >&2
  exit 1
fi
release=$(jq -r '."packages/release" // empty' "$links")
devel=$(jq -r '."packages/devel" // empty' "$links")
[[ -n $release && -n $devel ]] || {
  echo "symlink map has no packages/release or packages/devel; cannot resolve versions" >&2
  exit 1
}
echo "release=$release devel=$devel"

emitted=()
for version in "$release" "$devel"; do
  for repo in $REPOS; do
    flat=${repo//\//-}
    out=$work/$version-$flat.tsv
    # p=path s=size h=hash. rclone stores md5chksum metadata on multipart
    # uploads, so this is a real MD5 rather than a composite ETag -- verified
    # against the OSN source for a 783 MB object. Not universal though: a
    # small number of objects return an empty or suffixed hash, and those are
    # emitted blank for the consumer to treat as size-checked only.
    # --files-only is load-bearing. Without it rclone emits directory entries
    # with size -1 and no hash, which land in the manifest as objects an
    # operator would then try to fetch. This is the second time the size -1
    # directory row has bitten in this project -- it also inflated the OSN
    # object count by 38,819 before being caught.
    if ! rclone lsf -R --files-only --format "psh" --separator $'\t' --hash md5 \
         "r2:$BUCKET/$ROOT/$version/$repo" 2>/dev/null |
         awk -F'\t' -v pfx="$ROOT/$version/$repo/" 'BEGIN{OFS="\t"}
           { h = ($3 ~ /^[0-9a-f]{32}$/) ? $3 : ""; print pfx $1, $2, h }' > "$out"; then
      echo "  $version/$repo: not present, skipped"
      continue
    fi
    n=$(wc -l < "$out")
    [[ $n -gt 0 ]] || { echo "  $version/$repo: empty, skipped"; continue; }
    nohash=$(awk -F'\t' '$3==""' "$out" | wc -l)
    gzip -9 < "$out" > "$out.gz"
    echo "  $version/$flat: $n objects ($nohash without a usable hash)"
    emitted+=("$version/$flat:$n:$nohash")
    [[ -z ${DRY_RUN:-} ]] &&
      rclone rcat "r2:$BUCKET/$PREFIX/$version/$flat.tsv.gz" < "$out.gz" \
        --header-upload "Content-Type: application/gzip"
  done
done

[[ ${#emitted[@]} -gt 0 ]] || { echo "nothing emitted; refusing to publish an empty index" >&2; exit 1; }

# The index is published last, for the same reason sync.sh publishes the
# symlink map last: an index naming files that are not there yet sends
# operators to 404s.
idx=$work/index.json
jq -n \
  --arg generated "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg release "$release" --arg devel "$devel" \
  --slurpfile links "$links" \
  --arg prefix "/$PREFIX" \
  --args '
  {
    generated: $generated,
    versions: { release: $release, devel: $devel },
    manifest_prefix: $prefix,
    manifests: [ $ARGS.positional[] | split(":") | { path: (.[0] + ".tsv.gz"), objects: (.[1]|tonumber), without_hash: (.[2]|tonumber) } ],
    symlinks: $links[0],
    format: {
      columns: ["path", "size", "md5"],
      separator: "tab",
      notes: "path is relative to the site root, so fetch it directly from this host. An empty md5 means the object has no usable MD5 (a small minority); verify those by size only. Do not pin the numeric version -- read versions.release and versions.devel from this file on every run."
    }
  }' "${emitted[@]}" > "$idx"

jq -e . "$idx" >/dev/null || { echo "generated index is not valid JSON" >&2; exit 1; }

if [[ -z ${DRY_RUN:-} ]]; then
  rclone rcat "r2:$BUCKET/$PREFIX/index.json" < "$idx" \
    --header-upload "Content-Type: application/json"
  echo "published $PREFIX/index.json (${#emitted[@]} manifests)"

  # Purge, or nobody sees any of this. cacheControl() gives every key
  # s-maxage=31536000, so freshness comes from purge-on-publish and never from
  # expiry -- exactly as for content. Skipping it here meant the edge served a
  # 21-hour-old test manifest naming the wrong release, and would have kept
  # doing so for a year. Same failure as the octet-stream that stuck on
  # /packages/plyranges during the POC.
  urls=("https://$HOST/$PREFIX/index.json")
  for e in "${emitted[@]}"; do urls+=("https://$HOST/$PREFIX/${e%%:*}.tsv.gz"); done
  api="https://api.cloudflare.com/client/v4"
  auth=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json")
  zone_id=$(curl -sS "${auth[@]}" "$api/zones?name=$ZONE" | jq -r '.result[0].id // empty')
  if [[ -z $zone_id ]]; then
    echo "WARNING: cannot resolve zone $ZONE -- manifests published but NOT purged." >&2
    echo "         The edge will serve the previous ones until purged by hand." >&2
  else
    # 100 URLs per request is the documented maximum below Enterprise; this
    # is ~11, so a single request.
    for ((i = 0; i < ${#urls[@]}; i += 100)); do
      ok=$(curl -sS -X POST "${auth[@]}" \
        --data "$(jq -nc --args '{files: $ARGS.positional}' "${urls[@]:i:100}")" \
        "$api/zones/$zone_id/purge_cache" | jq -r '.success')
      [[ $ok == true ]] || { echo "purge failed for batch $i" >&2; exit 1; }
    done
    echo "purged ${#urls[@]} manifest urls"
  fi
else
  echo "--- DRY_RUN, index.json would be:"; jq '{generated, versions, manifests}' "$idx"
fi
