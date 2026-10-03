---
name: sync-review
description: For each comma-separated branch, in order, commit and push its worktree, merge origin/main, open a PR to main, review it until clean (Claude Opus 5.5 reviews, Codex Sol 6.1 validates and fixes), get CI green, and merge it. Stops at the first branch that doesn't merge. Use when the user invokes $sync-review [--fast] <branches>.
---

# Sync, review and merge branches

Usage: `$sync-review [--fast] codex/tree-canopy, codex/stable-labels, codex/vehicle-lamps-exhaust`

The user lists only branches that are safe to process. Invoking `$sync-review` authorizes these actions, for the listed branches only:

- committing everything uncommitted in their worktrees
- merging `main` into them, and pushing
- opening PRs to `main`
- running `$review-pr`, which commits and pushes fixes
- fixing CI
- merging the PRs into `main`, which deploys to production through Vercel

Don't ask for confirmation between steps or branches. Stop only where this skill says to stop.

## Models

Always pass these explicitly. Never change them or fall back to another model.

| Role | Model | Effort | Speed | How |
| --- | --- | --- | --- | --- |
| Loop session (this session): commits, conflicts, PRs, CI fixes, merges | Sol 6.1 (`gpt-6.1-sol`) | xhigh | the session's own setting | the user's session |
| PR review | Claude Opus 5.5 (`claude-opus-5-5`) | high | normal | started by `$review-pr` |
| Codex #1: validates Claude's review (analysis only) | Sol 6.1 (`gpt-6.1-sol`) | max | `<speed>` | started by `$review-pr` |
| Codex #2: runs `$review-pr` (review rounds, fixes, CI gate) | Sol 6.1 (`gpt-6.1-sol`) | xhigh | `<speed>` | started by this skill (step 4) |

This session must be Sol 6.1 (`gpt-6.1-sol`) at xhigh effort. If it's running a different model or effort, stop and ask the user to start `$sync-review` again from a session with those settings.

`<speed>` comes from the `--fast` option:

- with `--fast`: `-c 'service_tier="fast"' --enable fast_mode`
- without it: `--disable fast_mode`. Pass this explicitly, because the user's Codex config may default to fast.

`--fast` also gets forwarded to `$review-pr`, so Codex #1 uses the same speed in every round. It doesn't change Claude, or this session's own speed.

## Rules for every branch

- **Fail-fast:** if any branch that steps 1–6 process ends without its PR merged, stop the whole loop. Report the remaining branches as `not processed: stopped after <branch>`. Branches skipped in step 0 don't trigger this.
- **Git safety:** never check out, switch branches, stash, reset, rebase, force-push, use `git add -A`, `git add .` or `git commit -a`, or pass `--no-verify`. Run every command against the branch's worktree (`git -C <wt> …`, or with `<wt>` as the working directory).
- **Windows:** prompts that contain `$` go in single quotes, and stdout is captured with `Out-File -Encoding utf8`, never a plain `>`.
- **Long commands:** the `$review-pr` run can take several hours, and `gh pr checks --watch` 10+ minutes. If the shell tool can't hold a command that long, start it in the background with its output going to a log in `<run>`, and poll until it exits.

## 0. Prepare (once)

1. Parse the argument:
   - Take out `--fast` if present and set `<speed>`.
   - Split the rest on commas. Trim, drop empty entries and duplicates, and strip a leading `origin/`.
   - Drop `main` and report it as skipped.
   - Print the branch order and the speed (fast or normal) as the first line of output.
2. Run `gh auth status`. If it fails, report it and stop. Then run `git fetch origin`.
3. Map each branch to its worktree with `git worktree list --porcelain`.
   - No worktree → `skipped: no worktree`. Never create one.
   - Checked out in the first entry (the main checkout) → `skipped: main checkout`.
4. Create `<run>` = `$env:TEMP/sync-review-<yyyyMMdd-HHmmss>/`. It lives outside `.plans/` on purpose. `<main-checkout>` is the first worktree entry.
5. `<skill-dir>` is the absolute folder of this `SKILL.md`. `<review-pr-skill>` is `<skill-dir>/../review-pr/SKILL.md`. Confirm that file exists. If it doesn't, stop.

Then process the branches one at a time, in the order given. `<slug>` is the branch name with `/` replaced by `-`.

## 1. Commit and push

1. If `git -C <wt> status --porcelain` isn't empty, review `git diff`, `git diff --cached` and the untracked files.
2. Hold back any file that looks like a secret (`.env*`, keys, tokens, credentials) and any file over 10 MB. If anything is held back, report it and stop (fail-fast).
3. Stage the rest by explicit path.
4. Commit with one gitmoji + conventional message written from the diff, matching `git log` (e.g. `✨ feat(life): …`): lowercase, imperative, header at most 72 characters. Hooks run. If a hook rejects the commit, stop.
5. If `origin/<branch>` has commits the local branch lacks, run `git merge origin/<branch>`. Resolve any conflicts as in step 2.
6. `git push -u origin <branch>`. If the push is rejected, stop.

## 2. Merge origin/main

1. `git -C <wt> fetch origin main`. If `git merge-base --is-ancestor origin/main HEAD` succeeds, go to step 3.
2. `git merge origin/main --no-ff -m "🔀 merge(<scope>): sync <topic> with main"`.
   - `<scope>` is the most common scope among the branch's recent commits.
   - `<topic>` is the branch name without `codex/`, written in words (e.g. `sync landmark details with main`).
3. Resolve conflicts one file at a time:
   - Understand both sides first. Read `git log --oneline origin/main...HEAD -- <file>` and the commits behind each side. If `<main-checkout>/.plans/README.md` lists the branch, read that task's `handoff.md`.
   - Combine both sides' intent. Take one side wholesale only when the other is clearly superseded, and name the commit that supersedes it.
   - `pnpm-lock.yaml`: take `main`'s version, then run `pnpm install --lockfile-only`.
   - Generated data (`apps/web/public/tiles/**`, `**/tiles.lock.json`, or anything the data pipeline writes): don't hand-merge it. Abort.
   - If the right resolution is unclear (two incompatible behaviors and no clear winner), abort. Don't guess.
4. Before committing:
   - Confirm no conflict markers remain: run `git diff --check`, and search the resolved files for `<<<<<<<`, `=======` and `>>>>>>>`.
   - Run `pnpm run test --changed`, plus `pnpm --filter @atlas/<pkg> typecheck` for every package with a resolved file. If a failure comes from the resolution, fix it. If it still fails, abort.
   - Commit the merge with the message from step 2.
5. To abort: run `git merge --abort`, record `merge conflict: <files> — <why>`, and stop.
6. `git push origin <branch>`.

## 3. Open a PR if none exists

1. `gh pr list --head <branch> --base main --state open --json number,url`. If there's one, use it.
2. Otherwise, write a body to `<run>/<slug>-pr-body.md` and run `gh pr create --base main --head <branch> --title "<title>" --body-file <run>/<slug>-pr-body.md`.
   - Title: a gitmoji + conventional header summarizing the branch's commits since `main`.
   - Body: what the branch does, taken from its commits and its handoff, plus a test plan listing the checks the handoff names. Don't invent claims about tests that weren't run.

## 4. Review until clean, with the CI gate ($review-pr)

`$review-pr` runs the review loop (up to 3 rounds, with stall detection) and the CI gate (up to 3 fix attempts) itself. Start it once, in a fresh Codex #2:

```
codex exec -m gpt-6.1-sol -c 'model_reasoning_effort="xhigh"' <speed> -C <wt> -o <run>/<slug>-review.md 'Use the review-pr skill at <review-pr-skill>, following it exactly, on this branch''s PR. Arguments: <--fast, or nothing>. Result file: <run>/<slug>-review.json.'
```

- Shell timeout: at least 4 hours (three review rounds plus CI). Background-and-poll as needed.
- Read `<run>/<slug>-review.json`. If it's missing, use the `review-pr-result` block at the end of the `-o` file.
- `status` is `clean` → go to step 5.
- Anything else (`capped`, `stalled`, `stopped`, `ci-red`, `error`), or no result → stop, with the result's `status` and `stopReason`.

## 5. Confirm CI

1. Confirm the result's `ci.status` is `green` or `fixed`.
2. Confirm `gh pr checks <N>` passes on the PR's current head SHA (`gh pr view <N> --json headRefOid`). If checks are still running, wait with `gh pr checks <N> --watch`.
3. If either check fails, stop.

## 6. Merge into main

1. Check every condition:
   - `$review-pr` ended `clean`
   - nothing was held back in step 1
   - step 5 passed on the PR's current head SHA
   - `gh pr view <N> --json mergeable,mergeStateStatus` shows `MERGEABLE`
2. If `main` moved and the PR is behind or conflicting, repeat step 2 (merge `origin/main` and push), at most twice. After each repeat, run the "CI gate" section (step 6) of `<review-pr-skill>` yourself in `<wt>`. If its rule calls for another review round (a CI fix touched non-test source code), run step 4 again instead. Then check again.
3. `gh pr merge <N> --merge`. Never use `--delete-branch` (the worktree still uses the branch), `--squash`, `--rebase`, `--admin` or `--auto`. GitHub doesn't enforce CI on this repo, so this checklist is the only gate.
4. Confirm with `gh pr view <N> --json state,mergeCommit`. If it isn't `MERGED`, stop.

## 7. Update the task's `.plans` row

In `<main-checkout>/.plans/README.md`, find the rows that aren't in `done/` and whose Evidence names the branch.

- **Merged, exactly one row:**
  - Move that task folder to `<main-checkout>/.plans/done/`.
  - Set its Status to `Complete; merged via sync-review`.
  - Add `PR #N, merge <sha>` to Evidence.
- **Merged, several rows:** only set their Next step to `branch merged via sync-review (PR #N)`, and list them in the report.
- **Stopped:** don't move anything. Set the Next step to the stop reason and what needs a human.
- **No row:** nothing to do.

## 8. Report and clean up

After each branch, print one line:

`<branch>: commit <sha|none> · main <clean|resolved n files|aborted> · PR #N · review <rounds> rounds, <status> · CI <ci.status> · <merged <sha> | stopped: <reason>>`

At the end, print a table of every listed branch (branch / commit / main merge / PR / review / CI / result). It includes skipped and not-processed branches, held-back files, aborted merges with their conflicting files, and errors. Then delete `<run>`.
