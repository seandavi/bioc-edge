#!/usr/bin/env bash
#
# The query layer over inventory/views.sql, so the answer to "how many
# objects are there" is one query against a view, not a bespoke awk re-
# derived on the spot. See views.sql for what each view means and why.
#
#   ./inventory/db.sh                    reconciliation summary
#   ./inventory/db.sh "SELECT ..."       any view, ad hoc
#   duckdb -init inventory/views.sql     the views, without this wrapper
#
# Nothing here is stored: every view reads a source artifact (an inventory/
# snapshot, the live mirror filesystem, or the published manifest over
# HTTPS) fresh on every query. Wrong number -> check the source artifact or
# re-run inventory/refresh.sh, never patch a view.
#
# INVENTORY_DIR / MIRROR_DIR / MANIFEST_HOST override where views.sql looks;
# see its macros for the defaults.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

if [[ $# -gt 0 ]]; then
  duckdb -init views.sql -c "$1"
  exit 0
fi

echo "== counts by top-level directory (upstream / local / r2) =="
duckdb -init views.sql -c "SELECT * FROM counts_by_top ORDER BY top, source;"

echo "== reconciliation, by top-level directory =="
echo "   (checkResults/ dominating upstream_not_local is expected -- rsync-filter"
echo "    keeps only current release+devel there; see MIGRATION.md 'Upstream shape')"
duckdb -init views.sql -c "SELECT * FROM reconcile_docroot_by_top;"

echo "== R2 objects with no upstream or local counterpart (orphans) =="
duckdb -init views.sql -c "SELECT count(*) AS orphans, sum(r2_size) AS bytes FROM reconcile_r2_orphans;"

echo "== symlinks that do not resolve to anything in R2 =="
duckdb -init views.sql -c "SELECT path, target FROM symlink_resolution WHERE NOT resolves;"

echo "== published manifests: entries not matching R2 =="
duckdb -init views.sql -c "SELECT manifest_path, status, count(*) FROM manifest_consistency WHERE status != 'ok' GROUP BY 1, 2 ORDER BY 1, 2;"
