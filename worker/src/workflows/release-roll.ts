/**
 * The pure half of the release-roll guard. The `WorkflowEntrypoint` class and
 * the cron handler that creates instances live in `../index.ts` -- a Workflow
 * class must be exported from wrangler's `main` anyway, and this module is
 * also loaded by `node --test`, which cannot resolve `cloudflare:workers`.
 * See DATAPLANE.md and docs/adr/0007.
 *
 * The release-roll guard from issue #34: detect that upstream's release/devel
 * pair has moved, compute what a roll would change and what it would delete,
 * then stop and wait for a human before anything destructive happens.
 *
 * Shape, and why it is this shape:
 *
 *   - Detection is cheap and unattended. `bioc-version` and `bioc-devel-version`
 *     are 4 bytes each on the live origin, so this can poll them without
 *     touching the upstream docroot host (which is rrsync-locked and has no HTTP surface). That
 *     is the chicken-and-egg answer from #34: the version has to be known
 *     *before* deciding what to sync, so read it over plain HTTP first.
 *   - Approval is `step.waitForEvent()`. An event sent before the instance
 *     reaches the wait is buffered rather than lost, so an operator who
 *     approves the moment the alert arrives does not race the workflow.
 *   - The enumerated delete list goes to R2 and only a pointer crosses a step
 *     boundary. Step outputs cap at 1 MiB; 129,000 keys do not fit.
 *   - Approval alone is not sufficient to delete. The approver has to
 *     acknowledge a specific object count, and a plan that grew between alert
 *     and approval is refused rather than applied. `sync.sh` has no such guard
 *     today: `rclone delete --files-from "$gone"` is unconditional.
 *
 * What this does NOT do, deliberately: it does not run rsync, does not edit
 * `rsync-filter`, and does not delete anything. Applying means writing an
 * approval record to R2 that the host-side sync would gate on. Wiring that gate
 * into sync.sh is a separate, later change.
 */
import type { Redirects } from "../keys.ts";

/** Version pair as upstream publishes it. */
export interface Pair {
  release: string;
  devel: string;
}

export interface Drift {
  drifted: boolean;
  /** Versions the container-binaries redirect expansion is missing. */
  missingRedirectVersions: string[];
}

/**
 * `bioc-version` / `bioc-devel-version` are one line, "3.24\n". Anything else is
 * a fetch that went wrong -- an error page, a truncated body, a rewritten
 * redirect -- and returning null makes the caller stop instead of comparing
 * against nonsense and declaring a roll.
 */
export function parseVersionFile(body: string): string | null {
  const v = body.trim();
  return /^\d+\.\d+$/.test(v) ? v : null;
}

/** Numeric, not lexical: "3.9" < "3.10" and string compare gets that backwards. */
export function compareVersions(a: string, b: string): number {
  const [am, an] = a.split(".").map(Number);
  const [bm, bn] = b.split(".").map(Number);
  return am - bm || an - bn;
}

/**
 * The highest version the generated container-binaries expansion covers.
 *
 * Read out of `redirects.json` rather than kept as a second constant beside
 * `gen-redirects.ts`'s loop bound. Two copies of the same number is how the
 * number in #34 got stale in the first place; this one cannot disagree with
 * what the Worker actually serves, because it *is* what the Worker serves.
 */
export function redirectVersionBound(redirects: Redirects): string | null {
  let best: string | null = null;
  for (const rule of redirects.prefix) {
    const m = rule.from.match(/^\/packages\/(\d+\.\d+)\/container-binaries\//);
    if (m && (best === null || compareVersions(m[1], best) > 0)) best = m[1];
  }
  return best;
}

/**
 * Has the pair moved past what this deploy knows about?
 *
 * Only the redirect bound is checked. `rsync-filter`'s per-version checkResults
 * carve-outs -- the other half of #34 -- were removed by ADR 0006 on
 * 2026-08-07: checkResults is now mirrored in full for every release, so a roll
 * no longer takes a version out of rsync scope and no longer triggers the
 * 129,000-object deletion that issue described. The delete guard below is kept
 * anyway; the hazard it covers is "any run proposes a mass deletion", and a
 * release roll was only the most predictable way to reach it.
 */
export function detectDrift(pair: Pair, bound: string | null): Drift {
  if (bound === null) return { drifted: false, missingRedirectVersions: [] };
  const missing: string[] = [];
  const [major, minor] = bound.split(".").map(Number);
  const [dMajor, dMinor] = pair.devel.split(".").map(Number);
  for (let v = minor + 1; major === dMajor && v <= dMinor; v++) missing.push(`${major}.${v}`);
  return { drifted: missing.length > 0, missingRedirectVersions: missing };
}

export interface BudgetCheck {
  allowed: boolean;
  reason: string;
}

/**
 * The guard sync.sh does not have.
 *
 * `budget` is PURGE_MAX's sibling, not PURGE_MAX itself: past this many
 * deletions the run is not a sync, it is a scope change, and the difference
 * between the two is a human. `acknowledged` is what the approver typed --
 * approving "delete 129,000 objects" must not silently apply to a plan that
 * has since grown to 400,000, which is exactly what a bare yes/no gate would do.
 */
export function checkDeleteBudget(
  count: number,
  budget: number,
  acknowledged: number | null = null,
): BudgetCheck {
  if (count <= budget) return { allowed: true, reason: `${count} deletions within budget ${budget}` };
  if (acknowledged === null) {
    return { allowed: false, reason: `${count} deletions exceeds budget ${budget}; needs explicit acknowledgement` };
  }
  if (acknowledged !== count) {
    return {
      allowed: false,
      reason: `plan changed since approval: acknowledged ${acknowledged}, now ${count}`,
    };
  }
  return { allowed: true, reason: `${count} deletions acknowledged by approver` };
}

/** What an operator sends back to `step.waitForEvent()`. */
export interface Approval {
  approved: boolean;
  by: string;
  /** Object count the approver saw and accepted. Absent = approving the plan, not the deletion. */
  acknowledgedDeletes?: number;
}

export type Outcome =
  | { act: "apply"; reason: string }
  | { act: "alert"; reason: string };

/**
 * Approval event (or its absence) -> what to do.
 *
 * Split out from the workflow body so it can be asserted on: a `waitForEvent`
 * needs a live instance, but "who is allowed to make this delete happen" is
 * ordinary logic and is the part worth testing. Timeout and rejection are the
 * same outcome deliberately -- an unanswered alert is not consent.
 */
export function approvalOutcome(
  approval: Approval | null,
  deleteCount: number,
  budget: number,
): Outcome {
  if (approval === null) return { act: "alert", reason: "no approval before timeout" };
  if (!approval.approved) return { act: "alert", reason: `rejected by ${approval.by}` };
  const budgetCheck = checkDeleteBudget(deleteCount, budget, approval.acknowledgedDeletes ?? null);
  if (!budgetCheck.allowed) return { act: "alert", reason: budgetCheck.reason };
  return { act: "apply", reason: budgetCheck.reason };
}

// ---------------------------------------------------------------------------
// Everything above is decision logic; everything below is the shared surface
// the entrypoint and the cron handler in ../index.ts call into.

export interface ReleaseRollParams {
  /** Where the 4-byte version files are read from, ahead of any sync. */
  originBase?: string;
  /** R2 prefixes a roll would take out of sync scope. Empty under ADR 0006. */
  atRiskPrefixes?: string[];
  budget?: number;
  /** Global ambient type from workers-types, e.g. "72 hours". */
  approvalTimeout?: WorkflowSleepDuration;
}

export const DEFAULTS = {
  originBase: "https://bioconductor.org",
  budget: 10_000,
  approvalTimeout: "72 hours" as const,
};

/**
 * The instance ID *is* the observation: one Workflow instance per distinct
 * upstream version pair, so a cron double-fire, a retry, or a manual replay of
 * the same state is a no-op rather than a duplicate alert. The flip side is
 * also deliberate: a refused or timed-out instance is not re-raised every 15
 * minutes -- the same pair alerts once per 30-day retention window.
 */
export function rollInstanceId(pair: Pair): string {
  // Instance IDs allow only alphanumerics, dashes and underscores.
  return `roll-${pair.release}-${pair.devel}`.replaceAll(".", "_");
}

export async function readPair(originBase: string = DEFAULTS.originBase): Promise<Pair> {
  const one = async (name: string) => {
    const res = await fetch(`${originBase}/${name}`, { cf: { cacheTtl: 0 } });
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const v = parseVersionFile(await res.text());
    if (v === null) throw new Error(`${name}: not a version file`);
    return v;
  };
  return { release: await one("bioc-version"), devel: await one("bioc-devel-version") };
}

/**
 * The alert. `bioc-notify@.service` files a GitHub issue on failure of the
 * host-side units; a Workflow has no systemd to hang OnFailure off, so this is
 * where the Workflow-native equivalent hooks in. Left as a webhook POST because
 * a GitHub token in a Worker secret is a decision, not a detail.
 * `url` unset = log only.
 */
export async function notify(url: string | undefined, message: string): Promise<{ notified: boolean }> {
  console.log(JSON.stringify({ type: "release-roll", message }));
  if (!url) return { notified: false };
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  return { notified: true };
}
