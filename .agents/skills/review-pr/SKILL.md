---
name: review-pr
description: Review a pull request until clean and CI is green, automatically continuing verified progress from an interrupted review. Claude Opus 5.5 reviews, Sol 6.1 validates, and the coordinator fixes and pushes. Saves a checkpoint and ends on usage exhaustion; never merges. Use for $review-pr with a PR number or branch, optional --fast, --fresh or --resume, or requests to get a Claude PR review and fix its findings.
---

# Claude review → Codex validation → fixes, until clean, then CI

Treat invocation of `$review-pr` as authorization to run the whole flow: opening the branch's PR if it has none, creating the PR branch's worktree (or a detached work tree) if needed, merging `origin/main` into the PR's branch (resolving every conflict, including regenerating and publishing tiles with `pnpm data:build` / `pnpm data:publish` when tiles conflict) and pushing, review rounds until one is clean (Claude's review, the validation run, the fixes, commits and pushes to the PR's branch), then the CI gate until CI is green (CI fixes, commits and pushes). Do not ask for confirmation between steps. Usage exhaustion ends with saved progress: see "Ends" below. Never merge the PR.

Read [recovery.md](references/recovery.md) before initialization or launching a process. Its checkpoint protocol applies throughout this skill, including delegated coordinators and model relaunches. `<state-tool>` is `<repo>/scripts/pr-review-state.ts`; run it from the skill checkout so branches predating the helper still work.

## Models

Always pass these explicitly. Never change them or fall back to another model.

| Role | Model | Effort | Speed |
| --- | --- | --- | --- |
| Review (every round) | Claude Opus 5.5 (`claude-opus-5-5`) | high | normal |
| Codex #1: validates Claude's review (analysis only, every round) | Sol 6.1 (`gpt-6.1-sol`) | max | `<speed>` |
| This session: fixes, commits, pushes, CI fixes | Sol 6.1 (`gpt-6.1-sol`) | xhigh | the session's own setting |

**Binaries:** several copies of `codex` and `claude` can be installed, and an old `codex` rejects `gpt-6.1-sol`. Run only the newest installed copies, `<codex>` and `<claude>`, resolved in step 1.6. Never run a bare `codex` or `claude`, or any path other than the resolved `<codex>` or `<claude>`.

## Inputs (all optional)

- `<PR number | branch>`: the PR to review: `22`, `#22`, `codex/x` or `origin/codex/x`. Without it, the current branch's PR (step 1.2). `$sync-review` and `$implement-handoff` pass none; they start Codex with `-C <wt>`, so the current branch is the PR's.

- `--fast`: every Codex instance this skill starts runs in fast mode. Today that's Codex #1, in every round. Set `<speed>` once, and pass it to every `<codex> exec` this skill runs:
  - with `--fast`: `-c 'service_tier="fast"' --enable fast_mode`
  - without it: `--disable fast_mode`. Pass this explicitly, because the user's Codex config may default to fast.

  `--fast` doesn't change Claude or this session.
- `Result file: <path>`: a caller such as `$sync-review` passes this. Write the final result JSON there (step 7).
- `--fresh`: start an independent review, retaining earlier invocations. Do not duplicate an active review process.
- `--resume <run-path>`: select that checkpoint or verifiable legacy invocation. With no PR argument, resolve the PR from its saved identity; reject a mismatched explicit target. Reject combining `--fresh` and `--resume`.
- `Worker checkpoint: <run-path>`: internal delegated invocation only. Attach to the caller's initialized checkpoint after verifying its repository, PR and branch. Do not initialize a second invocation or mistake the supervising coordinator receipt for another reviewer.

## Ends

A run ends only when:

- **the work is done:** `clean`;
- **usage is exhausted:** `interrupted`, with checkpoint, phase, round, literal reset information and resume command. Save immediately rather than spending the Retry window on a known exhausted quota. Do not schedule a restart; a new invocation resumes it. A coordinator that ends abruptly may have no final result; its last checkpoint and process receipts still support recovery.
- **there is nothing to do:** no open PR and no branch commits to open one from, or the PR is already merged or closed (`error`, with that reason);
- **a tool is missing:** `cli:latest` can't resolve `codex` or `claude`, `gh` isn't authenticated, the repo lacks `.claude/skills/review-pr/SKILL.md`, a needed tool such as tippecanoe can't run natively or through Docker, or the network or a model stays unavailable through the whole Retry window (`error`).

Everything else is solved with the patterns below. `$implement-handoff`, `$review-handoff`, `$merge-pr` and `$sync-review` use the same patterns and refer to this section.

## Shared patterns

- **Retry.** In this PR review and delegation into it, check the process receipt for explicit usage exhaustion first and propagate `interrupted`. Temporary capacity errors, generic rate limits, network errors, missing reports and malformed reports still use Retry. When a CLI process exits nonzero, or a `git fetch`, network `git push` or `gh` call fails, rerun the same command with the same model, effort and input, writing process output to a fresh `attempt-<n>/` subfolder. Back off 1, 2, 4, 8, 15, 15… minutes, up to 60 minutes in total, printing a progress line before each wait. A retry never counts as a round. Never switch models. Only when the window runs out does the failure count as a missing tool. Other skills' own handoff reviewer retry policies are unchanged.
- **Detached work tree.** When the branch's worktree can't be used (its branch is checked out in `<main-checkout>`, its path is occupied by a folder of unknown origin, a merge would touch its uncommitted files, it is behind and dirty, or its local branch has diverged from `origin/<branch>`), leave it untouched. Create `<main-checkout>/worktrees/pr<N>` (a caller without a PR uses `<main-checkout>/worktrees/<short>-work`) with `git -C <main-checkout> worktree add --detach <path> origin/<branch>`, then run `pnpm install --frozen-lockfile --prefer-offline`, `pnpm data:fetch` and `pnpm.cmd exec tsx "<repo>/scripts/claude-worktree-settings.ts"` in it. Work there and push with `git push origin HEAD:<branch>`. If that path is already a detached tree, reuse it when it is clean and `git merge --ff-only origin/<branch>` succeeds; otherwise use the next free `-<k>` suffix. Report the path and the untouched worktree's state. `$merge-pr` removes it with `git worktree remove` once the PR merges.
- **Decide, don't stall.** For two claims or fixes that contradict each other, a finding that recurs after it was fixed, or a fix that would revert an earlier one, read the evidence on both sides, choose or combine, and record the decision and its reason (in the commit body and the round's record). Add the losing claim to `rejected.md` (or the ledger) so it doesn't come back. Never stop for it.
- **Carry, don't stop.** Something that still can't be made to work after real attempts, such as a fix whose test won't pass or a gate that won't meet its target, is committed as far as it works. List it in the PR body under "Open review entries", with what was tried, and continue.
- **Relaunch on the wrong model.** A skill that requires a Sol 6.1 (`gpt-6.1-sol`) xhigh session may be started from a different model or effort. It then resolves `<codex>` (`pnpm.cmd -C <repo> --silent cli:latest codex`) and starts itself with `& '<codex>' exec -m gpt-6.1-sol -c 'model_reasoning_effort="xhigh"' <speed> -C '<same directory>' '<the same invocation and arguments>'`, relaying that run's report and result. It never asks the user to restart.
  For a PR review relaunch, use the recovery reference's initialized coordinator wrapper and `Worker checkpoint` prompt, so usage exhaustion is recorded even without a final model report. Preserve the same public arguments. Other skills' own relaunch commands retain their existing behavior.

## Rules

- **Git safety:** never check out, switch branches, stash, reset, rebase, force-push, use `git add -A`, `git add .` or `git commit -a`, or pass `--no-verify`.
- **Work in the PR's worktree.** Moving to the PR means working in its worktree (step 1.3), never checking its branch out somewhere else. Run every command from step 1.3 on with `<pr-checkout>` as its working directory (`git -C <pr-checkout>`, `pnpm -C <pr-checkout>`, `<codex> exec -C <pr-checkout>`, or the shell tool's working-directory option), except where a step explicitly targets `<repo>` or `<main-checkout>`.
- **Windows:** stdout is captured with `Out-File -Encoding utf8`, never a plain `>`, which writes UTF-16.
- **Long commands:** if the shell tool can't hold a command for its timeout, start it in the background with output going to a log in `<scratch>`, and poll until it exits.
- **On "end with `error`"**, skip straight to step 7 with that status and a `stopReason`. Only the cases under "Ends" do this.
- **On `interrupted`**, use the recovery reference to publish the checkpoint result, then step 7 to update the index and report. Preserve scratch and working changes. A result or receipt from an earlier invocation is reusable only under the reference's provenance and commit checks.

## 1. Resolve the branch's PR

1. `<skill-dir>` is the absolute folder holding this loaded `SKILL.md`; `<repo>` is its checkout (`<skill-dir>/../../..`). Confirm the repo has the Claude skill: `.claude/skills/review-pr/SKILL.md`. If it is missing, end with `error` (missing tool).
2. Find the PR. The fields are `number,title,headRefName,headRefOid,baseRefName,url,state`. Resolve `--resume` identity before choosing a PR; a saved PR never falls back to a different open PR.
   - **With a `<PR number | branch>` argument:** strip a leading `#` or `origin/`, then `gh pr view <arg> --json <fields>`. If its `state` is `MERGED` or `CLOSED`, end with `error` (`PR #<N> is <state>`: nothing to do). If a branch has no PR, open one (below).
   - **Without one:** run `git branch --show-current`, then `gh pr view --json <fields>`.
     - If the current branch isn't `main` and has no PR, open one (below). Never fall back to another PR: a caller running in a task worktree must get its own branch's PR.
     - If the current branch is `main` (the user started it from the main checkout), run `gh pr list --state open --json number,headRefName,title,updatedAt`. Use the most recently updated open PR whose head branch has a worktree in `git worktree list`, or the most recently updated open PR when none has one. Say which, and list the others as `$review-pr <N>  # <branch> — <title>` lines. With no open PR at all, end with `error` (nothing to do).
   - **Opening a PR:** the branch must have commits that `origin/main` lacks; if it has none, end with `error` (nothing to do). Push it (`git push -u origin <branch>`) if `origin/<branch>` is missing or behind. Write a body to a file in the OS temp folder and run `gh pr create --base main --head <branch> --title "<title>" --body-file <file>`. Title: a gitmoji + conventional header summarizing the branch's commits since `main`. Body: what the branch does, from its commits and its handoff (if `.plans/README.md` lists it), plus the checks its handoff names, without claiming tests that weren't run. Then read the new PR's fields.
3. Go to the PR's worktree. `<main-checkout>` is the first entry of `git worktree list --porcelain`. `<pr-checkout>` is the entry whose branch is `headRefName`. Inspect the saved checkpoint before fast-forwarding, pushing, selecting a detached tree, or replacing a baseline. Preserve verified owned WIP; unfamiliar edits retain the protections below. A pending commit or push is reconciled with Git before repeating it.
   - If `headRefName` is checked out in `<main-checkout>`, use a detached work tree (Shared patterns) as `<pr-checkout>`; the main checkout stays untouched.
   - If no worktree has it, create one as AGENTS.md's Git section says. `<short>` is `headRefName` without `codex/` and with `/` replaced by `-`. Run `git -C <main-checkout> fetch origin <headRefName>`. Then, if the local branch exists: `git -C <main-checkout> worktree add <main-checkout>/worktrees/<short> <headRefName>`. Otherwise: `git -C <main-checkout> worktree add --track -b <headRefName> <main-checkout>/worktrees/<short> origin/<headRefName>`. In the new worktree, run `pnpm install --frozen-lockfile --prefer-offline`, `pnpm data:fetch` and `pnpm.cmd exec tsx "<repo>/scripts/claude-worktree-settings.ts"`. Use the initializer from the skill checkout even when the PR branch predates it; keep the new worktree as the command's working directory. If the path is already occupied by a folder of unknown origin, don't reuse it: use a detached work tree instead.
   - For existing worktrees too, run `git -C <pr-checkout> fetch origin <headRefName>` (with Retry) before comparing `HEAD` with `origin/<headRefName>`.
   - If the local branch is behind the fetched remote (different heads, and `git -C <pr-checkout> merge-base --is-ancestor HEAD origin/<headRefName>` succeeds), fast-forward when `git -C <pr-checkout> status --porcelain` is empty: `git -C <pr-checkout> merge --ff-only origin/<headRefName>`. A behind, dirty worktree, or a fast-forward that fails, switches to a detached work tree at `origin/<headRefName>`. Leave the dirty files untouched and name them in the report.
   - If the local branch is ahead of the remote (unpushed commits on the PR's branch), push them first. If neither head is an ancestor of the other, use a detached work tree at `origin/<headRefName>`, leave the local branch alone, and report both SHAs.
   - Say which PR (#, branch) and `<pr-checkout>` this run uses, and whether it is a detached work tree, in the first lines of output. In a detached work tree, every `git push` in this skill is `git push origin HEAD:<headRefName>`.
4. Fetch `origin/main` and refresh the PR head, then initialize with the recovery reference's `init` command (or attach to `Worker checkpoint`). Set `<scratch>` to the returned new invocation path. It automatically selects the latest valid checkpoint or imports verifiable legacy work; explicit `--fresh` starts independently. Earlier invocation files remain read-only. Report the recovered phase and source invocation. Carry the cumulative round numbers, history and rejected decisions.
5. Save `<scratch>/status-baseline.txt` from the checkpoint's baseline status when resuming; on a fresh run use `git status --porcelain=v1 -z --untracked-files=all`. Use this same NUL-separated form for baseline comparisons. Verified owned WIP is tracked separately from baseline edits. Never adopt all current dirty files as the review's own changes.
6. Set `<speed>` from `--fast`, and say in the first line of output which speed is used. Then resolve the binaries (PowerShell; `pnpm.cmd`, because the execution policy blocks `pnpm.ps1`). `<repo>` is the checkout holding this `SKILL.md` (`<skill-dir>/../../..`):

   ```
   pnpm.cmd -C <repo> --silent cli:latest codex
   pnpm.cmd -C <repo> --silent cli:latest claude
   ```

   Check `$LASTEXITCODE` immediately after each command. If either fails, end with `error` (missing tool). Set `<codex>` and `<claude>` to the absolute paths each prints on stdout, and retain them in session context, like `<scratch>` and `<speed>`. Each prints `<tool> <version> <path>` on stderr; note both versions for the report. Shell variables do not survive separate tool calls: replace these placeholders with the resolved paths in every later command, keeping the single quotes around them for paths containing spaces.
7. **Merge origin/main.** Claude reviews the branch as it will merge, so bring in `main` first. Every flow merges `main` with this one procedure: `$implement-handoff` before implementing, `$sync-review` through this skill, and `$merge-pr` when `main` moves again before the merge. Work in `<pr-checkout>`.
   Save a checkpoint before and after synchronization. Finish a pending merge only when its saved operation and `MERGE_HEAD` establish ownership. If synchronization changes HEAD, preserve historical records and review the new commit in a new round. Otherwise dispatch to the recovered phase; do not restart at round 1. A saved clean result requires local HEAD to equal the refreshed PR head, current main ancestry, and a fresh GitHub CI check before it can be reported clean.
   1. `git -C <pr-checkout> fetch origin main`. Record the fetched main SHA. If `git -C <pr-checkout> merge-base --is-ancestor origin/main HEAD` succeeds, set `mainMerge` to `current`, skip the rest of step 1.7, and dispatch to the recovered phase (section 2 for a new review).
   2. If the merge would touch a file listed in the baseline, those are another session's uncommitted edits: never merge over them. Switch to a detached work tree (Shared patterns), make it `<pr-checkout>` for the rest of the run with an empty baseline, and merge there.
   3. `git -C <pr-checkout> merge origin/main --no-ff -m "🔀 merge(<scope>): sync <topic> with main"`.
      - `<scope>` is the most common scope among the branch's recent commits.
      - `<topic>` is the branch name without `codex/`, written in words (e.g. `sync landmark details with main`).
   4. Resolve every conflict. Never stop because a conflict is hard; work it out. One file at a time:
      - Understand both sides first. Read `git -C <pr-checkout> log --oneline origin/main...HEAD -- <file>` and the commits behind each side. If `<main-checkout>/.plans/README.md` lists the branch, read that task's `handoff.md`.
      - Combine both sides' intent. Take one side wholesale only when the other is clearly superseded, and name the commit that supersedes it.
      - `pnpm-lock.yaml`: take `main`'s version, then run `pnpm install --lockfile-only`.
      - Generated data (`apps/web/public/tiles/**`, `**/tiles.lock.json`, or anything the data pipeline writes): never hand-merge it; regenerate it. Resolve every other file first. Then, for each conflicting `packages/content/cities/<slug>/tiles.lock.json`, first run `git -C <pr-checkout> restore --theirs -- packages/content/cities/<slug>/tiles.lock.json` to select main's complete, valid lock so the pipeline can parse it. Run `pnpm data:build -- --city <slug>` from the merged tree, followed by `pnpm data:publish -- --city <slug>`. That publishes a release built from both sides' inputs and writes a fresh lock, or keeps main's lock when the generated outputs are unchanged. Stage the resulting lock as the resolution in either case.
        - Other pipeline output follows the same rule: rebuild it from the merged inputs.
      - Two incompatible behaviors with no obvious winner: decide, don't stop. `main`'s behavior is the baseline, because it's merged and reviewed. Reapply the branch's intent on top of it, guided by the branch's commits and its handoff. Keep both behaviors where the code allows it (both fields, both cases, both options). Otherwise keep `main`'s semantics and adapt the branch's change to fit them.
      - Record every resolution that took judgment (anything beyond keeping both sides' lines or taking a clearly superseded side) in a `Conflict decisions:` list in the merge commit body: `<file> — kept <what>, because <why>`.
   5. Before committing:
      - Confirm no conflict markers remain: run `git diff --check`, and search the resolved files for `<<<<<<<`, `=======` and `>>>>>>>`.
      - Run `pnpm run test --changed`, plus `pnpm --filter @atlas/<pkg> typecheck` for every package with a resolved file. Fix every failure the resolution causes, and rerun until they pass. A failure that also happens on plain `origin/main` (check its CI with `gh run list --branch main`) isn't from the merge: note it for the report and continue.
      - Commit the merge with the message from 3, plus its `Conflict decisions:` body when there is one.
   6. A tool the resolution needs gets every fallback first: tippecanoe through Docker (`packages/data/README.md`), network steps through Retry. Abort only when it is still missing (no tippecanoe natively or in Docker, or no `gh` auth for `data:publish`): run `git merge --abort`, then end with `error` and stopReason `merge tool unavailable: <tool> — <files>`. Set `mainMerge` to `aborted`. A conflict alone is never a reason to abort.
   7. `git push` (with Retry; if it is rejected because the remote moved, fetch, merge `origin/<headRefName>` and push again). Refresh and checkpoint `remoteSha` after the push. Set `mainMerge` to `merged` (or `resolved <n> files` when there were conflicts).

## 2. Round k: Claude reviews the PR

Rounds start at k = 1 for a new review; recovery retains the saved k. Each round has its own folder, `<scratch>/round<k>/`. Refresh `headRefOid` with `gh pr view` at the start of every round. Launch through the recovery reference's `run` wrapper using the command arguments below; it creates a unique attempt folder, captures UTF-8 output and writes an independent receipt. A verified completed reviewer receipt at this head skips directly to validation.

Run from `<pr-checkout>`, with a shell timeout of at least 20 minutes:

```
pnpm.cmd -C <repo> --silent review:state run --input <scratch>/round<k>/claude-input.json
```

- Use the reference's exact Claude arguments. Never change the model or effort, or drop a flag. Combine the pinned head instruction and saved rejection text in one `--append-system-prompt` argument.
- `--report-only` keeps the Claude skill from editing. Afterwards, compare `git -C <pr-checkout> status --porcelain=v1 -z --untracked-files=all` with the baseline. If anything changed, record the difference in the round's record, never revert or stage it, and protect the unfamiliar changes with the reference's `protect` command.
- Require a successful native exit and a complete report with a verified receipt and unchanged PR head. A newly launched process uses its new report; a recovered receipt must pass the reference's checks. Quota receipt or wrapper exit 75 → `interrupted`; other failed or incomplete attempts → Retry. Use the receipt's report path as `<claude-report>` in validation. Do not review the PR yourself instead.

## 3. Round k: validate Claude's review (Codex #1: Sol 6.1, max, analysis only)

Run from `<pr-checkout>`, with a shell timeout of at least 30 minutes. `<skill-dir>` is the absolute path of the folder holding this `SKILL.md` (`.agents/skills/review-pr/` in the checkout Codex loaded it from).

Launch through `run` as in the recovery reference. Replace the `-o` output with `{report}` and pass `<claude-report>` as the input report. A recovered successful validator receipt skips to fixes.

```
pnpm.cmd -C <repo> --silent review:state run --input <scratch>/round<k>/validation-input.json
```

- Never change the model, effort or speed flags, and never skip this run to validate in this session instead.
- Afterwards, compare `git -C <pr-checkout> status --porcelain=v1 -z --untracked-files=all` with the baseline. Gitignored test caches don't show up. If anything changed, record it, never revert or stage it, and protect unfamiliar changes with `protect`.
- Require a successful native exit and a complete validation report whose receipt matches the reviewed commit and unchanged PR head. Recover completed validation only under the reference's checks; a failed fresh process cannot be replaced by an unrelated older table. Quota receipt or wrapper exit 75 → `interrupted`; other failures → Retry. Use the receipt's report path as `<validation-report>` below.
- Append this round's `invalid` entries to `<scratch>/rejected.md`, one per line: `path:line — claim`. When creating the file, start it with this line: "Entries below were already judged invalid in earlier review rounds. Don't report them again unless the cited code has changed since."

## 4. Round k: implement the valid entries

Read `<validation-report>`. A blocker or should-fix under "Noticed, not in Claude's review" is a valid entry of this round, just as if Claude had reported it. Add it to this round's entries (`claudeSeverity: null`, `verdict: "valid"`, the validator's severity as `finalSeverity`) and fix it with the others; never stop for it. Save `begin` and `finish` checkpoints for each fix, check, commit and push as the recovery reference describes. Continue verified completed fix steps; unfamiliar or uncheckpointed edits remain untouched. Then check these before editing anything:

- **No valid blocker or should-fix** (including noticed ones): the round is **clean**. Fix any valid nits as below, then go to step 6.
- **A fix step needs files outside the PR's diff:** that's allowed. Find out why the fix reaches them (a caller, a shared helper, a test fixture), keep the change scoped to the entry, and record the reason in the commit message and in the entry's `outOfDiff` field.
- **Repeat** (round 2 and later, compared with earlier rounds' `result.json`): a valid blocker or should-fix has the same `path` and claim as an entry an earlier round marked `fixed`. The earlier fix didn't work: find out why from its commit and fix it differently this round. Set the entry's `repeat` to that round.
- **Oscillation:** applying a fix would revert, fully or partly, an earlier round's commit (check with `git show <commit>`). Decide, don't stall (Shared patterns): keep the behavior the evidence supports, or combine both, record the decision in the commit body and the entry's `decision` field, and add the losing claim to `rejected.md`.

Otherwise, work in `<pr-checkout>` on the PR's head branch:

1. Follow the fix steps in order: blockers, then should-fix, then nits. Scope each change to its entry. Follow `AGENTS.md` conventions.
2. After each step, run that step's targeted test: the named Vitest file, or `pnpm run test --changed`. Fix a failure before moving on. If a fix can't be made to pass, try other approaches. If none passes, keep the part that passes (or revert only your own edit for that entry), mark the entry `open` with what was tried, and Carry, don't stop: add it to the PR body's "Open review entries" section (`gh pr edit <N> --body-file`). The round goes on.
3. Once at the end of the round, run the checks from the `AGENTS.md` "Verifying changes" table that cover the touched files. Leave the full suite to CI.
4. Before committing, run `git status` and `git branch`. Confirm this is the PR's head branch or its initialized detached checkout. Stage only the files you changed, by explicit path. If a file you must stage also holds someone else's uncommitted edits from the baseline, don't commit it. Report it instead.
5. Commit with a gitmoji + conventional message that matches `git log` (e.g. `🐛 fix(renderer): …`). Use one commit, or one per area if the fixes are unrelated.
6. Push to the PR's branch with a plain `git push`, then refresh and checkpoint `remoteSha`. If the fixes change what the PR description says, update it with `gh pr edit <N> --body-file`.

Write this round's record to `<scratch>/round<k>/result.json`: `{round, claudeVerdict, entries, noticed, commits}` (shape in step 7).
Also record it in checkpoint `history`, with findings, noticed items, rejected decisions, commits and the next phase, before starting another round.

## 5. Review loop (until clean)

After each round:

- **Clean** (no valid blocker or should-fix, apart from entries already carried as `open`) → step 6.
- **Fixed** (valid blockers or should-fix items were fixed and pushed) → start round k+1 at step 2. There is no round cap: Repeat and Oscillation handling plus `rejected.md` keep the rounds converging.

Nits are fixed when they come up. New nits alone never start another round, because a round whose only valid entries are nits is clean.

## 6. CI gate (until green)

Checkpoint CI attempts, reruns and fixes. Record `pending` while waiting, the checked head, and `needsReview: true` after a non-test source fix. Save completed local check commands and the working-tree hash in operation data; reuse them only when that hash still matches. GitHub CI is always rechecked against the current remote head on recovery.

1. Wait until the PR has checks for its current head SHA (`gh pr view <N> --json headRefOid,statusCheckRollup`), then run `gh pr checks <N> --watch`, with a shell timeout of at least 30 minutes. If everything passes:
   - If a CI fix in this run touched non-test source code and no review round has run since that fix, go to 3.
   - Otherwise go to step 7 with `clean`.
2. If a check fails, find its run and read it: `gh run view <run-id> --log-failed`. For e2e failures, also download the Playwright artifact: `gh run download <run-id> -n playwright-results-<shard> -D <scratch>/ci`.
   - **Infrastructure flake** (runner, network or dependency-download error, or a timeout with no failing test): rerun with `gh run rerun <run-id> --failed`, then go back to 1. If the same failure comes back twice, treat it as real.
   - **Real failure:**
     - Reproduce it locally in `<pr-checkout>` with the narrowest command: the failing Vitest file, or `pnpm test:e2e --project=chromium -g "<test>"`. A run may wait for a heavy slot; let it wait.
     - Fix the cause. Change the test only if the test itself is wrong. A failure that also happens on plain `origin/main` gets fixed here too; record why the fix is outside the PR's diff.
     - Once it passes locally, commit (`🐛 fix(<scope>): …` or `💚 ci(<scope>): …`) following step 4's staging rules, push, and go back to 1. Count each attempt in `ci.attempts`. There is no attempt cap: when an approach keeps failing, change the approach.
3. If any CI fix touched non-test source code, run one more review round (steps 2–4) once CI is green. If the round isn't clean, follow step 5's outcomes. If it's clean, repeat this step from 1 for its pushes.

## 7. Report and clean up

Report:

- `Main merge: <mainMerge>` (from step 1.7), with its `Conflict decisions:` list and any failures that also happen on `main`
- `Review rounds: <k>`, counting every round, including one run after a CI fix. Then one line per round with its outcome (`clean` or `fixed`), its repeats and its decisions
- Each round: Claude's verdict, and the validation table (# / Claude's severity / verdict / evidence / final severity)
- Fixed entries, with the commit hashes
- Open entries carried into the PR body, each with what was tried
- The detached work tree's path, if one was used, and the untouched worktree's state
- Anything under "Noticed, not in Claude's review", with its severity. Noticed blockers and should-fix items were fixed as entries (step 4); noticed nits are listed for the user
- The CI gate: reruns, fix attempts and fix commits, and the final check state
- Which checks ran locally, and which were left to CI
- The PR URL, the speed Codex #1 ran at (fast or normal), the `codex` and `claude` versions from step 1.6, and the final status

End the report with a fenced block tagged `review-pr-result`, holding one JSON object:

```review-pr-result
{
  "status": "clean",
  "pr": 12,
  "headSha": "def5678",
  "fast": false,
  "cli": { "codex": "0.159.3", "claude": "2.1.289" },
  "mainMerge": "current",
  "workTree": null,
  "roundCount": 1,
  "rounds": [
    {
      "round": 1,
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
  "stopReason": null
}
```

- `verdict` is one of `valid`, `partly` or `invalid`. `outcome` is one of `fixed`, `open` (carried into the PR body, with `openReason`) or `none`. `repeat` names the earlier round of a repeated entry; `decision` records an oscillation decision. `claudeSeverity` is `null` for an entry promoted from "Noticed". `outOfDiff` is `null`, or the files outside the PR's diff that the fix touched and why.
- `headSha`: the PR's head SHA when the run ends (`gh pr view <N> --json headRefOid`). The review and CI results apply to this commit only.
- `cli`: the versions step 1.6 resolved (`null` for one not resolved).
- `mainMerge`: `current` (already had `origin/main`), `merged`, `resolved <n> files`, `aborted` (only for `merge tool unavailable`), or `not-run` (ended before step 1.7).
- `workTree`: `null`, or the detached work tree's path and why the PR's worktree wasn't used.
- `roundCount`: the number of review rounds run, the same `<k>` as the report's first line.
- `noticed`: every round's "Noticed, not in Claude's review" items, with the validator's severity. Blockers and should-fix items among them also appear as that round's entries.
- `ci.status`: `green` (passed with no fixes), `fixed` (passed after fix commits), `pending` (unfinished checks on an interrupted run), or `not-run` (the gate has not run for this head).
- `status`:
  - `clean`: the last round was clean (no valid blocker or should-fix, noticed ones included, apart from entries carried as `open`) and CI passed (`ci.status` is `green` or `fixed`).
  - `error`: only a case under "Ends": nothing to do (no PR and nothing to open one from, or the PR is merged or closed), or a missing tool. `stopReason` names it.
  - `interrupted`: usage exhaustion or an abruptly ended coordinator. `resume` is `{checkpoint, phase, round, reason, reset, command}`; `reset` is the literal reported reset string or null. Completed historical rounds remain in `rounds`; unfinished fixes are described in checkpoint operations. No clean result is implied for WIP. `resume` is null on normal final results.
- Record final status, reporting metadata and CI state in the checkpoint before writing the final result. Interrupted publication uses the helper's `interrupt` command; the process wrapper also publishes a canonical interrupted result immediately on quota failure, even if the coordinator ends before reporting.
- Always write the final JSON object to `<scratch>/result.json` at the invocation root, distinct from the per-round records. If a `Result file` was given, also write the identical object to that path. Write only the object, without the fence, to both files.

Then, in `<main-checkout>/.plans/README.md`, set the **PR review** cell of every row whose Evidence names the PR's branch or `#<N>` (the original task row and this `pr<N>-review-fixes` row) to `<status> <roundCount> rounds · CI <ci.status> · <short headSha> · <YYYY-MM-DD>` (for example `clean 2 rounds · CI green · d0c7322 · 2026-10-05`), adding `· <n> open` when entries were carried. Existing rows change only that cell; the caller owns their Status and Next step. If the `pr<N>-review-fixes` row is missing, create it with these seven cells: Task `active/pr<N>-review-fixes/`, Status `PR review record`, Handoff review `not run`, PR review the final formatted value, Evidence `PR #<N> / <headRefName> / <pr-checkout> / <scratch>`, Keep `None`, and Next step `Retain review scratch until $merge-pr cleanup`. These defaults apply only when creating the row.

Leave this invocation's `<scratch>` in place. `$merge-pr` deletes the entire `pr<N>-review-fixes/` root, including all invocation folders, with `pnpm plans:clean` after the PR merges. Never delete it with shell commands: Codex rejects recursive deletes as "blocked by policy".
