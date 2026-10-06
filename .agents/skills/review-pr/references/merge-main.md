# Merge origin/main into a branch

Every flow merges `main` with this one procedure: `$review-pr` step 1.7 before reviewing, `$implement-handoff` "Pull main", `$sync-review` when the remote branch moved, and `$merge-pr` gate 3. Work in `<checkout>`, the caller's checkout for the branch. The caller says which baseline applies and what to record (`$review-pr` sets `mainMerge` and checkpoints; callers without a baseline treat it as empty).

1. `git -C <checkout> fetch origin main` (Retry), and record the fetched SHA. If `git -C <checkout> merge-base --is-ancestor origin/main HEAD` succeeds, the branch is current (`mainMerge: current`); skip the remaining items.
2. If the merge would touch a file in the baseline (another session's uncommitted edits), never merge over it. Switch to a detached work tree (shared.md, Shared patterns) with an empty baseline, use it as `<checkout>` from now on, and merge there.
3. `git -C <checkout> merge origin/main --no-ff -m "🔀 merge(<scope>): sync <topic> with main"`. `<scope>` is the most common scope in the branch's recent commits. `<topic>` is the branch name without `codex/`, in words (`sync landmark details with main`). A branch with no commits of its own fast-forwards instead (`git merge --ff-only origin/main`).
4. **Resolve every conflict.** Never stop because a conflict is hard. Work one file at a time:
   - **Understand both sides first.** Read `git -C <checkout> log --oneline origin/main...HEAD -- <file>` and the commits behind each side. If `<main-checkout>/.plans/README.md` lists the branch, read that task's `handoff.md`.
   - **Combine both sides' intent.** Take one side wholesale only when the other is clearly superseded, and name the superseding commit.
   - **`pnpm-lock.yaml`:** take `main`'s version, then run `pnpm install --lockfile-only`.
   - **Generated data** (`apps/web/public/tiles/**`, `**/tiles.lock.json`, any pipeline output): never hand-merge it; regenerate it after every other file is resolved. For each conflicting `packages/content/cities/<slug>/tiles.lock.json`:
     1. Run `git -C <checkout> restore --theirs -- packages/content/cities/<slug>/tiles.lock.json`. This selects main's complete, valid lock so the pipeline can parse it.
     2. From the merged tree, run `pnpm data:build -- --city <slug>`, then `pnpm data:publish -- --city <slug>`. That publishes a release built from both sides' inputs and writes a fresh lock, or keeps main's lock when the outputs are unchanged.
     3. Stage the resulting lock as the resolution.

     Rebuild other pipeline output from the merged inputs the same way.
   - **Incompatible behaviors with no obvious winner:** decide, don't stop.
     - `main` is the baseline, because it's merged and reviewed. Reapply the branch's intent on top of it, guided by the branch's commits and handoff.
     - Keep both behaviors where the code allows it (both fields, both cases, both options). Otherwise keep `main`'s semantics and adapt the branch's change.
   - **Record judgment calls.** Every resolution beyond keeping both sides' lines or taking a clearly superseded side goes in a `Conflict decisions:` list in the merge commit body: `<file> — kept <what>, because <why>`.
5. Before committing:
   - **No conflict markers:** `git diff --check` passes, and the resolved files contain no `<<<<<<<`, `=======` or `>>>>>>>`.
   - **Tests:** run `pnpm run test --changed`, plus `pnpm --filter @atlas/<pkg> typecheck` for every package with a resolved file. Fix every failure the resolution causes and rerun. A failure that also happens on plain `origin/main` (check `gh run list --branch main`) isn't from the merge: note it for the report and continue.
   - **Commit** with the message from item 3, plus the `Conflict decisions:` body when there is one.
   - **Uncommitted files:** if git refused the merge because it would overwrite them, the caller's rules decide. Commit them as the task's WIP, or use a detached work tree.
6. A tool the resolution needs gets every fallback first: tippecanoe through Docker (`packages/data/README.md`), network steps through Retry. Abort only when it is still missing (no tippecanoe natively or in Docker, or no `gh` auth for `data:publish`):
   - Run `git merge --abort`.
   - End with `error` and stopReason `merge tool unavailable: <tool> — <files>` (`mainMerge: aborted`).

   A conflict alone is never a reason to abort.
7. `git push`, unless the caller pushes later (`$implement-handoff` pushes with the rest of the branch). Use Retry, and in a detached tree push with `git push origin HEAD:<branch>`. If the push is rejected because the remote moved, fetch, merge `origin/<branch>` and push again. Result: `mainMerge: merged`, or `resolved <n> files` when there were conflicts. List the `Conflict decisions:` in the caller's report.
