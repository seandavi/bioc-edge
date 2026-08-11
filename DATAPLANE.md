# A data plane for bioconductor.org

Status: design note, 2026-08-08. One pilot exists in code and is undeployed
(`worker/src/workflows/release-roll.ts`, [ADR 0007](docs/adr/0007-cloudflare-workflows-for-the-release-roll-guard.md));
everything else here is a sketch, not a commitment.

Root-level and deliberately not part of the public site: it names internal hosts, unit names and
paths, and it speculates about upstream Bioconductor plans that are not this project's to announce.
Marked **[V]** for verified in this repo or a cited source and **[A]** for assumption — the
assumptions are the parts most likely to be wrong, so they are flagged rather than smoothed over.

## Why this note exists

The site's content pipeline is one bash script on one host behind two systemd timers. That is the
right amount of machinery for what it does, and it is not the constraint. The constraint is that
every *decision* the pipeline has to make — is this deletion normal, has the release rolled, did
last night's run finish — is either made implicitly or made by a human reading a log. There is
nowhere for a run to hold state, nowhere for a human to say yes to a specific plan, and no place
that survives the sync host failing.

That gap is small today and grows with every thing bolted onto the site. Writing down the shape
now costs one document; discovering it after four such things are wired differently costs a
rewrite.

## 1. Prior art

Condensed from a survey done 2026-08-07/08. Sources are Cloudflare's own docs and blog posts
except where noted.

### Cloudflare Workflows [V]

Durable execution on Workers. `WorkflowEntrypoint` with `step.do()` (per-step retry and backoff),
`step.sleep()` / `sleepUntil()`, `step.waitForEvent()`. GA April 2025.

| Limit (paid) | Value |
|---|---|
| Steps per instance | 10,000 default, 25,000 configurable; sleeps don't count |
| Step return / event payload | **1 MiB** |
| Sleep | up to 365 days |
| CPU per step | 30s default, to 5 min |
| Retries per step | 10,000 max |
| Concurrent instances | 50,000 |
| Persisted state per instance | 1 GB |
| Completed-instance history | **30 days** (3 on free) |
| `waitForEvent` timeout | 24h default, 1s–365d range; throws on timeout |

Two properties do real work in the pilot. `waitForEvent` **buffers an event sent before the
instance reaches the wait step**, which is what makes a human-approval gate safe to build rather
than a race to lose. And sleeping incurs no CPU charge, so a twice-yearly job that waits three days
for a person is effectively free.

V2 (May 2026) sharded the control plane from one account-level Durable Object into per-workflow
DOs plus a leasing "Gatekeeper" — confirming Workflows is DOs underneath — and added Agents-SDK
integration and per-tenant "Dynamic Workflows".

Rough edges, all of which the pilot accepts rather than solves: no graceful cancellation (forced
termination, no cleanup hooks); step-level detail requires the rate-limited REST API; **versioning
of in-flight instances against a new deploy is undocumented**; and `wrangler dev` does not enforce
production limits.

### Durable Objects as workflow state [V]

DO-as-actor — single-threaded, strongly consistent, embedded SQLite, alarms for timeouts — is an
established pattern with Cloudflare itself as the strongest prior art: Workflows V1 literally was
one DO holding all state. The Agents SDK productises it (per-instance SQLite, cron/alarm
scheduling, webhook and queue triggers, hibernation) and delegates long work to Workflows. OSS:
PartyKit/PartyServer, now under Cloudflare's org; `threepointone/durable-scheduler`.

The implication for us: "DO holds run state, Workflows provides execution semantics" is not a
clever synthesis, it is what Cloudflare converged on after shipping both.

### Managed alternatives [V]

| Option | Fit here |
|---|---|
| Temporal / Temporal Cloud | Deterministic replay, polyglot, needs a worker fleet. Overkill for ~2 runs/year. |
| Restate | Single binary, lighter than Temporal, can invoke Workers services. Closest credible alternative. |
| Inngest | Steps run in your own app over HTTP; least lock-in. |
| Trigger.dev | Managed compute, usage-priced. |
| AWS Step Functions | Zero-ops on AWS; 256 KiB payload cap is tighter than Workflows' 1 MiB. |
| Prefect | Batch/ETL DNA. Wrong shape for event-driven glue. |

Heuristic, stated so it can be re-applied rather than re-argued: **already on Workers + low volume
+ simple linear flow → Workflows wins on ops and cost. Complex compensation, child workflows,
cross-language workers, or instances that must survive months of deploys → Temporal or Restate.**
If the data plane grows the right-hand column, revisit; do not stretch Workflows into it.

### Scientific / bioinformatics prior art [V]

None found on Cloudflare specifically. The nearest neighbours:

- **Cloudflare's own CI/CD platform built on Workflows** — pipelines as TypeScript Workflows,
  artifact-push triggered, Sandbox SDK for isolated builds, R2 for caches, DOs for stateful
  "healing agents", across millions of repos. This is essentially the blueprint for the long-term
  ambition, from the vendor, at a scale that settles the "does this pattern hold up" question.
- `cloudflare/serverless-registry` — a container registry on Workers + R2.
- Bioconda's update bot — watches CRAN/PyPI/GitHub, auto-files PRs. The contributor-automation
  *pattern* exists in bioinformatics; it just isn't on Cloudflare.

### The dumb-worker / dispatch pattern [V]

For anything needing real compute that cannot run on Workers (R, rsync against the upstream docroot host, DuckDB
over the log archive): **Cloudflare Queues HTTP pull consumers.** External compute in any language
pulls batches over HTTPS with an API token — per-message `lease_id`, visibility timeout 30s default
/ 12h max, at-least-once delivery, explicit retry-with-delay. The canonical named version of this
shape is GitHub Actions self-hosted runners: a long-polling listener receives a job assignment,
hands it to a worker process, streams status back. Pull-based, no inbound ports on the compute
side — which matters, because the sync host has none open and should keep it that way.

Failure modes are known and each has a fix: worker dies mid-task (visibility-timeout redelivery
plus a workflow-side step timeout); duplicate delivery (idempotency keys `{run_id, step_id,
attempt}`); zombie completion, where a late callback lands after a retry already fired (a DO's
single-threaded compare-on-attempt check).

### Existing Workers prior art in this ecosystem [V]

`icegate` — a **stateless** Iceberg REST catalog gateway, running on Cloudflare Workers / Node /
Docker, claiming 0.40 ms median gateway overhead — and `iceberg-registry` are already in this orbit
[V — READMEs, 2026-08-08], and `ANALYTICS.md` already puts an Iceberg table in R2. Two things
transfer. First, "query the access log from a Worker" is not new ground. Second, and more useful
here: icegate's stated design is *stateless, holds no metadata, it's a proxy*. That is the opposite
end of the spectrum from what this page needs, and the contrast is the point — the data plane's
whole value is the state icegate deliberately refuses to hold. Do not reach for the same shape.

## 2. The shape

Three layers, chosen for what each is actually good at rather than for symmetry:

```
  trigger  ──▶  Workflow (execution)  ──▶  Queue  ──▶  pull consumer (real compute)
                      │                                      │
                      │  waitForEvent                        │  HTTP callback
                      ▼                                      ▼
                   human                            Durable Object (run state)
                      │                                      │
                      └──────────── R2: manifests, artifacts, audit ───────────┘
```

**Workflows is where to focus.** Every pipeline the site needs is a linear sequence of steps with
retries, one or two waits, and a destructive step near the end. That is exactly the shape
Workflows encodes, and encoding it in bash means re-implementing retry, resume and idempotency per
script — which is how `sync.sh` ended up 250 lines with a comment per incident.

**Durable Objects, only for state that outlives an instance.** Completed-instance history is
retained 30 days [V], so anything that must answer "when did this last succeed" or "is a run
already in flight" over a longer horizon needs a DO (or D1, or R2). Two concrete near-term uses:
a single-flight lock so two sync runs cannot overlap, and a last-success timestamp per pipeline
that a staleness check reads. Deliberately *not* a use: orchestration. Workflows V1 was a DO;
rebuilding that is the mistake this note exists to prevent.

**Queues plus pull consumers for anything off-Cloudflare.** rsync against the upstream docroot host, R package
builds, DuckDB over 7.1B log rows — none of that runs in an isolate, and none of it should need
an inbound port. The Workflow enqueues, the host pulls, the host calls back, the Workflow (or DO)
arbitrates. At-least-once everywhere, so callbacks carry idempotency keys.

**R2 for everything large.** The 1 MiB step-output cap is not a soft limit to design near — the
release-roll pilot already hits it at 129,000 keys. Steps pass `{key, count}`, never lists.

### The wider ambition, sketched

Not to be built yet, and listed so the near-term work can be sequenced without painting itself
into a corner:

1. **Package build results, sourced rather than mirrored.**
   [#54](https://github.com/seandavi/bioc-cloudflare/issues/54) is the tracked version of this, and
   it is worth reading before repeating the summary it is usually given: it does **not** describe
   an HTTP API and does not mention r-universe or a `_jobs` endpoint anywhere [V — checked
   2026-08-08]. What it describes is an rsync pull from the build machines
   (`biocbuild@<machine>:~/public_html/BBS/<biocversion>/<buildtype>/nodes`, per `Rakefile:383` in
   the site repo), blocked on [#46](https://github.com/seandavi/bioc-cloudflare/issues/46), needing
   a fresh credential and a consumer-side check because the disabled path pulls per-node `.dcf`
   while the live path pulls aggregated `BUILD_STATUS_DB.txt`. **[A]** that r-universe's `_jobs`
   API is relevant at all — that belief is in circulation but has no support in this repo, and
   should be confirmed or dropped before it becomes a design input.

   #54 also still asserts that `rsync-filter` mirrors only release + devel `*-LATEST`, which ADR
   0006 superseded on 2026-08-07. Second issue on this page whose premise has expired; see §3.0.
2. **Package management moving from `git.bioconductor.org` to GitHub** [A] — nothing in *this* repo
   documents it, so treat every specific as unvalidated. The nearest hard evidence is in the
   sibling `bioc-contrib-intelligence`, which ingests two submission trackers at once *"because
   they overlap during a live migration"*: `Bioconductor/Contributions` (legacy, ~4,300 closed
   issues, 2016–2025) and `Bioconductor/BiocContributions` (new, ~113 issues, live, described as
   R-universe / GitHub Actions) [V — read 2026-08-08]. That is evidence of a live tracker
   migration, which is not the same claim as the git server moving, and it is probably also where
   the r-universe association in (1) came from. If webhook-triggered Workflows are ever the
   integration point, this is the surface they would attach to.
3. **Agentic tooling that fixes packages.** `bioc-contrib-intelligence` is the closest existing
   thing — a database plus bot toolkit for the submission-review process, already holding the
   corpus such tooling would need. The Agents SDK's "DO as long-lived actor, delegate long work to
   Workflows" split is the shape that would connect it to anything here.
4. **Contributor workflows generally** — the Bioconda update-bot pattern, applied to Bioconductor.

Sequencing note: (1) and (4) are additive and can land whenever. (2) and (3) both want a durable
identity per package or per contributor, which is the first genuine DO use case beyond a lock.
None of them should go first, because none of them fix a thing that is currently broken.

## 3. Near-term roadmap

Ordered by "what is broken now", not by what is interesting. Everything here is about this repo's
own refresh pipeline.

### 0. Release-roll guard — the pilot [in code, undeployed]

`worker/src/workflows/release-roll.ts`, ADR 0007, issue
[#34](https://github.com/seandavi/bioc-cloudflare/issues/34). Detects that devel has rolled past
`gen-redirects.ts`'s hardcoded bound, estimates the deletion blast radius, blocks on
`waitForEvent` for an approval that must acknowledge a specific object count, and alerts on
timeout or rejection.

**Issue #34's premise has half-expired and this is the most important thing on the page.** ADR 0006
(2026-08-07) removed the per-version `checkResults` carve-outs from `rsync-filter` [V — read the
file]. checkResults is now mirrored in full for every release, so a roll no longer takes a version
out of scope and no longer produces the ~129,000-object deletion #34 measured. What survives:

- `worker/gen-redirects.ts:100` still hardcodes `v <= 24` for the container-binaries expansion.
  Miss it and container-binary URLs for the new release 404 silently [V].
- `sync.sh:184` still runs `rclone delete --files-from "$gone"` with **no count check whatsoever**
  [V]. That was never release-roll-specific; a filter edit, an upstream reorganisation, or a
  partial rsync all reach it. `PURGE_MAX` guards the *purge*, not the *delete*, and by the time it
  fires the objects are already gone.
- **A third hardcoded pair #34 does not list:** `justfile:12` `releases := "3.23,3.24"`, plus
  `data-packages` and `data-tree` each defaulting `bioc="3.23"` [V]. Same silent failure — the
  build fetches data for the old pair and the site renders it without complaint. Worth folding
  into the same detector, and worth taking as evidence that enumerating the hardcodes by hand is
  itself the unreliable step.

**To finish this:** the workflow writes `_ops/release-roll/approved.json` and nothing reads it.
Until `sync.sh` gates on that object the pilot detects and alerts but prevents nothing — which is
worse than obviously-absent if it is mistaken for wired.

### 1. A delete count guard in `sync.sh` [not started]

Independent of the pilot and cheaper: refuse to run `rclone delete` past a threshold without an
explicit override, exactly as `finish-load.sh:36,83` already guards the initial load
(`MAX_DELETES=2000`, refuses and exits) [V]. The pattern exists in this repo, it is nine lines of
bash, and the only reason the hourly path lacks it is that nobody wrote it there. This is the
smallest change on the page for the largest blast radius avoided, and it should probably land
before anything Workflows-shaped is deployed.

### 2. Sync-run supervision [not started]

Two observed failures, both this week:

- **Hardcoded absolute paths in the systemd units, unvalidated.** `bioc-sync.service` and
  `bioc-reconcile.service` both `ExecStart=` an absolute path into one checkout, and both hang
  `OnFailure=bioc-notify@%N.service` off it — which itself `ExecStart=`s `notify-failure.sh` from
  the same absolute path [V]. So the alert that reports a broken path is behind the same path.
  Broke silently for 4.5 hours on 2026-08-08, alert path included [V — observed]. A unit whose
  alerting shares the failure mode it alerts on has no alerting.
- **An interrupted run loses track of unfinished uploads until the weekly reconcile.** The upload
  candidate list comes from rsync's itemized delta, not from a source-of-truth diff, so a killed
  run's remaining candidates are simply forgotten. Worst case is six days of a partially-published
  tree with nothing reporting it [V — by construction; see `sync.sh` header].

Both are "did the run finish, and if not what was outstanding" — a durable run record. A DO holding
`{run_id, started, candidate manifest key, completed}` plus an alarm answers both, and the candidate
manifest in R2 makes a resumed run pick up rather than restart. This is the first thing that
genuinely wants a DO rather than a Workflow.

### 3. `shields/` needs an independent producer [not started]

43,773 badge SVGs, issue [#68](https://github.com/seandavi/bioc-cloudflare/issues/68), currently
produced by rake tasks on the host being retired. **Recommendation: replicate the rendered output,
do not reverse-engineer the rake tasks.** Reimplementing a generator on a host that is going away
is work whose output is verified against a thing that will not exist to verify against.

### 4. CI/CD for the site build and Worker deploy [not started]

`just data && just build && just sync && just deploy-worker` is entirely manual today.
`.github/workflows/test.yml` only tests and `docs.yml` only publishes the Quarto site — nothing
deploys [V]. This is ordinary GitHub Actions work, not a Workflows use case, and it is listed here
because manual deploys are what make every other item on this list harder to verify.

### 5. Download-stats scheduling and staleness alert [not started]

[ADR 0004](docs/adr/0004-download-statistics-are-generated-static-files.md):
*"An alert on stamp age is the one guard this design requires."* No such alert exists — a search
for stamp-age, `generated_at` or staleness logic across the shell, Python, TypeScript, CI and unit
files returns nothing [V, 2026-08-08] — and no scheduled trigger for the generation itself was
found either. The one guard an accepted ADR declared mandatory is unbuilt, and the failure mode is
the one this whole document is about: correct-looking output that quietly stopped updating. Natural first *scheduled* Workflow once the pilot has been
reviewed — a cron trigger, a Queue message to a puller with DuckDB, a callback, and a staleness
check with an alert.

## 4. Out of scope, for now

- **Anything ecosystem-wide before the refresh pipeline is supervised.** Explicit sequencing
  decision, not an oversight.
- **Replacing `sync.sh` or the systemd units.** They work. The gaps are guards and observability
  around them, not a rewrite. A Workflow that shells out to rsync is not an improvement over rsync.
- **Migrating the analytics pipeline.** `ANALYTICS.md` owns it; the only overlap is item 5's
  scheduled trigger.
- **A general-purpose job framework.** Every item above is one linear flow. The moment something
  needs child workflows or compensation, re-read the heuristic in §1 rather than building it here.
- **A second vendor.** The heuristic points at Workflows for what is on this page; adding Temporal
  or Inngest for it would add a failure surface without removing one.
- **`waitForEvent` instances that live for months.** In-flight versioning is undocumented [V], so
  every gate on this page is designed to be killable and re-derivable from scratch. Anything that
  cannot be re-derived should not use a long wait.

## 5. Assumptions worth validating before anything else is built

1. That r-universe's `_jobs` API has anything to do with build results here [A]. #54, the issue it
   is usually attributed to, never mentions it — it describes an rsync pull from the build
   machines. Either find the real source for this belief or drop it.
2. That the `git.bioconductor.org` → GitHub transition is happening on a timeline that matters here
   [A]. Nothing in this repo documents it, and the one piece of evidence nearby
   (`bioc-contrib-intelligence`'s dual tracker ingest) is about the *submission tracker* migrating,
   not the git server. Do not let one become the other by repetition.
3. That a Cloudflare API token scoped for Workflows event dispatch is acceptable to hold wherever
   approvals originate (GitHub Action, a person's shell) — a Workflow approval is only as good as
   the thing allowed to send the event. Unexamined.
4. That the sync host is staying. Half of §3 is about supervising it; if it is being retired the
   ordering changes.
