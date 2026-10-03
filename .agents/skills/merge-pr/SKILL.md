---
name: merge-pr
description: Merge a branch's PR into main once CI is green and GitHub reports it mergeable, then clean up after it — delete its task scratch in .plans with pnpm plans:clean (keeping handoff.md and keep files), update the task's .plans row, and remove the local branch and its worktree folder with pnpm worktree:remove. The remote branch stays. Use when the user invokes $merge-pr [<branch>] [Head: <sha>], or when $sync-review reaches its merge step.
---

# Merge a PR, then clean up its scratch, branch and worktree

Usage: `$merge-pr [<branch>] [Head: <sha>]`. Without a branch, it uses the current branch (`git branch --show-current`).

`Head: <sha>` is optional. A caller such as `$sync-review` passes the commit it reviewed and checked CI on, so nothing pushed after that review gets merged.

Invoking `$merge-pr` authorizes these actions, for that branch only:

- merging its PR into `main`, which deploys to production through Vercel
- deleting its task scratch in `.plans/` and its `pr<N>-review-fixes/` folder
- deleting its local branch and its worktree folder

Don't ask for confirmation between steps. Stop only where this skill says to stop.

## Rules

- **Git safety:** never check out, switch branches, stash, reset, rebase, force-push, commit, or pass `--no-verify`. This skill never changes the branch's content.
- **Remote branch stays:** never pass `--delete-branch` to `gh pr merge`, and never run `git push --delete` or `git push origin :<branch>`.
- **Deleting:** delete only with `pnpm plans:clean` and `pnpm worktree:remove`. Never delete files or folders with shell commands (`Remove-Item`, `rm`, `del`, `rmdir`): Codex rejects recursive deletes as "blocked by policy".
- **Working directory:** run steps 4–6 with `<main-checkout>` as the working directory, never from inside `<wt>`. Windows can't delete a folder that a process is using as its current directory.
- **On "stop with `<status>`"**, skip straight to step 7 with that status and a `stopReason`.

## 1. Resolve

1. Take the branch from the argument, stripping a leading `origin/`, or from `git branch --show-current`. If it's `main`, stop with `error`.
2. Run `git worktree list --porcelain`. `<main-checkout>` is the first entry. `<wt>` is the entry with this branch, if any. If the branch is checked out in `<main-checkout>`, stop with `error`.
3. Run `gh pr view <branch> --json number,state,headRefOid,mergeable,mergeStateStatus,url`.
   - No PR → stop with `error` (`No PR for <branch>`).
   - `state` is `MERGED` → a rerun after a cleanup failure. Take the merge commit from `gh pr view <N> --json mergeCommit` and go to step 4, which checks for newer local work before anything is cleaned.
   - `state` is `CLOSED` → stop with `error`.

## 2. Gate

Check every condition. If one fails, stop with `stopped`, naming it.

1. `<wt>` exists and `git -C <wt> status --porcelain` is empty. Uncommitted work belongs to the user or `$sync-review`, not this skill.
2. `git -C <wt> fetch origin <branch>`, then `git -C <wt> rev-parse HEAD` equals `origin/<branch>` and the PR's `headRefOid`. Everything local is pushed.
   - With `Head: <sha>`, `headRefOid` must also equal `<sha>`. If it doesn't, something was pushed after the caller's review: stop.
   - Call this SHA `<gated-sha>`.
3. CI passes on `<gated-sha>`. Wait until the PR has checks for it (`gh pr view <N> --json headRefOid,statusCheckRollup`), then run `gh pr checks <N> --watch` with a shell timeout of at least 30 minutes. Any failing check stops the run. This skill doesn't fix CI; `$review-pr` does.
4. `gh pr view <N> --json mergeable,mergeStateStatus` shows `MERGEABLE`. If the PR is behind `main` or conflicts, stop and point to `$sync-review`, which merges `main` in. GitHub doesn't enforce CI on this repo, so this gate is the only one.

## 3. Merge

1. `gh pr merge <N> --merge --match-head-commit <gated-sha>`. GitHub refuses the merge if the head moved after the gate; then stop with `stopped`. Never use `--delete-branch`, `--squash`, `--rebase`, `--admin` or `--auto`.
2. Confirm with `gh pr view <N> --json state,mergeCommit`. If it isn't `MERGED`, stop with `error`. Record the merge commit `<sha>`.

From here on the merge is done. A cleanup failure in steps 4–6 is reported, not retried, and doesn't change the status from `merged`.

## 4. Check for newer local work

Before cleaning anything, from `<main-checkout>`:

```
pnpm worktree:remove <branch> --dry-run
```

It runs every check of step 6 without deleting: the branch is merged into `origin/main` (no local commits after the merge) and the worktree has no uncommitted changes. If it refuses, skip steps 5 and 6 entirely: someone is still working on the branch, and its scratch may still be needed. Report the refusal as the cleanup result. A reported `finishing an interrupted removal` is fine: go on.

## 5. Plans: rows and scratch

Work in `<main-checkout>/.plans/`. Find the rows of `README.md` whose Evidence names the branch.

1. **Move:**
   - Exactly one row isn't in `done/`: move its folder to `.plans/done/`, set its Status to `Complete; merged (PR #N)`, and add `merge <sha>` to its Evidence.
   - Several rows aren't in `done/`: only set their Next step to `branch merged (PR #N); check whether this task is finished`. Don't move or clean them. List them in the report.
   - No row: nothing to move.
2. **Clean** every row of this branch that is now in `done/`. For each, read its `handoff.md` for entries marked **keep** that still exist in its folder, and run from `<main-checkout>`:

   ```
   pnpm plans:clean <task> --keep <name> --keep <name> ...
   ```

   - `--keep` takes paths relative to the task folder, nested ones included (`e2e-results/final.png`). Pass each file or folder the handoff marks **keep**. `handoff.md` is always kept.
   - The command fails without deleting anything on a bad keep path. If it says a keep path doesn't exist, check the folder: drop the path only if the file is really gone, then rerun. On any other error, don't clean that task; report it.
   - Never drop or change a keep path just to make the command pass.
   - Set the row's Keep column to what the command kept.
3. If `.plans/active/pr<N>-review-fixes/` (or that folder under another status) exists, run `pnpm plans:clean pr<N>-review-fixes`. It deletes the folder too, since nothing in it is kept.

## 6. Worktree and local branch

From `<main-checkout>`:

```
pnpm worktree:remove <branch>
```

It repeats step 4's checks, deletes the worktree folder, prunes it from git, and deletes the local branch. The remote branch stays.

- If it reports `Partially deleted`, a process (dev server, terminal or editor) is using the folder. Don't retry. Report it, so the user can close that process and run `$merge-pr <branch>` again: the rerun finishes the removal.
- If there's no worktree (step 1 found none), it deletes only the local branch.

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
  "cleanup": {
    "plans": ["done/stable-labels: deleted 12, kept 3", "pr12-review-fixes: deleted 4, removed folder"],
    "worktree": "removed D:/Projects/naga-ascii-labels",
    "branch": "deleted codex/stable-labels"
  },
  "stopReason": null
}
```

- `status`: `merged` (the PR is merged, even if some cleanup failed), `stopped` (a step-2 gate or the head-commit match failed, nothing changed), or `error`.
- `headSha`: the `<gated-sha>` that was merged.
- A cleanup entry that failed or was skipped says why, e.g. `"worktree": "partially deleted: in use by another process"` or `"plans": ["skipped: codex/x has local commits after the merge"]`.
