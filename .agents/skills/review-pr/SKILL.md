---
name: review-pr
description: Review a pull request until clean (at most 3 rounds) and CI is green, automatically continuing verified progress from an interrupted review. Claude Opus 5.5 reviews with configurable effort (later rounds review only the fixes), Sol 6.1 validates, and the coordinator fixes and pushes. Saves a checkpoint and ends on usage exhaustion; never merges. Use for $review-pr with a PR number or branch, optional --fast, --claude-effort, --fresh or --resume, or requests to get a Claude PR review and fix its findings.
---

# Claude review → Codex validation → fixes, up to 3 rounds, then CI

Invoking `$review-pr` authorizes the whole flow, without confirmation between steps:

- opening the branch's PR if it has none
- creating the PR branch's worktree, or a detached work tree
- merging `origin/main` into the PR's branch (resolving every conflict, including regenerating and publishing tiles) and pushing
- review rounds until one is clean, at most 3: Claude's review, the validation run, then fixes committed and pushed to the PR's branch
- the CI gate until CI is green, with CI fixes committed and pushed

Never merge the PR.

Read [shared.md](references/shared.md) (Ends, Shared patterns, Rules, Binaries, Speed, Claude effort) and [recovery.md](references/recovery.md) before initialization or launching a process. The recovery checkpoint protocol applies throughout, including delegated coordinators and relaunches. Run `review:state` (`<repo>/scripts/pr-review-state.ts`) from the skill checkout, so branches predating the helper still work.

## Models

| Role | Model | Effort | Speed |
| --- | --- | --- | --- |
| Review (every round) | Claude Opus 5.5 (`claude-opus-5-5`) | `<claude-effort>` | normal |
| Codex #1: validates Claude's review (analysis only, every round) | Sol 6.1 (`gpt-6.1-sol`) | max | `<speed>` |
| This session: fixes, commits, pushes, CI fixes | Sol 6.1 (`gpt-6.1-sol`) | xhigh | the session's own setting |

## Inputs (all optional)

- `<PR number | branch>`: `22`, `#22`, `codex/x` or `origin/codex/x`. Without it, the current branch's PR (step 1.2). `$sync-review` and `$implement-handoff` start Codex with `-C <wt>`, so the current branch is the PR's.
- `--fast`: sets `<speed>` for Codex #1 in every round (shared.md, Speed).
- `--claude-effort <level>`: shared.md, Claude effort. Save the resolved value as `claudeEffort` and use it for unfinished reviews and later rounds.
- `Result file: <path>`: also write the final result JSON there (step 7).
- `--fresh`: start an independent review, retaining earlier invocations. Never duplicate an active review process.
- `--resume <run-path>`: continue that checkpoint or verifiable legacy invocation.
  - With no PR argument, take the PR from its saved identity.
  - Reject a mismatched explicit target.
  - Reject combining `--fresh` and `--resume`.
- `Worker checkpoint: <run-path>` (delegated invocations only): attach to the caller's initialized checkpoint after verifying its repository, PR and branch.
  - Its `claudeEffort` is authoritative; an explicit effort argument must match it.
  - Never initialize a second invocation, or mistake the supervising coordinator receipt for a reviewer.

## Rules

shared.md's Rules apply, plus:

- **Work in the PR's checkout.** From step 1.3 on, every command runs with `<pr-checkout>` as its working directory (`git -C`, `pnpm -C`, `<codex> exec -C`, or the shell tool's option), except where a step targets `<repo>` or `<main-checkout>`. Never check the PR's branch out anywhere else. In a detached work tree, every push is `git push origin HEAD:<headRefName>`.
- **On `error`** (an Ends case only), go straight to step 7 with that status and a `stopReason`.
- **On `interrupted`**, publish the checkpoint result as the recovery reference says, then do step 7's index update and report. Preserve scratch and working changes. Results and receipts from earlier invocations are reusable only under the reference's provenance and commit checks.

## 1. Resolve the PR and its checkout

1. `<skill-dir>` is this `SKILL.md`'s folder. If `<repo>` lacks `.claude/skills/review-pr/SKILL.md`, end with `error` (missing tool).
2. **Find the PR** (fields `number,title,headRefName,headRefOid,baseRefName,url,state`). Resolve a `--resume` identity first; a saved PR never falls back to another PR.
   - **With an argument:** strip a leading `#` or `origin/`, then `gh pr view <arg> --json <fields>`.
     - `MERGED` or `CLOSED`: end with `error` (`PR #<N> is <state>`).
     - A branch without a PR: open one (below).
   - **Without one:** use `git branch --show-current`, then `gh pr view --json <fields>`.
     - **A branch other than `main` without a PR:** open one. Never fall back to another PR; a caller in a task worktree must get its own branch's PR.
     - **On `main`:** list open PRs with `gh pr list --state open --json number,headRefName,title,updatedAt`.
       - Use the most recently updated one whose head branch has a worktree, or else the most recently updated one.
       - Say which, and list the others as `$review-pr <N>  # <branch> — <title>`.
       - No open PR: end with `error` (nothing to do).
   - **Opening a PR:**
     - The branch needs commits that `origin/main` lacks; otherwise end with `error` (nothing to do).
     - Push it (`git push -u origin <branch>`) if `origin/<branch>` is missing or behind.
     - Write the body to a file in the OS temp folder and run `gh pr create --base main --head <branch> --title "<title>" --body-file <file>`.
       - Title: a gitmoji + conventional header summarizing the branch's commits since `main`.
       - Body: what the branch does, from its commits and its handoff (if `.plans/README.md` lists it), plus the checks the handoff names. Never claim tests that didn't run.
     - Read the new PR's fields.
3. **Pick `<pr-checkout>`,** the worktree on `headRefName`.
   - Before fast-forwarding, pushing, choosing a detached tree or replacing a baseline, inspect the saved checkpoint. Preserve verified owned WIP; unfamiliar edits keep the protections below. Reconcile a pending commit or push with Git before repeating it.
   - **Checked out in `<main-checkout>`:** use a detached work tree (shared.md); the main checkout stays untouched.
   - **No worktree:**
     1. `<short>` is `headRefName` without `codex/`, with `/` replaced by `-`.
     2. Run `git -C <main-checkout> fetch origin <headRefName>`.
     3. If the local branch exists, run `git -C <main-checkout> worktree add <main-checkout>/worktrees/<short> <headRefName>`. Otherwise run `git -C <main-checkout> worktree add --track -b <headRefName> <main-checkout>/worktrees/<short> origin/<headRefName>`.
     4. In the new worktree, run `pnpm install --frozen-lockfile --prefer-offline`, `pnpm data:fetch` and `pnpm.cmd exec tsx "<repo>/scripts/claude-worktree-settings.ts"`. Use the skill checkout's initializer even when the branch predates it.
     5. If the path is occupied by a folder of unknown origin, use a detached work tree instead.
   - **Existing worktree:** run `git -C <pr-checkout> fetch origin <headRefName>` (Retry). After the recovery reference's `inspect` (so owned checkpoint WIP and live children are known), follow "Commit task leftovers" (shared.md) in it with `<main-checkout>/.plans/active/pr<N>-review-fixes/leftovers/` as `<scratch>` (the invocation's own scratch doesn't exist yet). It commits every uncommitted file except held-back ones and owned WIP, merges `origin/<headRefName>` when the worktree is behind or diverged, and pushes. Then:
     - **Behind** (`merge-base --is-ancestor HEAD origin/<headRefName>`; only when nothing was committed): fast-forward with `merge --ff-only`. If git refuses because of held-back or owned files, merge `origin/<headRefName>` instead.
     - **Ahead:** push the unpushed commits.
     - Never move to a detached work tree because the worktree is dirty, behind or diverged; that would strand its work. Name each leftovers commit and held-back file in the report.
   - In the first lines of output, name the PR (#, branch), `<pr-checkout>`, and whether it is a detached work tree.
4. **Initialize.** Fetch `origin/main` and refresh the PR head. Run the recovery reference's `init`, or attach to `Worker checkpoint`.
   - Set `<scratch>` to the returned invocation path.
   - `init` continues the latest valid checkpoint or imports verifiable legacy work; `--fresh` starts independently. Earlier invocation files stay read-only.
   - Report the recovered phase and source invocation. Carry the cumulative round numbers, history and rejected decisions.
5. **Baseline.** Save `<scratch>/status-baseline.txt`: the checkpoint's baseline status when resuming, or `git status --porcelain=v1 -z --untracked-files=all` on a fresh run. Use this NUL-separated form for every baseline comparison. Owned WIP is tracked separately. In the PR's task worktree, step 1.3 already committed the leftovers, so the baseline holds only held-back files and owned WIP. In a detached work tree, never adopt dirty files as the review's own.
6. **Settings.** Set `<speed>` and `<claude-effort>` (`state.claudeEffort`), and print both in the first line of output. Resolve `<codex>` and `<claude>` (shared.md, Binaries) and note their versions.
7. **Merge `origin/main`** so Claude reviews the branch as it will merge. Follow [merge-main.md](references/merge-main.md) in `<pr-checkout>` with the step 1.5 baseline, setting `mainMerge`. Around it:
   - Save a checkpoint before and after synchronization, and refresh and checkpoint `remoteSha` after the push.
   - Finish a pending merge only when its saved operation and `MERGE_HEAD` establish ownership.
   - If synchronization changed HEAD, keep the historical records and review the new commit in a new round. Otherwise continue at the recovered phase (step 2 for a new review); never restart at round 1.
   - A saved clean result counts only when local HEAD equals the refreshed PR head, current main is an ancestor, and a fresh GitHub CI check passes.

## 2. Round k: Claude reviews the PR

Rounds start at 1; recovery keeps the saved k. Each round uses `<scratch>/round<k>/`. Refresh `headRefOid` with `gh pr view` at the start of every round. A verified completed reviewer receipt at this head and scope skips straight to validation.

**Scope first** (recovery reference, "Choose the review scope"):

```
pnpm.cmd -C <repo> --silent review:state scope --input <scratch>/round<k>/scope-input.json
```

It returns `mode`, `since`, `reason`, `path` (the scope file), `ledger` and `delta`.

- **delta:** review only the commits since the last reviewed commit (`since`), plus their callers and tests, guided by the ledger of earlier findings. Chosen only when:
  - that commit is an ancestor of HEAD
  - no merge happened since
  - at most 400 lines changed
  - no dependency, build, CI or agent-instruction file changed
- **full:** everything else; review the whole PR.

Pass the scope file as the process's `scope`, so its receipt is bound to it.

**Launch** through the recovery reference's `run` wrapper from `<pr-checkout>`, with a shell timeout of at least 20 minutes. The wrapper creates a unique attempt folder, captures UTF-8 output and writes an independent receipt. The Claude prompt is `/review-pr <N> --report-only`. Add `--since <since>` in a delta round, and `--ledger <ledger>` whenever the scope returned one.

```
pnpm.cmd -C <repo> --silent review:state run --input <scratch>/round<k>/claude-input.json
```

- **Arguments:** use the reference's exact Claude arguments; the wrapper substitutes the saved effort. Never change the model or effort, or drop a flag. Put the pinned-head instruction and the saved rejection text in one `--append-system-prompt` argument.
- **Read-only check:** `--report-only` keeps Claude from editing. Afterwards, compare `git status --porcelain=v1 -z --untracked-files=all` with the baseline. Record any difference in the round's record. Never revert or stage it; protect unfamiliar changes with the reference's `protect`.
- **Acceptance:** require a successful native exit and a complete report, with a verified receipt and an unchanged PR head. A recovered receipt must pass the reference's checks.
  - A quota receipt or wrapper exit 75 means `interrupted`.
  - Any other failed or incomplete attempt gets Retry.

  The receipt's report path is `<claude-report>`. Never review the PR yourself instead.

## 3. Round k: Codex validates Claude's review

Launch through `run` as in the recovery reference, from `<pr-checkout>`, with a shell timeout of at least 30 minutes:
- Use `{report}` as the `-o` output and `<claude-report>` as the input report.
- Pass the round's scope file as `scope`. The wrapper rejects a scope that differs from the review's.
- The prompt names the scope mode, `since` and the ledger path.

A recovered successful validator receipt skips to fixes.

```
pnpm.cmd -C <repo> --silent review:state run --input <scratch>/round<k>/validation-input.json
```

- **Never** change the model, effort or speed flags, or skip this run to validate in this session.
- **Read-only check:** compare the status with the baseline afterwards, as in step 2. Gitignored test caches don't show up.
- **Acceptance:** require a successful native exit and a complete validation report whose receipt matches the reviewed commit and an unchanged PR head. A failed fresh process can't be replaced by an unrelated older table.
  - A quota receipt or exit 75 means `interrupted`.
  - Any other failure gets Retry.

  The receipt's report path is `<validation-report>`.
- **Rejected claims:** append the round's `invalid` entries to `<scratch>/rejected.md` as `path:line — claim`. A new file starts with: "Entries below were already judged invalid in earlier review rounds. Don't report them again unless the cited code has changed since."

## 4. Round k: implement the valid entries

Read `<validation-report>`. A blocker or should-fix under "Noticed, not in Claude's review" is a valid entry of this round: add it with `claudeSeverity: null`, `verdict: "valid"` and the validator's severity as `finalSeverity`, and fix it with the others. Save `begin` / `finish` checkpoints for each fix, check, commit and push (recovery reference). Continue verified completed steps; leave unfamiliar or uncheckpointed edits untouched.

Classify before editing:

- **Clean:** no valid blocker or should-fix, noticed ones included. Fix any valid nits as below, then go to step 6.
- **Outside the PR's diff:** allowed. Find why the fix reaches those files (a caller, a shared helper, a fixture), keep the change scoped, and record why in the commit message and the entry's `outOfDiff`.
- **Repeat** (round 2+): a valid blocker or should-fix with the same `path` and claim as an entry an earlier round marked `fixed`. That fix didn't work: learn why from its commit, fix it differently, and set `repeat` to that round. An entry that has already repeated once isn't fixed a third time: mark it `open` with both attempts and carry it into the PR body (step 4.2).
- **Oscillation:** a fix that would revert all or part of an earlier round's commit (`git show <commit>`). Decide, don't stall: record the decision in the commit body and the entry's `decision`, and add the losing claim to `rejected.md`.

Then, in `<pr-checkout>` on the PR's head branch:

1. **Order:** fix blockers, then should-fix, then nits, each scoped to its entry, following `AGENTS.md`.
2. **Targeted test:** after each step, run that step's test (the named Vitest file, or `pnpm run test --changed`) and fix failures before moving on.
   - If no approach passes, keep the part that passes, or revert only your own edit for that entry.
   - Mark the entry `open` with what was tried, and add it to the PR body's "Open review entries" (`gh pr edit <N> --body-file`). The round goes on.
3. **End checks:** once at the end of the round, run the `AGENTS.md` "Verifying changes" checks for the touched files. The full suite is CI's.
4. **Staging:** run `git status` and `git branch`, and confirm this is the PR's head branch or its initialized detached checkout. Stage only your files, by explicit path. A file that also holds baseline edits from someone else isn't committed; report it.
5. **Commit:** gitmoji + conventional, matching `git log`. Use one commit, or one per area for unrelated fixes.
6. **Push:** plain `git push`, then refresh and checkpoint `remoteSha`. Update the PR description (`gh pr edit <N> --body-file`) if the fixes change what it says.

Write the round's record to `<scratch>/round<k>/result.json` with `{round, reviewedHead, scope, claudeEffort, usage, claudeVerdict, entries, noticed, commits}` (shape in step 7):
- `reviewedHead` is the review receipt's `headSha`; the next round's scope starts from it.
- `scope` is `{mode, since, reason}` from the scope file.
- `usage` is the review receipt's `usage`, null when unavailable.
- `claudeEffort` is the actual `--effort` in the review receipt, reused receipts included; legacy records without that proof use `high`.

Record the same fields in checkpoint `history` before another round starts, plus findings, noticed items, rejected decisions, commits and the next phase. The next scope and ledger are built from them.

## 5. Review loop (until clean, at most 3 rounds)

- **Clean** (no valid blocker or should-fix, apart from entries already carried as `open`) → step 6.
- **Fixed** (valid blockers or should-fix items were fixed and pushed):
  - k < 3 → round k+1 at step 2.
  - k = 3 → no round 4. Round 3's fixes stay pushed without another review, and any entry left unfixed is carried as `open` in the PR body. Go to step 6. Record `roundCap: true` in the report.

Round 1 is the full review that should find everything; rounds 2 and 3 check the fixes. Repeat, Oscillation and `rejected.md` keep them converging.

Nits are fixed as they come up. A round whose only valid entries are nits is clean, so nits never start another round.

## 6. CI gate (until green)

Checkpoint CI attempts, reruns and fixes:
- Record `pending` while waiting, the checked head, and `needsReview: true` after a non-test source fix.
- Save completed local check commands with the working-tree hash, and reuse them only while that hash matches.
- Recovery always rechecks GitHub CI against the current remote head.

1. **Wait** until the PR has checks for its current head (`gh pr view <N> --json headRefOid,statusCheckRollup`), then run `gh pr checks <N> --watch` with a shell timeout of at least 30 minutes. If everything passes, go to 3 when a CI fix or leftovers commit in this run touched non-test source and no round has run since. Otherwise go to 4.
2. **A check fails:** read `gh run view <run-id> --log-failed`. For e2e failures, also run `gh run download <run-id> -n playwright-results-<shard> -D <scratch>/ci`.
   - **Infrastructure flake** (runner, network or dependency-download error, or a timeout with no failing test): run `gh run rerun <run-id> --failed`, then back to 1. The same failure twice counts as real.
   - **Real failure:**
     - Reproduce it in `<pr-checkout>` with the narrowest command: the failing Vitest file, or `pnpm test:e2e --project=chromium -g "<test>"`. It may wait for a heavy slot.
     - Fix the cause. Change the test only if the test is wrong. A failure that also happens on plain `origin/main` gets fixed too; record why the fix is outside the diff.
     - Commit (`🐛 fix(<scope>): …` or `💚 ci(<scope>): …`) with step 4's staging rules, push, and go back to 1.
     - Count each attempt in `ci.attempts`. There's no attempt cap; change the approach when one keeps failing.
3. **Review CI fixes:** after a CI fix or leftovers commit to non-test source, run one more round (steps 2–4) once CI is green, if fewer than 3 rounds have run. It counts toward the 3. Not clean → step 5. Clean → repeat this step from 1 for its pushes. With 3 rounds already run, skip the review, list those commits as unreviewed in the report, and go to 4.
4. **Nothing left uncommitted.** Before reporting `clean`, in the PR's task worktree (`<pr-checkout>`, or the untouched original worktree when a detached tree was used for another reason), `git status --porcelain=v1 --untracked-files=all` lists only held-back files, and `HEAD` equals the PR head (fast-forward an untouched worktree that is merely behind). Otherwise follow "Commit task leftovers" (shared.md) with `<scratch>` there, including bytes recorded with `protect` and fix WIP this run left behind, and go back to 1. Skip the main checkout. Then go to step 7 with `clean`.

## 7. Report and clean up

The report covers:

- **Main merge:** `mainMerge` with its `Conflict decisions:`, and failures that also happen on `main`.
- **Rounds:** the round count (every round, including one after a CI fix), and `round cap reached; round 3 fixes not re-reviewed` when `roundCap` is true. One line per round: `round <k> · <clean|fixed> · <full|delta> (<reason>) · effort <effort> · Claude tokens <main input+cache> / <subagent input+cache> over <n> subagents` (or `usage unavailable`), then its repeats and decisions.
- **Per round:** Claude's verdict and the validation table (# / Claude's severity / verdict / evidence / final severity).
- **Entries:** fixed entries with commit hashes; open entries carried into the PR body, with what was tried; noticed items with severity (noticed nits are listed for the user).
- **Checkout:** the detached work tree used, if any, and the untouched worktree's state. Every leftovers commit (step 1.3 or 6.4) and every held-back file.
- **CI:** the gate's reruns, fix attempts, fix commits and final state, plus which checks ran locally and which were left to CI.
- **Settings and status:** the PR URL, Codex #1's speed, the selected Claude effort, the `codex` and `claude` versions, and the final status.

End with a fenced `review-pr-result` block holding one JSON object:

```review-pr-result
{
  "status": "clean",
  "pr": 12,
  "headSha": "def5678",
  "fast": false,
  "claudeEffort": "medium",
  "cli": { "codex": "0.159.3", "claude": "2.1.289" },
  "mainMerge": "current",
  "workTree": null,
  "leftovers": [],
  "heldBack": [],
  "roundCount": 1,
  "rounds": [
    {
      "round": 1,
      "reviewedHead": "abc1234…",
      "scope": { "mode": "full", "since": null, "reason": "No earlier reviewed commit in this review" },
      "claudeEffort": "medium",
      "usage": { "sessionId": "…", "main": { "turns": 27, "input": 0, "cacheWrite": 97000, "cacheRead": 2100000, "output": 17000 }, "subagents": { "count": 4, "turns": 140, "input": 0, "cacheWrite": 490000, "cacheRead": 13400000, "output": 7000 } },
      "claudeVerdict": "Changes requested — …",
      "entries": [
        {
          "id": 1,
          "claudeSeverity": "blocker",
          "finalSeverity": "should-fix",
          "path": "packages/renderer/src/x.ts",
          "line": 42,
          "claim": "one line",
          "verdict": "valid",
          "outcome": "fixed",
          "commit": "abc1234",
          "openReason": null,
          "repeat": null,
          "decision": null,
          "outOfDiff": null
        }
      ],
      "commits": ["abc1234"]
    }
  ],
  "noticed": [
    { "round": 1, "path": "scripts/y.ts", "line": 7, "claim": "one line", "severity": "nit" }
  ],
  "ci": { "status": "green", "reruns": 0, "attempts": 0, "fixCommits": [] },
  "roundCap": false,
  "stopReason": null
}
```

- **`status`:**
  - `clean`: the last round was clean (no valid blocker or should-fix, noticed ones included, apart from `open` entries), or round 3 ended with its fixes pushed (`roundCap: true`), and `ci.status` is `green` or `fixed`.
  - `error`: an Ends case; `stopReason` names it.
  - `interrupted`: usage exhaustion or an abruptly ended coordinator. It adds `resume: {checkpoint, phase, round, reason, reset, command}`, where `reset` is the literal reset text or null. Completed rounds stay in `rounds`; unfinished fixes live in checkpoint operations, and no clean result is implied for WIP. `resume` is null otherwise.
- **`headSha`:** the PR head when the run ends (`gh pr view <N> --json headRefOid`). The results apply to this commit only.
- **`claudeEffort`:** the resolved selection for unfinished and future reviews. Each round keeps its actual effort.
- **`cli`:** the resolved versions (`null` when unresolved). **`workTree`:** `null`, or the detached tree's path and why. **`leftovers`:** the SHAs of leftovers commits (shared.md, Commit task leftovers). **`heldBack`:** paths left uncommitted as secrets or files over 10 MB; a `clean` result has nothing else uncommitted. **`roundCount`:** the report's round count. **`roundCap`:** true when round 3 had fixes and no round 4 ran.
- **`mainMerge`:** `current`, `merged`, `resolved <n> files`, `aborted` (only for `merge tool unavailable`), or `not-run` (ended before step 1.7).
- **Per round:**
  - `scope` and `usage` come from the review receipt; `usage` is null when unavailable, never estimated.
  - Entry `verdict` is `valid`, `partly` or `invalid`.
  - Entry `outcome` is `fixed`, `open` (with `openReason`) or `none`.
  - `repeat` names the repeated round, and `decision` records an oscillation decision.
  - `claudeSeverity` is `null` for a promoted noticed item.
  - `outOfDiff` is `null`, or the files outside the diff and why.
- **`noticed`:** every round's noticed items with the validator's severity. Blockers and should-fix items among them also appear as entries.
- **`ci.status`:** `green` (no fixes), `fixed` (after fix commits), `pending` (unfinished checks on an interrupted run), or `not-run`.

**Publishing:**
- Record the final status, reporting metadata and CI state in the checkpoint before writing the result.
- Write the object, without the fence, to `<scratch>/result.json` at the invocation root, and identically to the `Result file` if one was given.
- Interrupted results are published with the helper's `interrupt`. The process wrapper already publishes one on quota failure, even if the coordinator dies.

**Index:** in `<main-checkout>/.plans/README.md`, set the **PR review** cell of every row whose Evidence names the PR's branch or `#<N>` to `<status> <roundCount> rounds · CI <ci.status> · <short headSha> · <YYYY-MM-DD>`, adding `· <n> open` when entries were carried (for example `clean 2 rounds · CI green · d0c7322 · 2026-10-05`). Change only that cell; the caller owns Status and Next step. If the `pr<N>-review-fixes` row is missing, create it:

| Task | Status | Handoff review | PR review | Evidence | Keep | Next step |
| --- | --- | --- | --- | --- | --- | --- |
| `active/pr<N>-review-fixes/` | PR review record | not run | the formatted value | `PR #<N> / <headRefName> / <pr-checkout> / <scratch>` | None | Retain review scratch until $merge-pr cleanup |

Leave `<scratch>` in place. `$merge-pr` deletes the whole `pr<N>-review-fixes/` root with `pnpm plans:clean` after the PR merges (shared.md, Deleting).
