---
name: review-pr
description: Review an ASCII Atlas pull request, branch, or diff for correctness, code quality, reuse, performance, test/CI cost, and AGENTS.md project rules. Reports verified, ranked findings with path:line and suggested fixes, then fixes the blockers and should-fix items (report only with --report-only). Use when asked to review a PR, a branch, or the current changes.
argument-hint: '[PR number | branch] [--report-only] [--since <sha>] [--ledger <path>]'
allowed-tools: Bash(gh pr view:*), Bash(gh pr diff:*), Bash(gh pr checks:*), Bash(gh pr list:*), Bash(git diff:*), Bash(git log:*), Bash(git show:*), Bash(git fetch:*), Bash(git status:*), Bash(git branch:*), Bash(git merge-base:*), Bash(git rev-parse:*), Bash(git grep:*), Read, Grep, Glob, Agent
---

# Review a pull request

Target: `$ARGUMENTS` (a PR number, a branch name, or empty for the current branch, optionally followed by `--report-only`, `--since <sha>` and `--ledger <path>`).

- `--since <sha>`: **delta mode**. An earlier round already reviewed the PR at `<sha>`; review only what changed since then (step 3).
- `--ledger <path>`: earlier rounds' findings, with stable IDs such as `r1.2`, and rejected claims. Read it before reviewing. Don't re-report a rejected claim unless its code changed.

Steps 1–5 are review only: no edits, comments, commits or pushes. Step 6 then fixes the findings, unless `--report-only` was given. `$review-pr` passes `--report-only`, because its validator and fixer run separately and its baseline check expects this process to leave the checkout unchanged.

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
- `AGENTS.md` is already in your context through `CLAUDE.md`; don't read it again. Use it for conventions, the "Verifying changes" table, and the Don'ts.
- The doc sections for the touched areas:
  - **Renderer or web:** `docs/ARCHITECTURE.md` §2 (public API), §3 (pipeline), §8 (performance budgets), §9 (testing)
  - **`packages/data` or `packages/content`:** `docs/DATA.md`
  - **UI behavior, URL state, tours, timeline:** `docs/SPEC.md`

## 3. Review

Work economically: every tool call re-reads the whole conversation so far. Batch independent reads into one message, and read line ranges around the changed hunks (`git diff -U20`, `sed -n`) rather than whole files. Some files run to thousands of lines.

**Delta mode (`--since <sha>`):** review `git diff <sha> <head>` yourself, with no subagents. In step 2, read only what the delta needs: the PR title, the handoff's invariants and the touched docs.
- Check every fix against the ledger entry it addresses. An entry that is still unresolved gets reported again under its ledger ID (`r1.2 — still …`). Don't report an entry the ledger marks `open`: it's already carried in the PR body.
- Find the callers and tests of every changed function, type or constant (`git grep`), and report regressions beyond the changed lines.
- Read beyond the delta whenever the evidence needs it, but don't re-audit untouched code. Earlier rounds reviewed it.
- The report keeps the step 5 shape. "Checked, no issues" names what the delta covered.

**Full review:** this is the only pass over the whole PR. Later rounds review only the fixes, so a defect left out now ships or costs another round. Report every one you can prove. Count the changed lines and files (`git diff --shortstat`).

- **Small diff** (under ~300 changed lines and at most 8 files): review it yourself, going through all four checklist areas.
- **Larger diff:** split the review by files, not by area. Use `n = min(6, max(2, ceil(changed lines / 1000)))` subagents. Group the changed files into `n` groups by package or directory, with roughly equal changed lines, and keep a file with its test. In one message, launch `n` `general-purpose` subagents in parallel, one per group.

  Give each one:
  - its file list, and a diff of only those files saved to the scratchpad (`git diff <base>...<head> -- <files>`), plus the head ref (so it can `git show <ref>:<path>`)
  - a 3–5 line summary of the PR's intent and any handoff invariants, and the ledger path if there is one
  - the instruction to read `.claude/skills/review-pr/checklist.md` and apply all four areas (A correctness, B performance and cost, C quality and reuse, D project rules, tests and docs) to its files. It may read callers and code outside its group to judge them.
  - the economy rules above: batch reads, and read hunks with context instead of whole files
  - the rules: read-only, no checkout, and no findings CI already catches (ESLint, typecheck, `no-hardcoding.test.ts`, `check:budgets`)
  - the severity definitions below and the finding format; it returns every finding it can prove, with no count limit

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

While subagents run, review the diff's overall shape and the interactions between file groups yourself: is the approach right, and is anything missing? Missing pieces include a test, a doc update, a schema, or attribution.

## 4. Verify every finding

For each candidate finding, yours or a subagent's:

- Re-read the cited code on the head ref. Drop it if the line, the behavior, or the claim doesn't hold.
- Drop it if CI already catches it, unless `gh pr checks` shows that check failing (then report the failure).
- Drop pure style preferences. Code that doesn't match its surroundings counts as a finding; taste doesn't.
- A performance finding must name its hot path: per frame, per agent step, per tile, worker message, initial JS, renderer chunk, pmtiles, or CI time. Without one, downgrade it to a nit or drop it.
- A reuse finding must cite the existing helper by `path:line`, and you must have read that helper.
- Merge duplicates found by different areas.
- Set each finding's severity:
  - **blocker:** wrong behavior a user or CI would hit, with a concrete failing scenario. That covers a crash, wrong output, a failing or broken test, data loss, a broken `AGENTS.md` rule (attribution, a hardcoded city, Google imagery, a backend), or a budget breach.
  - **should-fix:** a real defect with no visible failure yet. Examples: an edge case that gives wrong results, a hot-path cost with its path named, new behavior without a test, a doc that now says something false, or duplicated logic that has already drifted apart.
  - **nit:** everything else, such as dead code, comment wording, naming, duplication that still agrees, commit structure, and test tidiness.
  - If it's unclear whether something is a should-fix or a nit, it's a nit. `$review-pr` runs another round only for blockers and should-fix items.

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

- Report every verified finding, with no count limit. Blockers come first, then should-fix, then nits, each section ordered by impact.
- Omit empty severity sections.
- Use `path:line` so the references are clickable.
- If CI is failing or pending, say so above the verdict.

## 6. Fix

With `--report-only`, stop after the report. Otherwise fix the blockers and should-fix items now, without asking. Don't wait for an answer, and don't offer a choice of subsets:

1. Work on the PR's head branch. If another worktree already has it checked out (`git worktree list`), work there. `<main-checkout>` is the first entry of `git worktree list`. Only if no worktree has it, add one with `git worktree add "<main-checkout>/worktrees/<short>" <headRef>`. In the new worktree, run `pnpm install --frozen-lockfile --prefer-offline`, then `pnpm exec tsx "<skill-checkout>/scripts/claude-worktree-settings.ts"`, then `pnpm data:fetch` before making fixes or running checks. `<skill-checkout>` is the repository root containing this loaded skill; use its initializer even if the reviewed branch predates it. This excludes the main checkout's instructions while preserving personal Claude settings.
2. Make the fixes, scoped to the findings.
3. Run the smallest checks from the AGENTS.md "Verifying changes" table that cover the changes. Leave the full suite to CI.
4. Before committing, run `git status` and `git branch`. Stage files by explicit path. Use a gitmoji + conventional commit message that matches `git log`.
5. Push, then update the PR description if the fixes change what it says.
6. Report:
   - which findings were fixed or skipped, and why
   - which checks ran and which were left to CI
   - whether a worktree was created. Leave it in place; `$merge-pr` removes it after the PR merges
