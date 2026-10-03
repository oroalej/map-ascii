---
name: implement-handoff
description: Take a handoff plan (.plans/<status>/<task>/handoff.md) from review to PR. A separate Sol 6.1 max-effort run reviews the handoff for gaps and wrong assumptions, every proposed amendment is applied, then this session implements it, commits and pushes, merges origin/main, opens a PR to main, and runs $review-pr (review loop and CI gate). Never merges. Use when the user invokes $implement-handoff [--fast] <task or handoff path>.
---

# Review a handoff → implement → land as a PR → $review-pr

Usage: `$implement-handoff [--fast] <task | path to handoff.md>`

Invoking `$implement-handoff` authorizes these actions for this one task:

- editing its `handoff.md` with review amendments
- creating its worktree if the handoff says it's a new task
- implementing it, committing and pushing
- merging `main` into its branch and opening a PR to `main`
- running `$review-pr`, which commits and pushes fixes and CI fixes

Don't ask for confirmation between steps. Stop only where this skill or the handoff says to stop. Never merge the PR.

## Models

Always pass these explicitly. Never change them or fall back to another model.

| Role | Model | Effort | Speed |
| --- | --- | --- | --- |
| This session: amends the handoff, implements, commits, merges `main`, opens the PR | Sol 6.1 (`gpt-6.1-sol`) | xhigh | the session's own setting |
| Codex #1: reviews the handoff (analysis only) | Sol 6.1 (`gpt-6.1-sol`) | max | `<speed>` |
| Codex #2: runs `$review-pr` | Sol 6.1 (`gpt-6.1-sol`) | xhigh | `<speed>` |
| Inside `$review-pr`: the review / its validation | Claude Opus 5.5 (`claude-opus-5-5`), high / Sol 6.1, max | | normal / `<speed>` |

This session must be Sol 6.1 (`gpt-6.1-sol`) at xhigh effort. If it's running a different model or effort, stop and ask the user to start `$implement-handoff` again from a session with those settings.

`<speed>` comes from the `--fast` option:

- with `--fast`: `-c 'service_tier="fast"' --enable fast_mode`
- without it: `--disable fast_mode`. Pass this explicitly, because the user's Codex config may default to fast.

`--fast` is also forwarded to `$review-pr`. It doesn't change Claude, or this session's own speed.

## Rules

- **Git safety:** never check out, switch branches, stash, reset, rebase, force-push, use `git add -A`, `git add .` or `git commit -a`, or pass `--no-verify`.
- **Windows:** prompts that contain `$` go in single quotes, and stdout is captured with `Out-File -Encoding utf8`, never a plain `>`.
- **Long commands:** the `$review-pr` run can take several hours. If the shell tool can't hold a command that long, start it in the background with its output going to a log in `<scratch>`, and poll until it exits.
- **To pause:** move the task folder to `.plans/paused/`, set its `.plans/README.md` row's Next step to the reason and what needs a human, then go to step 6.

## 0. Resolve the handoff

1. `<main-checkout>` is the first entry of `git worktree list`. Take out `--fast` if present, and set `<speed>`.
2. Find the handoff:
   - **A path:** use it.
   - **A task name:** look for `<main-checkout>/.plans/{todo,paused,active}/<task>/handoff.md`.
   - If none is found, or more than one, stop and say so.

   `<task-dir>` is the folder holding the handoff. Use it as `<scratch>`: every file this skill writes goes there.
3. Read the whole handoff, and `AGENTS.md`.
4. From the handoff's §1 (Goal & context), take the branch and worktree:
   - **It names an existing worktree** (a follow-up): use it. Confirm with `git worktree list` that the worktree is on that branch.
   - **It's a new task:** run `pnpm worktree:new <short> <topic>` from `<main-checkout>`, with the names the handoff gives. If it gives none, derive them from the task folder name. If the script fails after creating the worktree, run `pnpm install --frozen-lockfile --prefer-offline` and `pnpm data:fetch` in it yourself.

   `<wt>` is that worktree.
5. Move `<task-dir>` to `<main-checkout>/.plans/active/` (update `<task-dir>`). Add or update its `.plans/README.md` row: status `Implementing (implement-handoff)`, Evidence `<branch> / <wt>`.
6. Save the baseline: `git -C <wt> status --porcelain` → `<scratch>/status-baseline.txt`.

## 1. Review the handoff (Codex #1: Sol 6.1, max, analysis only)

Run from `<wt>`, with a shell timeout of at least 30 minutes. `<skill-dir>` is the absolute folder of this `SKILL.md`.

```
codex exec -m gpt-6.1-sol -c 'model_reasoning_effort="max"' <speed> -s danger-full-access -C <wt> -o <scratch>/handoff-review.md "Follow <skill-dir>/references/handoff-review-prompt.md exactly. Handoff: <task-dir>/handoff.md. Worktree: <wt>, branch <branch>. Main checkout: <main-checkout>."
```

- Never change the model, effort or speed flags, and never skip this run to review the handoff in this session instead.
- Afterwards, compare `git -C <wt> status --porcelain` with the baseline. If anything changed, report the difference and stop. Do not revert it.
- If `handoff-review.md` is missing, or has no verdict line, stop and report.

## 2. Apply the amendments

Read `handoff-review.md`.

- **Verdict `blocked`:** pause and stop before any code changes. This verdict is used only when no amendment can make the handoff implementable:
  - one of its own "Stop and report if" conditions is already true, or
  - its work has already landed on `main`, or
  - the branch or worktree it names belongs to a different task.
- **Otherwise:** apply every finding's proposed amendment, factual and design alike, to `<task-dir>/handoff.md`:
  - Edit the affected sections in place, using the replacement text the review proposes.
  - Append (or extend) a `## Review amendments` section at the end. List each finding as `<n>. [factual|design] <section> — <problem> → <what changed>`. Mark design amendments in **bold**.
  - Then re-read the amended handoff in full. From here on, it's the spec.

## 3. Implement

Work in `<wt>`, following the amended handoff:

1. Do its steps in order. After each step, run that step's targeted test. Fix failures before moving on.
2. Obey its "Stop and report if" section. If a condition is hit, commit nothing further, then pause and stop. Leave any commits already made local and unpushed, and list them in the report.
3. Respect its Invariants and Out of scope sections, and `AGENTS.md`.
4. Once at the end, run its Verification section.
5. Commit as its Commit section says. Run `git status` and `git branch` first, stage by explicit path, and use its gitmoji message(s).

## 4. Land the branch

Follow steps 1 and 3 of `<skill-dir>/../sync-review/SKILL.md` for this one branch and worktree, with these adjustments. Don't merge `origin/main` here: `$review-pr` does it first, in step 5.

- **Step 1 (commit and push):** usually only pushes, since step 3 already committed. Anything uncommitted at this point is either work the handoff missed (commit it) or not this task's (hold it back and report it). A held-back file or rejected push → pause and stop.
- **Step 3 (PR):** if there's no PR, create one. Take the body from the handoff's Goal & context, its steps, and its Verification results (what actually ran). Add a "Handoff review amendments" section listing the design amendments.

## 5. Run $review-pr

Start it once, in a fresh Codex #2, with a shell timeout of at least 4 hours:

```
codex exec -m gpt-6.1-sol -c 'model_reasoning_effort="xhigh"' <speed> -C <wt> -o <scratch>/review.md 'Use the review-pr skill at <skill-dir>/../review-pr/SKILL.md, following it exactly, on this branch''s PR. Arguments: <--fast, or nothing>. Result file: <scratch>/review.json.'
```

Read `<scratch>/review.json`. If it's missing, use the `review-pr-result` block at the end of `review.md`.

- `clean` (review clean and CI green): the task is done.
- Anything else (`capped`, `stalled`, `stopped`, `ci-red`, `error`), including `stopped` for a `merge conflict` with `main` it couldn't resolve: the PR stays open. Set the row's Next step to the status and its `stopReason`. The folder stays in `active/`.

## 6. Report and clean up

Report, following the handoff's "Report back" section, and add:

- **Handoff review:** the verdict and every amendment, with the design amendments listed first.
- **The PR URL**, and the `$review-pr` result: the main merge (`mainMerge`), review rounds (`roundCount` of 3), final status, the CI status, and anything it skipped or noticed.
- Which checks ran locally, and which were left to CI.
- The speed the Codex instances ran at (fast or normal).

Then, per `AGENTS.md`:

- **Task status:**
  - `clean`: move `<task-dir>` to `.plans/done/`, and set its row to Complete, with the PR # and the final commit.
  - Paused or not clean: leave the folder where step 2–5 put it, with the row's Next step saying why.
- **Scratch:** leave it in `<task-dir>`. `$merge-pr` deletes it with `pnpm plans:clean` when the PR merges, keeping `handoff.md` and the files the handoff marks **keep**. Never delete scratch with shell commands: Codex rejects recursive deletes as "blocked by policy".
