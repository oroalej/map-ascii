---
name: implement-handoff
description: Take an ASCII Atlas handoff from two-round review to PR, implementation, synchronization, resumable PR review and CI. Retains progress when delegated PR review exhausts usage; never merges. Use for $implement-handoff with optional --fast, --claude-effort and a task name or handoff path.
---

# Review a handoff → implement → land as a PR → $review-pr

Usage: `$implement-handoff [--fast] [--claude-effort <level>] [--candidate <prior candidate path>] <task | path to handoff.md>`

Invoking `$implement-handoff` authorizes these actions for this one task:

- editing its `handoff.md` with review amendments
- running `$review-handoff --apply` with its two-round limit
- creating its worktree if the handoff says it's a new task (or a detached work tree when it can't be used)
- implementing it, committing and pushing
- merging `origin/main` into its branch, resolving every conflict (including regenerating and publishing tiles with `pnpm data:build` / `pnpm data:publish`)
- opening a PR to `main`
- running `$review-pr`, which synchronizes `main` into the branch, commits and pushes fixes and CI fixes

Don't ask for confirmation between steps. An interrupted delegated PR review ends this invocation with saved progress; the handoff review keeps its existing retry policy. Other ends are the ones in `<skill-dir>/../review-pr/SKILL.md` "Ends": nothing to do (no such handoff, or the work already landed on `main`) and a missing tool. Its Shared patterns (Retry, Detached work tree, Decide, don't stall, Carry, don't stop, Relaunch on the wrong model) apply here. The handoff's "Stop and report if" conditions are problems to solve, not stops. Never merge the PR.

## Models

Always pass these explicitly. Claude PR-review effort follows the explicit option or recovered checkpoint; keep the listed models, handoff-review effort and Codex effort settings. Never fall back to another model.

| Role | Model | Effort | Speed |
| --- | --- | --- | --- |
| This session: amends the handoff, implements, commits, opens the PR | Sol 6.1 (`gpt-6.1-sol`) | xhigh | the session's own setting |
| Inside `$review-handoff`: round 1 review / round 2 validation | Sol 6.1 (`gpt-6.1-sol`) | max | `<speed>` |
| Inside `$review-handoff`: round 2 review | Claude Opus 5.5 (`claude-opus-5-5`) | high | normal |
| PR review coordinator: runs `$review-pr`, including main synchronization | Sol 6.1 (`gpt-6.1-sol`) | xhigh | `<speed>` |
| Inside `$review-pr`: the review / its validation | Claude Opus 5.5 (`claude-opus-5-5`), `<claude-effort>` / Sol 6.1, max | | normal / `<speed>` |

**Binaries:** several copies of `codex` can be installed, and an old one rejects `gpt-6.1-sol`. Run only `<codex>`, the newest installed copy, resolved in step 0.1. Never run a bare `codex` or any path other than the resolved `<codex>`. `$review-handoff` and `$review-pr` resolve their own newest `codex` and `claude`.

This session must be Sol 6.1 (`gpt-6.1-sol`) at xhigh effort. If it's running a different model or effort, relaunch (review-pr Shared patterns) with the same arguments and relay that run's report.

`<speed>` comes from the `--fast` option:

- with `--fast`: `-c 'service_tier="fast"' --enable fast_mode`
- without it: `--disable fast_mode`. Pass this explicitly, because the user's Codex config may default to fast.

`--fast` is also forwarded to `$review-handoff` and `$review-pr`. It doesn't change Claude, or this session's own speed.

`--claude-effort <level>` accepts `low`, `medium`, `high`, `xhigh` or `max` for PR reviews only. Reject missing/invalid values before changing the task or launching a process. Pass an explicit selection into PR checkpoint initialization as `claudeEffort`; omit it when absent so recovery inherits an explicitly chosen saved setting or defaults to `medium`. Preserve it on coordinator relaunches. Do not forward it to `$review-handoff`; its Claude review stays at `high`.

## Rules

- **Git safety:** never check out, switch branches, stash, reset, rebase, force-push, use `git add -A`, `git add .` or `git commit -a`, or pass `--no-verify`.
- **Main moves on.** Pull `origin/main` before the handoff review (step 0.4) and once more before implementing (step 3.0). The review reads `main` once; it never re-checks it. Drift after the review is handled while implementing (step 3.2): find where the code went and continue. After implementation starts, `$review-pr` handles synchronization.
- **Windows:** prompts that contain `$` go in single quotes, and stdout is captured with `Out-File -Encoding utf8`, never a plain `>`.
- **Long commands:** the `$review-pr` run can take several hours. If the shell tool can't hold a command that long, start it in the background with its output going to a log in `<scratch>`, and poll until it exits.
- **Solve blockers; don't pause for them.** A failed gate, a premise that turns out false, an approach that doesn't work, or a finding a reviewer noticed is a problem to solve inside this task, not a decision for the owner. Diagnose it, change the approach within the handoff's goal, Invariants, Out of scope and `AGENTS.md`, and measure again. A gate that still fails after that doesn't stop the run: commit, open the PR, and list the gate as unmet in the PR body and the report. The same goes for a step whose only implementation would break an `AGENTS.md` rule: choose a compliant approach, and if the goal can't be reached that way, carry it as an unmet gate.
- **Uncommitted files in this task's worktree** are this task's work in progress (from an earlier run of it). Commit them with this task's commits, holding back secrets (`.env*`, keys, tokens, credentials) and files over 10 MB, which stay uncommitted and are reported. If they would block a merge anyway, use a detached work tree (review-pr Shared patterns) for the merge.
- **Ending early** happens only for a missing tool: set the task row's Next step to the missing tool and what installs it, leave the folder in `active/`, and go to step 6. Commits already made stay; push them first when the push itself works.

## 0. Resolve the handoff

1. `<main-checkout>` is the first entry of `git worktree list`. Take out `--fast` if present, and set `<speed>`. Take out and validate `--claude-effort <level>` if present, retaining whether it was explicit. Resolve an explicitly supplied `--candidate` path against the invocation directory and retain its absolute path for the handoff review; it is not the original handoff path. Resolve the newest installed Codex (PowerShell):

   ```
   pnpm.cmd -C <repo> --silent cli:latest codex
   ```

   `<repo>` is the checkout holding this `SKILL.md` (`<skill-dir>/../../..`). Use `pnpm.cmd`, because the execution policy blocks `pnpm.ps1`. Check `$LASTEXITCODE` immediately; if non-zero, end with a missing tool. Set `<codex>` to the absolute path printed on stdout and retain it in session context, like `<scratch>` and `<speed>`. It prints `codex <version> <path>` on stderr; note the version for the report. Shell variables do not survive separate tool calls: replace `<codex>` with the resolved path in every later command, keeping its single quotes for paths containing spaces.
2. Find the handoff:
   - **A path:** use it.
   - **A task name:** look for `<main-checkout>/.plans/{todo,paused,active}/<task>/handoff.md`.
   - None found: end (nothing to do). Several: use the first in the order active, paused, todo, and say which.

   `<task-dir>` is the folder holding the handoff. Use it as `<scratch>`: every file this skill writes goes there.
3. Read the whole handoff, and `AGENTS.md`.
4. From the handoff's §1 (Goal & context), take the branch and worktree:
   - **It names an existing worktree** (a follow-up): use it. Confirm with `git worktree list` that the worktree is on that branch. If cleanup removed it, restore the original branch/path using AGENTS.md's retained-remote procedure: fetch the task branch, reuse its local branch if present, or recreate it tracking `origin/<branch>`. Never invent a replacement branch/path or overwrite an occupied directory; an occupied path gets a detached work tree instead. In the restored worktree run `pnpm install --frozen-lockfile --prefer-offline`, `pnpm data:fetch` and the Claude worktree-settings initializer from this skill's checkout. These restoration steps are authorized by this invocation.
   - **It's a new task:** run `pnpm worktree:new <short> <topic>` from `<main-checkout>`, with the names the handoff gives. If it gives none, derive them from the task folder name. If the script fails after creating the worktree, run `pnpm install --frozen-lockfile --prefer-offline` and `pnpm data:fetch` in it yourself. If it fails before (the branch or path already exists for another task), derive the names from the task folder name; `$review-handoff` amends the handoff to match.

   `<wt>` is that worktree.

   Then pull `origin/main` into it (see "Pull main" below).
5. Move `<task-dir>` to `<main-checkout>/.plans/active/` if it is not already there. Before moving, verify resolved old/new paths stay within this task's main-checkout `.plans/` locations and that the destination is unoccupied. Retain each task-local path's suffix relative to the old task directory. After moving, rebase `<task-dir>`, `<scratch>`, a supplied task-local `--candidate`, and any result/artifact variables onto the new directory. Preserve historical JSON records unchanged. Add or update its `.plans/README.md` row: status `Implementing (implement-handoff)`, Evidence `<branch> / <wt>`. Leave its Handoff review and PR review cells as they are (`not run` in a new row); the review skills write them.
6. **Resume where the task left off.** Decide from the result files, not from the README cells (those are for people):
   - **An open, non-draft PR exists for the branch** (`gh pr list --head <branch> --state open --json number,isDraft,headRefOid`): the implementation already landed. Read its body with `gh pr view <N> --json body` and restore the "Unmet gates" section's gates, targets, latest measurements and approaches tried for steps 5–6. Skip steps 1–4. Search only `<task-dir>/review.json` and invocation-root `.plans/*/pr<N>-review-fixes/run-*/result.json` files for final `review-pr` results; never consume `round<k>/result.json` records. Require `pr: <N>` and `headSha` equal to the PR's current `headRefOid`, then select the newest matching final result by modification time. If it is `clean` with `ci.status` equal to `green` or `fixed`, report "PR review: already clean at <sha>" and go to step 6 as `clean`, retaining the restored unmet gates. Otherwise go to step 5 with those gates retained.
   - **Otherwise, a ready handoff review may be reused.** Take the newest `<task-dir>/handoff-review/run-*/result.json` with `status: ready`, `applied: true`, this task, and a `candidateHash` equal to the SHA-256 of the current `handoff.md`. If one exists, skip step 1, set `<handoff-result>` to it and go to step 2. `main` having moved since doesn't matter (Rules).
   - **A resumed implementation:** if the branch already has this task's commits after the reused result's `branchSha` (`git merge-base --is-ancestor <branchSha> HEAD` succeeds and HEAD differs), those commits are the implementation in progress. Step 3.1 continues from the first step that `<scratch>/progress.md` and `git log` don't show as done.
   - **Nothing to reuse:** continue normally.

### Pull main

Bring the branch up to date with `main` before the review and again before the first code edit, so both work against current code:

1. `git -C <wt> fetch origin main` (with Retry). If `git -C <wt> merge-base --is-ancestor origin/main HEAD` succeeds, it's already current.
2. Otherwise `git -C <wt> merge origin/main -m "🔀 merge(<scope>): sync <topic> with main"` (same `<scope>`/`<topic>` rule as `<skill-dir>/../review-pr/SKILL.md` step 1.7.3). A branch with no commits of its own just fast-forwards.
3. Resolve every conflict as `review-pr` step 1.7.4–1.7.6 says: regenerate tiles (tippecanoe through Docker when it isn't installed), decide incompatible behaviors with `main` as the baseline, record `Conflict decisions:` in the merge commit, and fix what the tests catch. Never stop for a conflict. Only a tool that is still missing after its fallbacks ends the run (`merge tool unavailable: <tool> — <files>`). List any conflict decisions in the step 6 report.
4. If git refuses because the merge would overwrite uncommitted files, commit those files first as this task's work in progress (Rules), then merge again.

The merge commit is pushed with the rest of the branch in step 4.

## 1. Run $review-handoff

Skip this step when step 0.6 reused a ready review or resumed at step 5.

Load [the sibling review-handoff skill](../review-handoff/SKILL.md) from this skill's checkout and follow it exactly. Missing skill or reference files are a missing tool. Use this session as its coordinator. Always pass `--apply` and the absolute `<task-dir>/handoff.md` path; forward `--fast` and `--candidate` only when explicitly supplied. Do not start another coordinator CLI session.

The standalone skill owns the reviewer prompts, models, evidence checks, candidate, ledger and unique invocation scratch. Its sequence is Codex round 1, then Claude review and Codex validation in round 2. It retries failed processes, fixes nonmatching amendments, decides conflicts and applies the validated amendments itself. The handoff budget is two rounds, independent of `$review-pr`'s rounds later.

Retain its fresh JSON result path as `<handoff-result>` and read it.

## 2. Use the reviewed handoff

- `ready` with `applied: true`: read the original handoff in full. Its validated amendments are now the spec. Design amendments and post-review amendments must remain visible in its review-amendments record and in the eventual PR description.
- `ready` without `applied: true`, or a result with missing fields: run step 1 again.
- `blocked` (the work already landed on `main`): nothing is left to do. Move `<task-dir>` to `.plans/done/`, set its row to `Complete (already on main)` with the commit that landed it, and go to step 6.
- `error`: a missing tool. End early (Rules) with its `stopReason`.

Do not apply additional amendments here: the standalone skill already saved the reviewed handoff.

## 3. Implement

Work in `<wt>`, following the amended handoff:

0. Pull `origin/main` again ("Pull main"). This is the last synchronization; from here on `$review-pr` merges `main`. There's no freshness check against the review: whatever moved is drift, handled in step 2.
1. Do its steps in order. After each step, run that step's targeted test. Fix failures before moving on.
2. Treat its "Stop and report if" section as a list of problems to solve, not places to pause (see "Solve blockers" under Rules):
   - **Drift** (cited code moved or changed): find where the code went and continue. If the step's change no longer applies to the code at all, adapt it so it reaches the same goal on the current code.
   - **An outcome or premise condition** (a measured gate fails, a premise is false, the approach doesn't work): find the cause, change the approach within the goal, Invariants and Out of scope, then measure again. Record each attempt and its numbers in `<scratch>/progress.md`. Keep committing working steps.
   - **Still unmet after those attempts:** don't pause. Finish the remaining steps, and carry the unmet gate, its latest numbers and what was tried into the PR body (step 4) and the report.
   - **A missing tool:** end early (Rules).
3. Respect its Invariants and Out of scope sections, and `AGENTS.md`.
4. Once at the end, run its Verification section.
5. Commit as its Commit section says. Run `git status` and `git branch` first, stage by explicit path, and use its gitmoji message(s).

## 4. Land the branch

Follow steps 1 and 3 of `<skill-dir>/../sync-review/SKILL.md` for this one branch and worktree, with these adjustments. Don't merge `origin/main` here: `$review-pr` does it first, in step 5.

For the delegated steps, set `<review-pr-skill>` to `<skill-dir>/../review-pr/SKILL.md`, `<run>` to this invocation's `<scratch>`, and `<slug>` to the branch name with `/` replaced by `-`. Confirm the sibling review skill exists before following step 1.

- **Step 1 (commit and push):** usually only pushes, since step 3 already committed. Anything uncommitted at this point is work the handoff missed (commit it) or a held-back secret or large file (leave it uncommitted and report it). A rejected push is fetched, merged and pushed again, as that step says.
- **Step 3 (PR):** if there's no PR, create one. Take the body from the handoff's Goal & context, its steps, and its Verification results (what actually ran). Add a "Handoff review amendments" section listing the design and post-review amendments. If a gate is still unmet (step 3.2), add an "Unmet gates" section: the gate, its target, the latest measurement, and the approaches tried.

## 5. Run $review-pr

Read `<skill-dir>/../review-pr/references/recovery.md` and follow its delegated coordinator protocol. Initialize the PR identity/current head with explicit `claudeEffort` only when supplied (automatic recovery), then run the coordinator through `review:state run` with `phase: "coordinator"`, `output: "file"`, and `resultFile: "<scratch>/review.json"`. Use the reference's exact model/effort/speed arguments, substitute `{report}` for the output path, and add `--claude-effort <state.claudeEffort>` and `Worker checkpoint: <review-scratch>` to the prompt. Allow at least 4 hours:

```
pnpm.cmd -C <repo> --silent review:state run --input <scratch>/coordinator-input.json
```

Read `<scratch>/review.json`, or the canonical checkpoint result. If missing, inspect the process receipt and checkpoint before Retry. Await a live child; a dead coordinator retry initializes a continuation without repeating verified review/validation. A quota receipt or wrapper exit 75 is interrupted, including when no final model report exists. `$review-pr` writes the task's PR review cell when it can report.

- `clean` (review clean and CI green): go to step 6, which decides completion from the retained unmet-gate state and any entries `$review-pr` carried as `open`.
- `error` (a missing tool): the PR stays open. Set the row's Next step to its `stopReason`. The folder stays in `active/`.
- `interrupted`: report the checkpoint, reset information and resume command; set the row's Next step accordingly. Leave the task active, preserve WIP and scratch, and end without marking implementation complete or retrying the exhausted process.

## 6. Report and clean up

Report, following the handoff's "Report back" section, and add:

- **Handoff review:** the status, round count (of 2), Codex then Claude → Codex sequence, result path, whether applied, retries and restarts, and every amendment (design first, then post-review). If step 0.6 reused an earlier review, say "reused <run folder>"; if it skipped to `$review-pr` because the PR already existed, say so.
- **Blockers solved and gates unmet:** each outcome or premise condition hit in step 3.2, what was changed to solve it, and any gate still unmet with its latest numbers.
- **The PR URL**, and the `$review-pr` result: the main merge (`mainMerge`), review rounds (`roundCount`), final status, the CI status, open entries it carried, and anything it noticed. If the review was already clean at the PR's head, say "PR review: already clean at <sha>".
- Held-back files, detached work trees, and conflict decisions.
- Which checks ran locally, and which were left to CI.
- The speed the Codex instances ran at (fast or normal), and the resolved `codex`/`claude` versions from the handoff and PR reviews.

Then, per `AGENTS.md`:

- **Task status:**
  - `clean` with every gate met and no open review entries: move `<task-dir>` to `.plans/done/`, and set its row to Complete, with the PR # and the final commit.
  - `clean` with an unmet gate or open review entries: leave the folder in `active/`. Set Status to `PR open; gate unmet` (or `PR open; <n> open review entries`) and Next step to the gate and its latest numbers, or the entries.
  - Ended early for a missing tool: leave the folder in `active/`, with the row's Next step naming the tool.
  - Interrupted review: leave the folder in `active/`, with the row's Next step naming the checkpoint and continuation command. Existing unmet gates and open entries remain in effect on the next invocation.
- **Scratch:** leave it in `<task-dir>`. `$merge-pr` deletes it with `pnpm plans:clean` when the PR merges, keeping `handoff.md` and the files the handoff marks **keep**. Never delete scratch with shell commands: Codex rejects recursive deletes as "blocked by policy".
