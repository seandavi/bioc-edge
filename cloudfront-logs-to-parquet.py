#!/usr/bin/env python3
"""Mirror the raw CloudFront access logs for bioconductor.org into Parquet.

Background: the published download stats at /packages/stats/ are produced by two
separate pipelines that currently disagree (see docs/download-stats.qmd). Both are
fed by these logs, and we have direct read access to them. This makes a local,
queryable copy so any question about the numbers can be settled without depending on
either pipeline — or on their Athena setup, which we have no permission to use.

This copies the logs. It does not interpret them. No rows are filtered and no columns
are dropped: all 33 CloudFront fields, every request, exactly as logged (VARCHAR
throughout, except `date`). Interpretation happens locally, as views over this
mirror — see DOWNLOADS_SQL below.

That split is deliberate, and it is the lesson from the two existing pipelines. Both
filter at ingest, keeping only package-tarball requests and a handful of columns. So
neither can answer a question its authors did not anticipate — whether redirects
should really count as downloads, whether bots can be excluded, what the 206
responses look like — without re-reading six years of logs from S3. The egress is
paid once; what you keep afterwards is free. Keep everything.

Usage:
    ./cloudfront-logs-to-parquet.py --self-check         # verify the downloads view
    ./cloudfront-logs-to-parquet.py --from 2026-06 --to 2026-07
    ./cloudfront-logs-to-parquet.py --from 2020-01 --to 2026-08 --out /data/cf

Output is one Parquet file per month, Hive-partitioned as year=YYYY/month=M/, so it
queries as a single table with pruning on either level:

    duckdb -c "select count(*) from read_parquet('/data/cf/**/*.parquet',
                    hive_partitioning=true) where year = 2026 and month = 7"

Rows arrive in roughly chronological order (the S3 keys sort by date and hour), so
Parquet row-group statistics on `date` prune well without an explicit sort or
day-level partitioning. Add day partitioning only if that stops being true.

Note this retains client IP addresses for all site traffic, not only for downloads —
a broader personal-data footprint than the published statistics imply. Worth a
deliberate decision about retention and access before it is copied anywhere else.

Caveat: CloudFront logs start 2020-01-01. Statistics before that exist only in the
legacy pipeline's own databases and cannot be regenerated from anything.
"""

import argparse, pathlib, sys, time

BUCKET = "bioc-cloudfront-logs"
# CloudFront names every object <distribution>.<YYYY-MM-DD-HH>.<hash>.gz, flat at the
# bucket root — there are no prefixes to narrow on except the date in the name.
DISTRIBUTION = "E1TVLJONPTUXV3"

# The 33 W3C fields, in the order CloudFront emits them (the '#Fields:' header line).
FIELDS = [
    "date", "time", "x_edge_location", "sc_bytes", "c_ip", "cs_method", "cs_host",
    "cs_uri_stem", "sc_status", "cs_referer", "cs_user_agent", "cs_uri_query",
    "cs_cookie", "x_edge_result_type", "x_edge_request_id", "x_host_header",
    "cs_protocol", "cs_bytes", "time_taken", "x_forwarded_for", "ssl_protocol",
    "ssl_cipher", "x_edge_response_result_type", "cs_protocol_version", "fle_status",
    "fle_encrypted_fields", "c_port", "time_to_first_byte",
    "x_edge_detailed_result_type", "sc_content_type", "sc_content_len",
    "sc_range_start", "sc_range_end",
]

_COLS = ",\n       ".join(
    (f"CAST(column{i:02d} AS DATE) AS {n}" if n == "date" else f"column{i:02d} AS {n}")
    for i, n in enumerate(FIELDS))

SELECT_SQL = f"SELECT {_COLS}\nFROM {{src}}"

READ_CSV = ("read_csv('s3://{bucket}/{dist}.{month}-*.gz', delim='\\t', header=false, "
            "comment='#', all_varchar=true, ignore_errors=true)")

# ---------------------------------------------------------------------------
# Interpretation lives here, as a view over the mirror — not in the extract.
#
# This reproduces what BOTH published pipelines count as a "download", so results are
# comparable to /packages/stats/ and /packages/oldstats/: a package tarball or binary
# under /packages/, status 200/301/302/307/308, HEAD excluded. Redirects count and 206
# (partial content) does not — that is their convention, not an endorsement. Measured
# to reproduce the published bioc figures to within 0.15%.
#
# It deliberately does NOT filter bots. Neither published series does, and both
# discarded the user-agent at ingest so neither now can. Here cs_user_agent is
# present, so that policy is a WHERE clause away rather than a re-download away.
# ---------------------------------------------------------------------------
PKG_URI = r'^/+packages/+[^/]+/+(bioc|workflows|data/+experiment|data/+annotation)/+(bin|src)/+.*_.*\.(tar\.gz|zip|tgz)$'

DOWNLOADS_SQL = f"""
CREATE OR REPLACE VIEW downloads AS
SELECT *,
       regexp_extract(cs_uri_stem, '{PKG_URI}', 1) AS category,
       regexp_extract(cs_uri_stem, '/([^/_]+)_[^/]*\\.(tar\\.gz|zip|tgz)$', 1) AS package
FROM {{src}}
WHERE sc_status IN ('200','301','302','307','308')
  AND cs_method <> 'HEAD'
  AND regexp_matches(cs_uri_stem, '{PKG_URI}')
"""


def connect():
    import duckdb
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs;")
    con.execute("CREATE SECRET (TYPE s3, PROVIDER credential_chain, REGION 'us-east-1')")
    return con


def extract_month(con, month, out_dir):
    """Mirror one month of logs to out_dir/year=YYYY/month=M/logs.parquet.

    DuckDB streams the COPY, so a month of logs does not need to fit in memory.
    """
    year, mon = month.split("-")
    dest = out_dir / f"year={year}" / f"month={int(mon)}"
    target = dest / "logs.parquet"
    if target.exists():          # resume: a 6-year backfill will be interrupted
        return None
    dest.mkdir(parents=True, exist_ok=True)
    src = READ_CSV.format(bucket=BUCKET, dist=DISTRIBUTION, month=month)
    # The mapping below is positional, and read_csv skips the '#Fields:' header, so a
    # format change upstream would silently shift every column. Verified identical
    # 2020-2026, but assert it per month rather than trust it.
    n_src = len(con.execute(f"SELECT * FROM {src} LIMIT 0").description)
    if n_src != len(FIELDS):
        raise SystemExit(f"{month}: expected {len(FIELDS)} CloudFront fields, source has "
                         f"{n_src} — the log format changed; fix FIELDS before continuing")
    # Write to a temp name first so an interrupted run doesn't leave a short file
    # that the resume check would then skip.
    tmp = dest / "logs.parquet.partial"
    con.execute(f"COPY ({SELECT_SQL.format(src=src)}) TO '{tmp}' "
                "(FORMAT parquet, COMPRESSION zstd)")
    tmp.rename(target)
    return con.execute(f"SELECT count(*) FROM read_parquet('{target}')").fetchone()[0]


def months(start, end):
    """Inclusive YYYY-MM range."""
    y, m = (int(x) for x in start.split("-"))
    ey, em = (int(x) for x in end.split("-"))
    while (y, m) <= (ey, em):
        yield f"{y:04d}-{m:02d}"
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def self_check():
    """The mirror is a straight copy; the downloads view is the part that can drift."""
    import duckdb
    con = duckdb.connect()
    # (uri, status, method, should_match, expected_package)
    cases = [
        ("/packages/3.20/bioc/src/contrib/limma_3.62.1.tar.gz", "200", "GET", True, "limma"),
        ("/packages/3.20/bioc/bin/windows/contrib/4.4/limma_3.62.1.zip", "200", "GET", True, "limma"),
        ("/packages/3.20/data/annotation/src/contrib/org.Hs.eg.db_3.20.0.tar.gz", "200", "GET", True, "org.Hs.eg.db"),
        ("/packages/3.20/bioc/src/contrib/limma_3.62.1.tar.gz", "302", "GET", True, "limma"),
        ("/packages/3.20/bioc/src/contrib/limma_3.62.1.tar.gz", "404", "GET", False, None),
        ("/packages/3.20/bioc/src/contrib/limma_3.62.1.tar.gz", "206", "GET", False, None),
        ("/packages/3.20/bioc/src/contrib/limma_3.62.1.tar.gz", "200", "HEAD", False, None),
        ("/packages/3.20/bioc/html/limma.html", "200", "GET", False, None),
        ("/packages/3.20/bioc/src/contrib/PACKAGES", "200", "GET", False, None),
        ("/about/index.html", "200", "GET", False, None),
    ]
    # A stand-in mirror with the real column names, so the view binds exactly as it
    # will against the Parquet.
    rows = ",".join(f"('{u}','{s}','{m}')" for u, s, m, _, _ in cases)
    con.execute(f"CREATE VIEW mirror AS SELECT * FROM (VALUES {rows}) "
                "AS v(cs_uri_stem, sc_status, cs_method)")
    con.execute(DOWNLOADS_SQL.format(src="mirror"))

    cur = con.execute("SELECT * FROM downloads")
    cols = [d[0] for d in cur.description]
    got = [dict(zip(cols, r)) for r in cur.fetchall()]

    failures = []
    matched = {r["package"] for r in got}
    for uri, status, method, should, pkg in cases:
        if should and pkg not in matched:
            failures.append(f"expected match, got none: {method} {status} {uri}")
    n_expected = sum(1 for c in cases if c[3])
    if len(got) != n_expected:
        failures.append(f"expected {n_expected} matching rows, got {len(got)}")
    for r in got:                                   # extraction must not yield blanks
        if not r["package"] or not r["category"]:
            failures.append(f"empty package/category for {r['cs_uri_stem']}")
    # The mirror must stay a faithful copy: no row filter, no derived columns.
    up = SELECT_SQL.upper()
    if "WHERE" in up or "REGEXP" in up:
        failures.append("SELECT_SQL has grown a filter — the mirror must stay raw")
    if len(FIELDS) != 33:
        failures.append(f"expected 33 CloudFront fields, have {len(FIELDS)}")

    for f in failures:
        print("FAIL:", f, file=sys.stderr)
    assert not failures, f"{len(failures)} self-check failure(s)"
    print(f"self-check OK (downloads view: {n_expected} matched, "
          f"{len(cases) - n_expected} rejected; mirror: {len(FIELDS)} fields, unfiltered)")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from", dest="start", help="first month, YYYY-MM")
    ap.add_argument("--to", dest="end", help="last month, YYYY-MM (inclusive)")
    ap.add_argument("--out", default="./cloudfront-parquet", type=pathlib.Path)
    ap.add_argument("--self-check", action="store_true",
                    help="verify the downloads view and exit")
    a = ap.parse_args()

    if a.self_check:
        return self_check()
    if not (a.start and a.end):
        ap.error("--from and --to are required (or use --self-check)")

    con, total = connect(), 0
    for month in months(a.start, a.end):
        t0 = time.time()
        n = extract_month(con, month, a.out)
        note = "skipped (exists)" if n is None else f"{n:>12,d} rows  {time.time()-t0:5.0f}s"
        print(f"{month}  {note}", flush=True)
        total += n or 0
    print(f"total {total:,d} rows -> {a.out}")


if __name__ == "__main__":
    main()
