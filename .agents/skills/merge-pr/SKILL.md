---
name: merge-pr
description: Merge a branch's PR into main once CI is green and GitHub reports it mergeable, synchronizing main and fixing CI first. An interrupted delegated review retains progress before any merge. After merging, clean task scratch with pnpm plans:clean, update the task row, and remove its local branch and worktree with pnpm worktree:remove; the remote branch stays. Use for $merge-pr with an optional branch, Head SHA and --claude-effort, or when $sync-review reaches its merge step.
---

# Merge a PR, then clean up its scratch, branch and worktree

Usage: `$merge-pr [--claude-effort <level>] [<branch>] [Head: <sha>]`. Without a branch, it uses the current branch (`git branch --show-current`).

`Head: <sha>` is optional. A caller such as `$sync-review` passes the commit it reviewed and checked CI on, so nothing pushed after that review gets merged.

`--claude-effort <level>` applies to PR reviews the merge gates require (shared.md, Claude effort). Use the initialized state's effort for delegated and inline reviews. It doesn't authorize repeating a completed review; `review-pr --fresh` does that.

Invoking `$merge-pr` authorizes these actions, for that branch only:

- merging `origin/main` into its branch and pushing, whenever `main` has moved (step 2.3), resolving every conflict, including regenerating and publishing tiles with `pnpm data:build` / `pnpm data:publish`
- fixing failing CI on its branch (gate 4) and running `$review-pr` on commits pushed after the caller's review (gate 2)
- creating and removing a detached work tree for those commits when the branch's worktree can't be used
- commenting on its PR with the conflict decisions that merge made
- merging its PR into `main`, which deploys to production through Vercel
- deleting its task scratch in `.plans/` and its `pr<N>-review-fixes/` folder
- deleting its local branch and its worktree folder

Don't ask for confirmation between steps. Follow [shared.md](../review-pr/references/shared.md): Ends, Shared patterns and Rules.

- **Interrupted review:** an interrupted delegated PR review ends this invocation with its saved checkpoint, before merging or cleanup.
- **Nothing to do:** no PR, a closed PR, or `main` as the branch.

## Rules

shared.md's Rules apply, plus:

- **Commits:** this skill commits only main-sync merges (gate 3) and CI fixes (gate 4); `$review-pr` makes its own.
- **Main moves on; keep going.** Other sessions merge into `main` all the time. A PR that is behind or conflicting gets `origin/main` merged in here, not sent back to `$review-pr`.
- **Remote branch stays:** never pass `--delete-branch` to `gh pr merge`, and never run `git push --delete` or `git push origin :<branch>`.
- **Working directory:** run steps 4–6 with `<main-checkout>` as the command working directory. On Windows, also determine the session process's own directory, using its startup context (not a child command's directory). If that directory is inside `<wt>`, or cannot be established, defer the actual removal in step 6. A child command running in main does not release the session's handle on `<wt>`.
- **On "end with `error`"**, skip straight to step 7 with that status and a `stopReason`. Only the "Ends" cases do this.
- **Work tree:** `<work>` is where this skill commits. It is `<wt>` when that worktree exists, is clean, and its `HEAD` equals the PR's head. Otherwise it is a detached work tree at `origin/<branch>` (shared.md), pushing with `git push origin HEAD:<branch>`. `<wt>` is never touched in that case.

## 1. Resolve

1. Take the branch from the argument, stripping a leading `origin/`, or from `git branch --show-current`. If it's `main`, end with `error` (nothing to do).
2. Run `git worktree list --porcelain`. `<main-checkout>` is the first entry. `<wt>` is the entry with this branch, if any. If the branch is checked out in `<main-checkout>`, there is no `<wt>`: `<work>` is a detached work tree, and cleanup skips step 6.
3. Run `gh pr view <branch> --json number,state,headRefOid,mergeable,mergeStateStatus,url`.
   - Record `headRefOid` as `<cleanup-head>` for every cleanup command, including already-merged reruns.
   - No PR → end with `error` (`No PR for <branch>`: nothing to do).
   - `state` is `MERGED` → a rerun after a cleanup failure. Take the merge commit from `gh pr view <N> --json mergeCommit` and go to step 4, which checks for newer local work before anything is cleaned.
   - `state` is `CLOSED` → end with `error` (nothing to do).

## 2. Gate

Each gate either passes or gets solved; none ends the run. `<skill-dir>` is the absolute folder of this `SKILL.md`.
When gate 2 or gate 4 needs `$review-pr`, make the delegated review call (shared.md). An `interrupted` result ends this invocation before the merge or cleanup. Return `merge-pr-result` with status `interrupted`, a null `mergeCommit`, the review's `resume` object and `stopReason`. The next invocation resumes the saved review.

1. **Pick `<work>`** (Rules). Uncommitted files in `<wt>` belong to the user or another session: they never block the merge, and a detached work tree keeps them untouched. Step 4's dry-run reports them for cleanup.
2. **Pin the head.** Fetch `origin/<branch>` (with Retry). The PR's `headRefOid` is what gets merged; local-only commits in `<wt>` stay local, and cleanup reports them.
   - With `Head: <sha>`, `headRefOid` must equal `<sha>`, or `<sha>` must be an ancestor of it and every commit in `git rev-list --first-parent <sha>..<headRefOid>` must be a main-sync merge: a merge commit whose message starts with `🔀 merge(` and whose second parent is an ancestor of `origin/main` (such as one an earlier `$merge-pr` run pushed). If anything else was pushed after the caller's review, run `$review-pr <N>` through the delegated review call so the new commits get reviewed, then use its result's `headSha` as `<sha>` and repeat this gate.
   - Set `<gated-sha>` to the verified `headRefOid`, including when the caller's `<sha>` is older.
3. **Sync with main.** Run `git -C <work> fetch origin main`. If `git -C <work> merge-base --is-ancestor origin/main <gated-sha>` succeeds, go on. Otherwise make sure `<work>` is at `<gated-sha>` (fast-forward it, or switch to a detached work tree), then follow [merge-main.md](../review-pr/references/merge-main.md) items 2–7 in `<work>`, with an empty baseline. It merges `origin/main`, resolves every conflict and pushes. If git refuses because the merge would overwrite uncommitted files, switch to a detached work tree and merge there. It ends only with that procedure's `merge tool unavailable` (`error`). This merge comes after the PR's review, so if its commit has a `Conflict decisions:` body, post that list as a PR comment (`gh pr comment <N> --body-file <file>`, the file in the OS temp folder) and include it in the report. After the push, set `<gated-sha>` to the new `HEAD` and add 1 to `mainSyncs`.
4. **CI passes on `<gated-sha>`.** Wait until the PR has checks for it (`gh pr view <N> --json headRefOid,statusCheckRollup`), then run `gh pr checks <N> --watch` with a shell timeout of at least 30 minutes. If a check fails, run `<skill-dir>/../review-pr/SKILL.md` step 6 (the CI gate) in `<work>` until CI is green, including its review round when a CI fix touched non-test source code. Then set `<gated-sha>` to the new head and go back to gate 3.
5. **Mergeable.** `gh pr view <N> --json mergeable,mergeStateStatus` shows `MERGEABLE`. If it shows `CONFLICTING`, `main` moved again: go back to gate 3. If it shows `UNKNOWN`, wait and query again (Retry). A `CLEAN` or `MERGEABLE` response does not prove that the head contains current `main` when branch protection has no freshness requirement; §3 step 1 explicitly checks ancestry. GitHub doesn't enforce CI on this repo, so these gates are the only ones.

Initialize `mainSyncs` to 0. There is no sync cap: when `main` keeps moving, keep syncing and re-checking CI until the merge lands.

## 3. Merge

1. Immediately before merging, after CI passes, run `git -C <wt> fetch origin main`, then `git -C <wt> merge-base --is-ancestor origin/main <gated-sha>`. If the head lacks current `main`, go back to gate 3 to sync it; don't merge merely because GitHub says `CLEAN`.
2. `gh pr merge <N> --merge --match-head-commit <gated-sha>`. GitHub refuses the merge if the head moved after the gate; then go back to gate 2 with the new head. Retry a network failure. Never use `--delete-branch`, `--squash`, `--rebase`, `--admin` or `--auto`.
3. Confirm with `gh pr view <N> --json state,mergeCommit`. If it isn't `MERGED` yet, query again with Retry, and go back to gate 2 if the PR is still open. Record the merge commit `<sha>`.

From here on the merge is done. A cleanup failure in steps 4–6 doesn't change the status from `merged`. A busy file (`Could not relocate`, EBUSY) is retried as step 6 says; other cleanup refusals are reported.

## 4. Check for newer local work

Before cleaning anything, from `<main-checkout>`:

1. Confirm `git -C <main-checkout> branch --show-current` is `main` and `git -C <main-checkout> status --porcelain` is empty. Otherwise report a cleanup error and skip steps 5–6; never switch branches or discard changes.
2. `git -C <main-checkout> fetch origin main`, then `git -C <main-checkout> merge --ff-only origin/main`. This refreshes both the merge ref and the cleanup scripts used below, including on a rerun after an earlier cleanup failure. If either command fails, report a cleanup error and skip steps 5–6.
3. Run:

```
pnpm worktree:remove <branch> --head <cleanup-head> --dry-run
```

It runs every check of step 6 without deleting: the local head matches the PR's `<cleanup-head>`, that head is merged into `origin/main`, and the worktree has no new uncommitted work or protected ignored files. Refusals saying `head differs from expected`, `is not merged into`, or `uncommitted changes` preserve the branch's scratch: skip steps 5–6 and report the safety refusal. For the distinct `has protected ignored files:` refusal, continue step 5 under its completion and keep-inventory safeguards, skip step 6, and report the protected paths to move before rerunning `pnpm worktree:remove <branch> --head <cleanup-head>` from main. Report other failures (missing scripts, Git errors, inaccessible metadata) as cleanup errors and skip steps 5–6. A reported `finishing an interrupted removal` is fine: go on; dry-run must still establish current safety.

Exception for an **already-merged rerun**: if the command succeeds and reports `already removed: <branch>`, it has confirmed the local branch and worktree are absent and no recorded folder needs recovery. Record `already removed`, continue step 5 to finish plans cleanup, and skip step 6. A `Removal marker pending` or inaccessible-metadata refusal is a cleanup error; skip steps 5–6. Consume the command's result rather than inspecting its private marker files. Never treat a missing branch as success for an open PR or bypass another safety refusal.

## 5. Plans: rows and scratch

Work in `<main-checkout>/.plans/`. Find rows whose Evidence explicitly associates them with the branch and this PR, using the handoff to resolve an unclear association. Do not infer task completion from the branch having merged. Earlier completed tasks on the same branch can be cleaned only when their association and keep inventory are established too.

1. **Move:**
   - Never move or clean `todo/` or `paused/` tasks, even when they name this PR. Set their Next step to `branch merged (PR #N); check whether this task is finished`, retaining unresolved work, and list them in the report.
   - Move an `active/` task to `.plans/done/` only when its row/handoff explicitly records completed work and met acceptance criteria for this PR. Set its Status to `Complete; merged (PR #N)` and add `merge <sha>` to its Evidence. If completion is unresolved or ambiguous, only note the merge in Next step; preserve its folder and scratch.
   - No row: nothing to move.
2. **Clean** associated, explicitly completed rows now in `done/`. For each, inventory its files without following symlinks/junctions, then reconcile its handoff's **keep** entries with the README's Keep column. Future handoffs list exact relative file or directory paths. For legacy prose (counts, patterns, “all prior evidence”), resolve it against the actual inventory; if the protected file identities cannot be established, skip cleanup for that task and report the ambiguity. Never use matching counts as proof of matching files.

   Run a dry-run from `<main-checkout>` with the resolved exact paths:

   ```
   pnpm plans:clean <task> --keep <path> --keep <path> ... --dry-run
   ```

   Verify every protected file is represented by a kept file or a kept directory ancestor, including all descendants of kept directories. Check that the deletion list contains no protected file or ancestor. If anything is missing or uncertain, preserve the whole task. Otherwise run the same keep arguments without `--dry-run`:

   ```
   pnpm plans:clean <task> --keep <path> --keep <path> ...
   ```

   - `--keep` takes paths relative to the task folder, nested ones included (`e2e-results/final.png`). Pass each file or folder the handoff marks **keep**. `handoff.md` is always kept.
   - The command fails without deleting anything on a bad keep path. If it says a keep path doesn't exist, check the folder: drop the path only if the file is really gone, then rerun. On any other error, don't clean that task; report it.
   - Never drop or change a keep path just to make the command pass.
   - Set the row's Keep column to what the command kept.
3. If `.plans/active/pr<N>-review-fixes/` (or that folder under another status) exists, run `pnpm plans:clean pr<N>-review-fixes`. It deletes the folder too, since nothing in it is kept.
4. If `git worktree list --porcelain` shows detached work trees this PR used (`<main-checkout>/worktrees/pr<N>` and its `-<k>` variants, or the ones a review result's `workTree` names) and each one's `git status --porcelain` is empty, remove each with `git -C <main-checkout> worktree remove <path>`. Report a dirty one and leave it.

## 6. Worktree and local branch

On Windows, if the session process's directory is inside `<wt>` (or unknown), run only `pnpm worktree:remove <branch> --head <cleanup-head> --dry-run` from main. Report removal as deferred, retain the worktree and local branch, and tell the user to close/leave the session using that directory and run `pnpm worktree:remove <branch> --head <cleanup-head>` from `<main-checkout>`. This also applies to the no-argument invocation that started inside the worktree. Do not attempt partial deletion.

Otherwise, from `<main-checkout>`:

```
pnpm worktree:remove <branch> --head <cleanup-head>
```

It repeats step 4's checks, records recovery information, and renames the worktree to a unique sibling folder before deleting its contents. It then removes only its Git registration and deletes the local branch. The remote branch stays.

- If it reports `Could not relocate` (a process is holding the original directory; its contents and branch were kept), rerun the same command after 1, 2 and 4 minutes, since the holder often lets go. If it still fails, report the path as deferred so the user can close the process and run `$merge-pr <branch>` again. If it reports `Partially deleted`, rerun the same command the same way: it resumes from the recorded sibling folder and refuses a recreated original path. Never prune worktree metadata.
- If an already-merged rerun has no worktree (step 1 found none), it deletes only the local branch. An open PR still requires a worktree at gate 2.1.

## 7. Report

Report:

- The PR URL, the merge commit, or the stop reason
- The `.plans` rows moved or noted, and each `plans:clean` result (deleted and kept)
- The `worktree:remove` output, and that the remote branch `origin/<branch>` was kept

End with a fenced block tagged `merge-pr-result`, holding one JSON object:

```merge-pr-result
{
  "status": "merged",
  "pr": 12,
  "mergeCommit": "abc1234",
  "headSha": "def5678",
  "mainSyncs": 0,
  "cleanup": {
    "plans": ["done/stable-labels: deleted 12, kept 3", "pr12-review-fixes: deleted 4, removed folder"],
    "worktree": "removed D:/Projects/naga-ascii/worktrees/labels",
    "branch": "deleted codex/stable-labels"
  },
  "stopReason": null
}
```

- `status`: `merged` (the PR is merged, even if some cleanup failed), `interrupted` (a delegated review exhausted usage or its coordinator ended; nothing merged or cleaned), or `error` (only an "Ends" case: nothing to do, or a missing tool). Interrupted results carry the review's `resume` object. A main-sync merge may already have been pushed to the branch.
- `headSha`: the `<gated-sha>` that was merged.
- `mainSyncs`: how many times gate 3 merged `origin/main` into the branch. The report lists each sync's `Conflict decisions:`, if any.
- A cleanup entry that failed or was skipped says why, e.g. `"worktree": "partially deleted: in use by another process"` or `"plans": ["skipped: codex/x has local commits after the merge"]`.
