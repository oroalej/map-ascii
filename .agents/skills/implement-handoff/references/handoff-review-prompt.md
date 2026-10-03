# Review a handoff before it is implemented

You are reviewing a handoff plan for ASCII Atlas before another session implements it. The handoff path, worktree, branch and main checkout are given in the prompt that sent you here. Your job is to find what would make the implementation go wrong, and to propose an exact fix for each finding.

## Analysis only

Work as if in plan mode. Don't edit, create, delete, stage, commit, or push anything in the repository or in `.plans/`. You may:

- read files, and run `git` and `gh` commands
- run targeted tests (`pnpm --filter @atlas/<pkg> exec vitest run <file>`) to confirm or refute a claim
- write throwaway probe scripts outside the repo only (the OS temp dir)

## Read first

1. The whole handoff.
2. `AGENTS.md`: conventions, the "Verifying changes" table, the Git rules, and the Don'ts.
3. The docs the handoff touches: `docs/ARCHITECTURE.md`, `docs/DATA.md`, `docs/SPEC.md`, and the city brief, as relevant.
4. `<main checkout>/.plans/README.md`, for the task's row and any related tasks.

## Check

1. **Verified current state:** check every claim against the code as it is now, on `origin/main` and on the task branch.
   - Each cited `path:line` still says what the handoff claims.
   - Each named function, utility, type, file, script and command exists, and works as described.
2. **Stale state:** look for commits on `origin/main` since the handoff was written (use its dates, or the task folder's history) that touch files it names. Check whether they change its assumptions, or already do part of its work.
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
8. **Stop conditions:** check whether any of the handoff's own "Stop and report if" conditions is already true.

## Classify each finding

- **factual:** a wrong path, line, name, signature or command, or a stale fact with an obvious correction.
- **design:** it changes the scope, the approach, an invariant, or what a step does.

Every finding must come with a concrete amendment: the section, and the exact replacement or added text. The implementer applies all of them as written, so make each one complete and correct. Don't propose "investigate X" as an amendment; investigate it now.

Don't nitpick wording, and don't add new features. Report only what would make the implementation fail, go wrong, break a rule, or miss its goal.

## Verdict

- `ready`: no findings.
- `ready-with-amendments`: findings that the amendments fix.
- `blocked`: nothing can make the handoff implementable now. Use this only when:
  - one of its own "Stop and report if" conditions is already true, or
  - its work has already landed on `main`, or
  - the branch or worktree it names belongs to a different task.

## Output

Your final message is saved as `handoff-review.md`. Use exactly this shape:

```
**Verdict:** ready | ready-with-amendments | blocked — one-line reason

### Findings
| # | Type | Section | Problem | Evidence (path:line or command output) |
| --- | --- | --- | --- | --- |

### Amendments
1. **#<n> [factual|design]** — Section: <handoff section heading>
   - Replace: <exact current text, or "(add)">
   - With: <exact new text>

### Blocked because
<only when the verdict is blocked: which condition, with evidence>
```
