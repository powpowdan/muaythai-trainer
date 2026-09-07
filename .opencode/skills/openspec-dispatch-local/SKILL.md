---
name: openspec-dispatch-local
description: Dispatch OpenSpec change tasks to parallel agents in isolated git worktrees without GitHub. Runs code review per worktree, then auto-merges passing worktrees into main in topological order (with a conflict-resolution subagent on conflicts).
license: MIT
compatibility: opencode
metadata:
  author: openspec
  version: "1.2"
---

Dispatch OpenSpec change tasks to parallel agents in isolated git worktrees, run code review per worktree, then auto-merge passing worktrees into main in topological order. Conflicts during merge trigger a conflict-resolution subagent that resolves them (or aborts cleanly if unresolvable). No GitHub required.

**Input**: Change name (e.g., `openspec-dispatch-local my-change`). If omitted, infers from the most recently modified active change.

**Prerequisites:**
1. `git` available on PATH
2. The current directory is inside a git repository
3. At least one OpenSpec change with incomplete tasks in `tasks.md`

**No GitHub required.** This skill does NOT call `gh`, does NOT require `GITHUB_TOKEN`, does NOT require a configured remote, and does NOT contact any external service. It runs entirely against local git and the OpenSpec artifacts on disk. Use this skill when GitHub is unavailable (no `gh` CLI installed, offline, no remote, expired token, rate-limited) or when you simply prefer a local dispatch flow.

**Invocation:** This skill is invoked directly by name — it is NOT a slash command. Call it via the skill-loading mechanism in your runtime (e.g., the Skill tool). It does not auto-redirect from the existing `openspec-dispatch` (GitHub mode) skill; the user consciously picks this skill when they want local mode.

## Steps

1. **Resolve the repo root**

   Run via Bash:
   ```
   git rev-parse --show-toplevel
   ```
   Save the output as `<repo-root>`.

2. **Verify cluster-tasks.js exists**

   The plugin resolves `cluster-tasks.js` relative to its own install location (`../lib/cluster-tasks.js`). If it is missing, the plugin aborts with a clear error message.

3. **Detect stale worktrees from prior runs**

   Check whether `<repo-root>/.dispatch-worktrees/<change-name>/cluster-*` already exists (glob). If any matching directories exist, surface them as "stale worktrees from a prior run" and ask the user to choose exactly one of:
   - **Resume** — re-run spec and code review on the existing worktrees; do not spawn new implementation agents.
   - **Delete** — run `git worktree remove --force <path>` for each, then start a fresh dispatch.

   Do NOT offer an "ignore and spawn fresh" option — that would orphan prior worktrees with undefined behavior. If no stale worktrees exist, proceed to step 4.

4. **Get the tasks.md path**

   Run:
   ```
   openspec status --change "<name>" --json
   ```
   Parse the JSON (ignore any `- Loading...` log lines emitted before the JSON object) and find the resolved path for the `tasks` artifact.

5. **Cluster the tasks**

   The plugin invokes `cluster-tasks.js` (resolved in step 2, relative to its own install location — not a literal `<repo-root>/shared/lib/...` or `<repo-root>/.opencode/plugins/lib/...` path) against `<tasks.md-path>`. This returns JSON with clusters — each cluster has a list of task numbers and a summary label. If the array is empty (all tasks already complete), display a toast "No incomplete tasks" and stop without spawning agents.

6. **Display cluster summary and confirm**

   Show the user:
   - Number of clusters identified
   - Tasks per cluster (task numbers + summary)
   - Total pending tasks

   Ask the user to confirm before spawning agents.

7. **Spawn implementation agents in isolated worktrees**

   For each cluster (1-indexed N):
   - Create a worktree at `<repo-root>/.dispatch-worktrees/<change-name>/cluster-<N>` via `git worktree add -b dispatch/<change-name>/cluster-<N> <path> HEAD`.
   - Spawn one implementation Task subagent (subagent_type: "general") with its working directory set to the worktree path. The agent's prompt:

     ---
     You are implementing tasks from the OpenSpec change **"<change-name>"**.

     Your assigned task numbers: **<comma-separated task numbers>**

     Your working directory is an isolated git worktree at: `<worktree-path>`. Do ALL of your work inside this worktree.

     OpenSpec artifacts are at:
     - Proposal: `<repo-root>/openspec/changes/<change-name>/proposal.md`
     - Design: `<repo-root>/openspec/changes/<change-name>/design.md`
     - Specs: `<repo-root>/openspec/changes/<change-name>/specs/`
     - Tasks: `<repo-root>/openspec/changes/<change-name>/tasks.md`

     Steps:
     1. Read the proposal, design, and all spec files to understand the full context.
     2. Read tasks.md to see the complete task list.
     3. Implement ONLY the tasks with these numbers: <task numbers>. Skip all other tasks.
     4. For each task you complete, update its checkbox in YOUR worktree's copy of tasks.md: `- [ ]` → `- [x]`. Do not touch the main worktree's tasks.md.
     5. Do NOT push branches, open PRs, run `git push`, or take any action outside this worktree. No remote operations.
     6. When done, conclude your output with exactly one of:
        - `STATUS: COMPLETE — <brief summary of what was implemented>`
        - `STATUS: BLOCKED — <reason you could not finish>`
     ---

8. **Wait and parse results**

   Wait for all agents to finish. For each agent result, scan the final output for a line matching `/^STATUS: (COMPLETE|BLOCKED) — (.+)$/`. Record the worktree as COMPLETE (with summary) or BLOCKED (with reason). If no status line is found, record as BLOCKED with reason "no status line in output".

9. **Run code review on each COMPLETE worktree**

   For each worktree whose implementation returned STATUS: COMPLETE, spawn a code-review orchestrator subagent using the locally-wrapped variant of the lib's review prompt. The orchestrator runs a 2-round review-fix loop:
   - Round 1: review subagent evaluates full source files in the worktree. If APPROVED, stop.
   - If NEEDS_CHANGES: fix subagent applies fixes as commits on the worktree branch (commit-only, no push).
   - Round 2: re-review. If APPROVED, stop. Otherwise stop after round 2.

   Parse the orchestrator's final verdict. Mark `codeReviewed: true` if APPROVED; leave `false` if NEEDS_REVISION after 2 rounds. Do NOT spawn a code-review subagent for BLOCKED worktrees.

10. **Merge passing worktrees into main (topological order, with conflict-resolution subagent)**

    Compute the merge order via topological sort of the clusters' `dependsOn` graph: dependencies first, then dependents; ties broken by ascending ticketGroup number.

    For each worktree in merge order:
    - **Skip BLOCKED worktrees** — they have no complete implementation. Mark them `skipped-blocked`.
    - **Skip worktrees whose dependencies failed** — if any worktree in this one's `dependsOn` list is in `skipped-blocked`, `conflict-unresolved`, or `skipped-failed-dep` state, mark this one `skipped-failed-dep` and continue.
    - **Merge all other worktrees** (gates are advisory — failed code review does NOT block merge):
      - Run `git merge --no-ff dispatch/<change-name>/cluster-<N> -m "Merge cluster <N>: <concept-key>"`
      - If clean: mark as `merged`.
      - If conflicts: spawn a conflict-resolution subagent (prompt below) that operates in the main worktree. It reads `git status`, resolves each conflicted file (consulting the specs/design for semantic conflicts), runs `git add` + `git commit --no-edit`. Returns `VERDICT: RESOLVED` or `VERDICT: UNRESOLVED`. On UNRESOLVED the subagent runs `git merge --abort` itself; mark the worktree `conflict-unresolved` and continue to the next.

    Each successful merge is its own commit on main — no cross-cluster squashing.

11. **Report completion**

    Output a summary table listing each worktree with: cluster task numbers, status, gate status (`code-reviewed`), merged state (`merged`/`skipped-blocked`/`skipped-failed-dep`/`conflict-unresolved`), worktree path, and summary or reason. Append a "Main branch state" section with counts and a "Next Steps" section with retry guidance for unresolved/skipped clusters.

    Do NOT push. Do NOT open PRs. The merges have already happened on main during step 11.

## Conflict-Resolution Subagent Prompt

When step 11 spawns a conflict-resolution subagent, its prompt is:

---
You are a staff engineer resolving git merge conflicts. The dispatcher just attempted to merge worktree branch `<branch-name>` (cluster <N> of change `<change-name>`) into main, and git reported conflicts.

Your working directory is the main worktree at `<repo-root>`. A `git merge <branch-name>` is currently in progress and conflicted.

Steps:
1. Run `git status` to list conflicted files (paths under "Unmerged paths").
2. For EACH conflicted file:
   a. Read the full file. It contains conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`).
   b. Understand what "ours" (current main) and "theirs" (the worktree branch) are trying to do.
   c. Read the relevant spec files and design.md if the conflict is semantic.
   d. Resolve by producing the correct merged file. Prefer combining both sides; when they genuinely conflict, pick the side that matches spec intent, or write a synthesis. Do NOT blindly pick "ours" or "theirs".
   e. Save the file with conflict markers removed.
   f. Run `git add <path>`.
3. After all conflicts resolved and staged, run `git commit --no-edit`.
4. Conclude with exactly one verdict line:
   - `VERDICT: RESOLVED — <one-line summary>`
   - `VERDICT: UNRESOLVED — <reason>` — and run `git merge --abort` BEFORE returning.

Do NOT push, do NOT open PRs, do NOT modify files outside the conflicted set.
---

## Output Format

```
## Local Dispatch Complete — <change-name>

Spawned <N> agents across <N> worktrees.

### Results

| Cluster | Status | Code-Reviewed | Merged | Worktree | Summary |
|---------|--------|---------------|--------|----------|---------|-
| tasks 1–4 | COMPLETE | yes | merged              | /path/cluster-1 | Implemented X and Y |
| tasks 5–8 | COMPLETE | no  | merged              | /path/cluster-2 | Code review found 2 issues; merged anyway (gates advisory) |
| tasks 9   | COMPLETE | yes | conflict-unresolved | /path/cluster-3 | Genuine semantic conflict in src/auth.ts |
| tasks 10  | BLOCKED | n/a | skipped-blocked     | /path/cluster-4 | Could not resolve Z |
| tasks 11–13 | COMPLETE | yes | skipped-failed-dep | /path/cluster-5 | Depends on cluster-3 (conflict-unresolved) |

### Main branch state

- Merged clusters: 2
- Skipped (BLOCKED): 1
- Skipped (failed dependency): 1
- Conflict-unresolved: 1

### Next Steps

Gates are advisory — failed-gate worktrees were merged anyway per design. Worktrees marked `conflict-unresolved` or `skipped-*` need manual attention:

- To retry a conflict-unresolved cluster: inspect `git status`, resolve the conflicts manually, run `git commit`, then re-invoke `openspec-dispatch-local` to handle remaining clusters.
- To inspect a BLOCKED worktree's partial work: `cd <worktree-path> && git log --stat HEAD ^main`.
- Worktrees you no longer need can be removed with `git worktree remove <worktree-path>`.
```

## Design Notes

### Why worktree-based coordination instead of GitHub Issues

The existing OpenCode `openspec-dispatch` skill uses GitHub Issues as its coordination layer: agents claim tickets atomically via labels, open branches, and open PRs that go through review before merge. This requires `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`, the `gh` CLI, and adds external dependencies (rate limits, PR review queue, label management). When GitHub is unavailable, the skill is dead.

Worktrees solve the underlying problem — parallel agents need isolated write surfaces — without any external coordination. Each agent gets its own filesystem, its own index, its own HEAD. No CWD contention, no label races, no API calls. The Claude Code port (`.claude/skills/openspec-dispatch/SKILL.md`) independently arrived at this design.

### Why the skill auto-merges (with conflict-resolution subagent)

The original "leave it for the user to merge" choice (Path C) maximized user audit but added friction: N manual merges, manual conflict resolution. The auto-merge loop with a conflict-resolution subagent provides equivalent audit (the subagent reads both sides and consults the spec/design) with less user toil. Each cluster is its own merge commit, preserving per-cluster history granularity; the user can `git reset` a single bad merge without affecting others. Unresolvable conflicts abort cleanly (`git merge --abort`) and the loop continues — already-merged clusters stay merged.

### Why gates are soft (advisory) rather than enforced

Hard gate enforcement in local mode would require either intercepting `git merge` (fragile — `git merge` is a common command), filesystem quarantine of un-gated worktrees (complex choreography), or trust in user compliance with prompt instructions. None of these add real value: the report IS the enforcement. The auto-merge loop honors this — failed-gate worktrees are still merged (their unresolved findings are noted in the report). Users who want hard gates can stay on GitHub mode (where `merge-gate.js` enforces them on `gh pr merge`).

### How this differs from the other dispatch skills

| Aspect | OpenCode `openspec-dispatch` (GitHub) | OpenCode `openspec-dispatch-local` (this skill) | Claude Code `openspec-dispatch` |
|--------|--------------------------------------|------------------------------------------------|--------------------------------|
| Coordination | GitHub Issues + PRs + labels | git worktrees (no external service) | git worktrees (no external service) |
| Review pipeline | Spec review + code review (PR-label gates) | Code review (advisory gate report) | None — user reviews diffs only |
| Gates | Hard-enforced via `merge-gate.js` | Soft (advisory; reported in summary) | None |
| Merge | Auto-merge after gates pass | Auto-merge in topological order, conflict-resolution subagent handles conflicts | Manual — user merges each worktree |
| Dependencies | `gh` CLI, `GITHUB_TOKEN`, remote | git only | git only |
| Crash recovery | Issues persist on GitHub; re-claim on restart | Worktrees persist on disk; resume option offered | Worktrees persist on disk; manual inspection |

A future iteration could add a single-line hint to the GitHub-mode skill's failure output pointing users here; see open question in `design.md`.
