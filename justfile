# Entry points for the serving side of bioconductor.org: the mirror, the
# Worker, and the R2 bucket behind them.
#
# The site *build* lives in the bioconductor-website repo, and its
# documentation in bioconductor-infrastructure. Neither is here any more.

set positional-arguments

# List the recipes.
default:
    @just --list

# Pull from upstream and push what changed to R2. DRY_RUN=1 to rehearse.
sync:
    ./sync.sh

# Diff what R2 serves against bioconductor.org before any cutover.
cutover-diff:
    ./cutover-diff.sh

# Deploy the Worker.
deploy-worker:
    cd worker && npx wrangler deploy

# Refresh the upstream/OSN/R2 inventory snapshots.
inventory:
    ./inventory/refresh.sh
