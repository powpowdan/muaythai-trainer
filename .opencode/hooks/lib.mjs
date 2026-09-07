// Shared helpers for the OpenSpec auto-review Claude Code hooks.
//
// Self-contained — no runtime imports from the OpenCode plugin or source repo.
// Prompt strings are bundled at install time from workflow/shared/prompts/*.md
// by install.mjs, injected between sentinel comment pairs:
//   /* __PROMPT_<NAME>_START__ */ ... /* __PROMPT_<NAME>_END__ */
//
// To update a prompt: edit the corresponding file in workflow/shared/prompts/,
// then re-run: node installers/install.mjs
// (editing this file directly will be overwritten on the next install run)

import { readFileSync, writeFileSync, appendFileSync, existsSync, rmSync, mkdirSync, readdirSync } from "node:fs"
import { join, dirname, basename } from "node:path"
import { homedir } from "node:os"
import { execSync, spawn } from "node:child_process"

let _projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd()
let _statePath = process.env.OPENSPEC_REVIEW_STATE_PATH || join(_projectDir, ".claude", ".openspec-review-state.json")

export function configure({ ade, payload } = {}) {
  if (ade === "antigravity") {
    _projectDir = payload?.workspacePaths?.[0] || process.cwd()
    if (!process.env.OPENSPEC_REVIEW_STATE_PATH) {
      _statePath = join(_projectDir, ".gemini", "config", ".openspec-review-state.json")
    }
  } else if (ade === "grok") {
    _projectDir =
      payload?.workspaceRoot ||
      payload?.cwd ||
      process.env.GROK_WORKSPACE_ROOT ||
      process.env.CLAUDE_PROJECT_DIR ||
      process.cwd()
    if (!process.env.OPENSPEC_REVIEW_STATE_PATH) {
      _statePath = join(_projectDir, ".grok", ".openspec-review-state.json")
    }
  } else if (ade === "cursor") {
    _projectDir =
      payload?.workspace_roots?.[0] ||
      payload?.workspaceRoots?.[0] ||
      payload?.workspaceRoot ||
      payload?.cwd ||
      process.env.CURSOR_PROJECT_DIR ||
      process.env.CLAUDE_PROJECT_DIR ||
      process.cwd()
    if (!process.env.OPENSPEC_REVIEW_STATE_PATH) {
      _statePath = join(_projectDir, ".cursor", ".openspec-review-state.json")
    }
  } else if (ade === "claude") {
    _projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd()
    if (!process.env.OPENSPEC_REVIEW_STATE_PATH) {
      _statePath = join(_projectDir, ".claude", ".openspec-review-state.json")
    }
  }
}

export function getProjectDir() { return _projectDir }
export function getStatePath() { return _statePath }

// OPENSPEC_REVIEW_STATE_PATH lets tests redirect state to a throwaway file so they
// never write to the live state the running Stop hook consumes. Production leaves
// it unset and uses the path under the project's .claude/.

// Orphaned state (detected but never consumed by a Stop within this window) is
// ignored, so a stale trigger can't kick off a review long after the fact.
export const MAX_STATE_AGE_MS = 30 * 60 * 1000

// ---- telemetry (inlined from workflow/.opencode/plugins/lib/telemetry.js) ----

const TEL_FILE = process.env.OPENSPEC_TEL_FILE || join(homedir(), ".claude", "workflow", ".openspec-telemetry.jsonl")

export function logEvent(event, baseDir = process.cwd()) {
  try {
    mkdirSync(dirname(TEL_FILE), { recursive: true })
    appendFileSync(TEL_FILE, JSON.stringify({ ts: new Date().toISOString(), repo: basename(baseDir), ...event }) + "\n", "utf-8")
    if (event.event === "review_loop_completed" || event.event === "merge" || event.event === "merge_failed") {
      try {
        const child = spawn('node', [join(homedir(), '.vsm', 'health-check.js')], { detached: true, stdio: 'ignore' })
        child.on('error', () => {})
        child.unref()
      } catch {}
    }
  } catch {}
}

// ---- state file (the in-memory plugin state, persisted to disk) ----

export function readState() {
  try {
    return JSON.parse(readFileSync(_statePath, "utf-8"))
  } catch {
    return null
  }
}

export function writeState(state) {
  // State may live under a nested ADE dir (e.g. <project>/.grok/) that does not
  // exist yet — create parents so first-write never ENOENTs.
  mkdirSync(dirname(_statePath), { recursive: true })
  writeFileSync(_statePath, JSON.stringify(state, null, 2))
}

export function clearState() {
  try {
    if (existsSync(_statePath)) rmSync(_statePath)
  } catch {
    // best effort
  }
}

// writeReviewingState — writes { reviewing: true, round, kind, changeName, sessionId, baselineCommit, detectedAt }
// detectedAt is always set to Date.now() at call time — never copied from pending state.
// baselineCommit must be threaded through explicitly on every call — it originates from the
// pending state (set once by detect.mjs) and has to survive every reviewing/revising transition
// for implementation reviews to keep diffing against the same baseline across all rounds.
// Optional Grok parent-loop fields: resumeCount (number), loopOwner ("parent" | "hook").
export function writeReviewingState({ round, kind, changeName, sessionId, baselineCommit, resumeCount, loopOwner }) {
  const state = { reviewing: true, round, kind, changeName, sessionId, baselineCommit, detectedAt: Date.now() }
  if (resumeCount !== undefined) state.resumeCount = resumeCount
  if (loopOwner !== undefined) state.loopOwner = loopOwner
  writeState(state)
}

// writeRevisingState — writes { revising: true, round, kind, changeName, sessionId, baselineCommit, detectedAt }
// detectedAt is always set to Date.now() at call time — never copied from pending state.
export function writeRevisingState({ round, kind, changeName, sessionId, baselineCommit }) {
  writeState({ revising: true, round, kind, changeName, sessionId, baselineCommit, detectedAt: Date.now() })
}

// Single-segment OpenSpec change names only — reject path traversal before join.
const CHANGE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/i

// readReviewOutcome — reads the review file for the current round and parses status.
// Returns { round: number, status: "APPROVED"|"NEEDS_REVISION" } or { error: string } on failure.
export function readReviewOutcome(changeName, kind, cwd = process.cwd()) {
  if (
    typeof changeName !== "string" ||
    !changeName ||
    changeName.includes("..") ||
    changeName.includes("/") ||
    changeName.includes("\\") ||
    !CHANGE_NAME_RE.test(changeName)
  ) {
    return { error: "parse_failed" }
  }

  const file = kind === "implementation"
    ? join(cwd, "openspec", "changes", changeName, "implementation-review.md")
    : join(cwd, "openspec", "changes", changeName, "review.md")

  if (!existsSync(file)) return { error: "file_missing" }

  let text
  try {
    text = readFileSync(file, "utf-8")
  } catch {
    return { error: "file_missing" }
  }

  const roundMatch = text.match(/^##\s+Review Round:\s*(\d+)/m)
  const statusMatch = text.match(/^\*\*Status:\*\*\s*(APPROVED|NEEDS_REVISION)/m)

  if (!roundMatch || !statusMatch) return { error: "parse_failed" }
  return { round: parseInt(roundMatch[1], 10), status: statusMatch[1] }
}

// ---- firstmate lane detection (read-only fleet meta scan) ----
// Lane = true when, for changeName, any .openspec-fleet/state/*.meta has either:
//   1. kind=ship + change=<name> + non-terminal ship lifecycle, or
//   2. change=<name> + propose_gate in in_progress|complete (any kind)
// Scout/unrelated meta without those conditions MUST return false (design D3).

const FIRSTMATE_NON_TERMINAL_STATUS = new Set([
  "in_flight",
  "needs_decision",
  "blocked",
  "failed",
  "queued",
])
// ready_to_land = forward write after panel APPROVED; awaiting_approval kept for dual-read
const FIRSTMATE_NON_TERMINAL_MERGE_PHASE = new Set([
  "ready_to_land",
  "awaiting_approval",
  "merging",
  "conflict_unresolved",
])
// merge_approval dual-read of legacy readiness token (forward write clears awaiting)
const FIRSTMATE_NON_TERMINAL_AWAITING = new Set([
  "merge_approval",
  "dep_complete",
  "captain_decision",
])
const FIRSTMATE_PROPOSE_GATE_ACTIVE = new Set(["in_progress", "complete"])

/** Parse key=value fleet meta text (self-contained; no fleet-state import). */
function parseFleetMetaContent(content) {
  /** @type {Record<string, string>} */
  const out = {}
  if (!content) return out
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq <= 0) continue
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return out
}

/**
 * Whether firstmate fleet state indicates ownership of this OpenSpec change.
 * Pure filesystem read of `.openspec-fleet/state/*.meta` under projectDir.
 *
 * Sticky lane (failed|blocked status, propose_gate=complete on terminal ship, etc.) is
 * intentional local-trust policy — captain clears via fleet cleanup or /openspec-review;
 * no authz redesign for suppress.
 *
 * @param {string} changeName
 * @param {string} [projectDir=process.cwd()]
 * @returns {boolean}
 */
export function isFirstmateLane(changeName, projectDir = process.cwd()) {
  if (!changeName) return false
  const stateDir = join(projectDir, ".openspec-fleet", "state")
  if (!existsSync(stateDir)) return false

  let names
  try {
    names = readdirSync(stateDir)
  } catch {
    return false
  }

  for (const name of names) {
    if (!name.endsWith(".meta")) continue
    let content
    try {
      content = readFileSync(join(stateDir, name), "utf-8")
    } catch {
      continue
    }
    const meta = parseFleetMetaContent(content)
    if (meta.change !== changeName) continue

    // Explicit propose gate (any kind, including future propose rows)
    if (FIRSTMATE_PROPOSE_GATE_ACTIVE.has(meta.propose_gate)) return true

    // Ship lifecycle: require kind=ship (case-insensitive) + non-terminal signal
    if ((meta.kind || "").toLowerCase() === "ship") {
      if (FIRSTMATE_NON_TERMINAL_STATUS.has(meta.status)) return true
      if (FIRSTMATE_NON_TERMINAL_MERGE_PHASE.has(meta.merge_phase)) return true
      if (FIRSTMATE_NON_TERMINAL_AWAITING.has(meta.awaiting)) return true
    }
  }
  return false
}

// ---- shell helpers ----

function sh(command, cwd) {
  return execSync(command, { cwd: cwd || _projectDir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
}

export function resolveActiveChange(projectDir) {
  try {
    const changes = JSON.parse(sh("openspec list --json", projectDir || _projectDir)).changes
    if (changes && changes.length > 0) {
      const sorted = [...changes].sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified))
      return sorted[0].name
    }
  } catch {
    // openspec not available or no changes
  }
  return null
}

export function currentCommit(projectDir) {
  try {
    return sh("git rev-parse HEAD", projectDir || _projectDir).trim() || null
  } catch {
    return null
  }
}

// ---- review subagent prompts (bundled from workflow/shared/prompts/ by install.mjs) ----
// Edit the source files in shared/prompts/, then re-run: node installers/install.mjs

/* __PROMPT_REVIEW_SUBAGENT_START__ */
const REVIEW_SUBAGENT_PROMPT = ``
/* __PROMPT_REVIEW_SUBAGENT_END__ */

/* __PROMPT_IMPLEMENTATION_REVIEW_START__ */
const IMPLEMENTATION_REVIEW_PROMPT = ``
/* __PROMPT_IMPLEMENTATION_REVIEW_END__ */

/* __PROMPT_IMPLEMENTATION_REVISION_START__ */
const IMPLEMENTATION_REVISION_PROMPT = ``
/* __PROMPT_IMPLEMENTATION_REVISION_END__ */

const REVISION_SUBAGENT_PROMPT = `You are revising OpenSpec artifacts based on review findings.

Steps:
a. Read the review.md file at: REVIEW_PATH
b. Read ALL artifact files referenced in the findings. Use \`openspec status --change "<name>" --json\` to find their paths if needed.
c. For each finding in the review, apply the suggested fix to the relevant artifact file. Be precise — edit only what the finding asks for, don't rewrite entire artifacts.
d. If two findings contradict each other, use your judgment and favor the higher-severity finding.

Return to me: a brief summary of what you revised (one line per artifact).`

/* __PROMPT_CODE_REVIEW_START__ */
export const CODE_REVIEW_SUBAGENT_PROMPT = ``
/* __PROMPT_CODE_REVIEW_END__ */

/* __PROMPT_CODE_FIX_START__ */
export const CODE_FIX_SUBAGENT_PROMPT = ``
/* __PROMPT_CODE_FIX_END__ */

// ---- Review injection prompts ----
// ADE split:
//   Claude / non-Grok: single-round prompts below. Loop sequencing is the stop-hook state machine
//     (one Stop → one review or revision inject). Do not put multi-round logic in these builders.
//   Grok: multi-round parent orchestrators (build*OrchestratorPromptGrok / continue). Parent owns
//     review → revision subagent → re-review up to 3 rounds in one injection; Stop only completes
//     or resumes when incomplete (see stop-review.mjs Decision 4).
//
// Use a general-purpose subagent. Artifacts are NOT pre-injected —
// each subagent reads them itself for fresh eyes and a small orchestrator context.
// ADE-aware spawn wording: Claude uses "Agent tool"; Grok uses "spawn_subagent tool".

const MAX_REVIEW_ROUNDS = 3

function subagentSpawnInstruction(ade = "claude") {
  if (ade === "grok") {
    return 'Use the spawn_subagent tool to launch one subagent (subagent_type: "general-purpose")'
  }
  if (ade === "cursor") {
    return 'Use the Task tool to launch one subagent (subagent_type: "generalPurpose")'
  }
  return 'Use the Agent tool to launch one subagent (subagent_type: "general-purpose")'
}

function reviewFilePath(changeName, kind) {
  return kind === "implementation"
    ? `openspec/changes/${changeName}/implementation-review.md`
    : `openspec/changes/${changeName}/review.md`
}

function reviewSubagentBody(kind, round, baselineCommit = "") {
  if (kind === "implementation") {
    return IMPLEMENTATION_REVIEW_PROMPT
      .replace("ROUND_NUMBER", String(round))
      .replace("<BASELINE_COMMIT>", baselineCommit || "HEAD~1")
  }
  return REVIEW_SUBAGENT_PROMPT.replace("ROUND_NUMBER", String(round))
}

function revisionSubagentBody(kind, changeName) {
  const reviewPath = reviewFilePath(changeName, kind)
  if (kind === "implementation") {
    return IMPLEMENTATION_REVISION_PROMPT.replace("REVIEW_PATH", reviewPath)
  }
  return REVISION_SUBAGENT_PROMPT.replace("REVIEW_PATH", reviewPath)
}

const OVERWRITE_RULE = `OVERWRITE RULE: Each review round MUST overwrite the review file entirely so it contains a single current "## Review Round: N" header and one "**Status:**" line. Do NOT append prior rounds under older headers — resume/terminal logic reads the first header only.`

const PARENT_ORCHESTRATE_ONLY = `IMPORTANT: You (the parent) only orchestrate. Do NOT edit artifact or implementation files yourself. All reading/editing of targets happens inside subagents. Wait for each subagent to complete before the next step.`

/**
 * Grok multi-round artifact review orchestrator (parent-owned loop).
 * startRound: first review round to run (1 on pending inject; continue uses buildGrokContinue*).
 */
export function buildArtifactReviewOrchestratorPromptGrok(changeName, startRound = 1, ade = "grok") {
  return buildGrokMultiRoundOrchestrator({
    kind: "artifact",
    changeName,
    startRound,
    baselineCommit: "",
    mode: "full",
    ade,
  })
}

/**
 * Grok multi-round implementation review orchestrator (parent-owned loop).
 */
export function buildImplementationReviewOrchestratorPromptGrok(changeName, baselineCommit = "", startRound = 1, ade = "grok") {
  return buildGrokMultiRoundOrchestrator({
    kind: "implementation",
    changeName,
    startRound,
    baselineCommit: baselineCommit || "",
    mode: "full",
    ade,
  })
}

/**
 * Grok continue orchestrator after incomplete parent loop.
 * Always runs revision once for needsRevisionRound, then reviews needsRevisionRound+1..3.
 * Do not ask the model whether revision was "already applied."
 */
export function buildGrokContinueOrchestratorPrompt(changeName, kind, needsRevisionRound, baselineCommit = "", ade = "grok") {
  return buildGrokMultiRoundOrchestrator({
    kind,
    changeName,
    startRound: needsRevisionRound,
    baselineCommit: baselineCommit || "",
    mode: "continue",
    needsRevisionRound,
    ade,
  })
}

function buildGrokMultiRoundOrchestrator({
  kind,
  changeName,
  startRound = 1,
  baselineCommit = "",
  mode = "full",
  needsRevisionRound,
  ade = "grok",
}) {
  const spawn = subagentSpawnInstruction(ade)
  const reviewPath = reviewFilePath(changeName, kind)
  const phaseLabel = kind === "implementation" ? "implementation" : "artifact"
  const skillLine = kind === "implementation"
    ? "The openspec-apply-change skill just ran."
    : "The openspec-propose skill just ran."
  const reviewFileName = kind === "implementation" ? "implementation-review.md" : "review.md"
  const baselineNote = kind === "implementation"
    ? `\nBaseline commit for diffs: ${baselineCommit || "HEAD~1"} (use this as BASELINE_COMMIT in review subagent prompts).\n`
    : ""

  const reviewTemplate = (n) => `---
${reviewSubagentBody(kind, n, baselineCommit)}

${OVERWRITE_RULE}
When writing ${reviewFileName}, replace ROUND_NUMBER with ${n}. Overwrite the whole file.
---`

  const revisionTemplate = `---
${revisionSubagentBody(kind, changeName)}
---`

  if (mode === "continue") {
    const n = needsRevisionRound ?? startRound
    const next = n + 1
    return `${skillLine} Auto-review is incomplete: ${reviewPath} shows Review Round: ${n}, Status: NEEDS_REVISION.

Continue the ${phaseLabel} review loop (do NOT re-run completed review rounds before ${n}).

${PARENT_ORCHESTRATE_ONLY}
${OVERWRITE_RULE}
${baselineNote}
DETERMINISTIC RESUME (always follow — do not infer "already applied"):
1. ALWAYS ${spawn} with this REVISION prompt (run revision once for round ${n}), wait for it to complete:
${revisionTemplate}

2. Then run review rounds ${next} through ${MAX_REVIEW_ROUNDS} as needed:
   For each review round R from ${next} to ${MAX_REVIEW_ROUNDS}:
   - ${spawn} with this REVIEW prompt (set Review Round to R), wait for it to complete:
${reviewTemplate("R")}
   - If status is APPROVED: present the review summary to the user${kind === "artifact" ? ", tell them artifacts are ready for implementation, suggest openspec-apply-change" : ", tell them the implementation is solid"}. STOP — no further rounds.
   - If status is NEEDS_REVISION and R < ${MAX_REVIEW_ROUNDS}: ${spawn} REVISION (same revision prompt as above with path ${reviewPath}), wait, then continue to review R+1.
   - If status is NEEDS_REVISION and R === ${MAX_REVIEW_ROUNDS}: present outstanding issues for manual resolution and STOP.

Max ${MAX_REVIEW_ROUNDS} review rounds total (absolute round numbers on disk). Do not launch a fourth review round.`
  }

  // Full loop from startRound (usually 1)
  return `${skillLine} An automatic staff engineer ${phaseLabel} review is now needed (multi-round parent orchestrator, max ${MAX_REVIEW_ROUNDS} rounds).

Change name: ${changeName}
Review file path: ${reviewPath}
${baselineNote}
${PARENT_ORCHESTRATE_ONLY}
${OVERWRITE_RULE}

You MUST orchestrate this loop yourself (do not stop after round 1 findings alone):

ROUND ${startRound} — Review:
- ${spawn} with this prompt, wait for it to complete:
${reviewTemplate(startRound)}
- Note status (APPROVED or NEEDS_REVISION).

If APPROVED at any round: present the review summary${kind === "artifact" ? ", tell the user artifacts are ready for implementation, suggest openspec-apply-change" : ", tell the user the implementation is solid"}. STOP.

If NEEDS_REVISION and current round < ${MAX_REVIEW_ROUNDS}:
- ${spawn} with this REVISION prompt, wait for it to complete:
${revisionTemplate}
- Then launch the next REVIEW round (replace Review Round number with the next integer). Wait for it.

If NEEDS_REVISION again and still under ${MAX_REVIEW_ROUNDS} review rounds: revision subagent again, then next review.

ROUND ${MAX_REVIEW_ROUNDS} is final. If still NEEDS_REVISION after round ${MAX_REVIEW_ROUNDS}: present outstanding issues for manual resolution and STOP.

Do not re-run a completed review round. Max ${MAX_REVIEW_ROUNDS} review rounds. Always wait for each subagent before proceeding.`
}

// ---- Single-round review prompts (Claude / non-Grok Path A) ----

export async function buildArtifactReviewPrompt(changeName, round = 1, ade = "claude") {
  const reviewPrompt = REVIEW_SUBAGENT_PROMPT.replace("ROUND_NUMBER", String(round))

  return `The openspec-propose skill just ran. ${subagentSpawnInstruction(ade)} with the prompt below, wait for it to complete, then present its findings to the user.

${reviewPrompt}`
}

export async function buildImplementationReviewPrompt(changeName, baselineCommit = "", round = 1, ade = "claude") {
  const reviewPrompt = IMPLEMENTATION_REVIEW_PROMPT
    .replace("ROUND_NUMBER", String(round))
    .replace("<BASELINE_COMMIT>", baselineCommit || "HEAD~1")

  return `The openspec-apply-change skill just ran. ${subagentSpawnInstruction(ade)} with the prompt below, wait for it to complete, then present its findings to the user.

${reviewPrompt}`
}

// buildRevisionPrompt — single-round revision injection (Claude Path A).
// REVIEW_PATH is substituted deterministically using the same path derivation as readReviewOutcome.
export function buildRevisionPrompt(changeName, kind, round, ade = "claude") {
  const reviewPath = reviewFilePath(changeName, kind)

  const revisionPrompt = kind === "implementation"
    ? IMPLEMENTATION_REVISION_PROMPT.replace("REVIEW_PATH", reviewPath)
    : REVISION_SUBAGENT_PROMPT.replace("REVIEW_PATH", reviewPath)

  return `A review subagent found issues in round ${round}. ${subagentSpawnInstruction(ade)} with the prompt below, wait for it to complete, then present its summary to the user.

${revisionPrompt}`
}
