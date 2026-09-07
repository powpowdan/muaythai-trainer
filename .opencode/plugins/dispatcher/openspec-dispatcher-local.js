import {
  CODE_REVIEW_SUBAGENT_PROMPT,
  CODE_FIX_SUBAGENT_PROMPT,
  buildCodeReviewOrchestratorPrompt,
} from "../lib/code-review-prompt.js"
import { logEvent } from "../lib/telemetry.js"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// ============================================================================
// Prompt templates
// ============================================================================

const LOCAL_AGENT_IMPLEMENTATION_PROMPT = `You are implementing tasks from the OpenSpec change "{{CHANGE_NAME}}".

Your assigned task numbers: {{TASK_NUMBERS}}

Your working directory is an isolated git worktree at: \`{{WORKTREE_PATH}}\`. Do ALL of your work inside this worktree.

OpenSpec artifacts are at:
- Proposal: \`{{REPO_ROOT}}/openspec/changes/{{CHANGE_NAME}}/proposal.md\`
- Design: \`{{REPO_ROOT}}/openspec/changes/{{CHANGE_NAME}}/design.md\`
- Specs: \`{{REPO_ROOT}}/openspec/changes/{{CHANGE_NAME}}/specs/\`
- Tasks: \`{{REPO_ROOT}}/openspec/changes/{{CHANGE_NAME}}/tasks.md\`

Steps:
1. Read the proposal, design, and all spec files to understand the full context.
2. Read tasks.md to see the complete task list.
3. Implement ONLY the tasks with these numbers: {{TASK_NUMBERS}}. Skip all other tasks.
4. For each task you complete, update its checkbox in YOUR worktree's copy of tasks.md: \`- [ ]\` -> \`- [x]\`. Do not touch the main worktree's tasks.md.
5. Do NOT push branches, open PRs, run \`git push\`, or take any action outside this worktree. No remote operations.
6. When done, conclude your output with exactly one of:
   - \`STATUS: COMPLETE — <brief summary of what was implemented>\`
   - \`STATUS: BLOCKED — <reason you could not finish>\``

const LOCAL_CONFLICT_RESOLUTION_PROMPT = `You are a staff engineer resolving git merge conflicts. The dispatcher just attempted to merge worktree branch \`{{BRANCH_NAME}}\` (cluster {{CLUSTER_ID}} of change \`{{CHANGE_NAME}}\`) into main, and git reported conflicts.

Your working directory is the main worktree at \`{{REPO_ROOT}}\`. A \`git merge {{BRANCH_NAME}}\` is currently in progress and conflicted.

Steps:
1. Run \`git status\` to list conflicted files (paths under "Unmerged paths").
2. For EACH conflicted file:
   a. Read the full file. It contains conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`).
   b. Understand what "ours" (current main) and "theirs" (the worktree branch) are trying to do. The worktree branch implements cluster {{CLUSTER_ID}} whose tasks are: {{TASK_NUMBERS}}.
   c. Read the relevant spec files at \`{{REPO_ROOT}}/openspec/changes/{{CHANGE_NAME}}/specs/\` and design.md to understand intent if the conflict is semantic (not just textual).
   d. Resolve the conflict by producing the correct merged file. Prefer combining both sides when they touch different concerns. When they genuinely conflict (same lines, incompatible changes), pick the side that better matches the spec/design intent, or write a synthesis if neither is fully correct. Do NOT blindly pick "ours" or "theirs".
   e. Save the file with conflict markers removed.
   f. Run \`git add <path>\` to mark it resolved.
3. After all conflicts are resolved and staged, run \`git commit --no-edit\` to complete the merge commit (use git's default merge message).
4. Conclude with exactly one verdict line:
   - \`VERDICT: RESOLVED — <one-line summary of what was merged>\` — all conflicts resolved, merge committed.
   - \`VERDICT: UNRESOLVED — <reason>\` — a genuine semantic conflict you cannot confidently resolve. In this case run \`git merge --abort\` to roll back to pre-merge state BEFORE returning your verdict.

Do NOT push, do NOT open PRs, do NOT modify files outside the conflicted set. You are resolving conflicts only.`

const DISPATCHER_LOCAL_PROMPT = `You are the OpenSpec LOCAL ticket dispatcher. You manage a single dispatch run for the change "{{CHANGE_NAME}}" in repository at {{REPO_ROOT}}. You spawn implementation agents in isolated git worktrees, monitor their progress, run code review per completed worktree, MERGE passing worktrees into main (dispatching a conflict-resolution subagent on conflicts), then report and stop. You do NOT push, do NOT open PRs.

**CRITICAL RULES — VIOLATING ANY OF THESE IS A BUG:**
- Execute steps 1-7 in order. Do NOT skip steps. Do NOT summarize and stop early.
- Do NOT call \`gh\`, do NOT call \`git push\`, do NOT open PRs.
- All implementation work happens inside per-cluster worktrees at \`{{REPO_ROOT}}/.dispatch-worktrees/{{CHANGE_NAME}}/cluster-<N>\`.
- Step 6 MERGES passing worktrees into the main branch in your current working tree. This is intentional — you ARE supposed to modify main during step 6. Conflicts are handled by a subagent.
- After step 6 (merge) and step 7 (final report) are complete, stop.
- Do NOT read plugin source files. Your instructions are self-contained below.

**Configuration:**
- Repo root: {{REPO_ROOT}}
- Change name: {{CHANGE_NAME}}
- Cluster count: {{CLUSTER_COUNT}}
- Stale worktrees detected at startup: {{STALE_WORKTREE_COUNT}}
- Stale worktree paths (if any):
{{STALE_WORKTREE_PATHS}}

**Step 1: Handle stale worktrees (skip if STALE_WORKTREE_COUNT is 0)**

The plugin detected the stale worktree paths listed in the Configuration section above (from a prior interrupted run). Ask the user to choose exactly one:
- **Resume** — re-run code review on the existing worktrees WITHOUT spawning new implementation agents. Skip step 3 entirely; jump to step 4 with the existing worktrees treated as COMPLETE, then run code review (step 5) on them.
- **Delete** — for each path listed above, run \`git worktree remove --force <path>\` from the repo root to delete the worktree. (The plugin's telemetry observes this action automatically — you do not need to log anything.) After all paths are removed, proceed to step 2 normally.

The user MUST choose explicitly — do NOT pick for them, and do NOT offer an "ignore and spawn fresh" option (that would orphan the prior worktrees with undefined behavior).

**Step 2: Cluster summary (already computed by the plugin)**

The plugin has already clustered the tasks. Treat {{CLUSTER_COUNT}} clusters as the work plan. Each cluster has a 1-indexed number N (1 to {{CLUSTER_COUNT}}), a list of task numbers, and a summary label.

**Step 3: Spawn implementation agents in worktrees**

For each cluster N (1-indexed):
1. Create the worktree directory parent if it does not exist:
   \`mkdir -p {{REPO_ROOT}}/.dispatch-worktrees/{{CHANGE_NAME}}\`
2. Create the worktree with a fresh branch from current HEAD:
   \`git worktree add -b dispatch/{{CHANGE_NAME}}/cluster-{{N}} {{REPO_ROOT}}/.dispatch-worktrees/{{CHANGE_NAME}}/cluster-{{N}} HEAD\`
   If the worktree or branch already exists (e.g., resuming), skip creation and reuse it.
3. Spawn one Task subagent (subagent_type: "general") with the LOCAL_AGENT_IMPLEMENTATION_PROMPT filled in for cluster N. The agent's prompt MUST include the literal status line format. Track the spawn time.

Spawn all clusters' agents (do not serialize). The Task tool runs them concurrently.

**Step 4: Wait and parse implementation results**

Wait for all implementation subagents to return. For each result, scan the final output for a line matching the regex /^STATUS: (COMPLETE|BLOCKED) — (.+)$/ (anywhere in the output):
- COMPLETE: record worktree N as COMPLETE with the captured summary.
- BLOCKED: record worktree N as BLOCKED with the captured reason.
- No matching line: record worktree N as BLOCKED with reason "no status line in output".

**Step 5: Run code review on each COMPLETE worktree**

For each worktree whose implementation returned COMPLETE belonging to cluster N, spawn one Task subagent (subagent_type: "general") using the corresponding pre-computed code-review orchestrator prompt from the "LOCAL_CODE_REVIEW_ORCHESTRATOR_PROMPTS" section at the bottom of these instructions (copy the matching \`--- BEGIN CODE REVIEW PROMPT FOR CLUSTER N ---\` ... \`--- END ...\` block verbatim into the Task tool's \`prompt\` argument — do NOT improvise your own, and do NOT read plugin source). The orchestrator runs a 2-round review-fix loop:
- Round 1 review: if APPROVED, stop and mark \`codeReviewed = true\`.
- If NEEDS_CHANGES: fix subagent commits fixes to the worktree branch (commit-only, NO \`git push\`). Then round 2 review.
- Round 2 review: if APPROVED, mark \`codeReviewed = true\`. Otherwise stop after round 2 and leave \`codeReviewed = false\`.

Do NOT spawn a code-review subagent for BLOCKED worktrees.

Wait for each code-review orchestrator to return.

**Step 6: Merge passing worktrees into main (DO NOT SKIP)**

You will merge worktrees into the main branch one at a time, in topological order. The main branch in your current working tree is the merge target.

**Merge order (topological by depends-on):**
Sort the worktrees by dependency graph: a worktree whose cluster has \`dependsOn: [M, ...]\` MUST merge AFTER all clusters with ticketGroup in that list. Within an independent group (same topological level), merge in ticketGroup order. Use the cluster dependency metadata the plugin embedded in the configuration above; do not re-derive it.

**Merge loop — for each worktree in topological order:**

1. **Skip BLOCKED worktrees.** If the worktree's implementation returned STATUS: BLOCKED, do NOT attempt to merge it. Mark it as \`skipped-blocked\` in the report.

2. **Skip worktrees whose dependencies failed.** If any worktree this one depends on (per its dependsOn list) is in any of these states: \`skipped-blocked\`, \`conflict-unresolved\`, \`skipped-failed-dep\`, then this worktree is \`skipped-failed-dep\` — its dependencies are not in main, so merging it would be meaningless. Note it and move on.

3. **For all other worktrees (COMPLETE regardless of code-review verdict — gates are advisory per the spec):** attempt the merge:
   - Run \`git merge --no-ff dispatch/{{CHANGE_NAME}}/cluster-{{N}} -m "Merge cluster {{N}}: {{CONCEPT_KEY}}"\`
   - **If the merge succeeds (exit 0, no conflicts):** mark this worktree as \`merged\`.
   - **If the merge reports conflicts:** spawn one Task subagent (subagent_type: "general") with the LOCAL_CONFLICT_RESOLUTION_PROMPT filled in (worktree path, branch name, cluster ID, task numbers, repo root, change name). Wait for it to return and parse the verdict line:
     - \`VERDICT: RESOLVED — <summary>\`: the subagent already committed the merge. Mark this worktree as \`merged\`.
     - \`VERDICT: UNRESOLVED — <reason>\`: the subagent already ran \`git merge --abort\`. Mark this worktree as \`conflict-unresolved\` with the reason. Continue to the next worktree in the merge order.

4. **Commit policy:** each successful merge (clean or conflict-resolved) produces ONE commit on main. Do NOT squash across clusters — each cluster's merge is its own commit, preserving per-cluster history granularity.

5. **Never skip the loop.** Every spawned worktree must end up in exactly one of these states in the final report: \`merged\`, \`skipped-blocked\`, \`skipped-failed-dep\`, or \`conflict-unresolved\`.

**Step 7: Final report (DO NOT SKIP)**

Produce the final summary table (see Output Format below) and stop. Do NOT push. Do NOT open PRs. The merges have already happened on main during step 6.

**Output Format:**

\`\`\`
## Local Dispatch Complete — {{CHANGE_NAME}}

Spawned {{CLUSTER_COUNT}} agents across {{CLUSTER_COUNT}} worktrees.

### Results

| Cluster | Status | Code-Reviewed | Merged | Worktree | Summary |
|---------|--------|---------------|--------|----------|---------|
| tasks <t1>–<t2> | COMPLETE | yes | merged              | <path> | <summary> |
| tasks <t3>–<t4> | COMPLETE | no  | merged              | <path> | <code-review outstanding issues; merged anyway (gates advisory)> |
| tasks <t5>     | COMPLETE | yes | conflict-unresolved | <path> | <unresolved conflict reason> |
| tasks <t6>     | BLOCKED | n/a | skipped-blocked     | <path> | <implementation blocker reason> |
| tasks <t7>–<t8> | COMPLETE | yes | skipped-failed-dep | <path> | <depends on cluster N which was unresolved> |

### Main branch state

- Merged clusters: <count>
- Skipped (BLOCKED): <count>
- Skipped (failed dependency): <count>
- Conflict-unresolved: <count>

### Next Steps

Gates are advisory — failed-gate worktrees were merged anyway per design. Worktrees marked \`conflict-unresolved\` or \`skipped-*\` need manual attention:

- To retry a conflict-unresolved cluster: inspect \`git status\`, resolve the conflicts manually, run \`git commit\`, then re-invoke \`openspec-dispatch-local\` to handle remaining clusters.
- To inspect a BLOCKED worktree's partial work: \`cd <worktree-path> && git log --stat HEAD ^main\`.
- Worktrees you no longer need can be removed with \`git worktree remove <worktree-path>\`.
\`\`\`

**Error Handling:**
- On any subagent error: log it, treat that worktree as BLOCKED with reason "subagent error: <message>".
- Never silently skip a cluster — every spawned worktree must produce a row in the final report.
- Never continue past step 7. After reporting, stop.

**Agent Templates:**

LOCAL_AGENT_IMPLEMENTATION_PROMPT:
\`\`\`
${LOCAL_AGENT_IMPLEMENTATION_PROMPT}
\`\`\`

LOCAL_CONFLICT_RESOLUTION_PROMPT:
\`\`\`
${LOCAL_CONFLICT_RESOLUTION_PROMPT}
\`\`\`

LOCAL_CODE_REVIEW_ORCHESTRATOR_PROMPTS (one per cluster; pre-computed and transformed by the plugin — GitHub-only commands stripped, template variables filled. When you reach step 6 for cluster N, copy the matching block below verbatim into the Task tool's prompt argument. Do NOT edit it, do NOT improvise your own, do NOT read plugin source to look for it.):

{{CODE_REVIEW_PROMPTS}}`

// ============================================================================
// Helpers
// ============================================================================

function fillTemplate(template, vars) {
  let result = template
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, String(value))
  }
  return result
}

// Status line parser — task 4.1, 4.2. Returns { status, summary } or { status: "BLOCKED", reason }.
export function parseStatusLine(output) {
  if (typeof output !== "string" || output.length === 0) {
    return { status: "BLOCKED", reason: "no status line in output" }
  }
  const match = output.match(/^STATUS: (COMPLETE|BLOCKED) — (.+)$/m)
  if (!match) {
    return { status: "BLOCKED", reason: "no status line in output" }
  }
  const [, status, captured] = match
  if (status === "COMPLETE") {
    return { status: "COMPLETE", summary: captured }
  }
  return { status: "BLOCKED", reason: captured }
}

// Code review orchestrator verdict parser — task 6.4. Returns "approved" | "needs-revision".
export function parseCodeReviewVerdict(output) {
  if (typeof output !== "string") return "needs-revision"
  // The orchestrator returns a JSON-like block; look for `"status": "approved"` or status: "approved".
  const m = output.match(/"status"\s*:\s*"(approved|needs-revision)"/i)
  if (m) return m[1].toLowerCase()
  // Fallback: scan for the literal phrases.
  if (/status\s*[:=]\s*"?approved"/i.test(output)) return "approved"
  return "needs-revision"
}

// Conflict-resolution verdict parser. Returns "resolved" | "unresolved".
export function parseConflictVerdict(output) {
  if (typeof output !== "string") return "unresolved"
  const m = output.match(/^VERDICT:\s*(RESOLVED|UNRESOLVED)/im)
  if (!m) return "unresolved"
  return m[1].toUpperCase() === "RESOLVED" ? "resolved" : "unresolved"
}

// Topological sort of cluster records by their dependsOn graph.
// Each record is expected to have at minimum: { ticketGroup: number, dependsOn: number[], ... }.
// Returns a new array in merge order: dependencies first, then dependents; ties broken by ticketGroup.
// Records whose dependencies are not all present in the input (e.g. a dep was BLOCKED and omitted)
// are still emitted — the merge loop is responsible for skipping them via the failed-dep check.
export function topologicalSort(records) {
  const byGroup = new Map()
  for (const r of records) {
    byGroup.set(r.ticketGroup, r)
  }
  const visited = new Set()
  const result = []

  function visit(record) {
    if (visited.has(record.ticketGroup)) return
    visited.add(record.ticketGroup)
    for (const depGroup of record.dependsOn || []) {
      const dep = byGroup.get(depGroup)
      if (dep) visit(dep)
    }
    result.push(record)
  }

  // Stable order: visit in ticketGroup order so ties resolve to ascending cluster number.
  const sorted = [...records].sort((a, b) => a.ticketGroup - b.ticketGroup)
  for (const r of sorted) visit(r)
  return result
}

// ============================================================================
// Code review orchestrator: transform wrapper (tasks 6.1, 6.2, 6.3)
// ============================================================================

// applies the lib's prompt builder, fills template vars, then runs the local-mode
// string transform to strip GitHub-only commands. The lib file is NOT modified.
export function buildLocalCodeReviewOrchestratorPrompt(
  reviewer,
  fixer,
  { worktreePath, branchName, changeName, clusterId, repoRoot } = {},
) {
  // Step 1: assemble the base orchestrator prompt via the lib (unchanged).
  const basePrompt = buildCodeReviewOrchestratorPrompt(reviewer, fixer)

  // Step 2: fill the lib's template variables with local-mode values.
  let filled = basePrompt
    .replaceAll("{{PR_NUMBER}}", branchName)
    .replaceAll("{{PR_BRANCH}}", branchName)
    .replaceAll("{{ISSUE_NUMBER}}", `local-${clusterId}`)
    .replaceAll("{{REPO}}", repoRoot || "(local)")
    .replaceAll("{{ROUND_NUMBER}}", "1")

  // Step 3: apply the seven deterministic transforms from the design (D6.1).
  //
  // 3a. Orchestrator-level "add code-reviewed label" — both occurrences (round 1 and round 2 approve paths).
  //     Anchored on the backticks the lib wraps commands in, so repo paths with
  //     spaces (Windows/macOS user dirs) don't break the match (MEDIUM fix).
  filled = filled.replace(
    /`gh pr edit [^`]+ --add-label "code-reviewed"`/g,
    "Record `codeReviewed: true` in your final JSON output (the local dispatcher reads this from your return value; there is no PR label to set in local mode).",
  )

  // 3b. PR-comment failure step ("Add a comment to the PR: ...") — captured by the surrounding sentence.
  filled = filled.replace(
    /Add a comment to the PR:\s*"Code review failed after 2 rounds\. Outstanding issues require manual resolution\."/,
    "Include the outstanding findings in your final JSON output's `findings` field (no PR comment thread exists in local mode).",
  )

  // 3c. gh issue edit --add-label "status:needs-revision" — drop the call (no issue to label locally).
  //     The line is prefixed with "N. Add ..." in the lib; match just the gh issue edit substring.
  filled = filled.replace(
    /`gh issue edit [^`]+ --add-label "status:needs-revision"`/g,
    "(no-op in local mode: no GitHub issue to label)",
  )

  // 3d. gh issue edit --remove-label "status:ready-to-merge" — drop the call.
  filled = filled.replace(
    /`gh issue edit [^`]+ --remove-label "status:ready-to-merge"`/g,
    "(no-op in local mode: no GitHub issue to update)",
  )

  // 3e. gh issue edit --remove-assignee "@me" — drop the call.
  filled = filled.replace(
    /`gh issue edit [^`]+ --remove-assignee "@me"`/g,
    "(no-op in local mode: no GitHub issue assignee to clear)",
  )

  // 3f. In the embedded review sub-prompt: `gh pr diff {{PR_NUMBER}}` -> `git diff main..HEAD` from the worktree.
  filled = filled.replace(
    /Run:\s*`gh pr diff [^`]+`/,
    "From inside the worktree directory `" + (worktreePath || "<worktree-path>") + "`, run: `git diff main..HEAD`",
  )

  // 3g. In the embedded fix sub-prompt: `git push origin {{PR_BRANCH}}` -> commit-only on the worktree branch.
  // The fix sub-prompt contains a multi-line sequence: stage, commit, push. Replace the push with a no-op note.
  filled = filled.replace(
    /Push to the PR branch:\s*`git push origin [^`]+`/,
    "Do NOT push — there is no remote in local mode. Your commit on the worktree branch is sufficient; the re-review subagent will read the updated code from the same worktree.",
  )

  // Also strip the "push to the PR branch so the re-review subagent can see updated code" reminder at the bottom.
  filled = filled.replace(
    /The fix subagent MUST push to the PR branch so the re-review subagent can see updated code\./,
    "The fix subagent MUST commit to the worktree branch so the re-review subagent can see updated code (no push — local mode).",
  )

  // Normalize the fix sub-prompt's commit message format and strip any prose
  // "push to the PR branch" clause that survives the rule 3g transform above
  // (MEDIUM fix). The lib emits the commit message in TWO places with different
  // quote styles: code-fix.md uses backticks, code-review-prompt.js uses double
  // quotes (and appends "and push to the PR branch." as prose). Both should
  // normalize to `local-<clusterId>: address code review feedback` (no leading
  // `#` — there is no GitHub issue in local mode) with the push prose dropped.
  filled = filled.replace(
    /Commit with message:\s*(["`])#local-\S+: address code review feedback\1/g,
    (_match, quote) =>
      `Commit with message: ${quote}local-${clusterId}: address code review feedback${quote}`,
  )
  filled = filled.replace(/ and push to the PR branch\./g, ".")

  // Cleanup: collapse any triple-or-more blank lines left by the dropped lines above.
  filled = filled.replace(/\n{3,}/g, "\n\n")

  return filled
}

// ============================================================================
// Final report builder — tasks 8.1, 8.2
// Documents the report shape after the merge loop (step 7) runs. Each result
// record may carry a `mergeState` of: "merged", "conflict-unresolved",
// "skipped-blocked", or "skipped-failed-dep". Records without a mergeState
// (e.g. the report was built before step 7 ran) render the column as "pending".
// ============================================================================

export function buildFinalReport(changeName, results) {
  const rows = results.map((r) => {
    const cluster = r.taskNumbers?.length
      ? r.taskNumbers.length > 1
        ? `tasks ${r.taskNumbers[0]}–${r.taskNumbers[r.taskNumbers.length - 1]}`
        : `task ${r.taskNumbers[0]}`
      : `cluster-${r.cluster}`
    const status = r.status
    const codeReviewed = status === "COMPLETE" ? (r.codeReviewed ? "yes" : "no") : "n/a"
    const merged = r.mergeState || "pending"
    const summary = status === "COMPLETE" ? (r.summary || "") : (r.reason || "")
    return `| ${cluster} | ${status} | ${codeReviewed} | ${merged} | ${r.worktreePath} | ${summary} |`
  })

  const mergedCount = results.filter((r) => r.mergeState === "merged").length
  const skippedBlockedCount = results.filter((r) => r.mergeState === "skipped-blocked").length
  const skippedFailedDepCount = results.filter((r) => r.mergeState === "skipped-failed-dep").length
  const conflictUnresolvedCount = results.filter((r) => r.mergeState === "conflict-unresolved").length

  return `## Local Dispatch Complete — ${changeName}

Spawned ${results.length} agents across ${results.length} worktrees.

### Results

| Cluster | Status | Code-Reviewed | Merged | Worktree | Summary |
|---------|--------|---------------|--------|----------|---------|
${rows.join("\n")}

### Main branch state

- Merged clusters: ${mergedCount}
- Skipped (BLOCKED): ${skippedBlockedCount}
- Skipped (failed dependency): ${skippedFailedDepCount}
- Conflict-unresolved: ${conflictUnresolvedCount}

### Next Steps

Gates are advisory — failed-gate worktrees were merged anyway per design. Worktrees marked \`conflict-unresolved\` or \`skipped-*\` need manual attention:

- To retry a conflict-unresolved cluster: inspect \`git status\`, resolve the conflicts manually, run \`git commit\`, then re-invoke \`openspec-dispatch-local\` to handle remaining clusters.
- To inspect a BLOCKED worktree's partial work: \`cd <worktree-path> && git log --stat HEAD ^main\`.
- Worktrees you no longer need can be removed with \`git worktree remove <worktree-path>\`.

<!-- counts: merged=${mergedCount} skipped-blocked=${skippedBlockedCount} skipped-failed-dep=${skippedFailedDepCount} conflict-unresolved=${conflictUnresolvedCount} -->`
}

// ============================================================================
// Plugin definition
// ============================================================================

export default {
  id: "openspec-dispatcher-local",
  server: async ({ client, $, directory }) => {
    let dispatcherSessionID = null
    const spawnTimes = new Map()
    const results = []
    let changeName = null
    let repoRoot = null

    return {
      // Track implementation subagent spawn times for duration telemetry (task 9.1).
      "tool.execute.before": async (input) => {
        if (!dispatcherSessionID || input.sessionID !== dispatcherSessionID) return
        try {
          if (input.tool === "task" && input.args?.prompt) {
            const prompt = input.args.prompt
            if (prompt.startsWith("You are implementing tasks from the OpenSpec change")) {
              const clusterMatch = prompt.match(/cluster-(\d+)/)
              const clusterId = clusterMatch ? parseInt(clusterMatch[1]) : null
              spawnTimes.set(input.callID, { spawnTime: Date.now(), clusterId })
              if (clusterId !== null && changeName) {
                logEvent(
                  { event: "worktree_spawned", plugin: "dispatcher-local", cluster: clusterId, changeName },
                  directory,
                )
              }
            }
          }
        } catch {
          // telemetry is best-effort; never fail the dispatch over it
        }
      },

      "tool.execute.after": async (input, output) => {
        // ---- Trigger: skill invocation (tasks 2.1, 2.2, 2.3) ----
        if (input.tool === "skill" && input.args?.name === "openspec-dispatch-local") {
          // Task 2.3: explicit early return is implicit — the equality check above
          // means openspec-dispatch (GitHub mode) and other skills do not trigger us.
          dispatcherSessionID = input.sessionID

          try {
            // ---- Task 3.1: compute repo root, locate cluster-tasks.js ----
            const repoRootResult = await $`git rev-parse --show-toplevel`
            repoRoot = repoRootResult.stdout.trim()
            if (!repoRoot) {
              await client.tui.showToast({
                body: { message: "Could not determine repo root (not in a git repo?).", variant: "error" },
              })
              return
            }

            // ---- Task 3.1 cont: verify cluster-tasks.js exists ----
            const clusterTasksPath = resolve(dirname(fileURLToPath(import.meta.url)), "../lib/cluster-tasks.js")
            try {
              await $`node -e "if (!require('fs').existsSync(process.argv[1])) process.exit(1)" ${clusterTasksPath}`
            } catch {
              await client.tui.showToast({
                body: {
                  message: `cluster-tasks.js not found at ${clusterTasksPath}. The workflow repo must be present alongside this project for dispatch to work.`,
                  variant: "error",
                },
              })
              return
            }

            // ---- Determine change name (from skill args or most recent active change) ----
            changeName = input.args?.args?.[0] || input.args?.changeName
            if (!changeName) {
              try {
                const listRaw = await $`openspec list --json`
                const listText = listRaw.stdout || ""
                const listJsonMatch = listText.match(/\{[\s\S]*\}/)
                if (listJsonMatch) {
                  const list = JSON.parse(listJsonMatch[0])
                  const active = (list.changes || []).filter((c) => !c.name.startsWith("archive/"))
                  if (active.length > 0) {
                    active.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified))
                    changeName = active[0].name
                  }
                }
              } catch {
                // fall through to error below
              }
            }
            if (!changeName) {
              await client.tui.showToast({
                body: { message: "No active OpenSpec change found. Pass a change name to the skill.", variant: "error" },
              })
              return
            }

            // ---- Task 3.2: locate tasks.md, run cluster-tasks.js ----
            let tasksMdPath
            try {
              const statusRaw = await $`openspec status --change ${changeName} --json`
              const statusText = statusRaw.stdout || ""
              const jsonMatch = statusText.match(/\{[\s\S]*\}/)
              if (!jsonMatch) throw new Error("could not parse openspec status JSON")
              const status = JSON.parse(jsonMatch[0])
              const tasksArtifact = (status.artifacts || []).find((a) => a.id === "tasks")
              if (!tasksArtifact) throw new Error("tasks artifact not found in change status")
              tasksMdPath = `${repoRoot}/openspec/changes/${changeName}/${tasksArtifact.outputPath}`
            } catch (err) {
              await client.tui.showToast({
                body: { message: `Could not locate tasks.md for change "${changeName}": ${err.message}`, variant: "error" },
              })
              return
            }

            // ---- Task 3.2 cont: run clustering ----
            let clusters = []
            try {
              const clusterRaw = await $`node ${clusterTasksPath} ${tasksMdPath}`
              const clusterText = clusterRaw.stdout || ""
              const clusterJsonMatch = clusterText.match(/\[[\s\S]*\]/)
              if (clusterJsonMatch) {
                clusters = JSON.parse(clusterJsonMatch[0])
              }
            } catch (err) {
              await client.tui.showToast({
                body: { message: `cluster-tasks.js failed: ${err.message}`, variant: "error" },
              })
              return
            }

            // ---- Task 3.2 cont: empty-cluster early exit ----
            if (!Array.isArray(clusters) || clusters.length === 0) {
              await client.tui.showToast({
                body: { message: "No incomplete tasks. Nothing to dispatch.", variant: "info" },
              })
              return
            }

            // ---- Task 8.1: detect stale worktrees ----
            const worktreeDir = `${repoRoot}/.dispatch-worktrees/${changeName}`
            let staleWorktrees = []
            try {
              const globRaw = await $`node -e "const fs=require('fs'),p=require('path'),dir=process.argv[1],pre=process.argv[2];try{const m=fs.readdirSync(dir).filter(e=>e.startsWith(pre)).map(e=>p.join(dir,e));if(m.length)console.log(m.join('\\n'))}catch{}" ${worktreeDir} cluster-`
              const lines = (globRaw.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean)
              staleWorktrees = lines
            } catch {
              // glob failure = no stale worktrees, which is fine
            }

            if (staleWorktrees.length > 0) {
              // Surface to user; the injected prompt's Step 1 will ask the user to
              // choose resume vs. delete, and (if delete) run the worktree removal
              // commands themselves. The plugin only detects + reports here — it
              // does NOT remove worktrees on its own (HIGH 2 fix).
              await client.tui.showToast({
                body: {
                  message: `Detected ${staleWorktrees.length} stale worktree(s) from a prior run. The dispatcher will ask whether to resume or delete.`,
                  variant: "info",
                },
              })
            }

            // ---- Telemetry: dispatch_started (task 9.1) ----
            try {
              logEvent(
                {
                  event: "dispatch_started",
                  plugin: "dispatcher-local",
                  changeName,
                  clusterCount: clusters.length,
                  staleWorktreeCount: staleWorktrees.length,
                },
                directory,
              )
            } catch {
              // best-effort
            }

            // ---- HIGH 1 fix: pre-compute per-cluster code-review orchestrator prompts ----
            // The agent in the session cannot read plugin source (DISPATCHER_LOCAL_PROMPT
            // explicitly forbids it), so we build the wrapped code-review prompt for each
            // cluster here and embed it directly in the injected prompt. Each prompt has
            // its GitHub-only commands stripped and its worktree/branch/cluster context
            // baked in, ready to be copied verbatim into a Task subagent call in step 6.
            const codeReviewPrompts = clusters
              .map((cluster, idx) => {
                const clusterId = idx + 1
                const branchName = `dispatch/${changeName}/cluster-${clusterId}`
                const worktreePath = `${repoRoot}/.dispatch-worktrees/${changeName}/cluster-${clusterId}`
                try {
                  const prompt = buildLocalCodeReviewOrchestratorPrompt(
                    CODE_REVIEW_SUBAGENT_PROMPT,
                    CODE_FIX_SUBAGENT_PROMPT,
                    { worktreePath, branchName, changeName, clusterId, repoRoot },
                  )
                  return `--- BEGIN CODE REVIEW PROMPT FOR CLUSTER ${clusterId} ---\n${prompt}\n--- END CODE REVIEW PROMPT FOR CLUSTER ${clusterId} ---`
                } catch (err) {
                  return `--- BEGIN CODE REVIEW PROMPT FOR CLUSTER ${clusterId} ---\n(PLUGIN FAILED TO BUILD THIS PROMPT: ${err.message}. Spawn the code-review subagent with a clear note that the rubric is unavailable.)\n--- END CODE REVIEW PROMPT FOR CLUSTER ${clusterId} ---`
                }
              })
              .join("\n\n")

            // ---- Build and inject the dispatcher prompt ----
            const promptText = fillTemplate(DISPATCHER_LOCAL_PROMPT, {
              REPO_ROOT: repoRoot,
              CHANGE_NAME: changeName,
              CLUSTER_COUNT: String(clusters.length),
              STALE_WORKTREE_COUNT: String(staleWorktrees.length),
              STALE_WORKTREE_PATHS:
                staleWorktrees.length > 0
                  ? staleWorktrees.map((p) => `- ${p}`).join("\n")
                  : "(none)",
              CODE_REVIEW_PROMPTS: codeReviewPrompts,
            })

            await client.session.prompt({
              path: { id: input.sessionID },
              body: { parts: [{ type: "text", text: promptText }] },
            })

            await client.tui.showToast({
              body: {
                message: `Local dispatcher started for ${changeName}. ${clusters.length} cluster(s). No GitHub required.`,
                variant: "info",
              },
            })
          } catch (err) {
            await client.app.log({
              body: {
                service: "openspec-dispatcher-local",
                level: "error",
                message: `Startup failed: ${err.message}`,
              },
            })
            await client.tui.showToast({
              body: { message: `Local dispatcher startup failed: ${err.message}`, variant: "error" },
            })
          }
          return
        }

        // ---- Per-tool tracking inside the dispatcher session (telemetry + result capture) ----
        if (!dispatcherSessionID || input.sessionID !== dispatcherSessionID) return

        try {
          if (input.tool === "task" && input.args?.prompt) {
            const prompt = input.args.prompt

            // Implementation agent completed — capture status + telemetry.
            if (prompt.startsWith("You are implementing tasks from the OpenSpec change")) {
              const clusterMatch = prompt.match(/cluster-(\d+)/)
              const clusterId = clusterMatch ? parseInt(clusterMatch[1]) : null
              const worktreeMatch = prompt.match(/worktree at:\s*`([^`]+)`/)
              const worktreePath = worktreeMatch ? worktreeMatch[1] : null
              const taskNumbersMatch = prompt.match(/task numbers:\s*\*\*([^*]+)\*\*/)
              const taskNumbersStr = taskNumbersMatch ? taskNumbersMatch[1] : ""
              const taskNumbers = taskNumbersStr.split(/[,，]/).map((s) => s.trim()).filter(Boolean)

              const outputText = typeof output === "string" ? output : (output?.stdout || output?.text || "")
              const parsed = parseStatusLine(outputText)

              const spawnEntry = spawnTimes.get(input.callID)
              const eventData = {
                event: "worktree_completed",
                plugin: "dispatcher-local",
                cluster: clusterId,
                changeName,
                status: parsed.status,
              }
              if (spawnEntry) {
                eventData.duration_ms = Date.now() - spawnEntry.spawnTime
                spawnTimes.delete(input.callID)
              }
              try {
                logEvent(eventData, directory)
              } catch {
                // best-effort
              }

              results.push({
                cluster: clusterId,
                worktreePath,
                taskNumbers,
                status: parsed.status,
                summary: parsed.summary || null,
                reason: parsed.reason || null,
                codeReviewed: false,
              })
            }

            // Code review orchestrator completed — capture verdict + telemetry.
            if (prompt.includes("A code review has been requested for")) {
              const branchMatch = prompt.match(/PR #([^\s.(]+)/) || prompt.match(/branch\s+([^\s)]+)/)
              const branchIdentifier = branchMatch ? branchMatch[1] : null
              const outputText = typeof output === "string" ? output : (output?.stdout || output?.text || "")
              const verdict = parseCodeReviewVerdict(outputText)

              // Find the matching worktree record by branch identifier.
              const clusterMatch = branchIdentifier?.match(/cluster-(\d+)/)
              if (clusterMatch) {
                const clusterId = parseInt(clusterMatch[1])
                const record = results.find((r) => r.cluster === clusterId)
                if (record) {
                  record.codeReviewed = verdict === "approved"
                }
              }
              try {
                logEvent(
                  { event: "code_review_completed", plugin: "dispatcher-local", changeName, verdict, cluster: clusterMatch ? parseInt(clusterMatch[1]) : null },
                  directory,
                )
              } catch {
                // best-effort
              }
            }

            // Final report detection — the dispatcher's last message contains "Local Dispatch Complete".
            // We log dispatch_completed and show the toast (task 7.3, 9.1).
          }

          // Detect when the agent produces the final report. The report is emitted as a bash echo
          // or as message text; we hook on the agent's final assistant message via a heuristic:
          // when a bash command contains the literal report header, log dispatch_completed.
          if (input.tool === "bash" && input.args?.command && typeof input.args.command === "string") {
            const cmd = input.args.command
            if (cmd.includes("Local Dispatch Complete")) {
              const mergedCount = results.filter((r) => r.mergeState === "merged").length
              const skippedBlockedCount = results.filter((r) => r.mergeState === "skipped-blocked").length
              const conflictUnresolvedCount = results.filter((r) => r.mergeState === "conflict-unresolved").length
              try {
                logEvent(
                  {
                    event: "dispatch_completed",
                    plugin: "dispatcher-local",
                    changeName,
                    merged: mergedCount,
                    skippedBlocked: skippedBlockedCount,
                    conflictUnresolved: conflictUnresolvedCount,
                  },
                  directory,
                )
              } catch {
                // best-effort
              }
              await client.tui.showToast({
                body: {
                  message: `Local dispatch complete: ${mergedCount} MERGED, ${skippedBlockedCount} BLOCKED, ${conflictUnresolvedCount} CONFLICT-UNRESOLVED`,
                  variant: "info",
                },
              })
            }

            // ---- Task 8.3: detect user-chosen delete of stale worktrees ----
            if (cmd.includes("git worktree remove --force") && cmd.includes(".dispatch-worktrees")) {
              try {
                logEvent({ event: "stale_worktrees_deleted", plugin: "dispatcher-local", changeName }, directory)
              } catch {
                // best-effort
              }
            }
          }
        } catch (err) {
          try {
            await client.app.log({
              body: {
                service: "openspec-dispatcher-local",
                level: "warn",
                message: `Telemetry/tracking failed: ${err.message}`,
              },
            })
          } catch {
            // truly best-effort
          }
        }
      },
    }
  },
}

export {
  LOCAL_AGENT_IMPLEMENTATION_PROMPT,
  LOCAL_CONFLICT_RESOLUTION_PROMPT,
  DISPATCHER_LOCAL_PROMPT,
  fillTemplate,
}
