# Validate round 2's handoff review

The prompt provides Claude's current report, the immutable round-2 candidate, context, ledger, checkout and main checkout. Validate this report against that exact candidate and the code revisions the context names. Do not substitute the original handoff or earlier output.

## Analysis only

Make no edits to the repository or `.plans/`, no git mutations, no publishing and no nested reviewer/subagent runs. Return your report as the final response for the invoking process to capture. Read-only git/gh commands and narrowly targeted tests may verify a claim; temporary probes stay in the OS temp directory. Follow the context's source-reading rules for dirty files or other refs.

## Validate findings

Read the candidate, context, ledger, Claude's report and `AGENTS.md`. Validate every finding, including a claimed blocked premise:

1. Read its cited code and enough surrounding callers, schemas, docs and tests to establish the scenario. State the revision and evidence. Inspect relevant material rather than repeating the full first-round audit.
2. Decide whether the problem is real, within the handoff's goal, and material to implementation. Wording preferences and speculative new features are invalid.
3. Check that replacement text matches this round's candidate and that the proposed amendment fixes the problem without breaking another section, invariant, project rule or verification requirement.
4. Classify it as `valid`, `partly valid` or `invalid`. For partly valid findings, supply complete corrected amendment text. For rejected findings, give the specific evidence and reason. Correct factual/design classification when necessary.
5. Check prior ledger decisions. If a supposedly resolved claim recurs or an amendment reverses an earlier accepted change, decide which side the current evidence supports and say why. The coordinator follows your decision; there is no stalled outcome.

Inspect a Claude `blocked` claim as strictly as any other finding. Main drift and tripped outcome/premise conditions are amendable and cannot justify `blocked`; for a tripped condition, supply the amendment that solves it (a revised approach, or a step that diagnoses, fixes and re-measures). Only work already landed on main can justify it. A branch or worktree owned by another task is an amendment naming this task's own branch and worktree. An unsupported blocked claim can be rejected and validated as ready when no other required issues remain.

Do not turn this validation into another full audit. If you notice a serious omission outside Claude's findings, list it under "Noticed" with evidence and give it an exact amendment (ID `N<n>`) in the Amendments section. Do not silently omit it.

The verdict describes the immutable input you just checked:

- `ready`: no valid required amendments, no serious noticed issues, and no confirmed blocked premise.
- `ready-with-amendments`: valid/partly valid findings or noticed issues need the exact amendments below. You have validated each amendment against the code; the coordinator applies them exactly as worded and the handoff is then ready.
- `blocked`: the work already landed on main, with evidence.

This is the last validation process in the two-round budget, so every amendment you approve must be complete, exact and compatible with the rest of the candidate.

## Output

Use exactly this shape. Include every Claude finding in the table; explicitly write "None" in empty sections, including a zero-findings table.

```text
**Verdict:** ready | ready-with-amendments | blocked — one-line reason
**Claude's verdict:** <copied from report>

### Validation
| ID | Type | Claim | Decision (valid/partly valid/invalid) | Evidence and reason |
| --- | --- | --- | --- | --- |

### Amendments
1. **<ID> [factual|design]** — Section: <candidate heading>
   - Replace: <exact candidate text, or "(add)">
   - With: <complete validated replacement>

### Decisions on prior conflicts
<entry IDs, the conflicting claims, which side the evidence supports and why, or "None">

### Noticed
<serious issue, candidate section and revision + path:line evidence, or "None">

### Blocked because
<confirmed condition and evidence, or "None">

### Inspected paths
<repo-relative inspected source/config/docs paths and their revisions; include referenced task targets, marking planned new files as "new">

### Not checked
<material verification limits, or "None">
```

Amendments cover valid/partly valid findings and noticed issues. Merge overlapping amendments into one, deciding between incompatible ones; never produce competing replacements for the same text.
