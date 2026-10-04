---
name: review-handoff
description: Review a Claude-authored ASCII Atlas handoff before implementation. Round 1 is Codex only; round 2 is Claude followed by Codex validation, with no third round. Return a verdict and exact amendments; --apply saves only a ready candidate. Use when invoked as $review-handoff or asked to review a handoff without implementing it.
---

# Review a handoff in two rounds

Usage: `$review-handoff [--fast] [--apply] [--candidate <prior candidate path>] <task | path to handoff.md>`

This skill authorizes reviewer CLI runs and review artifacts inside the task's main-checkout `.plans/` folder. Default mode preserves the original handoff. `--apply` authorizes replacing that handoff with a ready candidate. Source edits, worktree creation, branch synchronization, commits, pushes, PRs, task-folder moves and task-status updates belong to the caller, not this skill.

The sequence is fixed: **round 1: Codex; round 2: Claude → Codex validation**. Run round 2 even if round 1 has no findings. A blocking condition or failed run can stop earlier. Never add a third round, restart the two rounds automatically, or substitute a review by the coordinating session for a required process.

Use the shared [review prompt](references/handoff-review-prompt.md) for both reviewers and the [validation prompt](references/handoff-validation-prompt.md) for round 2's Codex run.

## Models and commands

| Role | Model | Effort | Speed |
| --- | --- | --- | --- |
| Round 1 reviewer | Sol 6.1 (`gpt-6.1-sol`) | max | `<speed>` |
| Round 2 reviewer | Claude Opus 5.5 (`claude-opus-5-5`) | high | normal |
| Round 2 validator | Sol 6.1 (`gpt-6.1-sol`) | max | `<speed>` |

The current session coordinates, checks evidence and edits only scratch candidates (and the original when authorized). There is no extra coordinator CLI run. Each listed reviewer/validator starts in a fresh process. Never change models or efforts or fall back to another model.

Resolve the newest installed binaries once with `pnpm.cmd -C <repo> --silent cli:latest codex` and the same command with `claude`. `<repo>` is the checkout containing this skill, `<skill-dir>/../../..`. Check `$LASTEXITCODE` immediately after each command; failure ends with `error`. Retain the printed absolute paths and versions. Never use bare `codex` or `claude`.

`<speed>` is `-c 'service_tier="fast"' --enable fast_mode` with `--fast`, otherwise `--disable fast_mode`. Pass it explicitly to both Codex runs. Claude remains at normal speed.

All reviewer and validator launches, including background launches, use `<checkout>` as their working directory. On Windows, quote paths and use single-quoted prompt strings, or put the exact prompt in a scratch file and pass `(Get-Content -Raw '<prompt-path>')`. Capture stdout with `Out-File -Encoding utf8`, never plain `>`. Capture native exit codes immediately. If a run needs a background process, use `Start-Process -WindowStyle Hidden`, capture its exit code, and poll with short waits while providing progress updates.

## 1. Resolve and snapshot

1. Identify `<main-checkout>` from the first `git worktree list --porcelain` entry. Resolve a task name to exactly one `.plans/{todo,active,paused,done}/<task>/handoff.md`, or use the explicit path. It must be a handoff in the main checkout's task folder. Missing or ambiguous targets end with `error`.
2. Read the original handoff, `AGENTS.md` and the task's `.plans/README.md` row. Validate its branch/worktree identity with `git worktree list`. For an existing task with a checkout, use it. If an existing task branch has no worktree, use `<main-checkout>` as `<checkout>` and read that branch through pinned git objects; fetch its retained remote branch when necessary to resolve its SHA. For a clearly new task without a branch/worktree, also use `<main-checkout>` as `<checkout>` and inspect the proposed base from git objects. Never create or restore a worktree in standalone review. Record the planned branch/path separately from the actual review checkout. A path owned by another task is `blocked`; an unavailable branch that an existing task requires is `error`.
3. Fetch `origin/main` from `<checkout>`; a failed fetch is `error`. Pin its SHA and the task branch's SHA when it exists. Do not merge or switch branches. Read clean files from the matching checkout, and committed versions with `git show <sha>:<path>` when reviewing another ref or a dirty file. When the main checkout is only the fallback execution directory, read all committed review inputs from pinned git objects. Evidence must state which revision it describes.
4. Create a unique `<task-dir>/handoff-review/run-<timestamp>-<uuid>/` folder, refusing an existing path. This is `<scratch>`. All invocation artifacts go there; never reuse earlier reports or verdicts. Copy the original to `original.md` and save its SHA-256 hash. Normally copy it to `candidate.md` too. With an explicitly supplied `--candidate`, use the saved proposal as described below.
5. Save `<scratch>/baseline.json` with the checkout's HEAD, `git status --porcelain`, separate hashes of `git diff --binary` and `git diff --cached --binary` (unstaged and staged changes), and live byte/existence hashes of tracked and nonignored untracked files. Record named planned targets too, with null for an absent file; extend the inventory for new targets introduced by round 1 before round 2 without replacing earlier fingerprints. Include explicitly reviewed nongit inputs (such as generated data) before a process reads them; do not inventory unrelated ignored caches. Before every reviewer/validator, also hash the original handoff, candidate, context, ledger and that round's input. Compare the checkout baseline and these protected inputs afterwards; only the coordinator may change scratch inputs between processes. Except for the verified external fast-forward below, a changed checkout or protected input ends with `stale` if another session changed it, or `error` if the review process changed it; report the paths and never revert them. When authorship cannot be established, use `stale`. Test caches may change in ignored locations.
6. Write `context.md` with the target identity, pinned revisions, relevant task-index/dependency facts and source-reading rules. Write an initially empty `ledger.md`. The ledger carries finding IDs, factual/design classification, accepted/rejected/unresolved decisions, evidence, reasons and exact amendments. Keep it compact; previous raw reports remain available for specific disputes rather than being passed as whole transcripts.

### External updates to the fallback main checkout

Only when `<checkout>` is the main checkout used as the fallback execution directory, a confirmed external fast-forward may pass the checkout guard. Require every condition:

- The checkout remains on `main`, and its baseline HEAD is an ancestor of its observed HEAD. Tie both SHAs to a confirmed action by another session or the user; a clean status or reflog alone does not establish authorship. A reviewer-caused update is `error`; uncertain authorship is `stale`.
- The complete `inspectedPaths` union is unchanged between those HEADs, including referenced targets and planned absent files. At the end, recheck earlier allowed advances against the final union, which may have grown during the review.
- Status, staged/unstaged diff hashes, baseline dirty-file bytes, and the nonignored untracked inventory and hashes are unchanged. Every remaining tracked byte/existence change must exactly match the checked-out committed changes between the baseline and observed HEADs; unexplained changes fail the guard.
- The original handoff, protected scratch inputs and reviewed nongit inputs still match their fingerprints. This exception does not authorize reviewer mutations or apply to a task worktree.

Record each allowed advance and its evidence separately. Preserve the original baseline and pinned review SHAs; never overwrite them to hide drift. All other guard changes retain the `stale`/`error` rules above.

`--candidate` permits a new user-requested invocation to review a previous run's saved proposal without rediscovering discarded amendments. The path must be that run's `candidate.md` under this same task's scratch. Verify the adjacent `result.json` identifies this task/branch and its candidate hash matches the supplied bytes; otherwise stop with `error`. If the current original matches neither that record's `originalHash` nor `candidateHash`, stop with `stale`: the original changed after that proposal and must be reconciled before reuse. Task-folder status may have changed since the record, so compare task identity rather than requiring its historical absolute handoff path to remain unchanged. Copy verified bytes into the new `candidate.md`, verify the copied hash, and record provenance in `context.md`. Carry forward compact decision history with previous invocation IDs qualified by their run path. Always snapshot the current original separately, resolve current code revisions, and run both rounds again; prior reports or readiness do not satisfy either round. Never select a prior candidate automatically.

Always write the canonical result to `<scratch>/result.json`. Optional `Result file: <path>` requests an additional identical JSON copy within this task's scratch. Refuse a preexisting requested path or one outside the task folder; publish results only after the run finishes. Every caller receives the canonical invocation path.

## 2. Round 1: Codex reviews

Create `<scratch>/round1/`, copy the candidate to its immutable `input.md`, and write a prompt file naming:

- `<skill-dir>/references/handoff-review-prompt.md`
- Mode: `full`, round: `1`
- the absolute `input.md`, `context.md`, `ledger.md`, checkout and main-checkout paths

Run from `<checkout>`:

```powershell
& '<codex>' exec -m gpt-6.1-sol -c 'model_reasoning_effort="max"' <speed> -s danger-full-access -C '<checkout>' -o '<scratch>/round1/codex-review.md' (Get-Content -Raw '<scratch>/round1/prompt.txt')
```

Require a successful exit, a newly written report with `**Verdict:**`, and complete findings/amendments/inspected-path sections; zero findings is explicit. Check the guard baseline. Missing or malformed output is `error`, not a clean round.

Verify every finding against its evidence. Accept supported factual and design amendments; record rejected claims and reasons. A factual drift finding updates the candidate rather than causing `blocked`. Require literal replacement text to match the current candidate; incompatible overlapping amendments are `stalled`, and a nonmatching replacement is `error`. Apply accepted amendments to `candidate.md`, with a `## Review amendments` record (design entries in bold), then read the whole candidate for consistency. Keep the round's input and raw report unchanged. Save the round's decisions and candidate hash.

If a genuine blocked premise is confirmed, finish with `blocked`. Otherwise continue to round 2, including when round 1 was already ready. No separate Codex validator runs in round 1.

## 3. Round 2: Claude reviews, Codex validates

Create `<scratch>/round2/` and copy the amended candidate to immutable `input.md`. Both processes review this same snapshot, context and ledger.

### Claude

Write a prompt naming the shared `handoff-review-prompt.md`, round `2`, and the absolute input/context/ledger/checkout/main-checkout paths. Use mode `follow-up`: inspect round 1's amendments, unresolved/rejected claims where evidence changed, and their effects on the handoff's goal, invariants, dependencies, steps and verification. If round 1 changed scope, architecture or core assumptions, use mode `full`. When round 1 changed nothing, perform an independent check of the plan's critical assumptions and completeness. Read the whole candidate for coherence in every case, and inspect repository files relevant to the claims rather than repeating unrelated source reads.

Run from `<checkout>`:

```powershell
& '<claude>' -p (Get-Content -Raw '<scratch>/round2/claude-prompt.txt') --model claude-opus-5-5 --effort high --dangerously-skip-permissions --output-format text | Out-File -Encoding utf8 '<scratch>/round2/claude-review.md'
```

Capture Claude's native exit code immediately; validate fresh output and the same report sections as round 1, then check the guard baseline. A failed or malformed report is `error` and ends the run before validation. Claude cannot amend the handoff or spawn additional reviewers.

### Codex

Write a prompt naming `<skill-dir>/references/handoff-validation-prompt.md`, Claude's current report, and the same round-2 input/context/ledger/checkout/main-checkout paths.

```powershell
& '<codex>' exec -m gpt-6.1-sol -c 'model_reasoning_effort="max"' <speed> -s danger-full-access -C '<checkout>' -o '<scratch>/round2/validation.md' (Get-Content -Raw '<scratch>/round2/validation-prompt.txt')
```

Require a successful exit and new output with a verdict, a validation table covering every Claude finding, concrete amendments for all valid/partly valid findings, and explicit noticed/inspected-path sections. Check the guard baseline. Codex validates claims and replacement text using the affected code; it does not repeat the full audit. It can reject an unsupported Claude blocked verdict. Serious omissions it notices remain unresolved and prevent `ready`.

Record all decisions in the ledger. Before editing, check accepted amendments against prior decisions: an accepted recurring claim or reversal ends with `stalled` unless changed evidence or a demonstrated error in the earlier decision explains it. Record that explanation. Supported corrections are required amendments and therefore finish `capped` when applied after round 2. For stalled conflicts, report the entries and leave the candidate at its last coherent version.

Determine the final outcome:

- **Confirmed unfixable premise:** `blocked`.
- **No valid required amendments, no serious noticed/unresolved issues, and no contradiction:** `ready`. Claude's raw verdict alone cannot grant readiness; a raw `ready-with-amendments` whose findings are all invalid can validate as ready.
- **Valid required amendments:** apply them to the scratch candidate and save them, then `capped`. These edits occurred after the last review of the candidate; do not report them ready or apply them to the original.
- **Unresolved serious omissions:** `capped`, with the remaining issues.

Round 2 is the hard limit. No third review, additional validation pass or automatic fresh invocation follows capped/stalled/error/stale. A later user-requested invocation is a new run with its own two-round budget.

## 4. Freshness, apply and report

Before publishing a ready result, require `candidate.md` to match `round2/input.md` byte for byte. A mismatch is `error`; the last reviewed snapshot cannot approve a different candidate. Check the checkout guard and original handoff hash again, then fetch `origin/main` and resolve the current task branch SHA. For each ref that moved, compare the pinned and observed git trees over the complete `inspectedPaths` union, including referenced targets and planned absent files; directory entries cover their descendants. Record changed paths and both SHAs. An unrelated revision advance with no changes in this union can pass freshness, subject to the independent checkout mutation guard. Any changed reviewed input, missing required ref or failed comparison is `stale` (a failed fetch is `error`); preserve artifacts and let the caller synchronize before a later review. Pinned `mainSha` and `branchSha` continue to identify the reviewed revisions; store newer observations separately. Drift is not an unfixable premise and must never be reported as `blocked`.

With `--apply` and `ready`, replace only the original handoff with the exact ready candidate after those checks. Verify the saved bytes match the candidate hash and set `applied: true`. If already identical, verify the hash and also set `applied: true`. All other combinations leave the original unchanged. Standalone review never moves the task folder or updates its index status. Preserve scratch for `$merge-pr` cleanup.

Report the status, round count (of 2), reviewer sequence, design amendments first, other accepted/rejected/unresolved entries, checks run, artifact paths, speed and resolved CLI versions. `--apply` must report whether the original was updated. Explain capped output as a saved proposal requiring a later review, not permission to implement.

Write the JSON result and end the final report with the same object in a fenced `review-handoff-result` block:

```json
{
  "status": "ready",
  "roundCount": 2,
  "task": "<task folder name>",
  "handoff": "<absolute original handoff path>",
  "scratch": "<absolute unique invocation folder>",
  "candidate": "<scratch>/candidate.md",
  "baseline": "<scratch>/baseline.json",
  "originalHash": "<SHA-256 before review>",
  "candidateHash": "<SHA-256 of final candidate>",
  "applied": true,
  "checkout": "<absolute review checkout>",
  "branch": "<planned task branch>",
  "branchSha": "<reviewed task branch SHA, or null for a new task>",
  "mainSha": "<reviewed origin/main SHA>",
  "observedRevisions": {
    "mainSha": "<latest observed origin/main SHA>",
    "branchSha": "<latest observed task branch SHA, or null>",
    "comparisons": [{ "ref": "origin/main", "from": "<pinned SHA>", "to": "<observed SHA>", "changedInspectedPaths": [] }],
    "allowedCheckoutAdvances": []
  },
  "inspectedPaths": ["<repo-relative reviewed input paths>"],
  "fast": false,
  "cli": { "codex": "<version>", "claude": "<version>" },
  "rounds": [
    { "round": 1, "reviewer": "codex", "reviewerVerdict": "ready-with-amendments", "accepted": ["1.1"], "rejected": [], "unresolved": [] },
    { "round": 2, "reviewer": "claude", "validator": "codex", "reviewerVerdict": "ready", "validatorVerdict": "ready", "accepted": [], "rejected": [], "unresolved": [] }
  ],
  "stopReason": null
}
```

Allowed statuses: `ready`, `capped`, `stalled`, `blocked`, `stale`, `error`. Report only rounds actually started; never claim ready without both rounds. `inspectedPaths` is the union of reviewed source/config/docs paths, including referenced task targets and planned absent files. `observedRevisions` records final observations and any ref comparisons; each allowed checkout advance includes its baseline/observed SHAs and external-authorship/guard evidence. Preserve pinned revisions even when later observations pass freshness.

Store each process's raw verdict as `reviewerVerdict` or `validatorVerdict`; round 1 has no validator field. These verdicts describe the inspected input. The top-level status also accounts for accepted amendments and guards: for example, round 2 can have Claude `ready-with-amendments`, Codex `ready` after rejecting every finding, and overall `ready`; any required amendment applied after round 2 makes the overall status `capped`. Early failures still produce a result and report when scratch could be resolved; unavailable hashes/revisions/versions are null and `applied` is false. Results from previous invocations cannot replace missing or failed current output.
