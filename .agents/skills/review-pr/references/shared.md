# Shared skill conventions

`$review-pr`, `$implement-handoff`, `$review-handoff`, `$sync-review` and `$merge-pr` follow this file. Each skill names the sections it uses and adds only what is specific to it. `<repo>` is the checkout holding the loaded skill (`<skill-dir>/../../..`), and `<main-checkout>` is the first entry of `git worktree list --porcelain`.

## Ends

A run ends only when:

- **the work is done:** `clean`, or the skill's own success status.
- **usage is exhausted:** `interrupted`, with the checkpoint, phase, round, literal reset text and resume command. Save immediately instead of spending the Retry window on a known exhausted quota. Don't schedule a restart; a new invocation resumes. A coordinator that ends abruptly may leave no final result; its last checkpoint and process receipts still support recovery.
- **there is nothing to do:** no PR and no branch commits to open one from, a merged or closed PR, no such handoff or branch, or the work already landed on `main` (`error` or `blocked`, with that reason).
- **a tool is missing:** `cli:latest` can't resolve `codex` or `claude`, `gh` isn't authenticated, a required skill file is missing, a needed tool such as tippecanoe can't run natively or through Docker, or the network or a model stays unavailable through the whole Retry window (`error`).

Everything else is solved with the patterns below. Never pause, ask the user, or stop for anything else.

## Shared patterns

- **Retry.** First check a process receipt for explicit usage exhaustion and propagate `interrupted`. Capacity errors, generic rate limits, network errors, missing reports and malformed reports use Retry. When a CLI process exits nonzero, or a `git fetch`, network `git push` or `gh` call fails, rerun the same command with the same model, effort and input. Write process output to a fresh `attempt-<n>/` subfolder. Back off 1, 2, 4, 8, 15, 15… minutes, up to 60 minutes in total, and print a progress line before each wait. A retry never counts as a round. Never switch models. Only an exhausted window makes the failure a missing tool.
- **Detached work tree.** Sometimes the branch's worktree can't be used:
  - its branch is checked out in `<main-checkout>`
  - its path is a folder of unknown origin
  - a merge would touch its uncommitted files
  - it is behind and dirty
  - its local branch has diverged from `origin/<branch>`

  Then leave it untouched and create a separate checkout:
  1. Run `git -C <main-checkout> worktree add --detach <path> origin/<branch>`. `<path>` is `<main-checkout>/worktrees/pr<N>`, or `<main-checkout>/worktrees/<short>-work` for a caller without a PR.
  2. Run `pnpm install --frozen-lockfile --prefer-offline`, `pnpm data:fetch` and `pnpm.cmd exec tsx "<repo>/scripts/claude-worktree-settings.ts"` in it.
  3. Work there and push with `git push origin HEAD:<branch>`.

  Reuse an existing detached tree at that path when it is clean and `git merge --ff-only origin/<branch>` succeeds; otherwise use the next free `-<k>` suffix. Report the path and the untouched worktree's state. `$merge-pr` removes the tree once the PR merges. Don't create one just in case: first confirm the worktree really is in one of those states.
- **Decide, don't stall.** Some cases need a decision rather than a pause: two claims or fixes that contradict each other, a finding that recurs after its fix, or a fix that would revert an earlier one. Read the evidence on both sides, then choose or combine. Record the decision and its reason in the commit body and the round's record. Add the losing claim to `rejected.md` (or the ledger) so it doesn't come back.
- **Carry, don't stop.** What still can't be made to work after real attempts (a fix whose test won't pass, a gate that misses its target) is committed as far as it works. List it in the PR body under "Open review entries" (or "Unmet gates"), with what was tried, and continue.
- **Relaunch on the wrong model.** A skill that requires a Sol 6.1 (`gpt-6.1-sol`) xhigh session may start under another model or effort. It then resolves `<codex>` (Binaries) and starts itself with `& '<codex>' exec -m gpt-6.1-sol -c 'model_reasoning_effort="xhigh"' <speed> -C '<same directory>' '<the same invocation and arguments>'`, relaying that run's report and result. It never asks the user to restart. A PR review relaunch instead uses the delegated review call below, with the same public arguments, so usage exhaustion is recorded even without a final model report.

## Rules

- **Session model:** when the skill's Models table lists "this session" as Sol 6.1 (`gpt-6.1-sol`) xhigh, a session on another model or effort relaunches (Shared patterns) with the same arguments.
- **Models:** pass every model, effort and speed flag explicitly as the skill's Models table lists it. Never fall back to another model.
- **Git safety:** never check out, switch branches, stash, reset, rebase or force-push. Never use `git add -A`, `git add .` or `git commit -a`, or pass `--no-verify`. Stage by explicit path after `git status` and `git branch`.
- **Windows:**
  - Run `pnpm.cmd`, because the execution policy blocks `pnpm.ps1`.
  - Single-quote prompts that contain `$`, or put the prompt in a file and pass `(Get-Content -Raw '<file>')`.
  - Capture stdout with `Out-File -Encoding utf8`, never a plain `>`, which writes UTF-16.
  - Capture native exit codes immediately.
- **Long commands:** a `$review-pr` run can take hours and `gh pr checks --watch` 10+ minutes. If the shell tool can't hold a command, start it in the background with output to a log in scratch (`Start-Process -WindowStyle Hidden` for native processes), then poll until it exits.
- **Deleting:** delete only with `pnpm plans:clean`, `pnpm worktree:remove` or `git worktree remove`. Never delete with shell commands (`Remove-Item`, `rm`, `del`, `rmdir`): Codex rejects recursive deletes as "blocked by policy". Leave scratch for `$merge-pr` cleanup.

## Binaries

Several copies of `codex` and `claude` can be installed, and an old `codex` rejects `gpt-6.1-sol`. Resolve the newest once per invocation:

```
pnpm.cmd -C <repo> --silent cli:latest codex
pnpm.cmd -C <repo> --silent cli:latest claude
```

- Resolve only the tools the skill runs. Check `$LASTEXITCODE` right after each command; a failure is a missing tool.
- Set `<codex>` / `<claude>` to the absolute path printed on stdout. Note the version from stderr (`<tool> <version> <path>`) for the report.
- Shell variables don't survive separate tool calls, so write the resolved path into every later command, single-quoted when it contains spaces.
- Never run a bare `codex` or `claude`, or any other path.

## Speed

`<speed>` comes from `--fast` and goes to every `<codex> exec` the skill starts, and is forwarded to the skills it delegates to:

- with `--fast`: `-c 'service_tier="fast"' --enable fast_mode`
- without it: `--disable fast_mode`. Pass this explicitly, because the user's Codex config may default to fast.

It never changes Claude, which runs at normal speed, or the coordinating session's own speed.

## Claude effort

`--claude-effort <level>` selects `low`, `medium`, `high`, `xhigh` or `max` for Claude **PR reviews** only.

- Reject a missing or unsupported value before any Git change or process launch.
- Pass an explicit value into review checkpoint initialization as `claudeEffort`, and carry it through relaunches. Omit it when absent. Initialization then uses a resumed checkpoint's explicitly chosen effort, or else `medium`.
- Completed verified reviews remain reusable at their original effort; `$review-pr --fresh` repeats a review.
- Codex settings never change.
- `$review-handoff`'s Claude review is fixed at `high` and never takes this option.

## Delegated review call

A caller that runs `$review-pr` (`$implement-handoff`, `$sync-review`, `$merge-pr`, or a wrong-model relaunch) follows [recovery.md](recovery.md)'s delegated coordinator protocol:

1. Initialize the PR identity and current head with `review:state init`, passing `claudeEffort` only when explicitly supplied. Initialization continues earlier verified work automatically.
2. Run the coordinator through `review:state run` with:
   - `phase: "coordinator"`, `output: "file"` and the caller's `resultFile`
   - the reference's exact Codex model, effort and speed arguments, with `{report}` as the `-o` output
   - a prompt that adds `--claude-effort <state.claudeEffort>` and `Worker checkpoint: <review-scratch>`

   Allow at least 4 hours (Long commands). Retain the resolved effort for any inline CI review.
3. Read the result file, or else the canonical `<review-scratch>/result.json`.
   - `clean`: the review is clean and CI is green. Entries carried as `open` are in the PR body and don't block.
   - `error`: an Ends case; use its `stopReason`.
   - `interrupted`, a quota receipt or wrapper exit 75: end the caller with saved progress. Report the checkpoint, reset text and resume command, and preserve all scratch, WIP and worktrees. Never relaunch the exhausted process. This applies even when no final model report exists.
   - No result: inspect the checkpoint and receipts before Retry. Await a live child. Retry a dead coordinator as a continuation, which never repeats verified review or validation work.
