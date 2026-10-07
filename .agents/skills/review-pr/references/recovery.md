# Durable PR review recovery

Use `<repo>/scripts/pr-review-state.ts` from the checkout holding the loaded skill. Inputs are UTF-8 JSON files in this task's scratch (or the caller's scratch before a PR invocation exists). Write real JSON using a file tool or `ConvertTo-Json`; do not build executable shell strings from model output.

```
pnpm.cmd -C <repo> --silent review:state <action> --input <absolute-input-file>
```

Capture the command's exit status immediately. `run` exits 0 for a successful complete report, 75 for explicit quota exhaustion, and 1 for a failed/incomplete attempt. Check the receipt as well. Save command output to the invocation's logs with UTF-8 encoding. Background wrappers use hidden windows and remain running until their native child exits.

## Select and initialize

Before altering a worktree, run `inspect` with:

```json
{
  "checkout": "<checkout sharing this repository>",
  "pr": 12,
  "branch": "codex/example",
  "remoteSha": "<full current PR head>",
  "fast": false
}
```

It returns the latest matching checkpoint or a legacy source. Add `claudeEffort: "<level>"` only when `--claude-effort` was explicitly supplied; omit it to inherit an explicitly chosen saved effort on resume. Accept only `low`, `medium`, `high`, `xhigh` or `max`. Reject missing/invalid option values before initialization or process launches. Add `fresh: true` or `resume: "<absolute-run-path>"` for the corresponding flags. Reject both together. A `--resume` target without a PR argument gets its PR and branch from the saved checkpoint, or verified `invocation.json`/`pr-round1.json` legacy metadata; then query that PR. Never use the main checkout's fallback PR selection for an explicit resume.

Inspect the original checkout, baseline, owned bytes and pending operations. Keep owned WIP only when the saved bytes and index/working-tree hashes still match. In the PR's own task worktree, every other dirty file (unknown changes, legacy dirty files, owned files whose bytes no longer match) is the task's work: adopt it with "Commit task leftovers" (shared.md) before `init`, so the new review covers it. In other checkouts (the main checkout, a folder of unknown origin), preserve unknown changes; if a detached worktree is needed, replay only recorded owned bytes with `restore` below.

Fetch the branch and main, reconcile local and remote commits under the skill's Git rules, then refresh the PR head. Run `init` with the same input using the chosen PR checkout and refreshed remote SHA. It creates a new invocation and returns `state`, verified `reusable` receipts, and recovery diagnostics. No files in the source invocation are changed. An active recorded child prevents initialization: observe its process and receipt rather than launching another.

Set `<scratch>` to `state.run`. Retain `state.resumedFrom`, cumulative `round`, `history`, `rejected`, baseline, operations and reporting metadata. Write inherited rejection text to the new invocation's `rejected.md` before launching Claude. Resolve newest installed binaries again; saved executable paths are provenance only. Current speed applies to unfinished steps.

Use `state.claudeEffort` for every new Claude PR-review attempt. Initialization resolves explicit effort, then a resumed effort that was explicitly chosen (`claudeEffortExplicit: true`), then `medium`; fresh runs default to `medium`, and a resumed default moves to `medium`. Older version-1 checkpoints without effort normalize to `high` in memory for provenance, preserving their saved bytes, and their continuation uses `medium`. An explicit override applies to unfinished reviews and later rounds without invalidating completed verified reports. Keep their actual effort from receipt arguments in each round's history, defaulting legacy fixed-effort records to `high`.

For `Worker checkpoint`, verify its identity with `show` and attach directly to that initialized invocation. Its saved effort is authoritative; reject a conflicting explicit worker option. The caller's coordinator receipt supervises this worker. Do not run `init` again. The worker checkpoints its own operations and launches reviewer/validator wrappers normally.

After main synchronization, dispatch to the recovered phase only when the reviewed head is unchanged. A new merge or external commit requires a new review round, retaining old rounds as history. Before consuming a saved clean result, verify local HEAD equals current PR head, current main is an ancestor, the task worktree has nothing uncommitted apart from held-back files, and GitHub CI passes for that exact head.

## Record operations

`show` takes `{ "run": "<scratch>" }`. `record` takes `{ "run": "<scratch>", "patch": {...} }` and accepts only coordinator fields: phase, round, status, nextAction, remoteSha, mainSha, history, rejected, ci, interruption and report. Replace complete nested values, rather than partial objects. Checkpoint JSON is schema/version validated; incomplete temporary writes never advance progress.

`protect` takes `{ "run": "<scratch>" }` and records currently dirty foreign bytes as baseline edits without touching files or claiming ownership. Use it when a read-only process or another session changes the checkout. It excludes bytes matching owned changes, and includes an owned file that was unexpectedly altered. A continuation re-establishes this protection from actual dirty bytes in its chosen checkout; the original baseline remains in the immutable source invocation. Baseline comparisons use `--porcelain=v1 -z --untracked-files=all` consistently.

Example reporting metadata:

```json
{
  "run": "<scratch>",
  "patch": {
    "report": {
      "mainMerge": "current",
      "cli": { "codex": "<resolved-version>", "claude": "<resolved-version>" },
      "workTree": null,
      "leftovers": [],
      "heldBack": [],
      "noticed": [],
      "localChecks": []
    }
  }
}
```

Before each synchronization, reviewer launch, validation launch, fix, verification, commit, push or CI operation, call `begin`:

```json
{
  "run": "<scratch>",
  "id": "round2-fix-entry3",
  "phase": "fixes",
  "paths": ["packages/renderer/src/example.ts"],
  "data": { "entry": 3, "change": "<specific intended fix>" }
}
```

Operation IDs are unique within the review lineage. List every file before editing it, including new files and deletions; each must be clean or match previously recorded owned bytes. For a multi-step fix reaching another file, create another operation before changing it. Baseline or unrecorded edits cannot be claimed as owned. Operations without source edits use an empty paths array. Before starting a merge, begin a synchronization with `data.mergeHeads: ["<intended-main-sha>"]` (ordered if there are several intended parents), and retain that field in its finish data. Do not begin a commit until explicit staging is complete. The helper checks every changed path, including rename sources, and saves its expected tree and complete ordered parents. A merge's current heads must match the recorded synchronization heads and pre-merge HEAD before its commit can begin.

After the operation succeeds, call `finish`:

```json
{
  "run": "<scratch>",
  "id": "round2-fix-entry3",
  "next": "verify",
  "nextAction": "Run the entry's targeted tests",
  "data": { "entry": 3, "outcome": "implemented", "checks": [] }
}
```

Fix completion saves owned file contents and base hashes. Verification completion records actual commands, exit codes and the operation's tree hash in `data`; reuse a check only when its tested snapshot still matches. Update finding progress after each step, not only at the end of a round. Final round records enter `history` with their actual commit hashes. Committed bytes cease to be WIP, while operation and round history remain.

Record `mainSha` after fetching main and refresh `remoteSha` after every push. Record the next round number before launching its reviewer. Preserve generated task artifact paths and content hashes in operation data so completed measurements can be checked without overwriting them.

Reconcile a pending operation before repeating it:

- A commit with the recorded complete ordered parent list and staged tree already exists: adopt its SHA, close its operation and retire only its committed owned paths. Continue at push when unpushed, or advance to review once when its head already reached the refreshed remote. Older checkpoints lacking parent-list evidence can recover a matching single-parent commit; they cannot authorize a merge merely by its first parent.
- A pending push's commit is already an ancestor of refreshed PR head: acknowledge the push; review any subsequent/new commits. Never duplicate a commit or force-push.
- A pending main merge is owned only when its saved pre-merge head and intended main SHA match Git's merge state. Continue its resolution; otherwise preserve that checkout and use a detached one.
- A running child is identified by PID and OS start identity. Read its existing logs and await completion. Missing output from a live child is not a retry condition.
- Uncheckpointed changes in the PR's task worktree are adopted with "Commit task leftovers" (shared.md), never stranded. In other checkouts they are preserved as unknown edits; recreate the unfinished step in an isolated checkout if ownership cannot be established.

`restore` takes `{ "run": "<scratch>", "checkout": "<isolated-checkout>" }`. It verifies repository identity and every destination's saved base bytes before writing any owned changes. A mismatch requires manual reconciliation of the saved patch intent; never overwrite unrelated bytes. Then initialize a new continuation using that checkout. Saved deletions are applied only to matching base files.

## Choose the review scope

`scope` takes `{ "run": "<scratch>", "round": <k> }` after the round's head is synchronized and recorded. It finds the last history entry with a `reviewedHead` and compares it with HEAD:

- **delta**: that commit is an ancestor of HEAD, no merge commit is in between, at most 400 lines changed, and no `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.github/`, `tsconfig*.json`, `*.config.*`, `.claude/` or `.agents/` file changed. It writes `round<k>/delta.patch`.
- **full**: everything else, including the first round, a rewritten branch, a main synchronization, binary changes and an unchanged head.

It always writes `round<k>/scope.json`, plus `round<k>/ledger.md` when earlier rounds recorded entries or rejected decisions. Ledger IDs are `r<round>.<id>` from the round that recorded the entry. The output contains paths beside the scope, but `scope.json` itself holds only commits, files, counts and content hashes. Rerunning it for the same commits and history reproduces the same bytes, so a resumed round keeps its reusable receipts. Pass `scope.json` as `scope` to the reviewer and validator processes. A receipt whose scope file no longer matches is not reusable, and validation refuses a scope different from its review's.

## Run native processes

Use `run` with this shape; the wrapper creates a new attempt, substitutes `{report}` as an individual argument, and writes `receipt.json` even if the coordinating agent disappears:

```json
{
  "run": "<scratch>",
  "phase": "review",
  "round": 2,
  "headSha": "<full synchronized PR/local head>",
  "executable": "<newest resolved absolute claude path>",
  "args": ["-p", "/review-pr 12 --report-only --since <since> --ledger <ledger>", "--model", "claude-opus-5-5", "--effort", "{claudeEffort}", "--session-id", "{sessionId}", "--strict-mcp-config", "--dangerously-skip-permissions", "--output-format", "text"],
  "output": "stdout",
  "scope": "<scratch>/round2/scope.json"
}
```

Drop `--since` for a full round and `--ledger` when the scope has no ledger. `--strict-mcp-config` keeps the user's claude.ai connectors (Docs, Gmail, Drive, Notion, Calendar) out of a review run; they add context and nothing else. For Claude, the wrapper substitutes `{claudeEffort}` from the checkpoint in review-phase arguments and `{sessionId}` with a new UUID, and records the resolved native arguments in the receipt. After the process exits it reads that session's transcript and its subagents' transcripts under `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/` and saves `usage` (turns plus input, cache-write, cache-read and output tokens, main session and subagents kept separate) in the receipt. A missing transcript leaves `usage: null`. Append one `--append-system-prompt` argument combining the pinned head instruction and saved rejection text. Require review of the pinned commit; if the PR head differs, the report is unusable. Query the PR head after either reviewer exits and discard results if it moved.

The wrapper is the only thing that ever ends a reviewer. While the child runs it polls the session transcript (every 30 s): once the last message is an `end_turn` assistant turn holding a complete report and the file has not changed for 2 minutes, it ends the child and takes that message as the report (`reportSource: "transcript"`, `terminatedBy: "idle-watchdog"`, `valid: true`). It also applies a time cap (90 min review, 60 min validation, 6 h coordinator; `terminatedBy: "time-cap"`, never valid). Reviews and validations also queue for one of two machine-wide review slots (`waiting for a review slot` on stderr) so parallel worktrees don't exhaust the Claude window together. Callers never pass a shell timeout; they launch in the background and poll the receipt. Optional `watchdog: {pollMs, idleMs, maxMs}` in the input exists for tests.

For validation, use `phase: "validation"`, `output: "file"`, `reviewReceipt: "<verified-review-receipt.json>"`, the exact Codex model/effort/speed flags from the skill, `-o`, `{report}`, and a prompt naming that receipt's actual report path and pinned head. The wrapper verifies the input receipt and report before launch and after completion, and records its token and report hash in the validation receipt. Recovery selects the latest verified review together with only its bound validation. Store prompts/config in the input JSON, never reference an unrelated run's output.

Validation arguments are `exec`, `-m`, `gpt-6.1-sol`, `-c`, `model_reasoning_effort="max"`, the individual `<speed>` arguments, `-s`, `danger-full-access`, `-C`, `<pr-checkout>`, `-o`, `{report}`, then the prompt: `Follow <skill-dir>/references/validate-prompt.md exactly. PR: #<N> (<url>), head <headRefOid>, base <baseRefName>. Claude's review: <claude-report>. Scope: <full | delta since <since>>. Ledger: <ledger or none>.` Normal speed is the two arguments `--disable`, `fast_mode`; fast speed is `-c`, `service_tier="fast"`, `--enable`, `fast_mode`.

For delegated coordinators and wrong-model relaunches, the caller first initializes the invocation, then uses `phase: "coordinator"`, `output: "file"`, the existing Codex xhigh/speed flags, `-o`, `{report}`, and a prompt with the same review invocation plus `Worker checkpoint: <scratch>` and the requested result path. Add `resultFile: "<caller-result-path>"` to the process input. This allows the wrapper to publish quota interruption even when the worker produces no final report.

Coordinator arguments are `exec`, `-m`, `gpt-6.1-sol`, `-c`, `model_reasoning_effort="xhigh"`, the individual `<speed>` arguments, `-C`, `<pr-checkout>`, `-o`, `{report}`, then: `Use the review-pr skill at <review-pr-skill>, following it exactly, on PR #<N>. Arguments: --claude-effort <state.claudeEffort> <--fast, or nothing>. Worker checkpoint: <scratch>. Result file: <caller-result-path>.` Pass the actual initialized effort in the prompt, `state.round` and the initialized local `state.headSha` to the wrapper. Preserve public arguments on wrong-model relaunches and pass explicit effort into initialization. A coordinator can start while a recorded local commit still needs pushing; reviewer/validator processes require synchronized local and remote heads.

After a worker exits, read the canonical `<scratch>/result.json` or requested result copy. If missing and its receipt reports quota exhaustion, publish `interrupt`. If the process ended abruptly without quota metadata, inspect the last checkpoint and dead/live child receipts before Retry. A dead coordinator retry uses a new invocation recovering that state; do not repeat successful reviewer/validator steps. A live coordinator is awaited.

Only successful, complete, unchanged reports at the required input commit are reusable. The receipt records native exit, command settings, identity, report hash and the validator's input-review dependency. A verdict/table marker alone is insufficient; failed receipts never substitute for completed work. Older native validation receipts lacking dependency proof require a new validation. Legacy import accepts known invocation/round metadata plus matching-head report files with successful structured exit receipts. A legacy validation also requires its exit metadata to identify `reviewReport` (the exact selected review path) and `reviewReportHash`; without both, retain the review and rerun validation. It carries round records only when their fixed commits remain in HEAD ancestry. Missing proof restarts that phase and preserves all legacy files.

## Interrupt and resume

Known usage-limit text or structured quota codes produce wrapper exit 75 immediately. Generic HTTP 429s, capacity failures and malformed output still use the existing retry window. Reset strings are preserved literally; do not infer dates or time zones.

`interrupt` takes `{ "run": "<scratch>", "reason": "<actual reason>", "reset": "<reported reset or omit>", "resultFile": "<optional caller copy>" }`. It saves interrupted state and publishes the canonical result plus the exact authorized absolute caller destination, rejecting linked paths. Use the caller's established task scratch or temporary run folder. The wrapper publishes a canonical result on quota even without this follow-up. On orderly interruption, step 7 updates the index and reports completed work, unfinished operations and the resume command. Keep the task active and preserve all scratch and WIP.

Normal and interrupted results include `claudeEffort: state.claudeEffort`. The interrupted result adds `status: "interrupted"` and `resume: {checkpoint, phase, round, reason, reset, command}`. Its resume command inherits the saved effort without requiring the flag again. CI may be pending; green history applies only to its recorded head and does not approve WIP. On a normal final result set `resume: null`. Checkpoint the actual final status and reporting metadata before publication.

Resume with `$review-pr <N>` for automatic selection or `$review-pr <N> --resume "<run-path>"` for an exact continuation. A caller can instead be invoked again; it restores its own retained gates and delegates into this recovery procedure. No timer or automatic restart is scheduled.
