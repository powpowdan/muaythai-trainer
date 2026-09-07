---
name: openspec-dispatch
description: Start the OpenSpec ticket dispatcher. Continuously polls GitHub Issues, spawns parallel agents to implement tasks, reviews PRs, and auto-merges approved changes.
license: MIT
compatibility: Requires openspec CLI, gh CLI authenticated, GITHUB_TOKEN env var. GITHUB_OWNER/GITHUB_REPO are auto-detected from git remote if not set.
metadata:
  author: openspec
  version: "1.0"
  generatedBy: "1.4.1"
---

Start the OpenSpec ticket dispatcher for parallel multi-agent implementation.

**Prerequisites:**
1. `gh` CLI installed and authenticated (`gh auth status`)
2. `GITHUB_TOKEN` env var set (or `gh` auth provides it)
3. At least one OpenSpec change with tickets generated (run `/opsx-propose` first)

**Configuration (env vars, optional):**
- `DISPATCHER_POLL_INTERVAL` — seconds between polls (default: 30)
- `DISPATCHER_TIMEOUT_MINUTES` — agent timeout (default: 30)
- `DISPATCHER_MAX_CONCURRENT` — max parallel agents (default: 3)

**Steps**

1. **Validate prerequisites**
   ```bash
   gh auth status
   ```
   If `gh` is not authenticated, tell the user and STOP.

   Then auto-detect owner/repo from git remote (do NOT require env vars):
   ```bash
   git remote get-url origin
   ```
   Parse the URL to extract `GITHUB_OWNER` and `GITHUB_REPO`. If env vars `GITHUB_OWNER`/`GITHUB_REPO` are already set, prefer those; otherwise use the detected values. Do NOT tell the user these env vars are required.

2. **Show initial status**
   ```bash
   gh issue list --label "status:open" --json number,title,labels --search "label:openspec"
   gh issue list --label "status:in-progress" --json number,title
   gh issue list --label "status:pr-open" --json number,title
   gh issue list --label "status:merged" --json number,title
   ```
   Display ticket counts for each status.

3. **Start the dispatcher**
   The dispatcher plugin (`openspec-dispatcher.js`) will inject a detailed prompt into this session. Follow the prompt's instructions to:
   - Recover any orphaned tickets from previous sessions
   - Enter the main polling loop: claim tickets → spawn agents → monitor → **spec review** → **code review** → **merge** → archive
   - Display real-time progress as tickets move through the pipeline

   **Two-gate review pipeline:**
   The dispatcher enforces a three-stage review pipeline before any merge:
   1. **Step 4 — Spec review:** A subagent evaluates the PR diff against the spec files for the change. If the implementation matches the specs, the PR receives the `reviewed` label.
   2. **Step 4.5 — Code review:** A subagent evaluates full source files at staff-engineer depth (correctness, edge cases, error handling, security, performance, naming, patterns, meaningful test coverage). It runs a 2-round fix loop: if issues are found, fixes are applied and pushed to the PR branch, then the code is re-evaluated. If the code passes, the PR receives the `code-reviewed` label. If issues persist after 2 rounds, the issue moves to `status:needs-revision`.
   3. **Step 5 — Merge:** The merge gate plugin (`merge-gate.js`) enforces that the PR has **all three** labels — `reviewed`, `approved`, AND `code-reviewed` — before allowing a merge via `gh pr merge`. If any label is missing, the merge is blocked.

4. **Stopping the dispatcher**
   Press Ctrl+C to stop. Any in-progress tickets will be recovered on next startup.

**Output**

```
## OpenSpec Dispatcher Started

**GitHub user:** @username
**Repository:** owner/repo
**Config:** poll=30s, timeout=30m, maxAgents=3

**Current tickets:**
- Open: 5
- In Progress: 0
- PR Open: 2
- Merged: 3

Starting polling loop...
```

**Guardrails**
- Only one dispatcher should run at a time per repository
- The "approved" label is only for PRs (added by review subagents) — it is NEVER required on issues
- The "code-reviewed" label is only for PRs (added by the code review subagent after passing Step 4.5)
- Issues are claimed based on "openspec" + "status:open" labels only
- Blocked tickets require human intervention before retrying
- The dispatcher will auto-archive changes when all tickets are merged
- The merge gate (`merge-gate.js`) blocks `gh pr merge` unless the PR has `reviewed`, `approved`, AND `code-reviewed` labels
