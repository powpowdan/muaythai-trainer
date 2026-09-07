import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))

const CODE_REVIEW_SUBAGENT_PROMPT = readFileSync(join(__dirname, "../prompts/auto-code-review.md"), "utf-8").trimEnd()

const CODE_FIX_SUBAGENT_PROMPT = readFileSync(join(__dirname, "../prompts/code-fix.md"), "utf-8").trimEnd()

function buildCodeReviewOrchestratorPrompt(reviewer, fixer) {
  return `A code review has been requested for PR #{{PR_NUMBER}} (issue #{{ISSUE_NUMBER}}). You must orchestrate a 2-round review-fix loop.

**MAXIMUM 2 ROUNDS. After 2 rounds, you MUST stop and return a final verdict.**

**CRITICAL — STOP CONDITIONS:**
- If the review subagent returns verdict APPROVED at ANY point, STOP IMMEDIATELY. Do NOT launch another review round. Do NOT launch a fix subagent. Apply the approval actions described below.
- After round 2, regardless of the verdict, STOP and return the final outcome.

Do the following:

ROUND 1:
- Use the Task tool to launch a REVIEW subagent (subagent_type: "general") with this prompt:

---
${reviewer}
---

- Wait for the subagent to return. Note the verdict (APPROVED, NEEDS_CHANGES, or NEEDS_MAJOR_CHANGES) and the findings.

- **If verdict is APPROVED**: STOP. Execute these actions:
  1. Add "code-reviewed" label to the PR: \`gh pr edit {{PR_NUMBER}} --repo {{REPO}} --add-label "code-reviewed"\`
  2. Return to me: status "approved", no fixes applied, the review summary.

- **If verdict is NEEDS_CHANGES or NEEDS_MAJOR_CHANGES**: proceed to fix phase.

FIX PHASE (between rounds):
- Use the Task tool to launch a FIX subagent (subagent_type: "general") with this prompt:

---
${fixer}
---

(Replace {{REVIEW_FINDINGS}} with the actual findings returned by the review subagent — copy them verbatim.)

- Wait for the fix subagent to return. The fix subagent will commit with message "#{{ISSUE_NUMBER}}: address code review feedback" and push to the PR branch.

ROUND 2:
- Launch another REVIEW subagent with the same prompt but with "Round 2" in the prompt text instead of "Round 1".
- Wait for it to return. Note the verdict.

- **If verdict is APPROVED**: STOP. Execute these actions:
  1. Add "code-reviewed" label to the PR: \`gh pr edit {{PR_NUMBER}} --repo {{REPO}} --add-label "code-reviewed"\`
  2. Return to me: status "approved", summary of both rounds.

- **If verdict is NEEDS_CHANGES or NEEDS_MAJOR_CHANGES**: STOP. Execute these failure actions:
  1. Add a comment to the PR: "Code review failed after 2 rounds. Outstanding issues require manual resolution."
  2. Add "status:needs-revision" label to the linked issue: \`gh issue edit {{ISSUE_NUMBER}} --repo {{REPO}} --add-label "status:needs-revision"\`
  3. Remove "status:ready-to-merge" label from the linked issue: \`gh issue edit {{ISSUE_NUMBER}} --repo {{REPO}} --remove-label "status:ready-to-merge"\`
  4. Clear the issue assignee so the dispatcher can re-assign it: \`gh issue edit {{ISSUE_NUMBER}} --repo {{REPO}} --remove-assignee "@me"\`
  5. Return to me: status "needs-revision", the outstanding findings from round 2, and note that manual intervention is required.

**FINAL OUTPUT FORMAT:**
Return a JSON-like block with:
- status: "approved" or "needs-revision"
- rounds_completed: 1 or 2
- final_verdict: the last review verdict
- findings: the findings from the last round (empty if approved)
- summary: brief summary of the review outcome

IMPORTANT:
- Do NOT read any files yourself. Do NOT run git diff yourself. Do NOT review or fix the code yourself. All reading, reviewing, and fixing happens inside subagents. You only orchestrate and apply label/comment actions.
- Do NOT exceed 2 rounds. Even if round 2 has minor issues, stop and return the verdict.
- The fix subagent MUST push to the PR branch so the re-review subagent can see updated code.`
}

export {
  CODE_REVIEW_SUBAGENT_PROMPT,
  CODE_FIX_SUBAGENT_PROMPT,
  buildCodeReviewOrchestratorPrompt,
}
