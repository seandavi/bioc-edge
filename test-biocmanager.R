#!/usr/bin/env Rscript
#
# Does BiocManager::install() work against the R2/Worker mirror?
#
#   ./test-biocmanager.R                        # bioc-dev, current release
#   MIRROR=https://bioconductor.org ./test-biocmanager.R   # control
#   BIOC_VERSION=2.14 ./test-biocmanager.R      # an archived release
#
# This is the acceptance test that matters, because it is the path that fails
# *quietly*. Every browse URL can work while install.packages() is broken: the
# contrib/ symlink aliases, the PACKAGES metadata files, and the tarballs are
# all things a human clicking around never touches.
#
# Layered on purpose. A bare install.packages() failure tells you nothing about
# which layer broke -- metadata, transport, or the repository layout. Each check
# below names the artifact it needs and what breaks without it, so a run against
# a partially-synced mirror is a to-do list rather than a red cross.
#
# Exit 0 only if every non-skipped check passes.

mirror  <- Sys.getenv("MIRROR", "https://bioc-dev.cancerdatasci.org")
version <- Sys.getenv("BIOC_VERSION", "")
timeout <- as.integer(Sys.getenv("TIMEOUT", "60"))
options(timeout = timeout, BioC_mirror = mirror, repos = c(CRAN = "https://cloud.r-project.org"))

pass <- 0L; fail <- 0L; skip <- 0L
ok   <- function(m) { cat(sprintf("  PASS  %s\n", m)); pass <<- pass + 1L }
bad  <- function(m, why) { cat(sprintf("  FAIL  %s\n        %s\n", m, why)); fail <<- fail + 1L }
note <- function(m, why) { cat(sprintf("  SKIP  %s\n        %s\n", m, why)); skip <<- skip + 1L }

# HEAD would be cheaper, but R's download machinery uses GET and we are testing
# what R actually does, not what a curl probe does.
fetchable <- function(url) {
  tryCatch({
    con <- url(url, "rb"); on.exit(close(con))
    length(readBin(con, "raw", 1L)) == 1L
  }, error = function(e) FALSE, warning = function(w) FALSE)
}

if (!nzchar(version)) {
  version <- tryCatch(as.character(BiocManager::version()), error = function(e) "3.23")
}
repo <- sprintf("%s/packages/%s/bioc", mirror, version)
cat(sprintf("mirror  %s\nversion %s\nrepo    %s\n\n", mirror, version, repo))

# --- 1. config.yaml ----------------------------------------------------------
# BiocManager reads this to map R version -> Bioconductor version. Without it
# BiocManager::version() cannot validate, and install() warns or refuses even
# though every package URL below might be perfectly fine.
if (fetchable(paste0(mirror, "/config.yaml"))) ok("config.yaml reachable") else
  bad("config.yaml reachable",
      "BiocManager maps R version -> Bioc version with this; install() complains without it")

# --- 2. release/devel aliases ------------------------------------------------
# packages/release is a symlink on disk and does not exist as an R2 key. The
# Worker resolves it from _symlinks.json. Nothing a browser does exercises this,
# but anyone following documentation that says "packages/release" hits it.
for (alias in c("release", "devel")) {
  u <- sprintf("%s/packages/%s/bioc/src/contrib/PACKAGES.gz", mirror, alias)
  if (fetchable(u)) ok(sprintf("packages/%s alias resolves", alias)) else
    bad(sprintf("packages/%s alias resolves", alias),
        "symlink map missing or unpublished -- see _symlinks.json and finish-load.sh")
}

# --- 3. PACKAGES metadata ----------------------------------------------------
meta <- sprintf("%s/src/contrib/PACKAGES.gz", repo)
if (!fetchable(meta)) {
  bad("PACKAGES.gz reachable", sprintf("%s -- nothing downstream can work", meta))
} else {
  ok("PACKAGES.gz reachable")

  # --- 4. R can parse it ---------------------------------------------------
  # Reachable is not the same as usable: a wrong Content-Type or a truncated
  # gzip both return 200 and then fail here.
  ap <- tryCatch(available.packages(repos = repo, type = "source"),
                 error = function(e) e)
  if (inherits(ap, "error") || nrow(ap) == 0L) {
    bad("available.packages() parses", if (inherits(ap, "error")) conditionMessage(ap) else "zero rows")
  } else {
    ok(sprintf("available.packages() parses (%d packages)", nrow(ap)))

    # --- 5. a tarball actually downloads ----------------------------------
    # The transport test. Prefer a package with no Depends/Imports: the install
    # check below would otherwise resolve dependencies against CRAN, which
    # tests CRAN rather than this mirror. Falls back to the first package if
    # every one has dependencies.
    deps <- paste(ap[, "Depends"], ap[, "Imports"], ap[, "LinkingTo"])
    leaf <- rownames(ap)[!is.na(deps) & trimws(gsub("NA", "", deps)) == ""]
    pkg <- if (length(leaf)) leaf[1L] else rownames(ap)[1L]
    dest <- tempfile("biocdl"); dir.create(dest)
    got <- tryCatch(
      download.packages(pkg, destdir = dest, repos = repo, type = "source", quiet = TRUE),
      error = function(e) e)
    if (inherits(got, "error") || !nrow(got)) {
      bad(sprintf("download.packages(%s)", pkg),
          if (inherits(got, "error")) conditionMessage(got) else "no file returned")
    } else {
      f <- got[1L, 2L]
      # A wrong Content-Type or an HTML error page saved as a .tar.gz both look
      # like a successful download until something opens the file.
      magic <- tryCatch(as.integer(readBin(f, "raw", 2L)), error = function(e) integer())
      if (identical(magic, c(31L, 139L))) {
        ok(sprintf("download.packages(%s): %d bytes, valid gzip", pkg, file.size(f)))
        if (length(tryCatch(untar(f, list = TRUE), error = function(e) character())))
          ok("tarball untars cleanly")
        else bad("tarball untars cleanly", "gzip magic present but archive is corrupt")
      } else {
        bad(sprintf("download.packages(%s)", pkg),
            sprintf("not gzip -- first bytes %s, likely an error page saved as .tar.gz",
                    paste(magic, collapse = " ")))
      }
    }

    # --- 6. full install --------------------------------------------------
    # Only meaningful for a release built against a compatible R. An archived
    # release will fail to compile for reasons that have nothing to do with the
    # mirror, and reporting that as a failure would be noise.
    rmaj <- as.numeric(paste(R.version$major, strsplit(R.version$minor, ".", fixed = TRUE)[[1L]][1L], sep = "."))
    if (numeric_version(version) < numeric_version("3.20")) {
      note("install into a temp library",
           sprintf("BioC %s predates R %s; a build failure would say nothing about the mirror",
                   version, rmaj))
    } else {
      lib <- tempfile("bioclib"); dir.create(lib)
      inst <- tryCatch({
        install.packages(pkg, lib = lib, repos = repo, type = "source", quiet = TRUE)
        requireNamespace(pkg, lib.loc = lib, quietly = TRUE)
      }, error = function(e) e)
      if (isTRUE(inst)) ok(sprintf("install.packages(%s) into a temp library, loads", pkg))
      else bad(sprintf("install.packages(%s)", pkg),
               if (inherits(inst, "error")) conditionMessage(inst) else "installed but will not load")
    }
  }
}

cat(sprintf("\n%d passed, %d failed, %d skipped\n", pass, fail, skip))
quit(status = if (fail > 0L) 1L else 0L)
