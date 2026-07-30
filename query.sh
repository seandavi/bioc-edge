#!/usr/bin/env bash
#
# Canned Analytics Engine queries. `./query.sh` for the summary, or
# `./query.sh "SELECT ..."` for an ad-hoc one.
#
# Blob layout, set in worker/src/index.ts: 1=path 2=user-agent 3=country
# 4=asn 5=cache-status 6=ip-range 7=query-string. double1=http status.
#
# blob7 is new in the v3 dataset. Analytics Engine fixes a schema at creation,
# so v1 (5 blobs) and v2 (6 blobs) still exist and stay queryable by name --
# set DATASET to read them. They will not have blob7.
#
# ALWAYS weight by _sample_interval. Analytics Engine samples -- already
# visibly, at trivial volume -- so count() undercounts, and will undercount
# badly at the 500k/day this exists to investigate.
set -euo pipefail
: "${CLOUDFLARE_API_TOKEN:?run: ./make-env.sh && set -a && . ./.env && set +a}"
D=${DATASET:-bioc_site_requests_v3}
SINCE=${SINCE:-"now() - INTERVAL '1' DAY"}

q() {
  curl -sS -X POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/analytics_engine/sql" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" --data "$1" \
    | jq -r '.data[] | to_entries | map("\(.key)=\(.value)") | join("  ")'
}

if [[ $# -gt 0 ]]; then q "$1"; exit 0; fi

echo "== requests by cache status =="
q "SELECT blob5 AS cache, sum(_sample_interval) AS requests FROM $D WHERE timestamp > $SINCE GROUP BY blob5 ORDER BY requests DESC"
echo "== busiest paths =="
q "SELECT blob1 AS path, sum(_sample_interval) AS requests FROM $D WHERE timestamp > $SINCE GROUP BY blob1 ORDER BY requests DESC LIMIT 15"
echo "== busiest IP ranges (the 'is it one crawler?' question) =="
q "SELECT blob6 AS ip_range, blob4 AS asn, sum(_sample_interval) AS requests FROM $D WHERE timestamp > $SINCE GROUP BY blob6, blob4 ORDER BY requests DESC LIMIT 15"
echo "== busiest user agents =="
q "SELECT blob2 AS user_agent, sum(_sample_interval) AS requests FROM $D WHERE timestamp > $SINCE GROUP BY blob2 ORDER BY requests DESC LIMIT 10"
echo "== UTM sources (blob7, v3+) =="
q "SELECT extract(blob7, 'utm_source=([^&]*)') AS utm_source, sum(_sample_interval) AS requests FROM $D WHERE timestamp > $SINCE AND blob7 LIKE '%utm_source=%' GROUP BY utm_source ORDER BY requests DESC LIMIT 10"
echo "== cache-busting: one path, many distinct query strings =="
# The pattern this field exists to expose. Our cache key ignores the query, so
# these all collapse onto one path and look like ordinary repeat traffic --
# invisible before v3. High distinct-query counts on a single path is either a
# crawler defeating caches or a client appending a nonce.
q "SELECT blob1 AS path, uniq(blob7) AS distinct_queries, sum(_sample_interval) AS requests FROM $D WHERE timestamp > $SINCE AND blob7 != '' GROUP BY blob1 HAVING distinct_queries > 5 ORDER BY distinct_queries DESC LIMIT 10"
echo "== cache hit ratio =="
q "SELECT round(100 * sumIf(_sample_interval, blob5 = 'HIT') / sum(_sample_interval), 1) AS hit_pct FROM $D WHERE timestamp > $SINCE"
