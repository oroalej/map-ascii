---
name: review-pr
description: Review an ASCII Atlas pull request, branch, or diff for correctness, code quality, reuse, performance, test/CI cost, and AGENTS.md project rules. Reports verified, ranked findings with path:line and suggested fixes, then offers to fix them. Use when asked to review a PR, a branch, or the current changes.
argument-hint: '[PR number | branch]'
allowed-tools: Bash(gh pr view:*), Bash(gh pr diff:*), Bash(gh pr checks:*), Bash(gh pr list:*), Bash(git diff:*), Bash(git log:*), Bash(git show:*), Bash(git fetch:*), Bash(git status:*), Bash(git branch:*), Bash(git merge-base:*), Bash(git rev-parse:*), Read, Grep, Glob, Agent
---

# Review a pull request

Target: `$ARGUMENTS` (a PR number, a branch name, or empty for the current branch).

Review only. Make no edits, comments, commits, or pushes until the user accepts the fix offer (step 6).

The detailed checks for each review area are in [checklist.md](checklist.md). Read it before reviewing.

## 1. Resolve the target

Other sessions share this working tree, so **never check out, stash, or reset**. Read the PR's code from git objects.

- **PR number:**
  - `gh pr view N --json number,title,body,baseRefName,headRefName,headRefOid,files,commits`
  - `gh pr diff N`
  - `gh pr checks N`
- **Branch name:** `git fetch origin <branch>` if it is remote-only, then `git diff main...<branch>` and `git log main..<branch> --oneline`.
- **Empty:**
  - Use the current branch (`git branch --show-current`).
  - If `gh pr view --json number` finds a PR for it, review that PR as above.
  - Otherwise diff `main...HEAD`, and mention uncommitted changes (`git status`) without reviewing them, since they may belong to another session.

Read head-version files with `git fetch origin <headRef>` and `git show origin/<headRef>:<path>` (or `git show <headRefOid>:<path>`). If the head branch is the one checked out here, the working copy is fine, as long as `git status` shows no edits to that file.

Save the full diff to the session scratchpad directory (or the OS temp dir), never inside the repo, so subagents can read it.

## 2. Gather intent

- The PR title, body, and commit messages. Review against what the PR claims to do.
- If `.plans/README.md` lists this branch, read that task's `handoff.md`. It holds the plan, its invariants, and what it ruled out of scope.
- `AGENTS.md`, for conventions, the "Verifying changes" table, and the Don'ts.
- The doc sections for the touched areas:
  - **Renderer or web:** `docs/ARCHITECTURE.md` §2 (public API), §3 (pipeline), §8 (performance budgets), §9 (testing)
  - **`packages/data` or `packages/content`:** `docs/DATA.md`
  - **UI behavior, URL state, tours, timeline:** `docs/SPEC.md`

## 3. Review

Count the changed lines and files (`git diff --shortstat`).

- **Small diff** (under ~300 changed lines and at most 8 files): review it yourself, going through all four checklist areas.
- **Larger diff:** in one message, launch up to 4 `general-purpose` subagents in parallel, one per area:
  - A. Correctness & robustness
  - B. Performance & cost
  - C. Quality & reuse
  - D. Project rules, tests & docs

  Give each one:
  - the diff path and the head ref (so it can `git show <ref>:<path>`)
  - a 3–5 line summary of the PR's intent and any handoff invariants
  - the instruction to read `.claude/skills/review-pr/checklist.md`, its own section only
  - the rules: read-only, no checkout, and no findings CI already catches (ESLint, typecheck, `no-hardcoding.test.ts`, `check:budgets`)
  - the finding format below; it returns at most 8 findings

  Finding format:

  ```
  - severity: blocker | should-fix | nit
    file: repo-relative path
    line: line number on the head ref
    problem: one sentence
    scenario: concrete input/state → wrong result, or the concrete cost (per frame, per tile, KB, CI seconds)
    fix: one sentence, plus a short code sketch when the shape matters
    evidence: for reuse claims, the existing helper's path:line; for perf claims, the hot path it sits on
  ```

While subagents run, review the diff's overall shape yourself: is the approach right, and is anything missing? Missing pieces include a test, a doc update, a schema, or attribution.

## 4. Verify every finding

For each candidate finding, yours or a subagent's:

- Re-read the cited code on the head ref. Drop it if the line, the behavior, or the claim doesn't hold.
- Drop it if CI already catches it, unless `gh pr checks` shows that check failing (then report the failure).
- Drop pure style preferences. Code that doesn't match its surroundings counts as a finding; taste doesn't.
- A performance finding must name its hot path: per frame, per agent step, per tile, worker message, initial JS, renderer chunk, pmtiles, or CI time. Without one, downgrade it to a nit or drop it.
- A reuse finding must cite the existing helper by `path:line`, and you must have read that helper.
- Merge duplicates found by different areas.

## 5. Report

Write the report in chat, in this shape:

```
**Verdict:** Approve | Approve with nits | Changes requested — one-line reason

### Blockers
1. `path:line` — problem. Scenario. **Fix:** suggestion (sketch if needed).

### Should fix
...

### Nits
...

**Checked, no issues:** A … · B … · C … · D …   (one short clause each)
**Not checked:** e.g. physical-device FPS, browser visuals, the data pipeline run
```

- Report at most ~15 findings, with at most 5 nits. Order them by severity, then by impact.
- Omit empty severity sections.
- Use `path:line` so the references are clickable.
- If CI is failing or pending, say so above the verdict.

## 6. Offer to fix, then stop

End with one line offering to fix the blockers and should-fix items, or a subset the user picks. Wait for the answer.

If the user accepts:

1. Work on the PR's head branch. If another worktree already has it checked out (`git worktree list`), work there. `<main-checkout>` is the first entry of `git worktree list`. Only if no worktree has it, add one with `git worktree add "<main-checkout>/worktrees/<short>" <headRef>`, then run `pnpm install --frozen-lockfile --prefer-offline` followed by `pnpm data:fetch` in it before making fixes or running checks.
2. Make the fixes, scoped to the findings.
3. Run the smallest checks from the AGENTS.md "Verifying changes" table that cover the changes. Leave the full suite to CI.
4. Before committing, run `git status` and `git branch`. Stage files by explicit path. Use a gitmoji + conventional commit message that matches `git log`.
5. Push, then update the PR description if the fixes change what it says.
6. Report:
   - which findings were fixed or skipped, and why
   - which checks ran and which were left to CI
   - whether a worktree was created, and remove it if the user agrees
