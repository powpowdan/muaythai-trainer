import { execFileSync } from "node:child_process"
import { parseDiffStat } from "../lib/diff-analyzer.js"
import { parseReviewOutput, computeRoundSurprise } from "../lib/review-output-parser.js"

// Deep-mode threshold: only changes at this risk level get the relaxed read
// budget plus architectural-fit / maintainability dimensions. Single tunable knob.
const DEEP_REVIEW_RISK_LEVEL = "high"

const CODE_REVIEW_SUBAGENT_PROMPT = `You are a staff engineer doing a code review. You have fresh eyes — you did NOT write this code.

**Diff scope:** {{DIFF_SCOPE}}
**Risk:** {{RISK_SCORE}} ({{RISK_LEVEL}})

**Static, adversarial review.** Do NOT execute tests or builds, and do NOT run the code under review — evaluate statically from the diff and any permitted context reads. Adopt a red-team stance: assume the code is broken and find the input or state that breaks it. (You MAY still flag missing or weak test coverage as a finding — only *executing* tests is prohibited.)

Steps:
1. Get the diff:
   {{DIFF_COMMAND}}

2. Build structured summaries: For each changed file in the diff, construct a summary directly from the diff output. Each summary MUST include:
   - **File path**
   - **File role:** what this file does in the project (infer from path, imports, exports visible in diff hunks)
   - **What changed:** 1-2 sentences describing the change
   - **Change type:** new feature / bug fix / refactor / config / test / docs

3. Evaluate the changes based on the diff and your summaries. Focus on the changed code within diff hunks — the surrounding unchanged lines provide context about codebase conventions.

{{MODE_INSTRUCTIONS}}

6. Evaluate the changes for these concerns, in priority order:

   **High severity — must fix before merge:**
   - Logic errors or incorrect behavior
   - Security vulnerabilities (injection, auth bypass, data exposure)
   - Unhandled error paths that could crash or silently fail
   - Race conditions or concurrency bugs
   - Breaking changes to existing behavior

   **Medium severity — should fix:**
   - Missing edge case handling (null, empty, boundary values)
   - Performance regressions (N+1 queries, unnecessary allocations, O(n²) where O(n) is trivial)
   - Inconsistent error handling (some paths throw, some return null, some silently fail)
   - Poor naming or excessive cognitive complexity in a single function
   - Missing or incorrect types/contracts

   **Low severity — nice to have:**
   - Style inconsistencies with the rest of the codebase
   - Dead code or unnecessary complexity
   - Comments that could be clearer
   - Minor test coverage gaps

7. Format your review as:

## Code Review — Round {{ROUND_NUMBER}}

**Files changed:** N files (+A/-D lines across M files)
**Verdict:** APPROVED | NEEDS_CHANGES | NEEDS_MAJOR_CHANGES

### Findings

For each finding:
- [SEVERITY: high|medium|low] **File:** path/to/file.ts:L42 — Finding title
  - **Issue:** what is wrong and why it matters
  - **Failure scenario:** (REQUIRED on every high- or medium-severity correctness finding) a concrete failure scenario — specific input/state → wrong output or crash. If you cannot construct one, do NOT file it as a high/medium correctness finding. Low-severity, style, and coverage findings do NOT require a failure scenario.
  - **Suggestion:** concrete fix (code snippet if helpful)

### Approval verdict
State plainly whether a staff engineer would approve this change, and why or why not — weighing correctness, architectural fit, and premise together, not merely listing bugs. Withhold approval for a poor fit or a questionable premise even when no correctness finding exists.

### Summary
(2-3 sentences. If approved, what looks solid. If changes needed, what the author should focus on first.)

Be ruthless. You are the quality gate between code and production. Bad code ships bugs, erodes trust, and wastes everyone's time down the line. Do not approve unless you are confident the changes are correct, handle edge cases, and follow the conventions of the codebase. Every finding must cite line numbers and include a concrete fix. If something looks off, flag it — no free passes.

Return to me: the verdict (APPROVED or NEEDS_CHANGES or NEEDS_MAJOR_CHANGES), the full list of findings, the approval verdict with rationale, and the summary.`

const CODE_FIX_SUBAGENT_PROMPT = `You are fixing code based on a staff engineer's review findings.

Steps:
1. Read the review findings below. Every finding has a file path, issue description, and suggested fix.
2. Read each affected file in full to understand context before making changes.
3. For each finding, apply the suggested fix to the relevant file. Be precise — edit only what the finding asks for, don't rewrite entire modules.
4. If two findings contradict each other, use your judgment and favor the higher-severity finding.
5. After applying all fixes, run the tests scoped to the files you changed and report pass/fail. Derive the test command from the repository (package scripts / detected runner); run ONLY the tests covering the changed files, and never run the full test suite. If you cannot determine a scoped test command for the changed files, report that no scoped tests were run and why — do not run the full suite and do not silently skip.
6. Do NOT commit. Leave the changes unstaged for the next review round.

**Review findings to fix:**
{{REVIEW_FINDINGS}}

Return to me: a brief summary of what you fixed (one line per file), plus the scoped-test outcome (pass/fail, or "no scoped tests run" with the reason).`

// Risk-gated read budget + evaluation dimensions. Only DEEP_REVIEW_RISK_LEVEL
// diffs get the relaxed neighbor reads and fit/maintainability lenses; everything
// below stays cheap and diff-local. Both branches name "high-risk" so parity
// verifiers can confirm the gate is present.
function buildReviewModeInstructions(riskLevel) {
  if (riskLevel === DEEP_REVIEW_RISK_LEVEL) {
    return `4. This is a **high-risk change** (risk level: ${DEEP_REVIEW_RISK_LEVEL}), so run a deep, context-aware review. Relax the read budget: read the callers, usage sites, and surrounding module of the changed code as needed to judge real impact. Note which files you read and why in your findings.

5. In addition to the correctness concerns below, evaluate:
   - **Architectural fit:** does the change adhere to existing patterns, layering, and conventions, and integrate cleanly with its callers?
   - **Maintainability / future cost:** does it add complexity or debt a staff engineer would push back on?`
  }
  return `4. This is a cheap, diff-local review (risk level is below the high-risk deep-mode threshold). Full file reads are ONLY allowed in these specific cases (max 1-2 files per review):
   - An exported interface changed and you need to see callers to assess impact
   - The change type genuinely cannot be determined from the diff alone
   If you read full files, note which files you read and why in your findings.

5. DO NOT read other files in the same directory for patterns or conventions. Context comes from the diff hunks and your structured summaries.`
}

function buildOrchestratorPrompt(reviewPrompt, fixPrompt, riskScore, riskLevel) {
  const riskLine = riskLevel !== "none"
    ? `\n**Risk assessment:** score ${riskScore} (${riskLevel})`
    : ""

  return `A code review has been requested. You must orchestrate a multi-round review loop (max 3 rounds).${riskLine}

**CRITICAL — STOP CONDITION:**
- If the review subagent returns verdict APPROVED, STOP IMMEDIATELY. Do NOT launch another review round. Do NOT launch a fix subagent. Present the approved review to the user and you are DONE.
- Only proceed to a fix + re-review cycle if the verdict is NEEDS_CHANGES or NEEDS_MAJOR_CHANGES.

Do the following:

ROUND 1:
- Use the Task tool to launch a REVIEW subagent (subagent_type: "general") with this prompt:

---
${reviewPrompt}
---

- Wait for the subagent to return. Note the verdict (APPROVED, NEEDS_CHANGES, or NEEDS_MAJOR_CHANGES) and the findings.

- **If verdict is APPROVED**: STOP. Present the review summary to the user. Tell them the code looks solid and is ready to commit. Do nothing else.

- **If verdict is NEEDS_CHANGES or NEEDS_MAJOR_CHANGES**: proceed to fix.

FIX ROUND 1:
- Use the Task tool to launch a FIX subagent (subagent_type: "general") with this prompt:

---
${fixPrompt}
---

(Replace {{REVIEW_FINDINGS}} with the actual findings returned by the review subagent — copy them verbatim.)

- Wait for the fix subagent to return.

ROUND 2:
- Launch another REVIEW subagent with the same prompt but replace "Round 1" with "Round 2" in the prompt text.
- Wait for it to return. Note the verdict.

- **If verdict is APPROVED**: STOP. Present the review summary to the user. Done.

- **If verdict is NEEDS_CHANGES or NEEDS_MAJOR_CHANGES**: proceed to fix.

FIX ROUND 2:
- Launch another FIX subagent with the updated findings.

ROUND 3 (final):
- Launch a final REVIEW subagent with "Round 3".
- Wait for it to return. Present the final verdict to the user.
- If APPROVED: tell them the code is ready to commit.
- If still NEEDS_CHANGES or NEEDS_MAJOR_CHANGES: present the outstanding issues for manual resolution.

IMPORTANT: Do NOT read any files yourself. Do NOT run git diff yourself. Do NOT review or fix the code yourself. All reading, reviewing, and fixing happens inside subagents. You only orchestrate and present results.`
}

function fillTemplate(template, vars) {
  let result = template
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value)
  }
  return result
}

function buildDiffCommands(diffScope) {
  switch (diffScope) {
    case "staged":
      return {
        scope: "staged changes only",
        command: "Run: `git diff --cached`",
      }
    case "unstaged":
      return {
        scope: "unstaged changes only",
        command: "Run: `git diff`",
      }
    default:
      if (diffScope && diffScope !== "all") {
        return {
          scope: diffScope,
          command: `Run: \`git diff ${diffScope}\``,
        }
      }
      return {
        scope: "all changes on this branch (committed + uncommitted)",
        command: `Run these in order:
   a. \`git diff --cached\` (staged changes)
   b. \`git diff\` (unstaged changes)
   c. \`git diff main...HEAD\` (committed changes on this branch vs main). If main doesn't exist, try origin/main or master. If the branch is main/master itself, skip this step.
   Combine all three to get the full picture.`,
      }
  }
}

function buildDiffStatArgs(diffScope) {
  switch (diffScope) {
    case "staged":
      return ["diff", "--cached", "--stat"]
    case "unstaged":
      return ["diff", "--stat"]
    default:
      if (diffScope && diffScope !== "all") {
        return ["diff", diffScope, "--stat"]
      }
      return ["diff", "HEAD", "--stat"]
  }
}

export default {
  id: "auto-code-review",
  server: async ({ client, $, directory }) => {
    let state = "idle"
    let targetSessionID = null
    let capturedScope = null
    let capturedCommand = null
    let capturedRawScope = null
    let telemetryActive = false
    let telemetrySessionID = null
    let telemetryRound = 0
    let telemetryReadCount = 0
    let telemetryRiskScore = 0
    let telemetryRiskLevel = "none"
    let telemetryReviewMode = "cheap"
    let telemetryDiffScope = ""
    let telemetryFilesChanged = 0
    let telemetryPrevFiles = new Set()
    let changeName = null

    const { logEvent } = await import("../lib/telemetry.js")

    return {
      "tool.execute.after": async (input, output) => {
        if (input.tool === "skill" && input.args?.name === "auto-code-review") {
          const rawArgs = input.args?.arguments || ""
          const diffScope = rawArgs.trim() || "all"

          const { scope, command } = buildDiffCommands(diffScope)

          state = "reviewing"
          targetSessionID = input.sessionID
          capturedScope = scope
          capturedCommand = command
          capturedRawScope = diffScope

          telemetryActive = true
          telemetrySessionID = input.sessionID
          telemetryRound = 0
          telemetryReadCount = 0
          telemetryPrevFiles = new Set()

          try {
            const listResult = await $`openspec list --json`
            const changes = JSON.parse(listResult.stdout).changes
            if (changes && changes.length === 1) {
              changeName = changes[0].name
            } else {
              changeName = null
            }
          } catch {
            changeName = null
          }

          logEvent({
            event: "code_review_triggered",
            plugin: "auto-code-review",
            changeName,
            metadata: { diffScope: scope },
          }, directory)

          await client.app.log({
            body: {
              service: "auto-code-review",
              level: "info",
              message: `Code review skill detected in session ${input.sessionID}, scope: ${scope}`,
            },
          })
        }

        if (telemetryActive && telemetrySessionID && input.sessionID === telemetrySessionID) {
          if (input.tool === "Read") {
            telemetryReadCount++
          }

          if (input.tool === "task" && input.args?.prompt) {
            const prompt = input.args.prompt
            if (prompt.startsWith("You are a staff engineer doing a code review")) {
              const outputStr = typeof output === "string" ? output : (output?.text || output?.content || JSON.stringify(output))
              try {
                const parsed = parseReviewOutput(outputStr)
                telemetryRound++
                const { surprise } = computeRoundSurprise(parsed, telemetryPrevFiles)

                for (const f of parsed.files) {
                  telemetryPrevFiles.add(f)
                }

                const readCount = telemetryReadCount
                telemetryReadCount = 0

                try {
                  logEvent({
                    event: "code_review_round",
                    plugin: "auto-code-review",
                    metadata: {
                      round: telemetryRound,
                      verdict: parsed.verdict,
                      findings_high: parsed.findings_high,
                      findings_medium: parsed.findings_medium,
                      findings_low: parsed.findings_low,
                      files_changed: telemetryFilesChanged,
                      files_mentioned: parsed.files_mentioned,
                      round_n_surprise: surprise,
                      risk_score: telemetryRiskScore,
                      risk_level: telemetryRiskLevel,
                      review_mode: telemetryReviewMode,
                      diff_scope: telemetryDiffScope,
                      read_tool_calls: readCount,
                      prompt_version: "summary-first",
                    },
                  }, directory)
                } catch {
                  await client.app.log({
                    body: { service: "auto-code-review", level: "warn", message: "Failed to write telemetry event" },
                  })
                }

                if (parsed.verdict === "APPROVED" || telemetryRound >= 3) {
                  telemetryActive = false
                  telemetrySessionID = null
                  telemetryRound = 0
                  telemetryPrevFiles = new Set()
                }
              } catch (err) {
                await client.app.log({
                  body: { service: "auto-code-review", level: "warn", message: `Telemetry parsing failed: ${err.message}` },
                })
              }
            }
          }
        }
      },

      event: async ({ event }) => {
        if (
          event.type === "session.idle" &&
          state === "reviewing" &&
          event.properties?.sessionID === targetSessionID
        ) {
          const sessionID = targetSessionID
          const scope = capturedScope
          const command = capturedCommand
          const rawScope = capturedRawScope

          state = "idle"
          targetSessionID = null
          capturedScope = null
          capturedCommand = null
          capturedRawScope = null

          let riskScore = 0
          let riskLevel = "none"
          let filesChanged = 0
          try {
            const args = buildDiffStatArgs(rawScope)
            const statOutput = execFileSync("git", args, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim()
            const analysis = parseDiffStat(statOutput)
            riskScore = analysis.score
            riskLevel = analysis.risk
            filesChanged = analysis.files
            telemetryRiskScore = riskScore
            telemetryRiskLevel = riskLevel
            telemetryReviewMode = riskLevel === DEEP_REVIEW_RISK_LEVEL ? "deep" : "cheap"
            telemetryDiffScope = scope
            telemetryFilesChanged = filesChanged
            logEvent({
              event: "code_review_risk_scored",
              plugin: "auto-code-review",
              changeName,
              metadata: { riskScore, riskLevel, files: analysis.files, logicFiles: analysis.logicFiles, testFiles: analysis.testFiles, totalLines: analysis.totalLines },
            }, directory)
          } catch {
            await client.app.log({
              body: { service: "auto-code-review", level: "warn", message: "Failed to compute risk score, continuing without it" },
            })
          }

          const reviewPrompt = fillTemplate(CODE_REVIEW_SUBAGENT_PROMPT, {
            DIFF_SCOPE: scope,
            DIFF_COMMAND: command,
            ROUND_NUMBER: "1",
            RISK_SCORE: String(riskScore),
            RISK_LEVEL: riskLevel,
            MODE_INSTRUCTIONS: buildReviewModeInstructions(riskLevel),
          })

          const fixPrompt = CODE_FIX_SUBAGENT_PROMPT
          const orchestratorPrompt = buildOrchestratorPrompt(reviewPrompt, fixPrompt, riskScore, riskLevel)

          await client.app.log({
            body: {
              service: "auto-code-review",
              level: "info",
              message: `Session idle, injecting code review orchestrator prompt (scope: ${scope})`,
            },
          })

          await client.session.prompt({
            path: { id: sessionID },
            body: {
              parts: [{ type: "text", text: orchestratorPrompt }],
            },
          })

          await client.tui.showToast({
            body: {
              message: `Staff engineer code review starting (${scope})...`,
              variant: "info",
            },
          })
        }
      },
    }
  },
}
