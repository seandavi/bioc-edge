#!/usr/bin/env bash
#
# The only non-obvious logic in sync.sh: turning `rsync --out-format` into the
# set of R2 keys to upload and delete. Everything else is rclone and curl.
# Runs against a local rsync, no network.
#
#   ./test-itemize.sh
set -euo pipefail

t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
src=$t/src dst=$t/dst log=$t/log
mkdir -p "$src/sub" "$dst"

pull() {
  rsync -a --delete --out-format='%i|%n' "$src/" "$dst/" > "$log"
  awk -F'|' '$1 ~ /^>f/         {print $2}' "$log" | sort > "$t/up"
  awk -F'|' '$1 ~ /^\*deleting/ && $2 !~ /\/$/ {print $2}' "$log" | sort > "$t/gone"
}
expect() { # expect <label> <up|gone> <expected lines...>
  local label=$1 which=$2; shift 2
  local want; want=$(printf '%s\n' "$@" | sed '/^$/d' | sort)
  local got; got=$(cat "$t/$which")
  [[ $want == "$got" ]] ||
    { echo "FAIL $label ($which)"; diff <(echo "$want") <(echo "$got"); exit 1; }
}

# 1. First pull: every file is new.
echo hello > "$src/a.txt"
echo world > "$src/sub/b.txt"
ln -s a.txt "$src/link"
pull
expect "initial" up a.txt sub/b.txt
expect "initial" gone
# A symlink is `cL`, not `>f`, so it never reaches the upload list -- R2 has no
# symlinks and the Worker resolves them.
[[ -L $dst/link ]] || { echo "FAIL symlink not mirrored locally"; exit 1; }

# 2. Content change only.
echo changed > "$src/a.txt"
pull
expect "content change" up a.txt
expect "content change" gone

# 3. The one that bites: rsync's quick check is size+mtime, so touching a file
#    without changing a byte still itemizes `>f..t......` and enters the
#    candidate list. This is why sync.sh runs `rclone copy --checksum` over the
#    candidates instead of uploading them -- and why the purge list comes from
#    rclone's log, not from this list. Assert the superset, so nobody "fixes"
#    the checksum pass away later.
touch -d '2020-01-01' "$src/a.txt"
pull
expect "mtime-only is a candidate, not a change" up a.txt
grep -q '^>f..t' "$log" || { echo "FAIL expected >f..t itemize"; exit 1; }

# 4. Attribute-only really is `.f`, and stays out of the candidate list.
chmod 600 "$src/a.txt"
pull
expect "perms only" up
expect "perms only" gone

# 5. Deletion of a file, and of a whole directory. The directory itself carries
#    a trailing slash and must not become a delete key.
rm "$src/a.txt"
rm -r "$src/sub"
pull
expect "deletion" up
expect "deletion" gone a.txt sub/b.txt

# 6. Nothing changed: both lists empty. This is the hourly steady state, and
#    the case where sync.sh must not purge anything.
pull
expect "no-op" up
expect "no-op" gone

echo "ok"
