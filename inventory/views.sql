-- DuckDB view layer over the artifacts this project already keeps: inventory/
-- snapshots, the local mirror, the R2 bucket, and the published manifest.
--
-- Derive, never store. Every view below reads a source artifact directly (a
-- file on disk, the live filesystem, or the published manifest over HTTPS) --
-- nothing here is materialized. If a number ever looks wrong, the fix is to
-- check the source artifact, never to patch a view's output: there is no
-- output to patch, only a query. Re-run inventory/db.sh and it is correct
-- again by construction. This matters because this project has repeatedly
-- been bitten by stored copies drifting from truth (a stale manifest, a
-- stale symlink map, a year-cached CDN response) -- see MIGRATION.md.
--
-- This file makes four specific, already-repeated mistakes structurally
-- impossible instead of re-deriving the fix ad hoc every time someone asks
-- "how many objects are there":
--
--   1. rclone lsf/lsd emit a row for every directory too, size -1, no hash.
--      Counted as objects once, this inflated a total by 38,819 and put
--      bin/ and src/contrib/ into a published manifest as fetchable objects.
--      Fix: --files-only at the rclone call site (refresh.sh, gen-manifest.sh)
--      *and* every view here that reads an rclone-shaped listing filters
--      size <> -1 before anyone can sum() over it (osn_archive_objects).
--   2. `du -sh` is GiB, `du -sb` is bytes -- comparing one to the other
--      invented a phantom "32 GB shortfall". Not applicable here: no view in
--      this file shells out to du. Every byte figure comes from a listing's
--      own size column, one unit (bytes), always.
--   3. rsync --out-format log lines are not file counts (>f transferred, cd
--      directory created, cL symlink -- counting lines as files reported "98%
--      complete" when it was 66%). Not applicable here either: this file only
--      reads *finished* listings (inventory snapshots, the live mirror, R2),
--      never an in-flight rsync/rclone log. sync.sh and test-itemize.sh own
--      that parsing; this file does not duplicate it.
--   4. rclone's "Transferred: N" summary is not `find -type f | wc -l` --
--      they differ legitimately (already-current files are not
--      transferred), and conflating them invented a phantom 113-file gap.
--      Every count in this file is count(*) over real rows, never a parsed
--      summary line.
--
-- Usage: ./inventory/db.sh, or `duckdb -init inventory/views.sql`.
--
-- Everything above the network-boundary marker further down reads local
-- files or the live mirror filesystem only -- no network, no credentials.
-- test-inventory-views.sh runs exactly that prefix against fixtures, so the
-- boundary stays true instead of drifting into a comment nobody checks.
-- httpfs/json (and the network they imply) are loaded right at the marker,
-- just above the first view that actually needs them.

-- ============================================================================
-- Where things live. getenv() returns '' (not NULL) for an unset variable --
-- coalesce(default, ...) alone silently loses the default, so nullif() first.
-- Override with INVENTORY_DIR / MIRROR_DIR / MANIFEST_HOST in the environment;
-- defaults match refresh.sh's $OUT and finish-load.sh's $DEST.
-- ============================================================================
CREATE OR REPLACE MACRO inventory_dir() AS
  coalesce(nullif(getenv('INVENTORY_DIR'), ''), '/data/davsean/bioc-cloudflare/inventory');
CREATE OR REPLACE MACRO mirror_dir() AS
  coalesce(nullif(getenv('MIRROR_DIR'), ''), '/data/davsean/bioc-cloudflare/mirror');
CREATE OR REPLACE MACRO manifest_host() AS
  coalesce(nullif(getenv('MANIFEST_HOST'), ''), 'https://bioc-dev.cancerdatasci.org');

-- Collapse "dir/../" segments in a POSIX relative path, left to right.
-- ponytail: fixed passes of regexp_replace, not a real stack -- RE2 (DuckDB's
-- regex engine) has no lookaround, so a stack-free single-pass regex can't
-- exclude ".." itself from matching as "the directory to pop", which silently
-- cancels two ".." against each other on deep targets. The inner alternation
-- (\.[^.]|[^/.]) requires the popped segment's first two characters not both
-- be dots, which rules that out for every real docroot name (none start with
-- a bare "."). Six passes covers every symlink target actually seen in the
-- docroot (deepest is 4 "../" segments, packages/lindsey/bin/macosx/...); a
-- future target needing more fails to fully collapse and shows up as
-- `resolves = false` in symlink_resolution -- wrong-but-safe, not silently
-- wrong. Upgrade to a recursive CTE if that ever fires for real.
CREATE OR REPLACE MACRO normalize_rel_path(base_dir, target) AS (
  trim(
    regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
      '/' || base_dir || '/' || target || '/',
    '/\./', '/', 'g'),
    '/((?:\.[^.]|[^/.])[^/]*)/\.\./', '/', 'g'),
    '/((?:\.[^.]|[^/.])[^/]*)/\.\./', '/', 'g'),
    '/((?:\.[^.]|[^/.])[^/]*)/\.\./', '/', 'g'),
    '/((?:\.[^.]|[^/.])[^/]*)/\.\./', '/', 'g'),
    '/((?:\.[^.]|[^/.])[^/]*)/\.\./', '/', 'g'),
  '/')
);

-- ============================================================================
-- Source 1: upstream docroot, from inventory/refresh.sh's rsync --list-only
-- snapshot. Comma-grouped sizes, and paths can contain spaces (86 of them in
-- the live tree) -- read the whole line as one column and regex it apart
-- rather than splitting on whitespace, exactly as inventory/README.md's own
-- awk recipe warns. Kind: '-' file, 'd' dir, 'l' symlink (rsync list col 1).
-- ============================================================================
CREATE OR REPLACE VIEW upstream_docroot_raw AS
SELECT
  regexp_extract(line, '^(\S)', 1) AS kind,
  CAST(replace(regexp_extract(line, '^\S+\s+([\d,]+)', 1), ',', '') AS BIGINT) AS size,
  strptime(regexp_extract(line, '^\S+\s+[\d,]+\s+(\S+\s+\S+)', 1), '%Y/%m/%d %H:%M:%S') AS mtime,
  -- Everything from field 5 to end of line, untouched -- this is what
  -- "rebuild the path from $5..NF" means when you can't awk it.
  regexp_extract(line, '^\S+\s+[\d,]+\s+\S+\s+\S+\s+(.*)$', 1) AS path_field
FROM read_csv(inventory_dir() || '/docroot-latest.txt.gz',
  delim = E'\x1e', header = false, quote = '', columns = {'line': 'VARCHAR'});

CREATE OR REPLACE VIEW upstream_docroot AS
SELECT
  kind, size, mtime,
  CASE WHEN kind = 'l' THEN regexp_extract(path_field, '^(.*) -> ', 1) ELSE path_field END AS path,
  CASE WHEN kind = 'l' THEN regexp_extract(path_field, ' -> (.*)$', 1) ELSE NULL END AS link_target
FROM upstream_docroot_raw;

CREATE OR REPLACE VIEW upstream_docroot_files AS
  SELECT path, size, mtime FROM upstream_docroot WHERE kind = '-';

-- All historical snapshots (not just -latest) for trend queries below. The
-- glob 'docroot-2*.txt.gz' deliberately excludes docroot-latest.txt.gz (a
-- symlink to one of these files, named "latest" not "2...") so the symlink's
-- target is not counted twice.
CREATE OR REPLACE VIEW upstream_docroot_snapshots AS
SELECT
  regexp_extract(filename, 'docroot-(\d{8}T\d{6}Z)\.txt\.gz$', 1) AS snapshot,
  regexp_extract(line, '^(\S)', 1) AS kind,
  CAST(replace(regexp_extract(line, '^\S+\s+([\d,]+)', 1), ',', '') AS BIGINT) AS size,
  regexp_extract(line, '^\S+\s+[\d,]+\s+\S+\s+\S+\s+(.*)$', 1) AS path_field
FROM read_csv(inventory_dir() || '/docroot-2*.txt.gz',
  delim = E'\x1e', header = false, quote = '', columns = {'line': 'VARCHAR'}, filename = true);

-- ============================================================================
-- Source 2: OSN archive, from inventory/refresh.sh's `rclone lsf -R --fast-
-- list --format sp`. size<TAB>path, one line per row -- but rows with size -1
-- are directory markers rclone emits during the recursive walk, not objects.
-- Trap #1: osn_archive_objects filters these out once, here. The raw view is
-- kept too, so "how many directory markers were there" stays answerable.
-- ============================================================================
CREATE OR REPLACE VIEW osn_archive AS
SELECT size, path, (size = -1) AS is_dir
FROM read_csv(inventory_dir() || '/osn-archive-latest.tsv.gz',
  delim = '\t', header = false, quote = '', columns = {'size': 'BIGINT', 'path': 'VARCHAR'});

CREATE OR REPLACE VIEW osn_archive_objects AS
  SELECT size, path FROM osn_archive WHERE NOT is_dir;

CREATE OR REPLACE VIEW osn_archive_snapshots AS
SELECT
  regexp_extract(filename, 'osn-archive-(\d{8}T\d{6}Z)\.tsv\.gz$', 1) AS snapshot,
  size, path
FROM read_csv(inventory_dir() || '/osn-archive-2*.tsv.gz',
  delim = '\t', header = false, quote = '', columns = {'size': 'BIGINT', 'path': 'VARCHAR'}, filename = true);

-- ============================================================================
-- Source 3: R2 bucket, from inventory/refresh.sh's `rclone lsf -R --files-
-- only --hash md5` snapshot (see that script for why this is a snapshot and
-- not a live view like local_mirror: a full-bucket listing is the slow one,
-- ~15 min at 1.65M objects). --files-only is load-bearing there for the same
-- reason as source 2 and gen-manifest.sh: without it, directory rows with
-- size -1 and no hash would land here as if they were fetchable objects.
--
-- md5 is blank for a minority of objects (rclone reports a composite ETag,
-- not a real MD5, on some multipart uploads -- gen-manifest.sh hit this
-- first). Same rule applied here: keep it only if it looks like a real MD5.
-- ============================================================================
CREATE OR REPLACE VIEW r2_objects AS
SELECT
  path, size,
  CASE WHEN regexp_matches(md5, '^[0-9a-f]{32}$') THEN md5 ELSE NULL END AS md5
FROM read_csv(inventory_dir() || '/r2-listing-latest.tsv.gz',
  delim = '\t', header = false, quote = '', columns = {'path': 'VARCHAR', 'size': 'BIGINT', 'md5': 'VARCHAR'});

-- R2 holds more than the docroot: the OSN archive under archive.bioconductor.
-- org/, the manifest/index API under api/, and _symlinks.json itself. None of
-- those has an upstream-docroot or local-mirror counterpart *by construction*
-- (MIGRATION.md "The OSN archive moves too", gen-manifest.sh, sync.sh) -- this
-- is describing what R2 additionally contains, not re-implementing
-- rsync-filter's scope decision. Re-implementing that filter here would be
-- exactly the second copy that drifts from truth this file exists to avoid;
-- see reconcile_docroot_by_top below for how the real scope gap (checkResults/
-- being 87% excluded on purpose) stays visible instead of hidden.
CREATE OR REPLACE VIEW r2_docroot_objects AS
  SELECT path, size, md5 FROM r2_objects
  WHERE path NOT LIKE 'archive.bioconductor.org/%'
    AND path NOT LIKE 'api/%'
    AND path <> '_symlinks.json';

-- ============================================================================
-- Source 4: local mirror. The one live view, not a snapshot: DuckDB's glob()/
-- read_blob() walk the real filesystem with lstat-like semantics -- verified
-- against `find $MIRROR_DIR -type f` on the actual 1.35M-file mirror: same
-- count, same byte total, to the object. It does not follow symlinks during
-- the recursive walk (matches plain `find`, not `find -L`), so this is
-- regular files only, same guarantee --files-only gives the R2 view. ~30s
-- over the real mirror; a snapshot would be a stale copy of a filesystem we
-- can already query directly, so the "materialize only when a view is
-- unusably slow" rule says no.
-- ============================================================================
CREATE OR REPLACE VIEW local_mirror AS
SELECT substr(filename, length(mirror_dir()) + 2) AS path, size
FROM read_blob(mirror_dir() || '/**');

-- ============================================================================
-- Reconciliation across upstream / local mirror / R2. The main event: this
-- used to be three bespoke awk scripts run by hand, which is exactly how the
-- size -1 and GiB/GB mistakes happened. One join, defined once.
-- ============================================================================
CREATE OR REPLACE VIEW reconcile_docroot AS
SELECT
  coalesce(u.path, l.path, r.path) AS path,
  u.size AS upstream_size, l.size AS local_size, r.size AS r2_size,
  (u.path IS NOT NULL) AS in_upstream,
  (l.path IS NOT NULL) AS in_local,
  (r.path IS NOT NULL) AS in_r2
FROM upstream_docroot_files u
FULL OUTER JOIN local_mirror l USING (path)
FULL OUTER JOIN r2_docroot_objects r USING (path);

CREATE OR REPLACE VIEW reconcile_upstream_not_local AS
  SELECT path, upstream_size FROM reconcile_docroot WHERE in_upstream AND NOT in_local;

CREATE OR REPLACE VIEW reconcile_local_not_r2 AS
  SELECT path, local_size FROM reconcile_docroot WHERE in_local AND NOT in_r2;

-- In R2, in the docroot namespace, but not in the current upstream listing at
-- all: either the phase-1 wget crawl's leftovers that finish-load.sh's first
-- `rclone sync` was supposed to clear (packages/plyranges is the documented
-- case, MIGRATION.md "The first load is not a delta"), or a local file that
-- was deleted and never purged from R2.
CREATE OR REPLACE VIEW reconcile_r2_orphans AS
  SELECT path, r2_size FROM reconcile_docroot WHERE in_r2 AND NOT in_upstream;

-- Same three-way comparison, rolled up by top-level directory, so the
-- expected gap (rsync-filter deliberately keeps only current release+devel
-- under checkResults/, MIGRATION.md "Upstream shape") reads as "checkResults
-- dominates upstream_not_local, as documented" instead of looking like a bug.
-- A large gap anywhere *else* is the signal actually worth chasing.
CREATE OR REPLACE VIEW reconcile_docroot_by_top AS
SELECT
  regexp_extract(path, '^([^/]+)', 1) AS top,
  count(*) FILTER (in_upstream) AS upstream_files,
  count(*) FILTER (in_local) AS local_files,
  count(*) FILTER (in_r2) AS r2_files,
  count(*) FILTER (in_upstream AND NOT in_local) AS upstream_not_local,
  count(*) FILTER (in_local AND NOT in_r2) AS local_not_r2,
  count(*) FILTER (in_r2 AND NOT in_upstream) AS r2_not_upstream
FROM reconcile_docroot
GROUP BY 1 ORDER BY 1;

-- OSN archive vs its R2 copy. Different namespace from reconcile_docroot: an
-- OSN path "1.8/bioc/..." lands in R2 as "archive.bioconductor.org/packages/
-- 1.8/bioc/..." (worker/src/keys.ts ARCHIVE_PREFIX + the docroot-style key
-- gen-manifest.sh/archiveFallback already assumes), so the join key has to be
-- built, not compared raw.
CREATE OR REPLACE VIEW reconcile_osn_r2 AS
WITH o AS (
  SELECT 'archive.bioconductor.org/packages/' || path AS path, size FROM osn_archive_objects
)
SELECT
  coalesce(o.path, r.path) AS path, o.size AS osn_size, r.size AS r2_size,
  (o.path IS NOT NULL) AS in_osn, (r.path IS NOT NULL) AS in_r2
FROM o
FULL OUTER JOIN (SELECT path, size FROM r2_objects WHERE path LIKE 'archive.bioconductor.org/packages/%') r
  USING (path);

-- ============================================================================
-- Counts and bytes, the two shapes asked for most often.
-- ============================================================================
CREATE OR REPLACE VIEW counts_by_top AS
  SELECT 'upstream' AS source, regexp_extract(path, '^([^/]+)', 1) AS top, count(*) AS files, sum(size) AS bytes
    FROM upstream_docroot_files GROUP BY 1, 2
  UNION ALL
  SELECT 'local', regexp_extract(path, '^([^/]+)', 1), count(*), sum(size)
    FROM local_mirror GROUP BY 1, 2
  UNION ALL
  SELECT 'r2', regexp_extract(path, '^([^/]+)', 1), count(*), sum(size)
    FROM r2_docroot_objects GROUP BY 1, 2
  ORDER BY 1, 2;

-- Version is the path segment right after packages/, books/, or checkResults/
-- -- the three trees keyed by Bioconductor release. Everything else (help/,
-- style/, shields/, ...) has no version and is left out, not zero-filled --
-- counts_by_top already covers those.
CREATE OR REPLACE VIEW counts_by_version AS
SELECT source, top, version, count(*) AS files, sum(size) AS bytes
FROM (
  SELECT 'upstream' AS source, regexp_extract(path, '^([^/]+)', 1) AS top,
         regexp_extract(path, '^(?:packages|books|checkResults)/([^/]+)', 1) AS version, size
  FROM upstream_docroot_files
  UNION ALL
  SELECT 'local', regexp_extract(path, '^([^/]+)', 1),
         regexp_extract(path, '^(?:packages|books|checkResults)/([^/]+)', 1), size
  FROM local_mirror
  UNION ALL
  SELECT 'r2', regexp_extract(path, '^([^/]+)', 1),
         regexp_extract(path, '^(?:packages|books|checkResults)/([^/]+)', 1), size
  FROM r2_docroot_objects
) WHERE version <> '' AND top IN ('packages', 'books', 'checkResults')
GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

-- ============================================================================
-- Trend across snapshots. Needs at least two inventory/refresh.sh runs to
-- show an actual trend -- with today's single snapshot these return one row
-- per group, which is a baseline, not yet a trend. That is the honest answer:
-- before this file, the question was unanswerable at all (snapshots were
-- kept, but nothing compared them); after it, it becomes answerable the
-- moment a second snapshot exists, with no new code.
-- ============================================================================
CREATE OR REPLACE VIEW trend_upstream_by_top AS
-- kind = '-' filtered before the GROUP BY, not in a FILTER clause: a
-- directory or symlink row's path_field would otherwise contribute its own
-- (files=0) group -- for a symlink that group's "top" is nonsense (the ' ->
-- target' text can itself contain the first '/'), just to report zero files.
SELECT snapshot, regexp_extract(path_field, '^([^/]+)', 1) AS top,
       count(*) AS files, sum(size) AS bytes
FROM upstream_docroot_snapshots
WHERE kind = '-'
GROUP BY 1, 2 ORDER BY 1, 2;

CREATE OR REPLACE VIEW trend_osn AS
SELECT snapshot,
       count(*) FILTER (size <> -1) AS objects, sum(size) FILTER (size <> -1) AS bytes
FROM osn_archive_snapshots
GROUP BY 1 ORDER BY 1;

-- === OFFLINE_BOUNDARY: everything above needs no network; below needs
-- === httpfs/json and a reachable manifest_host(). See the file header.
INSTALL httpfs; LOAD httpfs;
INSTALL json; LOAD json;

-- ============================================================================
-- Symlink map: published as part of api/v1/manifest/index.json (gen-
-- manifest.sh writes it there from the same _symlinks.json sync.sh
-- publishes). Read live over HTTPS rather than snapshotted: it is 145
-- entries, already public, and reading the published copy is the actual
-- question ("what does an operator see"), not a cached guess at it.
-- ============================================================================
CREATE OR REPLACE VIEW symlink_map AS
SELECT unnest(map_keys(m.symlinks)) AS path, unnest(map_values(m.symlinks)) AS target
FROM (
  SELECT * FROM read_json(manifest_host() || '/api/v1/manifest/index.json',
    columns = {'symlinks': 'MAP(VARCHAR, VARCHAR)'})
) AS m;

CREATE OR REPLACE VIEW symlink_inventory AS
SELECT
  path, target,
  -- worker/src/keys.ts resolveLinks(): an absolute target is treated as
  -- outside the mirror and never followed. None of the 145 published entries
  -- are absolute today, but a future one would be, so this is a real branch.
  (target LIKE '/%') AS target_absolute,
  CASE WHEN target LIKE '/%' THEN NULL
       ELSE normalize_rel_path(regexp_replace(path, '/[^/]*$', ''), target)
  END AS resolved_target
FROM symlink_map;

CREATE OR REPLACE VIEW symlink_resolution AS
SELECT
  s.path, s.target, s.resolved_target,
  CASE
    WHEN s.target_absolute THEN false
    -- Resolves either as a file key itself, or as a directory prefix of one
    -- (most links target a directory, e.g. checkResults/release -> 3.23; R2
    -- has no directory objects, so "3.23 exists" means "something is keyed
    -- under 3.23/").
    WHEN EXISTS (SELECT 1 FROM r2_docroot_objects r WHERE r.path = s.resolved_target) THEN true
    WHEN EXISTS (SELECT 1 FROM r2_docroot_objects r WHERE r.path LIKE s.resolved_target || '/%') THEN true
    ELSE false
  END AS resolves
FROM symlink_inventory s;

-- ============================================================================
-- Published manifests: /api/v1/manifest/index.json lists them, each one a
-- gzipped path<TAB>size<TAB>md5 file, both fetched live over HTTPS -- this is
-- what an operator with no credentials actually sees (MIRRORS.md), so reading
-- the snapshot instead would answer a different question.
-- ============================================================================
CREATE OR REPLACE VIEW published_manifest_index AS
WITH idx AS (
  SELECT * FROM read_json(manifest_host() || '/api/v1/manifest/index.json',
    columns = {'versions': 'STRUCT(release VARCHAR, devel VARCHAR)',
               'manifests': 'STRUCT(path VARCHAR, objects BIGINT, without_hash BIGINT)[]'})
), m AS (
  SELECT versions, unnest(manifests) AS entry FROM idx
)
SELECT
  versions.release AS release, versions.devel AS devel,
  entry.path AS manifest_path, entry.objects AS manifest_objects, entry.without_hash AS manifest_without_hash
FROM m;

-- SET VARIABLE, not a CTE feeding read_csv() directly: DuckDB table functions
-- take constant arguments only ("Table function cannot contain subqueries"),
-- so the list of manifest URLs has to be materialized as a session variable
-- first, then read_csv() takes the list as a VARCHAR[] literal.
SET VARIABLE manifest_urls = (
  SELECT list(manifest_host() || '/api/v1/manifest/' || m.path)
  FROM (SELECT unnest(manifests) AS m FROM
    read_json(manifest_host() || '/api/v1/manifest/index.json',
      columns = {'manifests': 'STRUCT(path VARCHAR, objects BIGINT, without_hash BIGINT)[]'}))
);

CREATE OR REPLACE VIEW published_manifest_entries AS
SELECT
  regexp_extract(filename, '/manifest/(.*)$', 1) AS manifest_path,
  path, size, nullif(md5, '') AS md5
FROM read_csv(getvariable('manifest_urls'),
  delim = '\t', header = false, quote = '',
  columns = {'path': 'VARCHAR', 'size': 'BIGINT', 'md5': 'VARCHAR'}, filename = true);

-- Deliverable: is every path in a published manifest actually present in R2,
-- with matching size? A manifest entry with no matching r2_docroot_objects
-- row is a manifest promising an object that a fresh operator sync would 404
-- on; a size mismatch is a manifest describing stale bytes.
CREATE OR REPLACE VIEW manifest_consistency AS
SELECT
  e.manifest_path, e.path, e.size AS manifest_size, r.size AS r2_size, e.md5 AS manifest_md5, r.md5 AS r2_md5,
  CASE
    WHEN r.path IS NULL THEN 'missing_in_r2'
    WHEN r.size <> e.size THEN 'size_mismatch'
    WHEN e.md5 IS NOT NULL AND r.md5 IS NOT NULL AND e.md5 <> r.md5 THEN 'hash_mismatch'
    ELSE 'ok'
  END AS status
FROM published_manifest_entries e
LEFT JOIN r2_docroot_objects r USING (path);
