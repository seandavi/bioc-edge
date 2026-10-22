# Entry points for bioc-edge. The recipes are only shortcuts; the logic lives
# in the scripts they call. sync.sh is not here: it runs from systemd
# (systemd/bioc-sync.service) and touches production R2.

# List the recipes.
default:
    @just --list

# Everything CI runs (.github/workflows/test.yml).
test:
    cd worker && npm run typecheck
    node --test worker/test.ts
    node --test worker/test-release-roll.ts
    ./test-itemize.sh
    ./test-cf-purge.sh
    ./test-parity.sh
    ./test-cutover-diff.sh
    ./test-gen-manifest.sh
    for f in *.sh inventory/*.sh; do bash -n "$f"; done

# Regenerate worker/src/redirects.json from a captured legacy .htaccess.
redirects htaccess="inventory/htaccess-20260730.conf":
    node worker/gen-redirects.ts {{htaccess}} > worker/src/redirects.json

# Deploy the Worker.
deploy-worker:
    cd worker && npx wrangler deploy

# Does bioconductor.org answer like master.bioconductor.org?
parity:
    ./parity.sh

# Diff bioc-dev against bioconductor.org for every crawled URL.
cutover-diff:
    ./cutover-diff.sh

# Publish the mirror manifest. DRY_RUN=1 to write locally only.
gen-manifest:
    ./gen-manifest.sh
