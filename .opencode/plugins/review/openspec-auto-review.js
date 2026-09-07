import { parseReviewOutput } from "../lib/review-output-parser.js"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))

const REVIEW_SUBAGENT_PROMPT = readFileSync(join(__dirname, "../prompts/review-subagent.md"), "utf-8").trimEnd()

const IMPLEMENTATION_REVIEW_PROMPT = readFileSync(join(__dirname, "../prompts/implementation-review.md"), "utf-8").trimEnd()

const REVISION_SUBAGENT_PROMPT = `You are revising OpenSpec artifacts based on review findings.

Steps:
a. Read the review.md file at: REVIEW_PATH
b. Read ALL artifact files referenced in the findings. Use \`openspec status --change "<name>" --json\` to find their paths if needed.
c. For each finding in the review, apply the suggested fix to the relevant artifact file. Be precise — edit only what the finding asks for, don't rewrite entire artifacts.
d. If two findings contradict each other, use your judgment and favor the higher-severity finding.

Return to me: a brief summary of what you revised (one line per artifact).`

const IMPLEMENTATION_REVISION_PROMPT = readFileSync(join(__dirname, "../prompts/implementation-revision.md"), "utf-8").trimEnd()

// Token budget note: the spec scenario "wrapper injection (≤100 tokens)" refers only to the
// outer instruction line ("The openspec-propose skill just ran. Use the Task tool..."), which
// is ~49 tokens. The embedded orchestratorPrompt (~1300 tokens) is a one-time static payload
// and is NOT accumulated per-round context — per-round context accumulates inside the Task
// subagent, not the main session. Both the outer line and the embedded prompt are part of the
// single session.prompt() call, but only the outer instruction line counts toward the ≤100
// token wrapper budget referenced in the spec scenario.
function buildArtifactReviewOrchestratorPrompt() {
  const reviewPrompt = REVIEW_SUBAGENT_PROMPT.replace("ROUND_NUMBER", "1")
  const revisionPrompt = REVISION_SUBAGENT_PROMPT

  const orchestratorPrompt = `The openspec-propose skill was just used in this session. An automatic staff engineer review is now needed.

Do the following:

1. Run \`openspec list --json\` to find the active change. If no change exists or artifacts are incomplete, tell the user and STOP.

**CRITICAL — STOP CONDITION:**
- If a review subagent returns status APPROVED, STOP IMMEDIATELY. Do NOT launch another review round and do NOT launch a revision subagent. Go straight to step 3 (present the approved summary) and the post-approval steps.
- Only launch the next round (and any revision) when the status is NEEDS_REVISION.

2. Start the review loop (max 3 rounds — stop as soon as a round returns APPROVED):

   ROUND 1:
   - Use the Task tool to launch a subagent (subagent_type: "general") with this prompt:
     ${reviewPrompt}
   - Wait for the subagent to return. Note the status (APPROVED or NEEDS_REVISION) and the review.md path.
   - If APPROVED: STOP — skip ROUND 2 and ROUND 3 and go to step 3.

   If NEEDS_REVISION:
   - Use the Task tool to launch a REVISION subagent (subagent_type: "general") with this prompt:
     ${revisionPrompt.replace("REVIEW_PATH", "<the review.md path from the review subagent>")}
     (Replace REVIEW_PATH with the actual path the review subagent returned.)
   - Wait for the revision subagent to return.

   ROUND 2 (only if ROUND 1 was NEEDS_REVISION):
   - Launch another review subagent with the same prompt but replace "Review Round: 1" with "Review Round: 2"
   - Wait for it to return.
   - If APPROVED: STOP — skip ROUND 3 and go to step 3.

   If NEEDS_REVISION again:
   - Launch another revision subagent with the updated review.md path.

   ROUND 3 (final — only if ROUND 2 was NEEDS_REVISION):
   - Launch a final review subagent with "Review Round: 3"

 3. If APPROVED at any round: present the review summary to the user, tell them the artifacts are ready for implementation, suggest running /opsx-apply.

    TICKET GENERATION: After presenting the APPROVED summary, attempt to generate GitHub Issues from tasks.md:
    a. Run \`openspec status --change "<name>" --json\` and find the resolved output path for the "tasks" artifact.
    b. If tasks.md exists, run: \`node shared/lib/ticket-generator.js --change "<name>" "<tasks-md-path>"\`
    c. If the command succeeds, inform the user that GitHub Issues were created and tasks.md was updated with issue numbers.
    d. If the command fails with a GitHub configuration error, tell the user: "GitHub not configured. Set GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO environment variables to enable automatic ticket creation."
    e. If no tasks.md exists, tell the user: "No tasks found. Tickets will be generated when tasks are created."

 4. If still NEEDS_REVISION after 3 rounds: present the outstanding issues to the user for manual resolution.

IMPORTANT: Do NOT read the artifact files yourself. Do NOT revise artifacts yourself. All reading and editing happens inside subagents. You only orchestrate.`

  return `The openspec-propose skill just ran. Use the Task tool to launch one subagent (subagent_type: "general") with the prompt below, wait for it to complete, then present its final summary to the user:

${orchestratorPrompt}`
}

function buildImplementationReviewOrchestratorPrompt(baselineCommit = "") {
  const reviewPrompt = IMPLEMENTATION_REVIEW_PROMPT.replace("ROUND_NUMBER", "1")
  const revisionPrompt = IMPLEMENTATION_REVISION_PROMPT

  const orchestratorPrompt = `The openspec-apply-change skill was just used in this session. An automatic staff engineer implementation review is now needed.

Do the following:

1. Run \`openspec list --json\` to find the active change. If no change exists, tell the user and STOP.
   Run \`openspec status --change "<name>" --json\` and check if all tasks are marked done. If any tasks are incomplete, STOP and tell the user which tasks remain — do not review incomplete work.

**CRITICAL — STOP CONDITION:**
- If a review subagent returns status APPROVED, STOP IMMEDIATELY. Do NOT launch another review round and do NOT launch a revision subagent. Go straight to step 3 (present the approved summary).
- Only launch the next round (and any revision) when the status is NEEDS_REVISION.

2. Start the implementation review loop (max 3 rounds — stop as soon as a round returns APPROVED):

    ROUND 1:
    - Use the Task tool to launch a subagent (subagent_type: "general") with this prompt:

    ---
    ${reviewPrompt}
    ---
    (Replace <BASELINE_COMMIT> with: ${baselineCommit})

    - Wait for the subagent to return. Note the status and the implementation-review.md path.
    - If APPROVED: STOP — skip ROUND 2 and ROUND 3 and go to step 3.

    If NEEDS_REVISION:
    - Use the Task tool to launch a REVISION subagent (subagent_type: "general") with this prompt:
      ${revisionPrompt}
      (Replace REVIEW_PATH with the actual implementation-review.md path from the review subagent)
    - Wait for the revision subagent to return.

    ROUND 2 (only if ROUND 1 was NEEDS_REVISION):
    - Launch another review subagent with the same prompt but replace "Review Round: 1" with "Review Round: 2"
    - Wait for it to return.
    - If APPROVED: STOP — skip ROUND 3 and go to step 3.

    If NEEDS_REVISION again:
    - Launch another revision subagent with the updated implementation-review.md path.

    ROUND 3 (final — only if ROUND 2 was NEEDS_REVISION):
    - Launch a final review subagent with "Review Round: 3"

 3. If APPROVED at any round: present the review summary to the user, tell them the implementation is solid.

 4. If still NEEDS_REVISION after 3 rounds: present the outstanding issues to the user for manual resolution.

IMPORTANT: Do NOT read the changed files yourself. Do NOT revise code yourself. All reading and editing happens inside subagents. You only orchestrate.`

  return `The openspec-apply-change skill just ran. Use the Task tool to launch one subagent (subagent_type: "general") with the prompt below, wait for it to complete, then present its final summary to the user:

${orchestratorPrompt}`
}

export default {
  id: "openspec-auto-review",
  server: async ({ client, $, directory }) => {
    let state = "idle"
    let targetSessionID = null
    let baselineCommit = null
    let telemetrySessionID = null
    let telemetrySessionTimestamp = null
    let changeName = null
    let reviewRound = 0

    const { logEvent } = await import("../lib/telemetry.js")

    // telemetrySessionID persists after targetSessionID is cleared in the event handler.
    // targetSessionID tracks the orchestrator session for prompt injection (cleared on session.idle),
    // while telemetrySessionID must survive session.idle to capture subagent events that fire afterward.
    // See design.md Decision 6.

    return {
      "tool.execute.after": async (input, output) => {
        if (input.tool === "skill") {
          if (input.args?.name === "openspec-propose" || input.args?.name === "openspec-apply-change") {
            telemetrySessionID = null
            telemetrySessionTimestamp = null
            reviewRound = 0
          }

          if (input.args?.name === "openspec-propose") {
            state = "proposing"
            targetSessionID = input.sessionID
            baselineCommit = null
            telemetrySessionID = input.sessionID
            telemetrySessionTimestamp = Date.now()

            try {
              const listResult = await $`openspec list --json`
              const changes = JSON.parse(listResult.stdout).changes
              if (changes && changes.length > 0) {
                const sorted = [...changes].sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified))
                changeName = sorted[0].name
                if (changes.length > 1) {
                  await client.app.log({
                    body: {
                      service: "openspec-auto-review",
                      level: "warn",
                      message: `Multiple changes found, selected "${changeName}" by most recent lastModified`,
                    },
                  })
                }
              }
            } catch {
              changeName = null
            }

            await client.app.log({
              body: {
                service: "openspec-auto-review",
                level: "info",
                message: `Propose skill detected in session ${input.sessionID}`,
              },
            })
          } else if (input.args?.name === "openspec-apply-change") {
            state = "applying"
            targetSessionID = input.sessionID
            try {
              const result = await $`git rev-parse HEAD`
              baselineCommit = result.stdout?.trim() || null
            } catch {
              baselineCommit = null
            }
            telemetrySessionID = input.sessionID
            telemetrySessionTimestamp = Date.now()

            try {
              const listResult = await $`openspec list --json`
              const changes = JSON.parse(listResult.stdout).changes
              if (changes && changes.length > 0) {
                const sorted = [...changes].sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified))
                changeName = sorted[0].name
                if (changes.length > 1) {
                  await client.app.log({
                    body: {
                      service: "openspec-auto-review",
                      level: "warn",
                      message: `Multiple changes found, selected "${changeName}" by most recent lastModified`,
                    },
                  })
                }
              }
            } catch {
              changeName = null
            }

            await client.app.log({
              body: {
                service: "openspec-auto-review",
                level: "info",
                message: `Apply skill detected in session ${input.sessionID}, baseline commit: ${baselineCommit || "none"}`,
              },
            })
          }
        } else if (input.tool === "bash" && input.args?.command) {
          const proposeMatch = input.args.command.match(/openspec\s+new\s+change\s+["']?([a-z0-9-]+)["']?/)
          if (proposeMatch) {
            telemetrySessionID = null
            telemetrySessionTimestamp = null
            reviewRound = 0

            changeName = proposeMatch[1]
            state = "proposing"
            targetSessionID = input.sessionID
            baselineCommit = null
            telemetrySessionID = input.sessionID
            telemetrySessionTimestamp = Date.now()
            await client.app.log({
              body: {
                service: "openspec-auto-review",
                level: "info",
                message: `Propose detected via bash in session ${input.sessionID}, change: ${changeName}`,
              },
            })
          } else if (/openspec\s+instructions\s+apply/.test(input.args.command)) {
            telemetrySessionID = null
            telemetrySessionTimestamp = null
            reviewRound = 0

            state = "applying"
            targetSessionID = input.sessionID
            try {
              const result = await $`git rev-parse HEAD`
              baselineCommit = result.stdout?.trim() || null
            } catch {
              baselineCommit = null
            }
            telemetrySessionID = input.sessionID
            telemetrySessionTimestamp = Date.now()

            try {
              const listResult = await $`openspec list --json`
              const changes = JSON.parse(listResult.stdout).changes
              if (changes && changes.length > 0) {
                const sorted = [...changes].sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified))
                changeName = sorted[0].name
                if (changes.length > 1) {
                  await client.app.log({
                    body: {
                      service: "openspec-auto-review",
                      level: "warn",
                      message: `Multiple changes found, selected "${changeName}" by most recent lastModified`,
                    },
                  })
                }
              }
            } catch {
              changeName = null
            }

            await client.app.log({
              body: {
                service: "openspec-auto-review",
                level: "info",
                message: `Apply detected via bash in session ${input.sessionID}, baseline commit: ${baselineCommit || "none"}`,
              },
            })
          }
        }

        if (telemetrySessionID && input.sessionID === telemetrySessionID) {
          if (Date.now() - telemetrySessionTimestamp > 30 * 60 * 1000) {
            telemetrySessionID = null
            telemetrySessionTimestamp = null
          }
        }

        if (telemetrySessionID && input.sessionID === telemetrySessionID) {
          try {
            if (input.tool === "task" && input.args?.prompt) {
              const prompt = input.args.prompt
              const outputStr = typeof output === "string" ? output : (output?.text || output?.content || JSON.stringify(output))

              if (prompt.startsWith("You are a staff engineer reviewing OpenSpec artifacts") || prompt.startsWith("You are a staff engineer reviewing implemented code against its specification")) {
                reviewRound++
                const parsed = parseReviewOutput(outputStr)
                logEvent({
                  event: "review_completed",
                  plugin: "auto-review",
                  changeName: changeName,
                  metadata: {
                    round: reviewRound,
                    status: parsed.verdict,
                    findings_high: parsed.findings_high,
                    findings_medium: parsed.findings_medium,
                    findings_low: parsed.findings_low,
                    files_mentioned: parsed.files_mentioned,
                  },
                }, directory)

                if (parsed.verdict === "APPROVED" || reviewRound >= 3) {
                  telemetrySessionID = null
                  telemetrySessionTimestamp = null
                  reviewRound = 0
                }
              }

              if (prompt.startsWith("You are revising OpenSpec artifacts") || prompt.startsWith("You are revising implementation code")) {
                const pathMatch = prompt.match(/file at:\s*(\S+)/)
                const reviewPath = pathMatch ? pathMatch[1] : null
                logEvent({ event: "revision_completed", plugin: "auto-review", changeName: changeName, metadata: { reviewPath } }, directory)
              }
            }
          } catch (err) {
            await client.app.log({
              body: {
                service: "openspec-auto-review",
                level: "warn",
                message: `Telemetry logging failed: ${err.message}`,
              },
            })
          }
        }
      },

      event: async ({ event }) => {
        if (
          event.type === "session.idle" &&
          (state === "proposing" || state === "applying") &&
          event.properties?.sessionID === targetSessionID
        ) {
          const currentState = state
          const sessionID = targetSessionID
          const capturedBaseline = baselineCommit
          const capturedChangeName = changeName

          state = "idle"
          targetSessionID = null
          baselineCommit = null

          const isProposing = currentState === "proposing"

          try {
            logEvent({
              event: "review_started",
              plugin: "auto-review",
              changeName: capturedChangeName,
              metadata: { reviewType: isProposing ? "artifact" : "implementation" },
            }, directory)
          } catch (err) {
            await client.app.log({
              body: {
                service: "openspec-auto-review",
                level: "warn",
                message: `Telemetry logging failed: ${err.message}`,
              },
            })
          }

          await client.app.log({
            body: {
              service: "openspec-auto-review",
              level: "info",
              message: `Session idle after ${currentState}, injecting ${isProposing ? "artifact" : "implementation"} review prompt`,
            },
          })

          let promptText
          if (isProposing) {
            promptText = buildArtifactReviewOrchestratorPrompt()
          } else {
            promptText = buildImplementationReviewOrchestratorPrompt(capturedBaseline || "")
          }

          await client.session.prompt({
            path: { id: sessionID },
            body: {
              parts: [{ type: "text", text: promptText }],
            },
          })

          await client.tui.showToast({
            body: {
              message: `Staff engineer ${isProposing ? "artifact" : "implementation"} review starting...`,
              variant: "info",
            },
          })
        }
      },
    }
  },
}

export {
  REVIEW_SUBAGENT_PROMPT,
  IMPLEMENTATION_REVIEW_PROMPT,
  REVISION_SUBAGENT_PROMPT,
  IMPLEMENTATION_REVISION_PROMPT,
  buildArtifactReviewOrchestratorPrompt,
  buildImplementationReviewOrchestratorPrompt,
}
