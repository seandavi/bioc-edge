#!/usr/bin/env bash
#
# OnFailure hook for bioc-sync.service / bioc-reconcile.service. Files or
# updates a GitHub issue with the full journal for the failed run plus
# whatever sync.sh log files it left on disk.
#
#   ./notify-failure.sh bioc-sync.service
#
# One issue per unit, reused across repeat failures (comment, not a new
# issue each time, and at most one comment per NOTIFY_QUIET_HOURS, default 6)
# so a flaky patch doesn't flood the tracker. Body is not
# trimmed for brevity -- this box has one operator and the log is the
# point -- only capped against GitHub's ~65KB body limit.
set -euo pipefail

UNIT=$1
cd "$(dirname "$0")"

title="$UNIT is failing"
status=$(systemctl --user status "$UNIT" --no-pager -l 2>&1 || true)
inv=$(systemctl --user show -p InvocationID --value "$UNIT" 2>&1 || true)
# Child-process output (sync.sh's own echoed lines) is tagged
# _SYSTEMD_INVOCATION_ID; systemd's own bookkeeping lines (Starting/Failed/
# Finished) are tagged USER_INVOCATION_ID instead. Need both, ORed with `+`.
journal=$(journalctl --user "_SYSTEMD_INVOCATION_ID=$inv" + "USER_INVOCATION_ID=$inv" --no-pager 2>&1 || echo "(could not read journal for invocation $inv)")

# sync.sh timestamps its own log/log.err/log.rclone/log.missing/log.differ.
# Conflicts= on both services guarantees only one run's files are the
# newest, so the 5 most recently modified are this run's.
logdump=""
for f in $(ls -t sync-*.log sync-*.log.err sync-*.log.rclone sync-*.log.missing sync-*.log.differ 2>/dev/null | head -5); do
  logdump+=$'\n\n--- '"$f"$' ---\n'"$(cat "$f")"
done

body="Automated failure report from systemd --user, $(date -u +%Y-%m-%dT%H:%M:%SZ).

## systemctl status
\`\`\`
$status
\`\`\`

## journal for this run (InvocationID=$inv)
\`\`\`
$journal
\`\`\`

## on-disk logs from this run$logdump"

# Hard cap, not a courtesy trim: GitHub rejects bodies over 65536 chars outright.
body=${body:0:60000}

existing=$(gh issue list --state open --search "\"$title\" in:title" --json number,title \
  --jq "[.[] | select(.title == \"$title\")][0].number" 2>/dev/null || true)

# A unit on a short timer (bioc-site-refresh runs every 20 min) can fail ~70
# times a day. Comment at most once per NOTIFY_QUIET_HOURS on the open issue;
# the journal keeps every run in between.
quiet_h=${NOTIFY_QUIET_HOURS:-6}
if [[ -n $existing ]]; then
  last=$(gh issue view "$existing" --json createdAt,comments \
    --jq '([.createdAt] + [.comments[].createdAt]) | max' 2>/dev/null || true)
  if [[ -n $last ]] && (( $(date -u +%s) - $(date -u -d "$last" +%s) < quiet_h * 3600 )); then
    echo "notify-failure: #$existing updated at $last, within ${quiet_h}h; not commenting" >&2
    exit 0
  fi
  gh issue comment "$existing" --body "$body"
else
  gh issue create --title "$title" --body "$body" --label bug
fi
