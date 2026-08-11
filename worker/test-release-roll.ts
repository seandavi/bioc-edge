// node --test worker/test-release-roll.ts
//
// Covers the pure half of the INERT release-roll pilot. A `waitForEvent` needs
// a live Workflow instance, so what is tested here is what an instance would
// have decided -- the same split keys.ts already keeps between pure functions
// and the fetch handler.
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseVersionFile,
  compareVersions,
  redirectVersionBound,
  detectDrift,
  checkDeleteBudget,
  approvalOutcome,
  rollInstanceId,
} from "./src/workflows/release-roll.ts";
import redirects from "./src/redirects.json" with { type: "json" };
import type { Redirects } from "./src/keys.ts";

const RS = redirects as Redirects;

test("version files are parsed strictly, so a bad fetch cannot look like a roll", () => {
  assert.equal(parseVersionFile("3.24\n"), "3.24");
  assert.equal(parseVersionFile("  3.9 "), "3.9");
  // An error page, a redirect body, a truncated read -- all must be null, not
  // a version. Comparing garbage against the bound is how a workflow declares
  // a release roll that did not happen and files an alert nobody can act on.
  assert.equal(parseVersionFile("<!DOCTYPE html>"), null);
  assert.equal(parseVersionFile(""), null);
  assert.equal(parseVersionFile("3"), null);
  assert.equal(parseVersionFile("3.24 (devel)"), null);
});

test("versions compare numerically -- 3.9 is older than 3.10", () => {
  // Lexically "3.9" > "3.10", which would make the roll from 3.9 to 3.10 read
  // as going backwards and suppress the alert entirely.
  assert.ok(compareVersions("3.9", "3.10") < 0);
  assert.ok(compareVersions("3.24", "3.9") > 0);
  assert.equal(compareVersions("3.24", "3.24"), 0);
});

test("the redirect bound is read out of the shipped table, not kept as a copy", () => {
  // gen-redirects.ts expands container-binaries per version up to a hardcoded
  // loop bound. Deriving it from the generated output means the two cannot
  // disagree -- which is precisely how the number in #34 went stale.
  assert.equal(redirectVersionBound(RS), "3.24");
  assert.equal(redirectVersionBound({ exact: {}, prefix: [] }), null);
  // Highest wins regardless of array order, and unrelated prefix rules are
  // ignored rather than parsed as versions.
  assert.equal(
    redirectVersionBound({
      exact: {},
      prefix: [
        { from: "/packages/3.10/container-binaries/", to: "x", keepSuffix: true },
        { from: "/packages/3.9/container-binaries/", to: "x", keepSuffix: true },
        { from: "/overview", to: "/about", keepSuffix: true },
      ],
    }),
    "3.10",
  );
});

test("drift is detected when devel rolls past the redirect bound", () => {
  // The live pair today: nothing missing, no alert.
  assert.deepEqual(detectDrift({ release: "3.23", devel: "3.24" }, "3.24"), {
    drifted: false,
    missingRedirectVersions: [],
  });
  // The roll #34 is about. 3.25 has no container-binaries redirect, so those
  // URLs 404 silently until someone bumps the generator.
  assert.deepEqual(detectDrift({ release: "3.24", devel: "3.25" }, "3.24"), {
    drifted: true,
    missingRedirectVersions: ["3.25"],
  });
  // Two rolls missed, not one -- the failure mode is silence, so it can run
  // for a year before anyone notices.
  assert.deepEqual(detectDrift({ release: "3.25", devel: "3.26" }, "3.24").missingRedirectVersions, [
    "3.25",
    "3.26",
  ]);
  // No table means no comparison. Claiming drift here would alert on a deploy
  // problem while describing it as a release roll.
  assert.equal(detectDrift({ release: "3.23", devel: "3.24" }, null).drifted, false);
});

test("the instance ID is the observation, so duplicate triggers collapse", () => {
  // Content-addressed: same pair -> same ID -> the cron handler finds the
  // existing instance and creates nothing. Distinct pairs must not collide,
  // and the ID must stay within Workflows' [a-zA-Z0-9_-] charset.
  const id = rollInstanceId({ release: "3.24", devel: "3.25" });
  assert.equal(id, rollInstanceId({ release: "3.24", devel: "3.25" }));
  assert.notEqual(id, rollInstanceId({ release: "3.25", devel: "3.26" }));
  assert.match(id, /^[a-zA-Z0-9_-]+$/);
});

test("the delete guard refuses an oversized delete", () => {
  // sync.sh runs `rclone delete --files-from "$gone"` unconditionally today.
  // ~129,000 objects is the number #34 measured for a scope change.
  assert.equal(checkDeleteBudget(129_000, 10_000).allowed, false);
  assert.match(checkDeleteBudget(129_000, 10_000).reason, /exceeds budget/);
  // An ordinary run is unaffected -- the guard must not need a human for the
  // hundreds of deletions a normal nightly rebuild produces.
  assert.equal(checkDeleteBudget(412, 10_000).allowed, true);
  assert.equal(checkDeleteBudget(10_000, 10_000).allowed, true);
  // Acknowledging the exact count is what unlocks it.
  assert.equal(checkDeleteBudget(129_000, 10_000, 129_000).allowed, true);
  // And an acknowledgement of a *different* count does not. Approval is for
  // the plan that was shown, not for whatever the plan becomes later.
  assert.equal(checkDeleteBudget(129_000, 10_000, 100_000).allowed, false);
  assert.match(checkDeleteBudget(400_000, 10_000, 129_000).reason, /plan changed since approval/);
});

test("the approval gate: silence and rejection are the same answer", () => {
  const small = 412;
  const huge = 129_000;
  const budget = 10_000;

  // Timeout. The whole point of the gate is that an unanswered alert leaves
  // the destructive step unrun -- not that it eventually proceeds.
  assert.deepEqual(approvalOutcome(null, huge, budget), {
    act: "alert",
    reason: "no approval before timeout",
  });
  assert.equal(approvalOutcome({ approved: false, by: "seandavi" }, small, budget).act, "alert");

  // Approved, and small enough that no acknowledgement is required.
  assert.deepEqual(approvalOutcome({ approved: true, by: "seandavi" }, small, budget), {
    act: "apply",
    reason: `${small} deletions within budget ${budget}`,
  });

  // Approved, but a bare yes does not authorise 129k deletions. This is the
  // case that separates this from a yes/no gate.
  const bare = approvalOutcome({ approved: true, by: "seandavi" }, huge, budget);
  assert.equal(bare.act, "alert");
  assert.match(bare.reason, /needs explicit acknowledgement/);

  // With the count acknowledged, it applies.
  assert.equal(
    approvalOutcome({ approved: true, by: "seandavi", acknowledgedDeletes: huge }, huge, budget).act,
    "apply",
  );
  // Acknowledged 129k, plan is now 400k: refused, not applied.
  assert.equal(
    approvalOutcome({ approved: true, by: "seandavi", acknowledgedDeletes: huge }, 400_000, budget).act,
    "alert",
  );
});
