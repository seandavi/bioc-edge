/**
 * Regenerate worker/src/redirects.json from the upstream .htaccess snapshot.
 *
 *   node worker/gen-redirects.ts inventory/htaccess-20260730.conf > worker/src/redirects.json
 *
 * Hand-transcribing ~100 target URLs is exactly how typos survive review, so
 * this parses the real RewriteRule/RedirectMatch/Redirect syntax instead of
 * re-typing it. It is deliberately narrow: it handles the three directive
 * shapes this file actually uses, plus an explicit SKIP table (by exact line
 * text, so a line that moves or gets re-flagged is still caught) for the
 * rules that are not a plain exact-or-prefix redirect. See MIGRATION.md,
 * "Redirects" for what each skip means and why -- this file only records
 * that a skip happened, not the reasoning.
 *
 * Rules are classified, not translated 1:1:
 *   - no wildcard in the source pattern            -> exact
 *   - wildcard, target has no backreference         -> prefix, fixed target
 *   - wildcard, target ends in a backreference       -> prefix, suffix kept
 * A backreference anywhere *other* than the end of the target (mid-path
 * insertion) isn't one of those three shapes and is skipped explicitly --
 * see the SKIP table.
 *
 * Every OSN-bound RedirectMatch (target host mghp.osn.xsede.org) is dropped
 * automatically: that content is being migrated into this bucket, not
 * redirected to, so it becomes a key-mapping fallback in keys.ts
 * (archiveFallback()) instead of an entry here.
 *
 * `%{ENV:proto}` and literal `http://` targets both become `https://` --
 * Cloudflare always terminates TLS, so there is no plaintext hop to
 * preserve, and perpetuating one repeats the downgrade bug MIGRATION.md
 * already flagged for the /books/ redirects.
 */
import { readFileSync, writeFileSync } from "node:fs";

const src = process.argv[2];
if (!src) {
  console.error("usage: node worker/gen-redirects.ts <htaccess-file> > worker/src/redirects.json");
  process.exit(1);
}

// Exact line text (trimmed), not line number, so this survives the file
// being re-snapshotted with different line numbers. Grouped by why.
const SKIP = new Set([
  // Sets an env var for other rules to read; nothing to redirect on its own.
  "RewriteRule ^(.*)$ - [env=proto:https]",
  "RewriteRule ^(.*)$ - [env=proto:http]",
  // Host-based (www -> apex), not path-based -- out of scope for a map keyed
  // on pathname. Also: a live crawl (MIGRATION.md, "Absolute URLs") found
  // www.bioconductor.org serving 200 directly, which this rule contradicts.
  "RewriteRule ^(.*)$ http://%1/$1 [R=302,L]",
  // Legacy Drupal artifact (any path ending "/index_html"). Open-ended
  // pattern with no enumerable path list and no known live links to it.
  "RewriteRule ^(.*)/index_html$ $1/ [R=302]",
  // Bare `(.*)` catch-all whose target is `%{ENV:proto}://bioconductor.org/$1/`
  // -- adds a trailing slash to any path that is a directory on disk. This
  // needs a filesystem check per request; candidates() already serves
  // extensionless paths directly (.html, then /index.html, then bare)
  // instead of redirecting to add a slash, which is what this exists for.
  "RewriteRule ^(.*)$ %{ENV:proto}://bioconductor.org/$1/ [L,R]",
  // Same shape, gated on a different filesystem check (REQUEST_FILENAME
  // ends .html but isn't a file, and the stem is a directory). Same reason
  // to skip: unevaluable at the edge, and superseded by candidates().
  "RewriteRule ^.*$ %1/ [R=301]",
  // PT (passthrough) triggers an internal second rewrite pass rather than a
  // client-visible redirect; the target then matches the
  // developers/how-to/git-mirrors* rule below and 301s from there. Folded
  // into one direct redirect as an OVERRIDE (see below) instead of an
  // auto-parsed two-hop chain.
  "RewriteRule ^developers/how-to/git-mirror/$ /developers/how-to/git-mirrors/ [PT]",
  // Capture lands in the middle of the target (.../annotation/$1/index.html,
  // .../$1.html), not at the end -- not a plain prefix rewrite. Only 2
  // rules, both legacy /help/workflows/ links superseded by
  // /packages/release/workflows/ pages; not worth a template-substitution
  // matcher for two rows.
  "RewriteRule ^help/workflows/annotation/(.*)/$ /packages/release/workflows/html/annotation/$1/index.html [R=301]",
  "RewriteRule ^help/workflows/(.*)/$ /packages/release/workflows/html/$1.html [R=301]",
  // Version-parameterized target (BioC version reused mid-URL), handled by
  // OVERRIDE below (enumerated per known version) instead of a generic
  // backreference engine for two rows.
  "RedirectMatch 302 /packages/(3.[0-9][0-9])/container-binaries/src/(.*) https://storage.googleapis.com/bioconductor-packages/$1/container-binaries/bioconductor_docker/src/$2",
  "RedirectMatch 302 /packages/(3.[0-9][0-9])/container-binaries/(.*) https://storage.googleapis.com/bioconductor-packages/$1/container-binaries/$2",
]);

// Manual entries the parser can't derive: the PT collapse and the
// container-binaries version expansion. `to` here is post-processing (no
// further http->https rewrite applied), so write it exactly as intended.
type Prefix = { from: string; to: string; keepSuffix: boolean };
const overrideExact: Record<string, string> = {
  // Two upstream hops (PT rewrite, then the git-mirrors* prefix rule)
  // collapsed into the one the client would have landed on anyway.
  "/developers/how-to/git-mirror/": "/about/mirrors/mirror-how-to.html",
};
const overridePrefix: Prefix[] = [];
{
  // RedirectMatch's `(3.[0-9][0-9])` requires exactly two digits after
  // "3." -- it does not match single-digit minors (3.0-3.9). That looks
  // like an upstream regex bug (see MIGRATION.md), but this is a port, not
  // a fix: only 3.10-3.24 are generated, matching what the rule actually
  // matches today. Bump the upper bound when devel rolls past 3.24.
  for (let v = 10; v <= 24; v++) {
    const ver = `3.${v}`;
    overridePrefix.push({
      from: `/packages/${ver}/container-binaries/src/`,
      to: `https://storage.googleapis.com/bioconductor-packages/${ver}/container-binaries/bioconductor_docker/src/`,
      keepSuffix: true,
    });
    overridePrefix.push({
      from: `/packages/${ver}/container-binaries/`,
      to: `https://storage.googleapis.com/bioconductor-packages/${ver}/container-binaries/`,
      keepSuffix: true,
    });
  }
}

function httpsify(target: string): string {
  return target.replace(/^%\{ENV:proto\}:/, "https:").replace(/^http:\/\//, "https://");
}

// Strip a leading "^" and a trailing "$", the only anchors this file uses.
function unanchor(pattern: string): string {
  return pattern.replace(/^\^/, "").replace(/\$$/, "");
}

const exact: Record<string, string> = { ...overrideExact };
const prefix: Prefix[] = [...overridePrefix];
let osnSkipped = 0;
let explicitSkipped = 0;

const lines = readFileSync(src, "utf8").split("\n");
for (const raw of lines) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;

  if (SKIP.has(line)) {
    explicitSkipped++;
    continue;
  }

  let pattern: string, target: string;

  const rw = line.match(/^RewriteRule\s+(\S+)\s+(\S+)/);
  const rm = line.match(/^RedirectMatch\s+\d+\s+(\S+)\s+(\S+)/);
  const rd = line.match(/^Redirect\s+(?:\d+\s+)?(\S+)\s+(\S+)/);
  if (rw) [, pattern, target] = rw;
  else if (rm) [, pattern, target] = rm;
  else if (rd) {
    // mod_alias `Redirect` is always a prefix match with the remainder
    // appended -- that's the directive's own semantics, no wildcard needed.
    [, pattern, target] = rd;
    prefix.push({ from: `/${pattern.replace(/^\//, "")}`, to: httpsify(target), keepSuffix: true });
    continue;
  } else continue; // not a directive line (comment body, RewriteCond, etc.)

  if (target.includes("mghp.osn.xsede.org")) {
    osnSkipped++;
    continue;
  }

  target = httpsify(target);

  const hasCapture = /\(\.\*\)/.test(pattern);
  const hasWildcard = hasCapture || /\.\*/.test(pattern);
  let stem = unanchor(pattern).replace(/\(\.\*\)$/, "").replace(/\.\*$/, "");
  // RedirectMatch (and Redirect) patterns already start with "/"; RewriteRule
  // ones never do. Don't double it.
  const from = stem.startsWith("/") ? stem : "/" + stem;

  if (!hasCapture && /\$1|\$2/.test(target)) {
    // No capturing group in the pattern, so the backreference in the target
    // refers to nothing -- e.g. techreports/TR1/relProjTR.pdf$1. Upstream
    // bug (see MIGRATION.md); the intended target is almost certainly the
    // string without the dangling reference, so strip it rather than ship
    // a URL ending in the literal text "$1".
    console.error(`dropping dead backreference in target: ${line}`);
    target = target.replace(/\$1|\$2/g, "");
  }

  if (!hasWildcard) {
    // mod_rewrite's trailing `?` (optional last char, e.g. "docs/workflows/?")
    // matches both with and without the slash -- not a wildcard we track,
    // but not literal either. Expand to both concrete paths.
    if (from.endsWith("/?")) {
      const bare = from.slice(0, -2);
      exact[bare] = target;
      exact[bare + "/"] = target;
    } else {
      exact[from] = target;
    }
    continue;
  }

  const keepSuffix = target.endsWith("$1");
  // A backreference anywhere but the tail isn't a plain prefix rewrite --
  // should have been caught by the SKIP table above.
  if (/\$1/.test(target) && !keepSuffix) {
    console.error(`unhandled mid-target backreference, add to SKIP: ${line}`);
    process.exit(1);
  }
  prefix.push({ from, to: keepSuffix ? target.slice(0, -2) : target, keepSuffix });
}

// Longest `from` first. redirectFor() in keys.ts finds the longest match
// itself and does not depend on this order for correctness -- this is only
// so the JSON reads like Apache's rule order (specific before catch-all)
// for anyone diffing it.
prefix.sort((a, b) => b.from.length - a.from.length);

writeFileSync(
  process.argv[3] ?? "/dev/stdout",
  JSON.stringify({ exact, prefix }, null, 2) + "\n",
);
console.error(
  `${Object.keys(exact).length} exact, ${prefix.length} prefix ` +
    `(${overridePrefix.length} from container-binaries expansion), ` +
    `${osnSkipped} OSN rules dropped (-> archiveFallback), ${explicitSkipped} explicit skips`,
);
