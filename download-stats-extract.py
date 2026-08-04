#!/usr/bin/env python3
"""Extract Bioconductor package downloads from raw CloudFront logs into Parquet.

Background: the published download stats at /packages/stats/ are produced by two
separate pipelines that currently disagree (see docs/download-stats.qmd). Both are
fed by the same CloudFront access logs in S3, and we have read access to those logs
directly. This turns them into a queryable Parquet extract so the numbers can be
checked, or rebuilt, without depending on either pipeline's Athena setup — which we
have no permission to use anyway.

Rows are filtered to package downloads (~3% of log lines). Columns are NOT filtered:
all 33 CloudFront fields are kept, named. Both existing pipelines project down to a
handful of columns, which is exactly why neither can filter bots today — the
user-agent was discarded upstream. Once the egress is paid, dropping columns only
buys a smaller file and a second download later.

Usage:
    ./download-stats-extract.py --self-check          # verify the row filter
    ./download-stats-extract.py --from 2026-06 --to 2026-07
    ./download-stats-extract.py --from 2020-01 --to 2026-08 --out /data/dl

Output is one Parquet file per month under --out, Hive-partitioned as
year=YYYY/month=M/, so the result queries as a single table with pruning on either
level:

    duckdb -c "select package, count(*) from read_parquet('/data/dl/**/*.parquet',
                    hive_partitioning=true)
               where year = 2026 and month in (6,7) group by 1 order by 2 desc"

Two partition levels rather than month=YYYY-MM because it prunes by year alone, and
because it matches the year=/month=/day= layout Bioconductor already used for its own
(abandoned) Parquet extract.

A month at a time rather than a day: ~80 files of tens of MB, not ~2,400 of ~1 MB.
Fewer, larger row groups compress better and query faster.

`date` and `time` stay in the data, not just implied by the partition. The open
question this exists to answer is a month-boundary attribution dispute, so day- and
hour-level detail across a boundary is what must not be aggregated away.

Fields stay VARCHAR exactly as the log records them, except `date`. That is
deliberate: no parsing means no lossy conversion, and the raw archive is the thing
we want to be able to re-derive from.

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
URI, STATUS, METHOD = "column07", "column08", "column05"

# Matches the filter both existing pipelines apply, so the output is comparable to
# what they publish: a package tarball/binary under /packages/, 2xx or 3xx, not HEAD.
# Redirects count as downloads and 206 (partial content) does not — that is their
# convention, not an oversight to fix here.
PKG_URI = r'^/+packages/+[^/]+/+(bioc|workflows|data/+experiment|data/+annotation)/+(bin|src)/+.*_.*\.(tar\.gz|zip|tgz)$'
OK_STATUS = "('200','301','302','307','308')"

_COLS = ",\n       ".join(
    (f"CAST(column{i:02d} AS DATE) AS {n}" if n == "date" else f"column{i:02d} AS {n}")
    for i, n in enumerate(FIELDS))

SELECT_SQL = f"""
SELECT {_COLS},
       regexp_extract({URI}, '{PKG_URI}', 1) AS category,
       regexp_extract({URI}, '/([^/_]+)_[^/]*\\.(tar\\.gz|zip|tgz)$', 1) AS package
FROM {{src}}
WHERE {STATUS} IN {OK_STATUS}
  AND {METHOD} <> 'HEAD'
  AND regexp_matches({URI}, '{PKG_URI}')
"""

READ_CSV = ("read_csv('s3://{bucket}/{dist}.{month}-*.gz', delim='\\t', header=false, "
            "comment='#', all_varchar=true, ignore_errors=true)")


def connect():
    import duckdb
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs;")
    con.execute("CREATE SECRET (TYPE s3, PROVIDER credential_chain, REGION 'us-east-1')")
    return con


def extract_month(con, month, out_dir):
    """Write one month's downloads to out_dir/year=YYYY/month=M/downloads.parquet.

    DuckDB streams the COPY, so a month of logs (~18 GB compressed at 2026 rates)
    does not need to fit in memory.
    """
    year, mon = month.split("-")
    dest = out_dir / f"year={year}" / f"month={int(mon)}"
    target = dest / "downloads.parquet"
    if target.exists():          # resume: a 6-year backfill will be interrupted
        return None
    dest.mkdir(parents=True, exist_ok=True)
    src = READ_CSV.format(bucket=BUCKET, dist=DISTRIBUTION, month=month)
    sql = SELECT_SQL.format(src=src)
    # Write to a temp name first so an interrupted run doesn't leave a short file
    # that the resume check would then skip.
    tmp = dest / "downloads.parquet.partial"
    con.execute(f"COPY ({sql}) TO '{tmp}' (FORMAT parquet, COMPRESSION zstd)")
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
    """The row filter is the only non-obvious logic here, so exercise it directly."""
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
    # Stub all 33 columns so the SELECT binds exactly as it does against real logs.
    def row(uri, status, method):
        v = ["'x'"] * len(FIELDS)
        v[0], v[1] = "'2026-01-01'", "'12:00:00'"
        v[5], v[7], v[8] = f"'{method}'", f"'{uri}'", f"'{status}'"
        return "(" + ",".join(v) + ")"
    rows = ",".join(row(u, s, m) for u, s, m, _, _ in cases)
    names = ",".join(f"column{i:02d}" for i in range(len(FIELDS)))
    con.execute(f"CREATE VIEW t AS SELECT * FROM (VALUES {rows}) AS v({names})")

    cur = con.execute(SELECT_SQL.format(src="t"))
    cols = [d[0] for d in cur.description]          # by name, not position
    got = [dict(zip(cols, r)) for r in cur.fetchall()]

    failures = []
    if len(cols) != len(FIELDS) + 2:
        failures.append(f"expected {len(FIELDS) + 2} columns, got {len(cols)}")
    matched = {r["package"] for r in got}
    for uri, status, method, should, pkg in cases:
        if should and pkg not in matched:
            failures.append(f"expected match, got none: {method} {status} {uri}")
    n_expected = sum(1 for c in cases if c[3])
    if len(got) != n_expected:
        failures.append(f"expected {n_expected} matching rows, got {len(got)}")
    for r in got:                                    # extraction must not yield blanks
        if not r["package"] or not r["category"]:
            failures.append(f"empty package/category in {r['cs_uri_stem']}")
    for f in failures:
        print("FAIL:", f, file=sys.stderr)
    assert not failures, f"{len(failures)} self-check failure(s)"
    print(f"self-check OK ({n_expected} matches, {len(cases) - n_expected} rejected, "
          f"{len(cols)} columns)")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from", dest="start", help="first month, YYYY-MM")
    ap.add_argument("--to", dest="end", help="last month, YYYY-MM (inclusive)")
    ap.add_argument("--out", default="./download-parquet", type=pathlib.Path)
    ap.add_argument("--self-check", action="store_true", help="verify the filter and exit")
    a = ap.parse_args()

    if a.self_check:
        return self_check()
    if not (a.start and a.end):
        ap.error("--from and --to are required (or use --self-check)")

    con, total = connect(), 0
    for month in months(a.start, a.end):
        t0 = time.time()
        n = extract_month(con, month, a.out)
        note = "skipped (exists)" if n is None else f"{n:>10,d} downloads  {time.time()-t0:5.0f}s"
        print(f"{month}  {note}", flush=True)
        total += n or 0
    print(f"total {total:,d} downloads -> {a.out}")


if __name__ == "__main__":
    main()
