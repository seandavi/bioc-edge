# Security

**In this repository** (the Worker, the sync scripts, the manifest API): report
vulnerabilities privately to Sean Davis (<seandavi@gmail.com>). You should hear
back within a few days; please allow a fix before public disclosure.

**In upstream bioconductor.org infrastructure**: this project measures the live
estate and occasionally finds issues that belong to the Bioconductor team, not
to this repo. Those follow the same route — email the maintainer privately, who
coordinates disclosure with the Bioconductor core team. Do not open a public
issue for them.

No credentials live in this repository or its history; `./make-env.sh` pulls
them from Secret Manager into a gitignored `.env`.
