#!/usr/bin/env node
// PostToolUse hook — Claude Code analog of the OpenCode plugin's
// "tool.execute.after" handler. Detects when an OpenSpec propose/apply happened
// (via the Skill tool or an openspec bash command) and records pending-review
// state to disk for the Stop hook to act on.
//
// Supports Claude Code, Antigravity, Grok, and Cursor payload shapes.
// This hook never blocks: it only writes state and exits 0.
//
// ADE selection: prefer argv[2] (installers pass "grok" / "antigravity" / "cursor" like Stop),
// then payload shape. Bare GROK_* env vars are session/path fallbacks only — not ADE.

import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { configure, writeState, resolveActiveChange, currentCommit } from "./lib.mjs"
import { logEvent } from "./lib.mjs"
import { attachKnownModel, resolveAdeModel } from "./resolve-model.mjs"

function extractPayloadModel(payload) {
  if (typeof payload?.model === "string" && payload.model.trim()) return payload.model.trim()
  return null
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

function skillName(toolInput = {}) {
  // Be tolerant of field naming across versions.
  return toolInput.name || toolInput.skill || ""
}

const PROPOSE_RE = /^openspec\s+new\s+change\s+["']?[a-z0-9-]+["']?/
const APPLY_RE = /^openspec\s+instructions\s+apply\b/

// Shell-like tools that may run openspec CLI commands.
const SHELL_TOOLS = new Set(["Bash", "Shell", "run_command", "run_terminal_command"])

// A real openspec invocation is the FIRST token of a command segment — not a
// substring buried in an `echo`/`grep`/`cat` argument, a quoted string, a pipe
// target, or a comment. Split on shell statement separators and test each
// segment after stripping leading env-var assignments.
function commandInvokes(command, re) {
  return command
    .split(/\s*(?:&&|\|\||[;|\n])\s*/)
    .some((segment) => {
      const s = segment.trim().replace(/^(?:\w+=\S*\s+)+/, "") // drop FOO=bar prefixes
      if (!s || s.startsWith("#")) return false
      return re.test(s)
    })
}

/**
 * Detect propose/apply from a PostToolUse tool name + input.
 *
 * Skill-tool arming is Claude-style (PostToolUse matcher includes Skill).
 * Grok and Cursor PostToolUse are registered only as shell tools — arming is
 * shell-command based only; Skill handling is skipped when ade is grok or cursor.
 */
export function detect(toolName, toolInput = {}, { ade } = {}) {
  // Grok / Cursor: shell-only (matcher never fires for Skill)
  if (toolName === "Skill" && ade !== "grok" && ade !== "cursor") {
    const name = skillName(toolInput)
    if (name === "openspec-propose" || name === "opsx:propose") return "propose"
    if (name === "openspec-apply-change" || name === "opsx:apply") return "apply"
    return null
  }
  if (SHELL_TOOLS.has(toolName)) {
    const command = toolInput.command || toolInput.CommandLine || ""
    if (commandInvokes(command, PROPOSE_RE)) return "propose"
    if (commandInvokes(command, APPLY_RE)) return "apply"
  }
  return null
}

/**
 * Normalize ADE-specific PostToolUse payloads into a common shape.
 *
 * Claude:      { tool_name, tool_input, session_id }
 * Grok:        { toolName, toolInput, sessionId, workspaceRoot, cwd }
 * Antigravity: { toolCall: { name, args }, workspacePaths, conversationId }
 * Cursor:      { tool_name|toolName, tool_input|toolInput, conversation_id,
 *                workspace_roots[], cwd } — argv "cursor" always wins over inference
 *
 * @param {object} payload
 * @param {string|null} adeFromArgv - installer-supplied ADE (e.g. "grok"); preferred over inference
 */
export function normalizePostToolUsePayload(payload = {}, adeFromArgv = null) {
  // Cursor: argv wins even when the payload also looks Grok-shaped (sessionId / workspaceRoot).
  if (adeFromArgv === "cursor") {
    const toolInput = payload.tool_input || payload.toolInput || {}
    return {
      ade: "cursor",
      toolName: payload.tool_name || payload.toolName || null,
      toolInput,
      sessionId:
        payload.conversation_id ||
        payload.conversationId ||
        payload.session_id ||
        payload.sessionId ||
        payload.generation_id ||
        payload.generationId ||
        null,
      projectDir:
        payload.workspace_roots?.[0] ||
        payload.workspaceRoots?.[0] ||
        payload.workspaceRoot ||
        payload.cwd ||
        process.env.CURSOR_PROJECT_DIR ||
        process.env.CLAUDE_PROJECT_DIR ||
        process.cwd(),
      model: extractPayloadModel(payload),
    }
  }

  // Antigravity: nested toolCall + workspacePaths, no top-level tool_name/toolName
  if (payload.workspacePaths && !payload.tool_name && !payload.toolName) {
    const args = payload.toolCall?.args
    let toolInput
    if (payload.toolCall?.name === "run_command") {
      toolInput = { command: typeof args === "string" ? args : args?.CommandLine || "" }
    } else {
      toolInput = typeof args === "string" ? { command: args } : (args || {})
    }
    return {
      ade: "antigravity",
      toolName: payload.toolCall?.name || null,
      toolInput,
      sessionId: payload.conversationId || null,
      projectDir: payload.workspacePaths?.[0] || process.cwd(),
      model: extractPayloadModel(payload),
    }
  }

  // Grok: prefer argv, then camelCase payload shape. Do NOT treat bare GROK_* env
  // as ADE proof (Claude + Grok may coexist on one machine). Env is only used for
  // sessionId / projectDir fallbacks after ADE is chosen.
  // When argv forces grok, take this path unconditionally so hybrid payloads that
  // also set tool_name still get camelCase sessionId / workspaceRoot extraction.
  const looksLikeGrok =
    adeFromArgv === "grok" ||
    typeof payload.toolName === "string" ||
    Boolean(payload.sessionId && !payload.session_id) ||
    Boolean(payload.workspaceRoot && !payload.tool_name)

  if (adeFromArgv === "grok" || (looksLikeGrok && !payload.tool_name)) {
    return {
      ade: "grok",
      toolName: payload.toolName || payload.tool_name || null,
      toolInput: payload.toolInput || payload.tool_input || {},
      sessionId:
        payload.sessionId ||
        payload.session_id ||
        process.env.GROK_SESSION_ID ||
        null,
      projectDir:
        payload.workspaceRoot ||
        payload.cwd ||
        process.env.GROK_WORKSPACE_ROOT ||
        process.env.CLAUDE_PROJECT_DIR ||
        process.cwd(),
      model: extractPayloadModel(payload),
    }
  }

  // Claude Code default (snake_case)
  return {
    ade: "claude",
    toolName: payload.tool_name || null,
    toolInput: payload.tool_input || {},
    sessionId: payload.session_id || null,
    projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    model: extractPayloadModel(payload),
  }
}

async function main() {
  let payload
  try {
    payload = JSON.parse(await readStdin())
  } catch {
    process.exit(0)
  }

  // Prefer argv ADE (installers pass "node detect.mjs grok") so shared env vars
  // cannot mis-route — same pattern as stop-review.mjs.
  const adeFromArgv = process.argv[2] || null
  const normalized = normalizePostToolUsePayload(payload, adeFromArgv)
  const ade = adeFromArgv || normalized.ade
  const { toolName, toolInput, sessionId, projectDir } = normalized
  const resolvedModel = resolveAdeModel({
    payloadModel: normalized.model,
    cwd: payload.cwd || projectDir,
    sessionId,
  })

  configure({ ade, payload })

  const mode = detect(toolName, toolInput, { ade })
  if (!mode) process.exit(0)

  if (!sessionId) {
    console.error("WARNING: no session ID found in payload — skipping pending-review state")
    process.exit(0)
  }

  const changeName = resolveActiveChange(projectDir)
  writeState({
    pending: true,
    mode,
    changeName,
    baselineCommit: mode === "apply" ? currentCommit(projectDir) : null,
    sessionId,
    detectedAt: Date.now(),
  })

  try {
    logEvent(attachKnownModel({
      event: mode === "propose" ? "propose_detected" : "apply_detected",
      plugin: `${ade}-auto-review`,
      changeName,
      sessionId,
    }, resolvedModel))
  } catch {
    // telemetry failure never prevents hook from exiting 0
  }

  process.exit(0)
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMainModule) {
  main()
}
