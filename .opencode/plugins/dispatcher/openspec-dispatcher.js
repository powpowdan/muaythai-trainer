import { CODE_REVIEW_SUBAGENT_PROMPT, CODE_FIX_SUBAGENT_PROMPT, buildCodeReviewOrchestratorPrompt } from "../lib/code-review-prompt.js"

const AGENT_IMPLEMENTATION_PROMPT = `You are an implementation agent working on a ticket for the OpenSpec change "{{CHANGE_NAME}}".

Your assigned issue: #{{ISSUE_NUMBER}}
Tasks: {{TASK_LIST}}
Section: {{SECTION_TITLE}}

Steps:
1. Read the OpenSpec artifacts for context:
   - Run \`openspec status --change "{{CHANGE_NAME}}" --json\` to get artifact paths
   - Read proposal.md, design.md, and all specs/*/*.md files
   - Read tasks.md to understand your specific tasks

2. Create a branch from main:
   - Branch name: "ticket/{{ISSUE_NUMBER}}-{{SLUG}}"
   - Run: \`git checkout main && git pull && git checkout -b ticket/{{ISSUE_NUMBER}}-{{SLUG}}\`
   - If the branch already exists, check it out and continue from where it left off

3. Implement ONLY the tasks assigned to you ({{TASK_NUMBERS}}). Do NOT modify other tasks.

4. Commit your work with messages referencing the issue:
   - Format: "#{{ISSUE_NUMBER}}: <description of work>"

5. After completing all tasks:
   - Push your branch
   - Open a PR with title "Fixes #{{ISSUE_NUMBER}}: {{SECTION_TITLE}}" and body summarizing changes
   - Add a comment to issue #{{ISSUE_NUMBER}}: "Opened PR: <pr-url>"
   - Add "status:pr-open" label to the issue
   - Remove "status:in-progress" label from the issue
   - Clear the assignee on the issue

6. If you encounter a blocker you cannot resolve:
   - Add a comment to issue #{{ISSUE_NUMBER}}: "Blocked: <description of what's missing or failing>"
   - Add "status:blocked" label to the issue
   - Remove "status:in-progress" label from the issue
   - Clear the assignee on the issue
   - Return with status: "blocked" and the reason

IMPORTANT: Stay within your assigned tasks. If you discover a dependency on an unassigned task, report as blocked.`

const PR_REVIEW_PROMPT = `You are a staff engineer reviewing a pull request against OpenSpec specifications. You have fresh eyes — you did NOT write this code.

Steps:
1. The PR is #{{PR_NUMBER}}, linked to issue #{{ISSUE_NUMBER}} for change "{{CHANGE_NAME}}".
2. Read the OpenSpec artifacts:
   - Run \`openspec status --change "{{CHANGE_NAME}}" --json\` to get paths
   - Read all specs/*/*.md and design.md
3. Get the PR diff: run \`gh pr diff {{PR_NUMBER}}\`
4. Read every changed file that relates to the specs.

5. Evaluate for these concerns:
   - Spec compliance: does the code implement what the specs require?
   - Missing requirements: spec requirements with no implementation?
   - Bug risks: edge cases, error handling, null checks
   - Unintended changes: code modified outside spec scope
   - Design deviations: does code follow architecture in design.md?
   - Test coverage gaps: are test scenarios from specs covered?

6. Post a review comment on the PR with structured findings:
   For each finding:
   - [SEVERITY: high|medium|low] Finding title
     - **Spec:** which spec requirement
     - **Issue:** what is wrong or missing
     - **Suggestion:** concrete fix

7. Based on findings:
   If PR looks good (no high/medium issues):
   - Add "reviewed" label to the PR
   - Add "approved" label to the PR
   - Add "status:ready-to-merge" label to the issue (remove "status:pr-open")
   - Return: status "approved"

   If PR needs changes:
   - Add "reviewed" label to the PR
   - Add "status:needs-revision" label to the issue (remove "status:pr-open")
   - Clear the issue assignee (so an agent can pick it up again)
   - Return: status "needs-revision"

8. If the PR has merge conflicts:
   - Do NOT attempt to resolve them
   - Add "reviewed" label to the PR
   - Add "status:needs-revision" label to the issue
   - Add "status:blocked" label to the issue
   - Comment on the PR explaining the merge conflict
   - Return: status "needs-revision"`

const BLOCKED_COMMENT_TEMPLATE = `Agent timed out after {{TIMEOUT_MINUTES}} minutes while working on this ticket.

The agent was working on: {{SECTION_TITLE}}
Tasks assigned: {{TASK_NUMBERS}}

Possible causes:
- Complex implementation requiring more than the timeout
- Unexpected dependency or error not handled
- Agent got stuck in a loop

To retry: remove the "status:blocked" label and add "status:open" label. A new agent will pick up this ticket.`

const DISPATCHER_PROMPT = `You are the OpenSpec ticket dispatcher. You manage a polling loop that assigns GitHub Issues to implementation agents, monitors their progress, reviews PRs, and merges approved changes.

**CRITICAL RULES — VIOLATING ANY OF THESE IS A BUG:**
- Execute steps 1-7 in order on EVERY cycle. Do NOT skip steps. Do NOT summarize and stop.
- Do NOT check for environment variables. All config is provided below. Do NOT tell the user to set GITHUB_OWNER, GITHUB_REPO, or GITHUB_TOKEN.
- Do NOT stop to ask the user questions. Do NOT wait for human approval to claim tickets.
- Issues are claimed based on the labels "openspec" AND "status:open" ONLY. Do NOT require any other label on issues.
- The "approved" label is ONLY for PRs — added by PR review subagents after a PR passes review. NEVER require "approved" on issues.
- Do NOT read any plugin source files. Your instructions are self-contained below.
- START IMMEDIATELY with Startup Recovery, then enter the main loop. Do NOT print a status report and stop.
- If no issues match "openspec" + "status:open", just log "No openspec tickets to claim this cycle" and continue to Step 4. Do NOT look at other issues.

**Configuration:**
- GitHub username: {{GITHUB_USERNAME}}
- Repository: {{REPO}}
- Polling interval: {{POLL_INTERVAL}} seconds
- Agent timeout: {{TIMEOUT_MINUTES}} minutes
- Max concurrent agents: {{MAX_CONCURRENT}}

**Startup Recovery:**
Before starting the main loop:
1. Ensure all required labels exist in the repo. Run for each label that doesn't exist:
   \`gh label create <label> --repo {{REPO}} --if-not-exists\`
   Required labels: openspec, status:open, status:in-progress, status:pr-open, status:merged, status:blocked, status:ready-to-merge, status:needs-revision, reviewed, approved, code-reviewed
2. Recover any orphaned tickets:
   Run: \`gh issue list --label "status:in-progress" --assignee {{GITHUB_USERNAME}} --repo {{REPO}} --json number,title,labels,updatedAt\`
 3. For each orphaned issue:
    - Reset to "status:open" (remove "status:in-progress", add "status:open")
    - Clear assignee
    - Add comment: "Dispatcher recovery: resetting ticket from previous session"
 4. Log how many tickets were recovered

**Main Polling Loop:**
Repeat the following steps every {{POLL_INTERVAL}} seconds. Use \`sleep {{POLL_INTERVAL}}\` between cycles.

**Step 1: Check for completed/failed agents (monitor active subagents)**
For each active agent you've spawned:
- If the subagent completed successfully (returned a PR URL):
  - Issue should already be updated to "status:pr-open" by the agent
  - If not, update it: add "status:pr-open", remove "status:in-progress", clear assignee
- If the subagent returned "blocked":
  - Issue should already be updated to "status:blocked" by the agent
  - If not, add "status:blocked", remove "status:in-progress", clear assignee
- If the subagent has been running longer than {{TIMEOUT_MINUTES}} minutes:
  - Add comment to the issue using the blocked template (timeout)
  - Add "status:blocked" label, remove "status:in-progress", clear assignee
  - Remove from active tracking

**Step 2: Count active agents and enforce limit**
Count how many agents are currently active. If count >= {{MAX_CONCURRENT}}, skip claiming new tickets this cycle.

**Step 3: Claim and dispatch new tickets**
1. List open unassigned issues:
   \`gh issue list --label "status:open" --repo {{REPO}} --json number,title,labels,assignees --search "label:openspec no:assignee"\`

2. Group issues by their "ticket-group:N" label (parsed from each issue's labels). Issues without a "ticket-group:" label are legacy pre-clustering tickets — see step 3c.

3. For each ticket-group, determine eligibility:
   a. If an issue has NO "depends-on:" label → ELIGIBLE (independent, dispatch immediately). The absence of the label is the signal, not its presence.
   b. If an issue has a "depends-on:G1-G2-..." label (where each G is a literal \`ticket-group\` number; e.g., \`depends-on:1-2-3\` means groups 1, 2, and 3) → eligible only when ALL issues in ALL referenced ticket-groups have "status:merged" or are manually closed (GitHub state "closed"). To check: for each group number N in the label, list issues via \`gh issue list --label "ticket-group:N" --repo {{REPO}} --json number,labels,state\` and verify all have "status:merged" or are closed.
   c. Issues WITHOUT any "ticket-group:" label SHALL be treated as eligible immediately (backward-compatible with pre-clustering tickets). NOTE: legacy tickets predate dependency-aware scheduling — inspect them for hidden ordering assumptions before dispatching in parallel, or gate them behind a manual "legacy-sequential" workflow if strict ordering is required.
   d. Count active agents across ALL eligible ticket-groups. If count >= {{MAX_CONCURRENT}}, skip claiming new tickets. The max concurrent limit is a GLOBAL cap across all ticket-groups, not per-group.

4. For eligible ticket-groups with unassigned tickets, claim them (up to available slots):
   - Set assignee to {{GITHUB_USERNAME}}
   - Remove "status:open" label, add "status:in-progress" label
   - Spawn a Task subagent (subagent_type: "general") with the AGENT_IMPLEMENTATION_PROMPT filled in
   - Track the subagent: record issue number, spawn time, subagent status

**Step 4: Review unreviewed PRs (DO NOT SKIP)**
1. Find PRs linked to openspec issues that haven't been reviewed:
   \`gh pr list --repo {{REPO}} --state open --search "label:status:pr-open -label:reviewed" --json number,title,labels\`

2. For EACH unreviewed PR you find, you MUST spawn a Task subagent for review. Do not skip this — spawn one review subagent per PR. The subagent will add the "approved" label if the PR passes review.

3. Check for revised PRs that need re-review:
   - Find PRs with both "reviewed" and "status:needs-revision" labels
   - Check if new commits exist since the last review (compare PR updated_at)
    - If new commits: remove "reviewed" label so it gets picked up next cycle

**Step 4.5: Code review for approved PRs (DO NOT SKIP)**
1. Find PRs that have passed spec review but haven't been code-reviewed yet:
   - PRs with \`approved\` AND \`reviewed\` labels, whose linked issue has \`status:ready-to-merge\`, but PR does NOT have \`code-reviewed\`
   - Practical approach: list open PRs with approved+reviewed labels, then for each check if code-reviewed is missing and the linked issue has status:ready-to-merge
   \`gh pr list --repo {{REPO}} --state open --search "label:approved label:reviewed -label:code-reviewed" --json number,title,labels\`
   - For each result, check the linked issue (from PR body "Fixes #N" or "Closes #N") for status:ready-to-merge label

2. For each PR needing code review:
   - Get the PR number and the linked issue number (from PR body/title referencing "Fixes #N" or "Closes #N")
   - Get the PR branch name: \`gh pr view <number> --repo {{REPO}} --json headRefName --jq .headRefName\`
   - Build the code review orchestrator prompt by calling buildCodeReviewOrchestratorPrompt(CODE_REVIEW_SUBAGENT_PROMPT, CODE_FIX_SUBAGENT_PROMPT)
   - Fill in the template variables: {{PR_NUMBER}}, {{ISSUE_NUMBER}}, {{PR_BRANCH}}, {{REPO}}, {{ROUND_NUMBER}} (start with 1)
   - Spawn a Task subagent (subagent_type: "general") with the filled-in orchestrator prompt
   - Track this subagent

3. When the code review orchestrator subagent returns:
   - If status "approved": the subagent already added "code-reviewed" label to the PR. Move on.
   - If status "needs-revision": the subagent already updated labels on the issue. Move on.

**Step 5: Merge approved and code-reviewed PRs**
1. Find PRs ready to merge:
   - PRs with "status:ready-to-merge" AND "approved" AND "code-reviewed" labels
   \`gh pr list --repo {{REPO}} --state open --search "label:status:ready-to-merge label:approved label:code-reviewed" --json number,title\`

2. For each:
   - Attempt merge: \`gh pr merge <number> --squash --delete-branch --repo {{REPO}}\`
   - On success: close linked issue, add "status:merged" label, remove other status labels
   - On failure: add comment to PR explaining failure, add "status:blocked" to linked issue

**Step 6: Auto-archive completed changes**
1. List all unique change names from openspec-labeled issues
2. For each change:
   - Check if ALL issues for that change have "status:merged" or are manually closed
   - Check that NONE have "status:blocked"
   - If all complete and no blocked: run \`openspec archive --change "<name>"\`
   - If archive fails: add comment to last merged issue noting the failure, continue polling

3. If no active changes remain (no open issues with "openspec:" labels):
   - Display summary of completed changes
   - Stop the polling loop and tell the user all work is done

**Step 7: Sleep and repeat**
Run \`sleep {{POLL_INTERVAL}}\` and go back to Step 1.

**Error Handling:**
- On GitHub API rate limit (403/429): wait 60 seconds, then retry with exponential backoff
- On any other error: log it, continue to next step in the cycle
- Never stop the loop unless all changes are archived or the user interrupts (Ctrl+C)

**Agent Templates:**

AGENT_IMPLEMENTATION_PROMPT:
\`\`\`
${AGENT_IMPLEMENTATION_PROMPT}
\`\`\`

PR_REVIEW_PROMPT:
\`\`\`
${PR_REVIEW_PROMPT}
\`\`\`

BLOCKED_COMMENT_TEMPLATE:
\`\`\`
${BLOCKED_COMMENT_TEMPLATE}
\`\`\`

CODE_REVIEW_SUBAGENT_PROMPT (from shared/lib/code-review-prompt.js):
\`\`\`
${CODE_REVIEW_SUBAGENT_PROMPT}
\`\`\`

CODE_FIX_SUBAGENT_PROMPT (from shared/lib/code-review-prompt.js):
\`\`\`
${CODE_FIX_SUBAGENT_PROMPT}
\`\`\`

CODE_REVIEW_ORCHESTRATOR_PROMPT:
\`\`\`
${buildCodeReviewOrchestratorPrompt(CODE_REVIEW_SUBAGENT_PROMPT, CODE_FIX_SUBAGENT_PROMPT)}
\`\`\`

Fill in the template variables: {{PR_NUMBER}}, {{ISSUE_NUMBER}}, {{PR_BRANCH}}, {{REPO}}, {{ROUND_NUMBER}}.`

function getSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 30)
}

function fillTemplate(template, vars) {
  let result = template
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value)
  }
  return result
}

function extractChangeName(labels) {
  for (const label of labels) {
    const name = typeof label === "string" ? label : (label.name || "")
    if (name.startsWith("openspec:")) {
      const cn = name.slice(9)
      return cn || null
    }
  }
  return null
}

export default {
  id: "openspec-dispatcher",
  server: async ({ client, $, directory }) => {
    let dispatcherSessionID = null
    const issueToChange = new Map()
    const spawnTimes = new Map()
    const claimTimestamps = new Map()
    const inProgressIssues = new Set()
    const recoveryCandidates = new Set()

    const { logEvent } = await import("../lib/telemetry.js")

    return {
      "tool.execute.before": async (input) => {
        if (dispatcherSessionID && input.sessionID === dispatcherSessionID) {
          try {
            if (input.tool === "task" && input.args?.prompt) {
              const prompt = input.args.prompt
              if (prompt.startsWith("You are an implementation agent working on a ticket")) {
                const issueMatch = prompt.match(/#(\d+)/)
                if (issueMatch) {
                  const issueNum = parseInt(issueMatch[1])
                  const changeName = issueToChange.get(issueNum) ?? null
                  const spawnTime = Date.now()
                  spawnTimes.set(input.callID, { spawnTime, changeName })
                  logEvent({ event: "agent_spawned", plugin: "dispatcher", issue: issueNum, changeName, spawnTime: new Date(spawnTime).toISOString() }, directory)
                }
              }
            }
          } catch (err) {
            spawnTimes.delete(input.callID)
            await client.app.log({
              body: {
                service: "openspec-dispatcher",
                level: "warn",
                message: `Spawn tracking failed: ${err.message}`,
              },
            })
          }
        }
      },

      "tool.execute.after": async (input, output) => {
        if (
          input.tool === "skill" &&
          input.args?.name === "openspec-dispatch"
        ) {
          dispatcherSessionID = input.sessionID

          let owner = "MaVictor"
          let repo = null
          try {
            const remoteResult = await $`git remote get-url origin`
            const match = remoteResult.stdout.trim().match(/[/:]([^/]+\/[^/]+?)(?:\.git)?$/)
            if (match) {
              const parts = match[1].split("/")
              owner = parts[0] || "MaVictor"
              repo = parts[1]
            }
          } catch {
            // fallback to defaults
          }

          let githubUsername = ""
          try {
            githubUsername = (await $`gh api user --jq .login`).stdout.trim()
          } catch {
            await client.tui.showToast({
              body: {
                message:
                  "Failed to get GitHub username. Ensure gh CLI is authenticated.",
                variant: "error",
              },
            })
            return
          }

          const requiredLabels = [
            "openspec",
            "status:open",
            "status:in-progress",
            "status:pr-open",
            "status:merged",
            "status:blocked",
            "status:ready-to-merge",
            "status:needs-revision",
            "reviewed",
            "approved",
            "code-reviewed",
          ]
          const repoArg = `${owner}/${repo}`
          for (const label of requiredLabels) {
            try {
              await $`gh label create ${label} --repo ${repoArg} --if-not-exists`
            } catch {
              // label likely already exists, ignore
            }
          }

          const pollInterval = process.env.DISPATCHER_POLL_INTERVAL || "30"
          const timeoutMinutes = process.env.DISPATCHER_TIMEOUT_MINUTES || "30"
          const maxConcurrent = process.env.DISPATCHER_MAX_CONCURRENT || "3"

          const promptText = fillTemplate(DISPATCHER_PROMPT, {
            GITHUB_USERNAME: githubUsername,
            REPO: `${owner}/${repo}`,
            POLL_INTERVAL: pollInterval,
            TIMEOUT_MINUTES: timeoutMinutes,
            MAX_CONCURRENT: maxConcurrent,
          })

          await client.session.prompt({
            path: { id: input.sessionID },
            body: {
              parts: [{ type: "text", text: promptText }],
            },
          })

          try {
            const recoveryResult = await $`gh issue list --label "status:in-progress" --assignee ${githubUsername} --json number,labels`
            const recoveryIssues = JSON.parse(recoveryResult.stdout)
            if (Array.isArray(recoveryIssues)) {
              for (const issue of recoveryIssues) {
                if (issue.number) {
                  recoveryCandidates.add(issue.number)
                  if (Array.isArray(issue.labels)) {
                    const cn = extractChangeName(issue.labels)
                    if (cn !== null) {
                      issueToChange.set(issue.number, cn)
                    }
                  }
                }
              }
            }
          } catch (err) {
            await client.app.log({
              body: {
                service: "openspec-dispatcher",
                level: "warn",
                message: `Recovery startup failed: ${err.message}`,
              },
            })
          }

          await client.tui.showToast({
            body: {
              message: `Dispatcher started as @${githubUsername}. Polling every ${pollInterval}s.`,
              variant: "info",
            },
          })
        }

        if (dispatcherSessionID && input.sessionID === dispatcherSessionID) {
          try {
            if (input.tool === "bash" && input.args?.command) {
              const cmd = input.args.command

              if (cmd.includes("gh issue list")) {
                try {
                  const text = output?.stdout ?? output?.text ?? (typeof output === "string" ? output : "")
                  const issues = JSON.parse(text)
                  if (Array.isArray(issues)) {
                    for (const issue of issues) {
                      if (issue.number && Array.isArray(issue.labels)) {
                        const cn = extractChangeName(issue.labels)
                        if (cn !== null) {
                          issueToChange.set(issue.number, cn)
                        }
                      }
                    }
                  }
                  } catch (err) {
                    await client.app.log({
                      body: {
                        service: "openspec-dispatcher",
                        level: "warn",
                        message: `Issue list parsing failed: ${err.message}`,
                      },
                    })
                  }
              }

              if (cmd.includes("gh issue edit")) {
                const issueMatch = cmd.match(/gh\s+issue\s+edit\s+(\d+)/)
                if (issueMatch) {
                  const issueNum = parseInt(issueMatch[1])

                  if (/--add-label[\s=]+["']?status:in-progress/.test(cmd)) {
                    let changeName = issueToChange.get(issueNum) ?? null
                    if (changeName === null) {
                      try {
                        const viewResult = await $`gh issue view ${issueNum} --json labels`
                        const viewData = JSON.parse(viewResult.stdout)
                        if (Array.isArray(viewData.labels)) {
                          changeName = extractChangeName(viewData.labels)
                        }
                        if (changeName !== null) {
                          issueToChange.set(issueNum, changeName)
                        }
                      } catch (err) {
                        await client.app.log({
                          body: {
                            service: "openspec-dispatcher",
                            level: "warn",
                            message: `Issue view fallback failed: ${err.message}`,
                          },
                        })
                      }
                    }
                    claimTimestamps.set(issueNum, Date.now())
                    inProgressIssues.add(issueNum)
                    logEvent({ event: "claim", plugin: "dispatcher", issue: issueNum, changeName }, directory)
                  }

                  if (inProgressIssues.has(issueNum) && /--add-label[\s=]+["']?status:blocked/.test(cmd)) {
                    const changeName = issueToChange.get(issueNum) ?? null
                    const claimTs = claimTimestamps.get(issueNum)
                    const duration_ms = claimTs !== undefined ? Date.now() - claimTs : undefined
                    logEvent({ event: "agent_timed_out", plugin: "dispatcher", issue: issueNum, changeName, duration_ms }, directory)
                    inProgressIssues.delete(issueNum)
                    claimTimestamps.delete(issueNum)
                  } else if (cmd.includes("status:pr-open") || cmd.includes("status:blocked")) {
                    inProgressIssues.delete(issueNum)
                    claimTimestamps.delete(issueNum)
                  }

                  if (recoveryCandidates.has(issueNum)) {
                    const changeName = issueToChange.get(issueNum) ?? null
                    logEvent({ event: "recovery", plugin: "dispatcher", issue: issueNum, changeName }, directory)
                    recoveryCandidates.delete(issueNum)
                  }
                }
              }

              if (cmd.includes("gh pr merge")) {
                const prMatch = cmd.match(/gh\s+pr\s+merge\s+(\d+)/)
                if (prMatch) {
                  const prNum = parseInt(prMatch[1])
                  let changeName = null
                  try {
                    const prView = await $`gh pr view ${prNum} --json closingIssuesReferences`
                    const prData = JSON.parse(prView.stdout)
                    const ref = prData.closingIssuesReferences?.[0]
                    if (ref) {
                      changeName = issueToChange.get(ref.number) ?? null
                    }
                  } catch (err) {
                    await client.app.log({
                      body: {
                        service: "openspec-dispatcher",
                        level: "warn",
                        message: `PR view for merge tracking failed: ${err.message}`,
                      },
                    })
                  }

                  const exitCode = output?.exitCode ?? 0
                  if (exitCode !== 0) {
                    const outText = ((output?.stdout ?? "") + (output?.stderr ?? "")).toLowerCase()
                    let reason = "unknown"
                    if (outText.includes("merge conflict") || outText.includes("conflict")) {
                      reason = "merge_conflict"
                    } else if (outText.includes("rate limit") || /\b403\b/.test(outText) || /\b429\b/.test(outText)) {
                      reason = "rate_limited"
                    } else if (outText.includes("authentication") || outText.includes("credentials")) {
                      reason = "auth_error"
                    } else if (outText.includes("protected branch") || outText.includes("branch protection")) {
                      reason = "branch_protection"
                    } else if (outText.includes("already been merged") || outText.includes("no commits to merge")) {
                      reason = "already_merged"
                    }
                    if (reason === "already_merged") {
                      logEvent({ event: "merge", plugin: "dispatcher", pr: prNum, changeName, already_merged: true }, directory)
                    } else {
                      logEvent({ event: "merge_failed", plugin: "dispatcher", pr: prNum, changeName, reason }, directory)
                    }
                  } else {
                    logEvent({ event: "merge", plugin: "dispatcher", pr: prNum, changeName }, directory)
                  }
                }
              }
            }

            if (input.tool === "task" && input.args?.prompt) {
              const prompt = input.args.prompt

              if (prompt.startsWith("You are an implementation agent working on a ticket")) {
                const issueMatch = prompt.match(/#(\d+)/)
                if (issueMatch) {
                  const issueNum = parseInt(issueMatch[1])
                  const changeName = issueToChange.get(issueNum) ?? null
                  const spawnEntry = spawnTimes.get(input.callID)
                  const eventData = { event: "agent_completed", plugin: "dispatcher", issue: issueNum, changeName }
                  if (spawnEntry) {
                    eventData.duration_ms = Date.now() - spawnEntry.spawnTime
                    spawnTimes.delete(input.callID)
                  }
                  logEvent(eventData, directory)
                }
              }

              if (prompt.startsWith("You are a staff engineer reviewing a pull request")) {
                const prMatch = prompt.match(/PR is #(\d+)/) || prompt.match(/#(\d+)/)
                const issueMatch = prompt.match(/linked to issue #(\d+)/)
                if (prMatch) {
                  const issueNum = issueMatch ? parseInt(issueMatch[1]) : null
                  const changeName = issueNum !== null ? (issueToChange.get(issueNum) ?? null) : null
                  logEvent({ event: "review_completed", plugin: "dispatcher", pr: parseInt(prMatch[1]), changeName }, directory)
                }
              }
            }
          } catch (err) {
            await client.app.log({
              body: {
                service: "openspec-dispatcher",
                level: "warn",
                message: `Telemetry logging failed: ${err.message}`,
              },
            })
          }
        }
      },
    }
  },
}

export {
  AGENT_IMPLEMENTATION_PROMPT,
  PR_REVIEW_PROMPT,
  BLOCKED_COMMENT_TEMPLATE,
  DISPATCHER_PROMPT,
  fillTemplate,
  getSlug,
}
