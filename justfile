# Entry points for the bioconductor.org rebuild.
#
# Two halves, one seam:
#   ./bioc.py <cmd>   pipeline -- fetches from primary sources into astro/data/
#   astro             renderer -- turns astro/data/ into a static site
#
# The recipes here are only shortcuts. Anything with real logic lives in
# pipeline/ (Python) or astro/src/ (Astro), never in this file.

set positional-arguments

releases := "3.23,3.24"
port     := "4321"

# List the recipes.
default:
    @just --list

# --- data -------------------------------------------------------------------

# Fetch everything from primary sources: site repo, assets, prose, packages, tree.
data releases=releases:
    ./bioc.py all --bioc {{releases}}

# Clone or update Bioconductor/bioconductor.org into .cache/.
fetch-site:
    ./bioc.py fetch-site

# Prose pages from the site's git repo -> astro/data/site/.
data-content:
    ./bioc.py content

# Static assets from the site's git repo -> astro/public/.
data-assets:
    ./bioc.py assets

# packages.json for one release, from r-universe + tarball DESCRIPTION.
data-packages bioc="3.23":
    ./bioc.py packages --bioc {{bioc}}

# tree.json for one release, from the biocViews vocabulary.
data-tree bioc="3.23":
    ./bioc.py tree --bioc {{bioc}}

# --- site -------------------------------------------------------------------

# Dev server, bound to all interfaces so it is reachable over the tailnet.
dev:
    cd astro && npm run dev

# Full static build -> astro/dist/.
build:
    cd astro && npm run build

# Serve the built dist/.
preview:
    cd astro && npm run preview

# Install Astro's dependencies.
install:
    cd astro && npm install

# --- checks -----------------------------------------------------------------

# How much of the real site does the build reproduce?
coverage:
    ./bioc.py coverage

# Diff the built site against bioconductor.org before any cutover.
cutover-diff:
    ./cutover-diff.sh

# --- deploy -----------------------------------------------------------------

# Push astro/dist to R2 and purge what changed. DRY_RUN=1 to rehearse.
sync:
    ./sync.sh

# Deploy the Worker.
deploy-worker:
    cd worker && npx wrangler deploy
