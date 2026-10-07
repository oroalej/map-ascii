---
name: review-handoff
description: Review a Claude-authored ASCII Atlas handoff before implementation. One Codex round by default (review, verify, apply the amendments with pnpm handoff:apply); --two-round adds a Claude review validated by Codex. Solves what it finds instead of pausing, returns the verdict and exact amendments, and --apply saves the reviewed handoff. Use when invoked as $review-handoff or asked to review a handoff without implementing it.
---

# Review a handoff

Usage: `$review-handoff [--fast] [--apply] [--two-round] [--candidate <prior candidate path>] <task | path to handoff.md>`

This skill authorizes reviewer CLI runs, review artifacts inside the task's main-checkout `.plans/` folder, and writing the task row's Handoff review cell in `.plans/README.md`. Default mode preserves the original handoff. `--apply` authorizes replacing that handoff with the reviewed candidate. Source edits, worktree creation, branch synchronization, commits, pushes, PRs, task-folder moves and other task-status updates belong to the caller, not this skill.

The sequence is **round 1: Codex**. With `--two-round`, **round 2: Claude → Codex validation** follows; use it when the owner asks for it on a large design handoff (a new subsystem, a schema change). Never add a round beyond that or substitute a review by the coordinating session for a required process. Reruns of a process (Retry, or a restart after the handoff itself changed) are not rounds.

One round is enough because a handoff is a plan: `$implement-handoff` re-verifies every citation against current `main` and solves drift itself (its step 3.2), and the PR gets its own review afterwards. The second round found three to five more amendments per handoff at the cost of two more processes (25 minutes), and running the review twice per task cost 1.5–2 hours before any code on 2026-10-07.

**Never pause.** Follow [shared.md](../review-pr/references/shared.md): Ends, Shared patterns, Rules, Binaries (`codex`, plus `claude` with `--two-round`) and Speed. The only ends are nothing to do (no such handoff: `error`; the work already landed on `main`: `blocked`) and a missing tool (`error`). Everything else is solved with Retry, Decide don't stall, and the rules below.

Use the shared [review prompt](references/handoff-review-prompt.md) for every reviewer and the [validation prompt](references/handoff-validation-prompt.md) for round 2's Codex run.

## Models and commands

| Role | Model | Effort | Speed |
| --- | --- | --- | --- |
| Round 1 reviewer | Sol 6.1 (`gpt-6.1-sol`) | high | `<speed>` |
| Round 2 reviewer (`--two-round` only) | Claude Opus 5.5 (`claude-opus-5-5`) | high | normal |
| Round 2 validator (`--two-round` only) | Sol 6.1 (`gpt-6.1-sol`) | high | `<speed>` |

The current session coordinates, checks evidence and edits only scratch candidates (and the original when authorized). There is no extra coordinator CLI run. Each listed reviewer/validator starts in a fresh process. Resolve `<codex>` (and `<claude>` with `--two-round`) once. `<speed>` goes to the Codex runs; Claude runs at normal speed and fixed `high` effort, never `--claude-effort`. Every launch, background ones included, uses `<checkout>` as its working directory and quotes paths. Prompts go in a scratch file passed as `(Get-Content -Raw '<prompt-path>')`. Launch each process in the background and poll its output file and exit code (shared.md, Long commands); never with a shell timeout.

**Process failures are retried.** A reviewer or validator gets Retry, writing to `<round>/attempt-<n>/`, when it:
- exits nonzero (including "Selected model is at capacity", rate limits and network errors)
- writes no report
- writes a report missing its verdict or required sections

Only an exhausted window ends the run (`error`, `model unavailable: <model>`).

## 1. Resolve and snapshot

1. Identify `<main-checkout>` from the first `git worktree list --porcelain` entry. Resolve a task name to `.plans/{todo,active,paused,done}/<task>/handoff.md`, or use the explicit path. It must be a handoff in the main checkout's task folder. No match ends with `error` (nothing to do). Several matches: use the first in the order active, paused, todo, done, and say which.
2. Read the original handoff, `AGENTS.md` and the task's `.plans/README.md` row. Take the planned branch/worktree from the handoff and check it with `git worktree list`:
   - An existing task with a checkout: use it as `<checkout>`.
   - An existing task branch without a worktree: use `<main-checkout>` as `<checkout>` and read that branch through git objects. Fetch `origin/<branch>` if needed. If the branch exists nowhere, treat the task as new.
   - A new task: use `<main-checkout>` as `<checkout>` and read the proposed base from git objects.
   - A planned branch or path that belongs to another task is not a stop: round 1's context notes it, and the coordinator writes an amendment that derives the branch (`codex/<topic>`) and worktree (`worktrees/<short>`) from this task's folder name, unless a reviewer supplies a better one.
   Never create or restore a worktree in standalone review.
3. Fetch `origin/main` from `<checkout>` (with Retry) and note its SHA as `mainSha`, and the task branch's SHA as `branchSha` when it exists. These identify what the reviewers read; they are information, not a guard. Do not merge or switch branches. In a task worktree, read clean files from it, and committed versions with `git show <sha>:<path>` for another ref or a dirty file. When `<checkout>` is the main checkout used as the fallback, read every file as `git show <mainSha>:<path>` (or `<branchSha>` for the task branch), never from its working tree: other sessions fast-forward the main checkout during merge cleanup, and that must not matter. `context.md` states the rule for the reviewers.
   **`main` moving later doesn't matter.** Never compare `origin/main` again during or after the review, and never end or rerun a round because it moved. Citations that drift after the review are the implementer's job (`$implement-handoff` step 3.2 finds where the code went), and `$review-pr` merges `main` before it reviews.
4. Create a unique `<task-dir>/handoff-review/run-<timestamp>-<uuid>/` folder; if the path exists, generate a new uuid. This is `<scratch>`. All invocation artifacts go there; never reuse earlier reports or verdicts. Copy the original to `original.md` and save its SHA-256 hash. Normally copy it to `candidate.md` too. With `--candidate`, see below.
5. Write `context.md` with the target identity, `mainSha`/`branchSha`, relevant task-index/dependency facts and source-reading rules. Write an initially empty `ledger.md`. The ledger carries finding IDs, factual/design classification, accepted/rejected decisions, evidence, reasons and exact amendments. Keep it compact; raw reports remain available for specific disputes rather than being passed as whole transcripts.
6. Keep a private copy (`<scratch>/.coordinator/`) of every scratch input before each process starts (`candidate.md`, `context.md`, `ledger.md`, the round's `input.md`). If a process changed one, restore it from that copy and note it in the ledger. Reviewers never edit the checkout (their prompts say so); the coordinator doesn't inventory or guard it.
7. **The original handoff changed** (someone edited it during the review): re-snapshot it as a new `original.md` and start again at round 1 on the new text, in the same `<scratch>` under `restart-<n>/`. This is not another round; record it in `restarts`.

`--candidate` lets a new user-requested invocation review a previous run's saved proposal. Use it when the path is that run's `candidate.md` under this task's scratch, its adjacent `result.json` names this task, its `candidateHash` matches the supplied bytes, and the current original matches that record's `originalHash` or `candidateHash`. Copy the verified bytes into the new `candidate.md` and record provenance and compact decision history in `context.md`. Otherwise ignore the candidate, review the current original, and say why. Always run the review again. Never select a prior candidate automatically.

Always write the canonical result to `<scratch>/result.json`. Optional `Result file: <path>` requests an additional identical JSON copy within this task's scratch. If that path exists or lies outside the task folder, write the copy to a unique sibling name inside `<scratch>` and report it. Publish results only after the run finishes. Every caller receives the canonical invocation path.

## 2. Round 1: Codex reviews

Create `<scratch>/round1/`, copy the candidate to its immutable `input.md`, and write a prompt file naming:

- `<skill-dir>/references/handoff-review-prompt.md`
- Mode: `full`, round: `1`
- the absolute `input.md`, `context.md`, `ledger.md`, checkout and main-checkout paths

Run from `<checkout>`:

```powershell
& '<codex>' exec -m gpt-6.1-sol -c 'model_reasoning_effort="high"' <speed> -s danger-full-access -C '<checkout>' -o '<scratch>/round1/codex-review.md' (Get-Content -Raw '<scratch>/round1/prompt.txt')
```

Require a successful exit, a newly written report with `**Verdict:**`, and complete findings/amendments/inspected-path sections; zero findings is explicit. Anything else is retried.

Verify every finding against its evidence. Accept supported factual and design amendments; record rejected claims and reasons in the ledger. A factual drift finding updates the candidate. Then apply the accepted amendments with the helper, not with a script of your own:

1. Write `<scratch>/round1/accepted.md`: the report's `### Amendments` section with the rejected entries removed (copy the accepted entries verbatim).
2. Run from `<repo>`:

   ```
   pnpm.cmd -C <repo> --silent handoff:apply --report '<scratch>/round1/accepted.md' --candidate '<scratch>/candidate.md' --record 'round 1' --out '<scratch>/round1/amendments.json'
   ```

   It places each amendment's Find text in the candidate (exactly, re-indented as the candidate nests it, or ignoring whitespace runs; `(add)` appends to the named section), rewrites the candidate, appends the applied entries to its `## Review amendments` record (design entries in bold), and exits 1 naming every amendment it could not place.
3. **Unplaced amendments** (a Find that matches nowhere or in several places, an earlier amendment touching the same lines): find the passage the amendment targets and rewrite its Find text to match the current candidate, keeping the reviewer's Replace intent, then rerun the helper on a file holding only those entries. If the passage can't be located, write the change from the reviewer's evidence directly into the candidate. Record each adjustment in the ledger. Never end the run for it.
4. **Overlapping or incompatible amendments:** decide, don't stall. Keep the one the evidence supports, or combine them when they're compatible, and record the decision and its reason in the ledger.

Then read the whole candidate for consistency. Keep the round's input and raw report unchanged. Save the round's decisions (`round1/decisions.json`: accepted, rejected, candidate hash, attempts).

A tripped outcome or premise condition is never blocked: accept the amendment that solves it, or write one from the reviewer's evidence. If round 1 confirms the work already landed on `main`, finish with `blocked`. Otherwise the amended candidate is the reviewed handoff: go to step 4, or to step 3 with `--two-round`.

## 3. Round 2 (`--two-round` only): Claude reviews, Codex validates

Create `<scratch>/round2/` and copy the amended candidate to immutable `input.md`. Both processes review this same snapshot, context and ledger.

### Claude

Write a prompt naming the shared `handoff-review-prompt.md`, round `2`, and the absolute input/context/ledger/checkout/main-checkout paths. Use mode `follow-up`: inspect round 1's amendments, rejected claims where evidence changed, and their effects on the handoff's goal, invariants, dependencies, steps and verification. If round 1 changed scope, architecture or core assumptions, use mode `full`. When round 1 changed nothing, perform an independent check of the plan's critical assumptions and completeness. Read the whole candidate for coherence in every case, and inspect repository files relevant to the claims rather than repeating unrelated source reads.

Run from `<checkout>`:

```powershell
& '<claude>' -p (Get-Content -Raw '<scratch>/round2/claude-prompt.txt') --model claude-opus-5-5 --effort high --strict-mcp-config --dangerously-skip-permissions --output-format text | Out-File -Encoding utf8 '<scratch>/round2/claude-review.md'
```

Capture Claude's native exit code immediately; validate fresh output and the same report sections as round 1. A failed or malformed report is retried before validation starts. Claude cannot amend the handoff or spawn additional reviewers.

### Codex

Write a prompt naming `<skill-dir>/references/handoff-validation-prompt.md`, Claude's current report, and the same round-2 input/context/ledger/checkout/main-checkout paths.

```powershell
& '<codex>' exec -m gpt-6.1-sol -c 'model_reasoning_effort="high"' <speed> -s danger-full-access -C '<checkout>' -o '<scratch>/round2/validation.md' (Get-Content -Raw '<scratch>/round2/validation-prompt.txt')
```

Require a successful exit and new output with a verdict, a validation table covering every Claude finding, exact amendments for all valid/partly valid findings and for every serious issue it noticed, and explicit noticed/inspected-path sections. Anything else is retried. Codex validates claims and replacement text using the affected code; it does not repeat the full audit. It can reject an unsupported Claude blocked verdict.

Record all decisions in the ledger. A claim that recurs or reverses an earlier accepted change is decided, not stalled: the validator states which side the current evidence supports; the coordinator follows it, records the reason, and moves the losing claim to the ledger's rejected list.

### Outcome

Apply the validator-approved amendments with the helper (`--report '<scratch>/round2/validation.md' --record 'round 2' --out '<scratch>/round2/amendments.json'`), fixing unplaced ones as in round 1. These are `postReviewAmendments`: the validator already checked each one against the code, so they need no further round. Then read the whole candidate for coherence.

- **The work already landed on `main`** (confirmed by the validator with evidence): `blocked`. Main drift, tripped conditions and another task's branch are amendments, never `blocked`.
- **Otherwise:** `ready`, with the round-2 input plus the approved amendments as the reviewed candidate. Claude's raw verdict alone can't block it, and a raw `ready-with-amendments` whose findings are all invalid validates as ready.

Round 2 is the last round. No third review or additional validation pass follows.

## 4. Apply and report

Before publishing, require `candidate.md` to equal the last round's `input.md` with exactly that round's recorded amendments applied, and the original handoff to still match `originalHash` (if it changed, step 1.7 restarts the review).

With `--apply` and `ready`, replace the original handoff with the reviewed candidate. Verify the saved bytes match the candidate hash and set `applied: true`. If already identical, verify the hash and also set `applied: true`. Without `--apply`, or for `blocked`/`error`, leave the original unchanged. Standalone review never moves the task folder or changes its row's Status. Preserve scratch for `$merge-pr` cleanup.

Once the result is written, find the task's row in `<main-checkout>/.plans/README.md` with a search (`Select-String`/`grep` for the task name; never read the whole index) and set its **Handoff review** cell to `<status> <roundCount>/<1 or 2 with --two-round> · <YYYY-MM-DD> · <run folder name>` (for example `ready 1/1 · 2026-10-07 · run-20261007-113018-…`). Change no other cell. If the row is missing, add it with Status `Not started`, PR review `not run`, and the handoff's branch/worktree as Evidence.

Report in a few lines: the status, round count and whether the original was updated; each design amendment (ID and one line); the counts of factual amendments, rejected claims and amendments placed by hand; retries and restarts; the result path, speed and resolved CLI versions. The JSON block carries the rest.

Write the JSON result and end the final report with the same object in a fenced `review-handoff-result` block:

```json
{
  "status": "ready",
  "roundCount": 1,
  "twoRound": false,
  "task": "<task folder name>",
  "handoff": "<absolute original handoff path>",
  "scratch": "<absolute unique invocation folder>",
  "candidate": "<scratch>/candidate.md",
  "originalHash": "<SHA-256 before review>",
  "candidateHash": "<SHA-256 of final candidate>",
  "applied": true,
  "checkout": "<absolute review checkout>",
  "branch": "<planned task branch>",
  "branchSha": "<task branch SHA the reviewers read, or null for a new task>",
  "mainSha": "<origin/main SHA the reviewers read>",
  "fast": false,
  "cli": { "codex": "<version>", "claude": null },
  "rounds": [
    { "round": 1, "reviewer": "codex", "reviewerVerdict": "ready-with-amendments", "accepted": ["1.1"], "rejected": [], "decisions": [], "attempts": 1 }
  ],
  "postReviewAmendments": [],
  "restarts": 0,
  "stopReason": null
}
```

With `--two-round`, `rounds` gains `{ "round": 2, "reviewer": "claude", "validator": "codex", "reviewerVerdict": …, "validatorVerdict": …, "accepted": [...], "rejected": [...], "decisions": [...], "attempts": n }`, `twoRound` is true, `postReviewAmendments` lists round 2's approved IDs, and `cli.claude` is the resolved version.

Allowed statuses: `ready`, `blocked` (the work already landed on `main`), `error` (a missing tool, or no handoff to review). Report only rounds actually started; never claim ready without the required rounds. Store each process's raw verdict as `reviewerVerdict` or `validatorVerdict`; round 1 has no validator field. `attempts` counts Retry reruns of that round's processes. An `error` result still produces a result and report when scratch could be resolved; unavailable hashes/revisions/versions are null and `applied` is false. Results from previous invocations cannot replace missing or failed current output.
