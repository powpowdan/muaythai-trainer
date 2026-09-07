#!/usr/bin/env node
// Stop hook — Claude Code analog of the OpenCode plugin's "session.idle" handler.
// When the parent finishes a turn after an OpenSpec propose/apply was detected, this
// drives review injection.
//
// ADE split:
//   Claude / non-parent-loop: per-Stop single-round state machine (pending → reviewing → revising → …)
//   Grok / Cursor: parent-owned multi-round orchestrator on first pending inject; subsequent Stops
//         complete or resume from disk (bounded by resumeCount). See design Decision 4.
//   Cursor inject stdout is { followup_message } only (no Claude decision/systemMessage).
//
// stop_hook_active is honored as a hard safety so subagent stop events never
// trigger state transitions.

import {
  configure,
  getProjectDir,
  readState,
  clearState,
  writeReviewingState,
  writeRevisingState,
  readReviewOutcome,
  isFirstmateLane,
  buildArtifactReviewPrompt,
  buildImplementationReviewPrompt,
  buildRevisionPrompt,
  buildArtifactReviewOrchestratorPromptGrok,
  buildImplementationReviewOrchestratorPromptGrok,
  buildGrokContinueOrchestratorPrompt,
  MAX_STATE_AGE_MS,
  logEvent,
} from "./lib.mjs"
import { attachKnownModel, resolveAdeModel } from "./resolve-model.mjs"

const MAX_ROUNDS = 3
/** Max continue injections on Grok/Cursor parent loop before terminal even if file still Round 1 NEEDS_REVISION. */
const MAX_GROK_RESUME_COUNT = 2

/** Set in main() before any allow/block so Cursor can emit followup_message / {}. */
let currentAde = "claude"
/** Resolved once per invocation; attached on auto-review events when not unknown. */
let resolvedAdeModel = { model: "unknown", source: "unknown" }

function emitReviewEvent(event) {
  try {
    logEvent(attachKnownModel(event, resolvedAdeModel))
  } catch {}
}

function usesParentMultiRoundLoop(ade) {
  return ade === "grok" || ade === "cursor"
}

function readStdin() {
  return new Promise((resolve) => {
    let data = ""
    process.stdin.setEncoding("utf-8")
    process.stdin.on("data", (chunk) => (data += chunk))
    process.stdin.on("end", () => resolve(data))
    process.stdin.on("error", () => resolve(data))
  })
}

function allow() {
  if (currentAde === "cursor") {
    process.stdout.write("{}")
  }
  process.exit(0)
}

function block(reason, systemMessage) {
  // Cursor stop: emit only followup_message (D6). Claude/Grok: decision block.
  if (currentAde === "cursor") {
    process.stdout.write(JSON.stringify({ followup_message: reason }))
    process.exit(0)
  }
  // `reason` goes to the parent (the next instruction); `systemMessage` is the
  // user-visible toast — the Claude Code analog of client.tui.showToast().
  process.stdout.write(JSON.stringify({ decision: "block", reason, systemMessage }))
  process.exit(0)
}

// Returns true if the state should be treated as stale.
// Missing detectedAt is always treated as stale (never silently a no-op).
function isStale(state) {
  if (!state.detectedAt) return true
  return Date.now() - state.detectedAt > MAX_STATE_AGE_MS
}

/**
 * Grok parent-owned loop: reviewing (or leftover revising normalized into reviewing).
 * Algorithm order is mandatory — do NOT apply Claude's outcome.round !== state.round
 * short-circuit before terminal / resume-cap checks.
 */
async function handleGrokParentLoop(state, { plugin, sessionId, ade = "grok" }) {
  let working = state

  // Leftover revising: normalize → fall through shared algorithm (no inject from this branch).
  if (working.revising) {
    try {
      emitReviewEvent({
        event: "revision_completed",
        plugin,
        changeName: working.changeName,
        sessionId: working.sessionId,
        round: working.round,
      })
    } catch {}

    const resumeCount = Number(working.resumeCount) || 0
    writeReviewingState({
      round: working.round,
      kind: working.kind,
      changeName: working.changeName,
      sessionId: working.sessionId,
      baselineCommit: working.baselineCommit,
      resumeCount,
      loopOwner: "parent",
    })
    working = {
      reviewing: true,
      round: working.round,
      kind: working.kind,
      changeName: working.changeName,
      sessionId: working.sessionId,
      baselineCommit: working.baselineCommit,
      resumeCount,
      loopOwner: "parent",
      detectedAt: Date.now(),
    }
  }

  if (!working.reviewing) allow()

  const { round, kind, changeName, baselineCommit } = working

  // (1) Session / stale / outcome guards
  if (working.sessionId && sessionId && working.sessionId !== sessionId) {
    allow()
  }

  if (isStale(working)) {
    try {
      emitReviewEvent({
        event: "review_loop_completed",
        plugin,
        changeName,
        sessionId: working.sessionId,
        finalStatus: "abandoned",
        rounds: round,
      })
    } catch {}
    clearState()
    allow()
  }

  const outcome = readReviewOutcome(changeName, kind, getProjectDir() || process.cwd())

  if (outcome.error) {
    try {
      emitReviewEvent({
        event: "review_loop_completed",
        plugin,
        changeName,
        sessionId: working.sessionId,
        finalStatus: "error",
        rounds: round,
      })
    } catch {}
    clearState()
    allow()
  }

  // Coerce before resume-cap / incomplete steps (never leave undefined for comparisons).
  const resumeCount = Number(working.resumeCount) || 0

  // (2) Terminal APPROVED — regardless of state.round
  if (outcome.status === "APPROVED") {
    try {
      emitReviewEvent({
        event: "review_round_completed",
        plugin,
        changeName,
        sessionId: working.sessionId,
        round: outcome.round,
        status: "APPROVED",
      })
    } catch {}
    try {
      emitReviewEvent({
        event: "review_loop_completed",
        plugin,
        changeName,
        sessionId: working.sessionId,
        finalStatus: "APPROVED",
        rounds: outcome.round,
      })
    } catch {}
    clearState()
    allow()
  }

  // (3) Terminal max-round NEEDS_REVISION via outcome.round
  if (outcome.status === "NEEDS_REVISION" && outcome.round >= MAX_ROUNDS) {
    try {
      emitReviewEvent({
        event: "review_round_completed",
        plugin,
        changeName,
        sessionId: working.sessionId,
        round: outcome.round,
        status: "NEEDS_REVISION",
      })
    } catch {}
    try {
      emitReviewEvent({
        event: "review_loop_completed",
        plugin,
        changeName,
        sessionId: working.sessionId,
        finalStatus: "NEEDS_REVISION",
        rounds: MAX_ROUNDS,
      })
    } catch {}
    clearState()
    allow()
  }

  // (4) Hook-owned resume cap
  if (outcome.status === "NEEDS_REVISION" && outcome.round < MAX_ROUNDS && resumeCount >= MAX_GROK_RESUME_COUNT) {
    try {
      emitReviewEvent({
        event: "review_round_completed",
        plugin,
        changeName,
        sessionId: working.sessionId,
        round: outcome.round,
        status: "NEEDS_REVISION",
      })
    } catch {}
    try {
      emitReviewEvent({
        event: "review_loop_completed",
        plugin,
        changeName,
        sessionId: working.sessionId,
        finalStatus: "NEEDS_REVISION",
        rounds: outcome.round,
      })
    } catch {}
    clearState()
    allow()
  }

  // (5) Incomplete resume — always revision once for outcome.round, then N+1..3
  if (outcome.status === "NEEDS_REVISION" && outcome.round < MAX_ROUNDS && resumeCount < MAX_GROK_RESUME_COUNT) {
    const nextResume = resumeCount + 1
    writeReviewingState({
      round: outcome.round,
      kind,
      changeName,
      sessionId: working.sessionId,
      baselineCommit,
      resumeCount: nextResume,
      loopOwner: "parent",
    })
    const continuePrompt = buildGrokContinueOrchestratorPrompt(
      changeName,
      kind,
      outcome.round,
      baselineCommit || "",
      ade,
    )
    block(continuePrompt, `✏️  Continue staff engineer ${kind} review (resume after round ${outcome.round})...`)
  }

  // (6) Mid-flight allow only — e.g. unexpected status while subagent still writing
  allow()
}

async function main() {
  let payload = {}
  try {
    payload = JSON.parse(await readStdin())
  } catch {
    allow()
  }

  // Determine ADE: installers pass it as argv[2] (e.g. "node stop-review.mjs grok").
  // Payload-based fallback is last-resort only — prefer argv so shared env vars
  // (e.g. GROK_SESSION_ID while Claude is also installed) cannot mis-route.
  const adeFromArgv = process.argv[2] || null
  let ade = adeFromArgv
  if (!ade) {
    if (payload.workspacePaths && !payload.tool_name && !payload.toolName) ade = "antigravity"
    else if (payload.workspace_roots || payload.workspaceRoots) ade = "cursor"
    else if (payload.sessionId || payload.workspaceRoot) ade = "grok"
    else ade = "claude"
  }
  currentAde = ade
  const plugin = `${ade}-auto-review`

  configure({ ade, payload })

  // Hard loop guard from the harness — subagent stop events must not advance state.
  // Claude uses stop_hook_active; Grok/Cursor may set equivalent flags — treat truthy broadly.
  if (payload.stop_hook_active || payload.stopHookActive) allow()

  // Normalize session ID across ADEs:
  //   Claude: session_id | Antigravity: conversationId | Grok: sessionId / GROK_SESSION_ID
  //   Cursor: conversation_id | conversationId | sessionId | generation_id
  const sessionId =
    payload.conversationId ||
    payload.conversation_id ||
    payload.session_id ||
    payload.sessionId ||
    payload.generation_id ||
    payload.generationId ||
    process.env.GROK_SESSION_ID ||
    null
  resolvedAdeModel = resolveAdeModel({
    payloadModel: typeof payload.model === "string" ? payload.model : undefined,
    cwd:
      payload.cwd ||
      payload.workspaceRoot ||
      payload.workspace_roots?.[0] ||
      payload.workspaceRoots?.[0] ||
      getProjectDir() ||
      process.cwd(),
    sessionId,
  })

  const state = readState()
  if (!state) allow()

  // ── pending branch ─────────────────────────────────────────────────────────
  if (state.pending) {
    // Stale pending state — never consumed in time.
    if (isStale(state)) {
      emitReviewEvent({ event: "review_skipped", plugin, changeName: state.changeName, sessionId: state.sessionId, reason: "stale_state" })
      clearState()
      allow()
    }

    // Only inject for the session that triggered detection.
    if (state.sessionId && sessionId && state.sessionId !== sessionId) {
      emitReviewEvent({ event: "review_skipped", plugin, changeName: state.changeName, sessionId: state.sessionId, reason: "session_mismatch" })
      allow()
    }

    const { changeName, mode, baselineCommit } = state
    const kind = mode === "apply" ? "implementation" : "artifact"
    const projectDir = getProjectDir() || process.cwd()

    // Artifact/propose short-circuits only (design D5 — apply still injects).
    // Evaluation order after session/stale: (1) firstmate lane (2) on-disk outcome (3) default inject.
    if (kind === "artifact") {
      // (1) Firstmate lane — prefer skip over hook-owned NEEDS_REVISION continue
      if (isFirstmateLane(changeName, projectDir)) {
        try {
          emitReviewEvent({
            event: "review_skipped",
            plugin,
            changeName,
            sessionId: state.sessionId,
            reason: "firstmate_lane",
          })
        } catch {}
        clearState()
        allow()
      }

      // (2) On-disk review outcome (lane already false)
      const diskOutcome = readReviewOutcome(changeName, "artifact", projectDir)
      if (!diskOutcome.error) {
        if (diskOutcome.status === "APPROVED") {
          try {
            emitReviewEvent({
              event: "review_skipped",
              plugin,
              changeName,
              sessionId: state.sessionId,
              reason: "already_approved",
            })
          } catch {}
          clearState()
          allow()
        }

        if (diskOutcome.status === "NEEDS_REVISION" && diskOutcome.round >= MAX_ROUNDS) {
          try {
            emitReviewEvent({
              event: "review_skipped",
              plugin,
              changeName,
              sessionId: state.sessionId,
              reason: "already_terminal",
            })
          } catch {}
          clearState()
          allow()
        }

        // Incomplete hook-owned loop: continue N+1, do not wipe with full Round-1 inject
        if (diskOutcome.status === "NEEDS_REVISION" && diskOutcome.round < MAX_ROUNDS) {
          if (usesParentMultiRoundLoop(ade)) {
            writeReviewingState({
              round: diskOutcome.round,
              kind,
              changeName,
              sessionId: state.sessionId,
              baselineCommit,
              resumeCount: 1,
              loopOwner: "parent",
            })
            const continuePrompt = buildGrokContinueOrchestratorPrompt(
              changeName,
              kind,
              diskOutcome.round,
              baselineCommit || "",
              ade,
            )
            block(
              continuePrompt,
              `✏️  Continue staff engineer ${kind} review (resume after round ${diskOutcome.round})...`,
            )
          }

          // Claude / non-Grok Path A: enter revision for the incomplete round
          writeRevisingState({
            round: diskOutcome.round,
            kind,
            changeName,
            sessionId: state.sessionId,
            baselineCommit,
          })
          const revisionPrompt = buildRevisionPrompt(changeName, kind, diskOutcome.round, ade)
          block(revisionPrompt, `✏️  Staff engineer revision round ${diskOutcome.round}...`)
        }
      }
    }

    if (usesParentMultiRoundLoop(ade)) {
      // Parent-owned multi-round loop: never write revising on Grok/Cursor pending.
      writeReviewingState({
        round: 1,
        kind,
        changeName,
        sessionId: state.sessionId,
        baselineCommit,
        resumeCount: 0,
        loopOwner: "parent",
      })

      try {
        if (kind === "artifact") {
          emitReviewEvent({ event: "artifact_review_started", plugin, changeName, sessionId: state.sessionId })
        } else {
          emitReviewEvent({
            event: "implementation_review_started",
            plugin,
            changeName,
            sessionId: state.sessionId,
            baselineCommit: baselineCommit || "",
          })
        }
      } catch {
        // telemetry failure never blocks review injection
      }

      const prompt = kind === "implementation"
        ? buildImplementationReviewOrchestratorPromptGrok(changeName, baselineCommit || "", 1, ade)
        : buildArtifactReviewOrchestratorPromptGrok(changeName, 1, ade)

      block(prompt, `🔍 Staff engineer ${kind} multi-round review starting...`)
    }

    // Non-Grok: single-round inject (Path A)
    writeReviewingState({ round: 1, kind, changeName, sessionId: state.sessionId, baselineCommit })

    try {
      if (kind === "artifact") {
        emitReviewEvent({ event: "artifact_review_started", plugin, changeName, sessionId: state.sessionId })
      } else {
        emitReviewEvent({ event: "implementation_review_started", plugin, changeName, sessionId: state.sessionId, baselineCommit: baselineCommit || "" })
      }
    } catch {
      // telemetry failure never blocks review injection
    }

    const prompt = kind === "implementation"
      ? await buildImplementationReviewPrompt(changeName, baselineCommit || "", 1, ade)
      : await buildArtifactReviewPrompt(changeName, 1, ade)

    block(prompt, `🔍 Staff engineer ${kind} review starting (round 1)...`)
  }

  // ── Grok / Cursor parent loop (reviewing or leftover revising) ─────────────
  if (usesParentMultiRoundLoop(ade) && (state.reviewing || state.revising)) {
    await handleGrokParentLoop(state, { plugin, sessionId, ade })
    // handleGrokParentLoop always exits via allow/block
  }

  // ── reviewing branch (Claude / non-Grok Path A) ────────────────────────────
  if (state.reviewing) {
    const { round, kind, changeName, baselineCommit } = state

    // Belt-and-suspenders session guard: stale state from a prior session (different
    // project or re-opened terminal) must not spuriously advance the state machine.
    // stop_hook_active already filters subagent stop events; this guards cross-session.
    if (state.sessionId && sessionId && state.sessionId !== sessionId) {
      allow()
    }

    // Stale reviewing state — session may have crashed.
    if (isStale(state)) {
      emitReviewEvent({ event: "review_loop_completed", plugin, changeName, sessionId: state.sessionId, finalStatus: "abandoned", rounds: round })
      clearState()
      allow()
    }

    // Use configured project dir (workspaceRoot / GROK_WORKSPACE_ROOT / CLAUDE_PROJECT_DIR),
    // not process.cwd() — hook process cwd may differ from the project root.
    const outcome = readReviewOutcome(changeName, kind, getProjectDir() || process.cwd())

    if (outcome.error) {
      emitReviewEvent({ event: "review_loop_completed", plugin, changeName, sessionId: state.sessionId, finalStatus: "error", rounds: round })
      clearState()
      allow()
    }

    // Review subagent hasn't written its result for this round yet.
    // Claude Path A only — Grok must not use this gate before terminals.
    if (outcome.round !== round) {
      allow()
    }

    // Emit round completion event.
    emitReviewEvent({ event: "review_round_completed", plugin, changeName, sessionId: state.sessionId, round, status: outcome.status })

    if (outcome.status === "APPROVED") {
      emitReviewEvent({ event: "review_loop_completed", plugin, changeName, sessionId: state.sessionId, finalStatus: "APPROVED", rounds: round })
      clearState()
      allow()
    }

    // NEEDS_REVISION — check round cap.
    if (round >= MAX_ROUNDS) {
      emitReviewEvent({ event: "review_loop_completed", plugin, changeName, sessionId: state.sessionId, finalStatus: "NEEDS_REVISION", rounds: MAX_ROUNDS })
      clearState()
      allow()
    }

    // Advance to revision.
    writeRevisingState({ round, kind, changeName, sessionId: state.sessionId, baselineCommit })
    const revisionPrompt = buildRevisionPrompt(changeName, kind, round, ade)
    block(revisionPrompt, `✏️  Staff engineer revision round ${round}...`)
  }

  // ── revising branch (Claude / non-Grok Path A) ─────────────────────────────
  if (state.revising) {
    const { round, kind, changeName, baselineCommit } = state

    // Belt-and-suspenders session guard (same rationale as reviewing branch).
    if (state.sessionId && sessionId && state.sessionId !== sessionId) {
      allow()
    }

    // Stale revising state.
    if (isStale(state)) {
      emitReviewEvent({ event: "review_loop_completed", plugin, changeName, sessionId: state.sessionId, finalStatus: "abandoned", rounds: round })
      clearState()
      allow()
    }

    emitReviewEvent({ event: "revision_completed", plugin, changeName, sessionId: state.sessionId, round })

    const nextRound = round + 1
    writeReviewingState({ round: nextRound, kind, changeName, sessionId: state.sessionId, baselineCommit })

    const prompt = kind === "implementation"
      ? await buildImplementationReviewPrompt(changeName, baselineCommit || "", nextRound, ade)
      : await buildArtifactReviewPrompt(changeName, nextRound, ade)

    block(prompt, `🔍 Staff engineer ${kind} review (round ${nextRound})...`)
  }

  // ── no matching state ──────────────────────────────────────────────────────
  allow()
}

main()
