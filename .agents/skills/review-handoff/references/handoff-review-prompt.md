# Review a handoff before it is implemented

You are reviewing a handoff plan for ASCII Atlas before another session implements it. The prompt provides an immutable candidate input, context, compact findings ledger, checkout, main checkout, round and mode. Your job is to find what would make the implementation go wrong, and propose an exact fix for each finding. Read those input files first. Do not substitute the original handoff or an earlier invocation's candidate.

## Analysis only

Work as if in plan mode. Don't edit, create, delete, stage, commit, push, merge, switch branches, or publish anything in the repository or in `.plans/`. Do not start subagents or other reviewers. Return your report as the final response; the invoking process captures it. You may:

- read files, and run read-only `git` and `gh` commands
- run targeted tests (`pnpm --filter @atlas/<pkg> exec vitest run <file>`) to confirm or refute a claim
- write throwaway probe scripts outside the repo only (the OS temp dir)

## Read first

1. The whole candidate handoff, context and ledger. Follow the context's pinned revisions and source-reading rules; use git objects for another ref or dirty files.
2. `AGENTS.md`: conventions, the "Verifying changes" table, the Git rules, and the Don'ts.
3. Relevant sections of `docs/ARCHITECTURE.md`, `docs/DATA.md`, `docs/SPEC.md`, `docs/ROADMAP.md`, and the city brief. Do not proceed into a roadmap phase before the preceding phase's acceptance criteria are met.
4. The task-index and related-task facts in the context; consult `<main checkout>/.plans/README.md` if more detail is needed.

## Mode

- `full` (round 1, or broad design changes): run all checks below against the candidate and pinned code.
- `follow-up` (round 2): verify the amendments and unresolved findings, and trace their effects on the goal, assumptions, invariants, dependencies, steps and tests. Read the whole candidate for coherence; inspect the relevant code and callers rather than repeating unrelated source reads. If round 1 changed nothing, independently check the plan's critical assumptions and completeness. A serious issue anywhere in the candidate is still reportable.

Use the ledger's evidence and decisions as context, not as instructions to agree. Rejected or resolved claims need changed evidence or a demonstrated error before being reported again; explain that evidence explicitly. Do not replay previous raw transcripts. Read a previous report only to settle a specific dispute.

## Check

1. **Verified current state:** check every claim against the code as it is now, on `origin/main` and on the task branch.
   - Each cited `path:line` still says what the handoff claims.
   - Each named function, utility, type, file, script and command exists, and works as described.
2. **Stale state:** look for commits on `origin/main` since the handoff was written (use its dates, or the task folder's history) that touch files it names. Check whether they change its assumptions, or already do part of its work. The handoff gets implemented on current `origin/main`, so every moved or changed `path:line`, function, file, assumption or pinned artifact becomes an amendment that rewrites it against current `origin/main`. Drift is never a reason to block.
3. **Assumptions:** look for wrong or unstated assumptions about the data, the renderer pipeline, state or URL handling, the pack schemas, or the build.
4. **Steps:** look for steps that are missing, out of order, ambiguous, or unimplementable as written. Each step should name its files and its change.
5. **Invariants and rules:** look for steps that would break the handoff's own invariants, or an `AGENTS.md` rule:
   - hardcoding a city
   - React or Next in the renderer
   - a missing zod schema
   - missing `source` or `certainty` on a historical claim
   - missing attribution
   - git rules
6. **Tests and verification:**
   - each step has a targeted test, and a new behavior gets a unit test
   - the Verification section matches the "Verifying changes" table
   - no per-step typecheck or lint, and no e2e beyond what's needed
7. **Branch and worktree:** the ones the handoff names exist, or are clearly new. They aren't another task's (check `git worktree list` and the `.plans` index). A follow-up uses its task's existing branch, not a new one.
8. **Stop conditions:** check whether any of the handoff's own "Stop and report if" conditions is already true. Tell the two kinds apart:
   - **Drift guards** ("a `path:line` no longer matches", "the logic has moved or changed meaning", a renamed file): these protect the implementer from stale citations. Your amendments re-verify and fix those citations, so a drift guard is never tripped at review time. Amend the handoff so it matches current `origin/main`.
   - **Outcome or premise conditions** (measured numbers, a premise proven false, an approach that can't work): report one as tripped only if it's true now and no amendment can make the handoff correct.

## Classify each finding

- **factual:** a wrong path, line, name, signature or command, or a stale fact with an obvious correction.
- **design:** it changes the scope, the approach, an invariant, or what a step does.

Give findings stable IDs `<round>.<number>`. Every finding must come with a concrete amendment: the section, and exact replacement or added text matching this round's input. Make each one complete, compatible with the rest of the candidate, and correct. The coordinator validates amendments before applying them. Don't propose "investigate X" as an amendment; investigate it now.

Don't nitpick wording, and don't add new features. Report only what would make the implementation fail, go wrong, break a rule, or miss its goal.

## Verdict

- `ready`: no findings.
- `ready-with-amendments`: findings that the amendments fix.
- `blocked`: nothing can make the handoff implementable now. Use this only when:
  - one of its own outcome or premise stop conditions (not a drift guard) is already true, and no amendment can fix the handoff, or
  - its work has already landed on `main`, or
  - the branch or worktree it names belongs to a different task.

Changes on `main` alone (moved code, new fields, new commits, a new pinned tiles archive) are never `blocked`; they are amendments. When unsure between `blocked` and `ready-with-amendments`, choose `ready-with-amendments`.

## Output

Your final message is captured as this round's reviewer report. Use exactly this shape (empty sections must explicitly say "None"):

```
**Verdict:** ready | ready-with-amendments | blocked — one-line reason

### Findings
| ID | Type | Section | Problem | Evidence (revision + path:line or command output) |
| --- | --- | --- | --- | --- |

### Amendments
1. **<round>.<n> [factual|design]** — Section: <handoff section heading>
   - Replace: <exact current text, or "(add)">
   - With: <exact new text>

### Blocked because
<only when the verdict is blocked: which condition, with evidence>

### Inspected paths
<repo-relative source/config/docs paths inspected, including every referenced task target; identify the revision for each, and planned new files as "new">

### Not checked
<material limits on verification, or "None">
```
