---
name: implement-handoff
description: Take an ASCII Atlas handoff from two-round review to PR. Run $review-handoff --apply (Codex first, then Claude with Codex validation), implement only a ready handoff, commit and push, open a PR to main, then run $review-pr for synchronization, review and CI. Never merges the PR. Use when invoked as $implement-handoff [--fast] with a task name or handoff path.
---

# Review a handoff → implement → land as a PR → $review-pr

Usage: `$implement-handoff [--fast] [--candidate <prior candidate path>] <task | path to handoff.md>`

Invoking `$implement-handoff` authorizes these actions for this one task:

- editing its `handoff.md` with review amendments
- running `$review-handoff --apply` with its two-round limit
- creating its worktree if the handoff says it's a new task
- implementing it, committing and pushing
- merging `origin/main` into its branch, resolving every conflict (including regenerating and publishing tiles with `pnpm data:build` / `pnpm data:publish`)
- opening a PR to `main`
- running `$review-pr`, which synchronizes `main` into the branch, commits and pushes fixes and CI fixes

Don't ask for confirmation between steps. Stop only at this skill's hard stops (Rules). The handoff's "Stop and report if" conditions are problems to solve, not stops. Never merge the PR.

## Models

Always pass these explicitly. Never change them or fall back to another model.

| Role | Model | Effort | Speed |
| --- | --- | --- | --- |
| This session: amends the handoff, implements, commits, opens the PR | Sol 6.1 (`gpt-6.1-sol`) | xhigh | the session's own setting |
| Inside `$review-handoff`: round 1 review / round 2 validation | Sol 6.1 (`gpt-6.1-sol`) | max | `<speed>` |
| Inside `$review-handoff`: round 2 review | Claude Opus 5.5 (`claude-opus-5-5`) | high | normal |
| PR review coordinator: runs `$review-pr`, including main synchronization | Sol 6.1 (`gpt-6.1-sol`) | xhigh | `<speed>` |
| Inside `$review-pr`: the review / its validation | Claude Opus 5.5 (`claude-opus-5-5`), high / Sol 6.1, max | | normal / `<speed>` |

**Binaries:** several copies of `codex` can be installed, and an old one rejects `gpt-6.1-sol`. Run only `<codex>`, the newest installed copy, resolved in step 0.1. Never run a bare `codex` or any path other than the resolved `<codex>`. `$review-handoff` and `$review-pr` resolve their own newest `codex` and `claude`.

This session must be Sol 6.1 (`gpt-6.1-sol`) at xhigh effort. If it's running a different model or effort, stop and ask the user to start `$implement-handoff` again from a session with those settings.

`<speed>` comes from the `--fast` option:

- with `--fast`: `-c 'service_tier="fast"' --enable fast_mode`
- without it: `--disable fast_mode`. Pass this explicitly, because the user's Codex config may default to fast.

`--fast` is also forwarded to `$review-handoff` and `$review-pr`. It doesn't change Claude, or this session's own speed.

## Rules

- **Git safety:** never check out, switch branches, stash, reset, rebase, force-push, use `git add -A`, `git add .` or `git commit -a`, or pass `--no-verify`.
- **Main moves on.** Pull `origin/main` before handoff review and once more before implementing (steps 0.4 and 3.0). Review amends stale assumptions; drift is never an unfixable `blocked` premise. If the final pull changes reviewed inputs, pause with `stale` instead of silently exceeding the handoff's two-round budget, except when step 0.6 reused a review: step 3.0 then requires one fresh invocation. After implementation starts, `$review-pr` handles synchronization.
- **Windows:** prompts that contain `$` go in single quotes, and stdout is captured with `Out-File -Encoding utf8`, never a plain `>`.
- **Long commands:** the `$review-pr` run can take several hours. If the shell tool can't hold a command that long, start it in the background with its output going to a log in `<scratch>`, and poll until it exits.
- **Solve blockers; don't pause for them.** A failed gate, a premise that turns out false, an approach that doesn't work, or a finding a reviewer noticed is a problem to solve inside this task, not a decision for the owner. Diagnose it, change the approach within the handoff's goal, Invariants, Out of scope and `AGENTS.md`, and measure again. A gate that still fails after that doesn't stop the run: commit, open the PR, and list the gate as unmet in the PR body and the report.
- **Setup guards:** the Models requirement and step 0's resolution checks can stop the run before a task is resolved. Once the task is resolved, these **hard stops** are the reasons to pause:
  - a tool or credential the work needs can't run (`merge tool unavailable`, missing `gh` auth, no tippecanoe/Docker for a required `data:build`)
  - another session's uncommitted files are in the way
  - the only fix would break a rule in `AGENTS.md` (its conventions, Git rules or Don'ts) or this skill's git safety
  - the handoff names a branch or worktree that belongs to another task
  - the handoff review ended `capped`, `stalled`, `stale` or `error` (step 2)
  - a held-back file or rejected push prevents landing the branch (step 4)
- **To pause:** move the task folder to `.plans/paused/`, rebase task-local path variables as step 0.5 describes, set its `.plans/README.md` row's Next step to the reason and what needs a human, then go to step 6. Historical review records remain unchanged; report their relocated artifact paths.

## 0. Resolve the handoff

1. `<main-checkout>` is the first entry of `git worktree list`. Take out `--fast` if present, and set `<speed>`. Resolve an explicitly supplied `--candidate` path against the invocation directory and retain its absolute path for the handoff review; it is not the original handoff path and never triggers an automatic retry. Resolve the newest installed Codex (PowerShell):

   ```
   pnpm.cmd -C <repo> --silent cli:latest codex
   ```

   `<repo>` is the checkout holding this `SKILL.md` (`<skill-dir>/../../..`). Use `pnpm.cmd`, because the execution policy blocks `pnpm.ps1`. Check `$LASTEXITCODE` immediately; if non-zero, stop and report. Set `<codex>` to the absolute path printed on stdout and retain it in session context, like `<scratch>` and `<speed>`. It prints `codex <version> <path>` on stderr; note the version for the report. Shell variables do not survive separate tool calls: replace `<codex>` with the resolved path in every later command, keeping its single quotes for paths containing spaces.
2. Find the handoff:
   - **A path:** use it.
   - **A task name:** look for `<main-checkout>/.plans/{todo,paused,active}/<task>/handoff.md`.
   - If none is found, or more than one, stop and say so.

   `<task-dir>` is the folder holding the handoff. Use it as `<scratch>`: every file this skill writes goes there.
3. Read the whole handoff, and `AGENTS.md`.
4. From the handoff's §1 (Goal & context), take the branch and worktree:
   - **It names an existing worktree** (a follow-up): use it. Confirm with `git worktree list` that the worktree is on that branch. If cleanup removed it, restore the original branch/path using AGENTS.md's retained-remote procedure: fetch the task branch, reuse its local branch if present, or recreate it tracking `origin/<branch>`. Never invent a replacement branch/path or overwrite an occupied directory. In the restored worktree run `pnpm install --frozen-lockfile --prefer-offline`, `pnpm data:fetch` and the Claude worktree-settings initializer from this skill's checkout. These restoration steps are authorized by this invocation.
   - **It's a new task:** run `pnpm worktree:new <short> <topic>` from `<main-checkout>`, with the names the handoff gives. If it gives none, derive them from the task folder name. If the script fails after creating the worktree, run `pnpm install --frozen-lockfile --prefer-offline` and `pnpm data:fetch` in it yourself.

   `<wt>` is that worktree.

   Then pull `origin/main` into it (see "Pull main" below).
5. Move `<task-dir>` to `<main-checkout>/.plans/active/` if it is not already there. Before moving, verify resolved old/new paths stay within this task's main-checkout `.plans/` locations and that the destination is unoccupied. Retain each task-local path's suffix relative to the old task directory. After moving, rebase `<task-dir>`, `<scratch>`, a supplied task-local `--candidate`, and any result/artifact variables onto the new directory. Verify the relocated candidate and its adjacent canonical result still exist before forwarding them; preserve historical JSON records unchanged. Add or update its `.plans/README.md` row: status `Implementing (implement-handoff)`, Evidence `<branch> / <wt>`. Leave its Handoff review and PR review cells as they are (`not run` in a new row); the review skills write them.
6. **Resume where the task left off.** Decide from the result files, not from the README cells (those are for people):
   - **An open, non-draft PR exists for the branch** (`gh pr list --head <branch> --state open --json number,isDraft,headRefOid`): the implementation already landed. Read its body with `gh pr view <N> --json body` and restore the "Unmet gates" section's gates, targets, latest measurements and approaches tried for steps 5–6. Skip steps 1–4. Search only `<task-dir>/review.json` and invocation-root `.plans/*/pr<N>-review-fixes/run-*/result.json` files for final `review-pr` results; never consume `round<k>/result.json` records. Require `pr: <N>` and `headSha` equal to the PR's current `headRefOid`, then select the newest matching final result by modification time. If it is `clean` with `ci.status` equal to `green` or `fixed`, report "PR review: already clean at <sha>" and go to step 6 as `clean`, retaining the restored unmet gates. Otherwise go to step 5 with those gates retained.
   - **Otherwise, a ready handoff review may be reused.** Take the newest `<task-dir>/handoff-review/run-*/result.json` with `status: ready`, `applied: true`, this task and branch, and a `candidateHash` equal to the SHA-256 of the current `handoff.md`. If one exists, skip step 1, set `<handoff-result>` to it and go to step 2. Step 3.0's freshness preflight still runs against it. If that preflight finds changed inputs, run step 1 once as a fresh `$review-handoff` invocation (a new two-round budget, not a third round) instead of pausing with `stale`.
   - **A resumed implementation:** if the branch already has this task's commits after the reused result's `branchSha` (`git merge-base --is-ancestor <branchSha> HEAD` succeeds and HEAD differs), those commits are the implementation in progress. Step 3.0's branch-side comparison then skips the changes those commits made, because they are this task's own work, and merges of `main` among them are checked as part of the `main` side. The `main` side is compared as usual. Step 3.1 continues from the first step that `<scratch>/progress.md` and `git log` don't show as done.
   - **Nothing to reuse:** continue normally.

### Pull main

Bring the branch up to date with `main` before the review and again before the first code edit, so both work against current code:

1. `git -C <wt> fetch origin main`. If `git -C <wt> merge-base --is-ancestor origin/main HEAD` succeeds, it's already current.
2. Otherwise `git -C <wt> merge origin/main -m "🔀 merge(<scope>): sync <topic> with main"` (same `<scope>`/`<topic>` rule as `<skill-dir>/../review-pr/SKILL.md` step 1.7.3). A branch with no commits of its own just fast-forwards.
3. Resolve every conflict as `review-pr` step 1.7.4–1.7.5 says: regenerate tiles, decide incompatible behaviors with `main` as the baseline, record `Conflict decisions:` in the merge commit, and fix what the tests catch. Never stop for a conflict. Only its step 1.7.6 case (a tool the resolution needs can't run) aborts the merge; then pause and stop with `merge tool unavailable: <tool> — <files>`. List any conflict decisions in the step 6 report.
4. If git refuses because the merge would overwrite uncommitted files, those are another session's edits: pause and stop, naming them. Don't touch them.

The merge commit is pushed with the rest of the branch in step 4.

## 1. Run $review-handoff

Skip this step when step 0.6 reused a ready review or resumed at step 5.

Load [the sibling review-handoff skill](../review-handoff/SKILL.md) from this skill's checkout and follow it exactly. Missing skill or reference files stop with `error`. Use this session as its coordinator. Always pass `--apply` and the absolute `<task-dir>/handoff.md` path; forward `--fast` and `--candidate` only when explicitly supplied. Do not start another coordinator CLI session.

The standalone skill owns the reviewer prompts, models, evidence checks, candidate, ledger and unique invocation scratch. Its sequence is Codex round 1, then Claude review and Codex validation in round 2. The handoff budget is two rounds, independent of `$review-pr`'s three-round budget later.

Retain its fresh JSON result path as `<handoff-result>` and read it. Do not reuse prior invocation output, except a ready result that step 0.6 checked against the current handoff hash. The result and candidate stay inside this task's scratch even when the task folder is moved later.

## 2. Require a ready, applied handoff

- Require `status: ready`, `roundCount: 2`, `applied: true`, this task's handoff/branch/checkout identity, and a candidate hash matching the saved original handoff. Require its baseline inventory and `inspectedPaths` to cover the reviewed paths and every referenced task target. Missing or contradictory result fields stop with `error`.
- For `blocked` because the work already landed on `main`: nothing is left to do. Move `<task-dir>` to `.plans/done/`, set its row to `Complete (already on main)` with the commit that landed it, and go to step 6.
- For `blocked` because the branch or worktree belongs to another task, or for `capped`, `stalled`, `stale` or `error`, pause and report the exact status, reason and artifact paths before code changes. Never implement a scratch candidate or automatically start another review invocation (step 0.6's single fresh review after a stale reuse is the only exception).
- Read the ready original handoff in full. Its validated amendments are now the spec. Design amendments must remain visible in its review-amendments record and in the eventual PR description.

Do not apply additional amendments here: the standalone skill already saved the exact ready candidate. Any substantive edit after readiness invalidates that approval.

## 3. Implement

Work in `<wt>`, following the amended handoff:

0. Fetch `origin/main` and pin the fetched SHA as `<sync-main-sha>`, then perform the freshness preflight **before** merging, resolving conflicts, rebuilding/publishing data or making code edits. Recheck the handoff hash and compare every `inspectedPaths` input (including planned new/deleted targets) between the result's `branchSha` and current HEAD, and between its `mainSha` and `<sync-main-sha>`. Also compare each reviewed input's live bytes/existence against the saved baseline inventory, and check its staged and unstaged differences: dirty reviewed git inputs or changed nongit inputs are `stale` even when HEAD is unchanged. Planned absent targets must still be absent. If any reviewed input changed and `<handoff-result>` was reused by step 0.6, run step 1 as a fresh `$review-handoff` invocation, then step 2, then this step again. Otherwise (the review ran in this invocation) pause with `stale`, naming the files and leaving them untouched; do not run a hidden third round. If the preflight passes, synchronize with steps 2–4 of "Pull main", skipping its fetch and substituting `<sync-main-sha>` for `origin/main` throughout that merge and its delegated conflict instructions. Repeat all revision, live-file, dirty-file and handoff-hash checks before implementing, including checking current `origin/main`, since another session or conflict decision may have changed reviewed inputs. If only unrelated files changed, record the comparisons and refreshed revisions alongside `<handoff-result>` without changing its original review record. Re-read the ready handoff without editing it. This is the last synchronization; from here on `$review-pr` merges `main`.
1. Do its steps in order. After each step, run that step's targeted test. Fix failures before moving on.
2. Treat its "Stop and report if" section as a list of problems to solve, not places to pause (see "Solve blockers" under Rules):
   - **Drift** (cited code moved or changed): find where the code went and continue. If the step's change no longer applies to the code at all, adapt it so it reaches the same goal on the current code.
   - **An outcome or premise condition** (a measured gate fails, a premise is false, the approach doesn't work): find the cause, change the approach within the goal, Invariants and Out of scope, then measure again. Record each attempt and its numbers in `<scratch>/progress.md`. Keep committing working steps.
   - **Still unmet after those attempts:** don't pause. Finish the remaining steps, and carry the unmet gate, its latest numbers and what was tried into the PR body (step 4) and the report.
   - **A hard stop** (Rules): commit nothing further, then pause and stop. Leave any commits already made local and unpushed, and list them in the report.
3. Respect its Invariants and Out of scope sections, and `AGENTS.md`.
4. Once at the end, run its Verification section.
5. Commit as its Commit section says. Run `git status` and `git branch` first, stage by explicit path, and use its gitmoji message(s).

## 4. Land the branch

Follow steps 1 and 3 of `<skill-dir>/../sync-review/SKILL.md` for this one branch and worktree, with these adjustments. Don't merge `origin/main` here: `$review-pr` does it first, in step 5.

For the delegated steps, set `<review-pr-skill>` to `<skill-dir>/../review-pr/SKILL.md`, `<run>` to this invocation's `<scratch>`, and `<slug>` to the branch name with `/` replaced by `-`. Confirm the sibling review skill exists before following step 1.

- **Step 1 (commit and push):** usually only pushes, since step 3 already committed. Anything uncommitted at this point is either work the handoff missed (commit it) or not this task's (hold it back and report it). A held-back file or rejected push → pause and stop.
- **Step 3 (PR):** if there's no PR, create one. Take the body from the handoff's Goal & context, its steps, and its Verification results (what actually ran). Add a "Handoff review amendments" section listing the design amendments. If a gate is still unmet (step 3.2), add an "Unmet gates" section: the gate, its target, the latest measurement, and the approaches tried.

## 5. Run $review-pr

Start it once, in a fresh Codex PR-review coordinator, with a shell timeout of at least 4 hours:

```
& '<codex>' exec -m gpt-6.1-sol -c 'model_reasoning_effort="xhigh"' <speed> -C <wt> -o <scratch>/review.md 'Use the review-pr skill at <skill-dir>/../review-pr/SKILL.md, following it exactly, on this branch''s PR. Arguments: <--fast, or nothing>. Result file: <scratch>/review.json.'
```

Read `<scratch>/review.json`. If it's missing, use the `review-pr-result` block at the end of `review.md`. `$review-pr` has already written the PR review cell of the task's row.

- `clean` (review clean and CI green): go to step 6, which decides completion from the retained unmet-gate state.
- Anything else (`capped`, `stalled`, `stopped`, `ci-red`, `error`), including `stopped` for `merge tool unavailable`: the PR stays open. Set the row's Next step to the status and its `stopReason`. The folder stays in `active/`.

## 6. Report and clean up

Report, following the handoff's "Report back" section, and add:

- **Handoff review:** the status, round count (of 2), Codex then Claude → Codex sequence, result path, whether applied, and every amendment (design first). Include any freshness stop. Never describe capped or stale review as ready. If step 0.6 reused an earlier review, say "reused <run folder>"; if it skipped to `$review-pr` because the PR already existed, say so.
- **Blockers solved and gates unmet:** each outcome or premise condition hit in step 3.2, what was changed to solve it, and any gate still unmet with its latest numbers.
- **The PR URL**, and the `$review-pr` result: the main merge (`mainMerge`), review rounds (`roundCount` of 3), final status, the CI status, and anything it skipped or noticed. If the review was already clean at the PR's head, say "PR review: already clean at <sha>".
- Which checks ran locally, and which were left to CI.
- The speed the Codex instances ran at (fast or normal), and the resolved `codex`/`claude` versions from the handoff and PR reviews.

Then, per `AGENTS.md`:

- **Task status:**
  - `clean` with every gate met: move `<task-dir>` to `.plans/done/`, and set its row to Complete, with the PR # and the final commit.
  - `clean` with an unmet gate: leave the folder in `active/`. Set Status to `PR open; gate unmet` and Next step to the gate and its latest numbers.
  - Paused or not clean: leave the folder where step 2–5 put it, with the row's Next step saying why.
- **Scratch:** leave it in `<task-dir>`. `$merge-pr` deletes it with `pnpm plans:clean` when the PR merges, keeping `handoff.md` and the files the handoff marks **keep**. Never delete scratch with shell commands: Codex rejects recursive deletes as "blocked by policy".
