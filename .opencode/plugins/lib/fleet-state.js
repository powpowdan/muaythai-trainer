/**
 * fleet-state.js — OpenSpec firstmate fleet operational state helpers.
 *
 * Layout (repo-local, should be gitignored):
 *
 *   .openspec-fleet/
 *     backlog.md                 # markdown table: id|kind|change|summary|status|updated
 *     captain.md                 # optional prefs
 *     learnings.md               # optional; scribe-appended (firstmate quality flywheel)
 *     quality-log.md             # optional; primary one-line panel telemetry
 *     last-bearings.json         # optional; written by bearings for Recently Landed window
 *     <task-id>/
 *       brief.md
 *       report.md                # scout deliverable
 *       panel-findings.md        # optional; multi-lens synthesis package
 *       revision-note.md         # optional; major-fix note
 *     state/
 *       <task-id>.meta           # key=value (meta is authoritative over .status)
 *       <task-id>.status         # append-only event log
 *
 * Backlog table columns (exact): id, kind, change, summary, status, updated
 *   kind:   ship | scout
 *   status: queued | in_flight | blocked | done | failed | needs_decision
 *   updated: ISO-8601 UTC
 *
 * Meta keys: kind, status, change, cluster, worktree, branch, subagent_id,
 *   merge_phase, awaiting, review, summary,
 *   depends_on, spawn_wave (firstmate spawn waves; optional freeform),
 *   panel_verdict, panel_round, panel_status, revision_note (firstmate multi-lens; freeform OK)
 *   merge_phase: none | ready_to_land | awaiting_approval (legacy dual-read) | merging | merged | conflict_unresolved | aborted
 *   awaiting:    (empty) | merge_approval (legacy dual-read of ready-to-land) | captain_decision | dep_complete
 *   review:      (empty) | pending | approved | needs_changes | failed | skipped
 *   depends_on:  comma-separated 1-based cluster numbers this cluster depends on
 *                (from cluster-tasks), or empty (wave-0 / no deps)
 *   spawn_wave:  non-negative integer wave index (0 = initially spawn-eligible)
 *   awaiting=dep_complete: cluster not yet spawn-eligible; stay queued until each
 *                depends_on cluster has implementer COMPLETE (no live subagent_id yet)
 * write-meta accepts arbitrary key=value pairs (no hard schema validation).
 * Snapshot surfaces known runtime keys including depends_on / spawn_wave / awaiting.
 * quality-log.md is managed via appendQualityLog / append-quality-log (SC5 one-liners).
 * learnings.md / panel-findings / revision-note remain freeform (helpers do not parse them).
 *
 * Ship lifecycle: status=done ONLY after successful merge (merge_phase=merged).
 * After panel APPROVED (closed-loop): write merge_phase=ready_to_land and clear awaiting.
 * Legacy dual-read: merge_phase=awaiting_approval / awaiting=merge_approval ≡ ready_to_land
 * (happy-path readiness — NOT captains_call). Real human gates (ask-before-merge, dual
 * ownership, blockers) MUST set status=needs_decision (or blocked/failed/conflict/…).
 * Scout lifecycle: status=done after STATUS: COMPLETE + report.md (no merge_phase).
 *
 * .status preferred line: ISO8601\t<event>\t<detail> (tab-separated).
 * Freeform lines with a leading ISO-8601 timestamp are acceptable.
 * When bare messages are passed, helpers prefix ISO-8601 UTC.
 *
 * CLI:
 *   node fleet-state.js init [repoRoot]
 *   node fleet-state.js write-meta <taskId> <key=value>... [--repo=<repoRoot>]
 *   node fleet-state.js transition <name> <taskId> [args] [--repo=<repoRoot>]
 *   node fleet-state.js append-status <taskId> <line...> [--repo=<repoRoot>]
 *   node fleet-state.js update-backlog <taskId> --kind= --change= --summary= --status= [--repo=<repoRoot>]
 *   node fleet-state.js append-quality-log --change= --cluster= --rounds= --r1= --major= --override=
 *       [--date=] [--themes=] [--lenses=] [--duration-min=] [--skill-hash=]
 *       [--ade=] [--impl-model=] [--correctness-seat=]
 *       [--repo=<repoRoot>] [--no-emit-telemetry] [--emit-telemetry]
 *   node fleet-state.js quality-summary [repoRoot] [--json] [--repo=<repoRoot>]
 *   node fleet-state.js snapshot [repoRoot]
 *
 * Named transitions (prefer over freeform multi-key write-meta for ship/panel outcomes):
 *   panel-approved | ready-to-land | implementer-complete | panel-needs-changes |
 *   panel-escalated | merge-start | merged
 *
 * Mutating commands accept optional `--repo=<path>` only (no trailing-path peel —
 * freeform status lines often contain worktree paths that must not become repoRoot).
 * Without `--repo=` they use process.cwd() — prefer running from the repo root.
 *
 * backlog.md is owned by formatBacklog/updateBacklog: every upsert rewrites the
 * full file from a fixed template. Freeform notes in backlog.md are not preserved.
 *
 * Gitignore: add `.openspec-fleet/` to the target repo's `.gitignore`.
 */

import { fileURLToPath } from "node:url"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  realpathSync,
} from "node:fs"
import { join, resolve, relative, isAbsolute, sep, dirname, basename } from "node:path"
import { homedir } from "node:os"

export { extractPanelMetrics } from "./panel-metrics.js"

export {
  isImplementerComplete,
  isHappyPathReadiness,
  isCaptainsCall,
  isMergeEligible,
  depsImplementersComplete,
  normalizeReadyToLandPatch,
  TERMINAL_REVIEW_VALUES,
} from "./ship-lifecycle.js"

import {
  isHappyPathReadiness,
  isCaptainsCall,
  normalizeReadyToLandPatch,
} from "./ship-lifecycle.js"

export const FLEET_DIR_NAME = ".openspec-fleet"
export const BACKLOG_HEADER =
  "| id | kind | change | summary | status | updated |"
export const BACKLOG_SEPARATOR =
  "|----|------|--------|---------|--------|---------|"

/** Task ids: alnum start, then alnum / . _ - ; max 64 chars. No path separators. */
export const TASK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

const EMPTY_BACKLOG = `# Fleet backlog

${BACKLOG_HEADER}
${BACKLOG_SEPARATOR}
`

/**
 * Reject hostile or sloppy task ids before joining into FS paths.
 * @param {string} taskId
 * @returns {string} the validated taskId
 */
export function assertValidTaskId(taskId) {
  if (!taskId || typeof taskId !== "string") {
    throw new Error("taskId is required")
  }
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new Error(
      `invalid taskId ${JSON.stringify(taskId)}: must match ${TASK_ID_PATTERN}`
    )
  }
  return taskId
}

/**
 * Assert resolved path stays under fleetRoot (no escape via .. etc.).
 * @param {string} root fleet root
 * @param {string} candidate absolute or joinable path under root
 * @returns {string} resolved path
 */
function assertUnderFleetRoot(root, candidate) {
  const resolvedRoot = resolve(root)
  const resolved = resolve(candidate)
  const rel = relative(resolvedRoot, resolved)
  // Empty rel = same path; absolute rel = different drive (Windows); .. = escape
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)) {
    throw new Error(
      `path escapes fleet root: ${resolved} is outside ${resolvedRoot}`
    )
  }
  return resolved
}

/**
 * Assert repoRoot is a string (path resolution requires a string path).
 * @param {unknown} repoRoot
 * @returns {string}
 */
function assertRepoRootString(repoRoot) {
  if (typeof repoRoot !== "string") {
    throw new Error(
      `repoRoot must be a string, got ${typeof repoRoot}`
    )
  }
  return repoRoot
}

/**
 * Reject meta keys/values that would break key=value line format (injection).
 * @param {string} kind "meta key" | "meta value"
 * @param {unknown} token
 * @returns {string}
 */
function assertMetaLineSafe(kind, token) {
  const s = token == null ? "" : String(token)
  if (/[\n\r\0]/.test(s)) {
    throw new Error(
      `${kind} must not contain newline, CR, or null characters: ${JSON.stringify(s)}`
    )
  }
  return s
}

/**
 * Resolve absolute fleet root under a repo.
 * @param {string} [repoRoot=process.cwd()]
 * @returns {string}
 */
export function fleetRoot(repoRoot = process.cwd()) {
  assertRepoRootString(repoRoot)
  return join(resolve(repoRoot), FLEET_DIR_NAME)
}

/**
 * Create `.openspec-fleet/` layout + empty backlog table if missing.
 * @param {string} [repoRoot=process.cwd()]
 * @returns {{ fleetRoot: string, created: boolean }}
 */
export function createLayout(repoRoot = process.cwd()) {
  const root = fleetRoot(repoRoot)
  const stateDir = join(root, "state")
  const created = !existsSync(root)

  mkdirSync(stateDir, { recursive: true })

  const backlogPath = join(root, "backlog.md")
  if (!existsSync(backlogPath)) {
    writeFileSync(backlogPath, EMPTY_BACKLOG, "utf-8")
  }

  return { fleetRoot: root, created }
}

/**
 * Parse key=value meta file into an object.
 * @param {string} content
 * @returns {Record<string, string>}
 */
export function parseMeta(content) {
  /** @type {Record<string, string>} */
  const out = {}
  if (!content) return out
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    out[key] = value
  }
  return out
}

/**
 * Serialize meta object to key=value lines (stable key order preferred).
 * @param {Record<string, string>} meta
 * @returns {string}
 */
export function formatMeta(meta) {
  const preferred = [
    "kind",
    "status",
    "change",
    "cluster",
    "worktree",
    "branch",
    "subagent_id",
    "merge_phase",
    "awaiting",
    "review",
    "summary",
    // firstmate spawn waves (optional; write-meta accepts arbitrary keys)
    "depends_on",
    "spawn_wave",
  ]
  const keys = [
    ...preferred.filter((k) => Object.prototype.hasOwnProperty.call(meta, k)),
    ...Object.keys(meta)
      .filter((k) => !preferred.includes(k))
      .sort(),
  ]
  return (
    keys
      .map((k) => {
        const key = assertMetaLineSafe("meta key", k)
        const value = assertMetaLineSafe("meta value", meta[k] ?? "")
        return `${key}=${value}`
      })
      .join("\n") + (keys.length ? "\n" : "")
  )
}

function metaPath(root, taskId) {
  assertValidTaskId(taskId)
  return assertUnderFleetRoot(root, join(root, "state", `${taskId}.meta`))
}

function statusPath(root, taskId) {
  assertValidTaskId(taskId)
  return assertUnderFleetRoot(root, join(root, "state", `${taskId}.status`))
}

function taskDir(root, taskId) {
  assertValidTaskId(taskId)
  return assertUnderFleetRoot(root, join(root, taskId))
}

/**
 * Create/update meta keys (merge into existing). Ensures layout + task dir.
 * @param {string} taskId
 * @param {Record<string, string>} pairs
 * @param {string} [repoRoot=process.cwd()]
 * @returns {Record<string, string>}
 */
export function writeMeta(taskId, pairs, repoRoot = process.cwd()) {
  assertValidTaskId(taskId)
  assertRepoRootString(repoRoot)
  if (pairs != null && typeof pairs === "object") {
    for (const [k, v] of Object.entries(pairs)) {
      assertMetaLineSafe("meta key", k)
      if (v !== undefined && v !== null) {
        assertMetaLineSafe("meta value", v)
      }
    }
  }
  const { fleetRoot: root } = createLayout(repoRoot)
  mkdirSync(join(root, "state"), { recursive: true })
  mkdirSync(taskDir(root, taskId), { recursive: true })

  const path = metaPath(root, taskId)
  /** @type {Record<string, string>} */
  let existing = {}
  if (existsSync(path)) {
    existing = parseMeta(readFileSync(path, "utf-8"))
  }
  const merged = { ...existing, ...pairs }
  // Normalize empty values that callers clear
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === null) delete merged[k]
    else merged[k] = String(v)
  }
  writeFileSync(path, formatMeta(merged), "utf-8")
  return merged
}

/**
 * Read meta for a task, or empty object.
 * @param {string} taskId
 * @param {string} [repoRoot]
 * @returns {Record<string, string>}
 */
export function readMeta(taskId, repoRoot = process.cwd()) {
  assertValidTaskId(taskId)
  const path = metaPath(fleetRoot(repoRoot), taskId)
  if (!existsSync(path)) return {}
  return parseMeta(readFileSync(path, "utf-8"))
}

/**
 * Format an ISO-8601 UTC timestamp without milliseconds (design examples).
 * @param {Date} [date]
 * @returns {string}
 */
export function isoNow(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z")
}

/**
 * Ensure a status line has a leading ISO-8601 timestamp.
 * Preferred: ISO8601\t<event>\t<detail>
 * @param {string} line
 * @returns {string}
 */
export function formatStatusLine(line) {
  const raw = String(line ?? "").trimEnd()
  if (!raw) {
    return `${isoNow()}\tevent\t`
  }
  // Already starts with ISO-8601 (date-time)
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) {
    return raw
  }
  // Bare message → prefix ISO + event column when single token-ish, else treat whole as detail
  if (raw.includes("\t")) {
    return `${isoNow()}\t${raw}`
  }
  // "EVENT detail..." or freeform
  const m = raw.match(/^([A-Za-z0-9_.-]+)\s+(.+)$/)
  if (m) {
    return `${isoNow()}\t${m[1]}\t${m[2]}`
  }
  return `${isoNow()}\tevent\t${raw}`
}

/**
 * Append one event line to `.status`. Meta remains authoritative over logs.
 * @param {string} taskId
 * @param {string} line
 * @param {string} [repoRoot=process.cwd()]
 * @returns {string} the line written
 */
export function appendStatus(taskId, line, repoRoot = process.cwd()) {
  assertValidTaskId(taskId)
  const { fleetRoot: root } = createLayout(repoRoot)
  mkdirSync(join(root, "state"), { recursive: true })
  const formatted = formatStatusLine(line)
  const path = statusPath(root, taskId)
  appendFileSync(path, formatted + "\n", "utf-8")
  return formatted
}

/**
 * Escape pipe characters in table cells.
 * @param {string} s
 * @returns {string}
 */
function cell(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
}

/**
 * Unescape `\|` sequences produced by cell().
 * @param {string} s
 * @returns {string}
 */
function uncell(s) {
  return String(s ?? "").replace(/\\\|/g, "|")
}

/**
 * Split a markdown table row on unescaped `|` delimiters.
 * Leading/trailing outer pipes are stripped first.
 * @param {string} line trimmed line starting with |
 * @returns {string[]}
 */
export function splitTableRow(line) {
  let body = line.trim()
  if (body.startsWith("|")) body = body.slice(1)
  // Strip trailing table delimiter, but keep a cell-final escaped pipe (`\|`)
  if (body.endsWith("|") && !body.endsWith("\\|")) {
    body = body.slice(0, -1)
  }
  const cells = []
  let cur = ""
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === "\\" && body[i + 1] === "|") {
      cur += "\\|"
      i++
      continue
    }
    if (ch === "|") {
      cells.push(uncell(cur.trim()))
      cur = ""
      continue
    }
    cur += ch
  }
  cells.push(uncell(cur.trim()))
  return cells
}

/**
 * Parse backlog.md markdown table into row objects.
 * Ignores non-table lines. Header must match required columns.
 * Pipe characters in cells may be written as `\|` and are unescaped on parse.
 * @param {string} content
 * @returns {Array<{id:string,kind:string,change:string,summary:string,status:string,updated:string}>}
 */
export function parseBacklog(content) {
  const rows = []
  if (!content) return rows
  const lines = content.split(/\r?\n/)
  let headerSeen = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("|")) continue
    const parts = splitTableRow(trimmed)
    if (parts.length < 6) continue
    // Separator row
    if (parts.every((p) => /^[-:]+$/.test(p))) {
      headerSeen = true
      continue
    }
    // Header row
    if (
      parts[0].toLowerCase() === "id" &&
      parts[1].toLowerCase() === "kind"
    ) {
      headerSeen = true
      continue
    }
    if (!headerSeen) continue
    rows.push({
      id: parts[0],
      kind: parts[1],
      change: parts[2],
      summary: parts[3],
      status: parts[4],
      updated: parts[5],
    })
  }
  return rows
}

/**
 * Format backlog rows as full markdown file content.
 * Owns the entire file: always rewrites a fixed `# Fleet backlog` + table template.
 * Non-table preamble/footer notes are not preserved — do not store freeform notes
 * in backlog.md (use brief.md, status events, captain.md, or learnings.md).
 * @param {Array<{id:string,kind:string,change:string,summary:string,status:string,updated:string}>} rows
 * @returns {string}
 */
export function formatBacklog(rows) {
  const body = rows
    .map(
      (r) =>
        `| ${cell(r.id)} | ${cell(r.kind)} | ${cell(r.change)} | ${cell(r.summary)} | ${cell(r.status)} | ${cell(r.updated)} |`
    )
    .join("\n")
  return `# Fleet backlog

${BACKLOG_HEADER}
${BACKLOG_SEPARATOR}
${body ? body + "\n" : ""}`
}

/**
 * Upsert a backlog table row by task id. Meta is not auto-synced (callers update both).
 * Rewrites the whole backlog.md via formatBacklog (drops non-table freeform notes).
 * @param {string} taskId
 * @param {{ kind?: string, change?: string, summary?: string, status?: string, updated?: string }} fields
 * @param {string} [repoRoot=process.cwd()]
 * @returns {object} the upserted row
 */
export function updateBacklog(taskId, fields = {}, repoRoot = process.cwd()) {
  assertValidTaskId(taskId)
  const { fleetRoot: root } = createLayout(repoRoot)
  const backlogPath = join(root, "backlog.md")
  const content = existsSync(backlogPath)
    ? readFileSync(backlogPath, "utf-8")
    : EMPTY_BACKLOG
  const rows = parseBacklog(content)
  const idx = rows.findIndex((r) => r.id === taskId)
  const prev = idx >= 0 ? rows[idx] : null
  const row = {
    id: taskId,
    kind: fields.kind ?? prev?.kind ?? "",
    change: fields.change ?? prev?.change ?? "",
    summary: fields.summary ?? prev?.summary ?? "",
    status: fields.status ?? prev?.status ?? "queued",
    updated: fields.updated ?? isoNow(),
  }
  if (idx >= 0) rows[idx] = row
  else rows.push(row)
  writeFileSync(backlogPath, formatBacklog(rows), "utf-8")
  return row
}

// ── Quality log (SC5 one-liners + optional JSONL) ────────────────────────────

export const QUALITY_LOG_ROUNDS = new Set(["1", "2", "esc"])
export const QUALITY_LOG_R1 = new Set([
  "APPROVED",
  "NEEDS_CHANGES",
  "NEEDS_MAJOR_CHANGES",
])
export const QUALITY_LOG_YN = new Set(["y", "n"])

/**
 * Safe change slug for quality-log lines (no whitespace/control chars).
 * Must start with alphanumeric; then alphanumeric, `.`, `_`, `-`, `/` only.
 */
export const QUALITY_LOG_CHANGE_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

/** Default telemetry path when OPENSPEC_TEL_FILE is unset (OpenSpec hook path). */
export function defaultTelemetryPath() {
  return join(homedir(), ".claude", "workflow", ".openspec-telemetry.jsonl")
}

/** Optional trailing enrich keys (space-separated key=value after SC5 core). */
export const QUALITY_LOG_ENRICH_KEYS = [
  "themes",
  "lenses",
  "duration_min",
  "skill_hash",
  "ade",
  "impl_model",
  "correctness_seat",
]

/** Allowed `ade=` enrich values. */
export const QUALITY_LOG_ADE = new Set(["grok", "cursor", "claude"])

/** Allowed `correctness_seat=` enrich values (cycle-1 seat only). */
export const QUALITY_LOG_CORRECTNESS_SEAT = new Set(["sidecar", "spawn"])

/**
 * Sanitize optional enrich value for quality-log token (no whitespace).
 * Empty / whitespace-only → null (omit field).
 * @param {unknown} v
 * @returns {string | null}
 */
export function sanitizeQualityLogEnrichValue(v) {
  if (v === undefined || v === null) return null
  const s = String(v).trim().replace(/\s+/g, "")
  if (!s) return null
  // Reject control chars that would break one-line format
  if (/[\r\n\0]/.test(s)) {
    throw new Error(
      `invalid enrich value ${JSON.stringify(v)}: must not contain newlines or NUL`
    )
  }
  return s
}

/**
 * Validate and normalize quality-log fields (SC5 core + optional enrich).
 * Optional enrich is omitted unless present and non-empty after sanitize.
 * @param {object} fields
 * @returns {{
 *   date: string,
 *   change: string,
 *   cluster: string,
 *   rounds: string,
 *   r1: string,
 *   major: string,
 *   override: string,
 *   themes?: string,
 *   lenses?: string,
 *   duration_min?: string,
 *   skill_hash?: string,
 *   ade?: string,
 *   impl_model?: string,
 *   correctness_seat?: string,
 * }}
 */
export function validateQualityLogFields(fields = {}) {
  const change = String(fields.change ?? "").trim()
  if (!change) {
    throw new Error("change is required (non-empty string)")
  }
  if (!QUALITY_LOG_CHANGE_RE.test(change)) {
    throw new Error(
      `invalid change ${JSON.stringify(fields.change)}: must be a slug (start alphanumeric; then alphanumeric . _ - / only; no whitespace, newlines, CR, or NUL)`
    )
  }

  const clusterRaw = fields.cluster
  if (clusterRaw === undefined || clusterRaw === null || String(clusterRaw).trim() === "") {
    throw new Error("cluster is required (positive integer)")
  }
  const clusterStr = String(clusterRaw).trim()
  if (!/^\d+$/.test(clusterStr) || Number(clusterStr) < 1) {
    throw new Error(
      `invalid cluster ${JSON.stringify(clusterRaw)}: must be a positive integer`
    )
  }

  const rounds = String(fields.rounds ?? "").trim()
  if (!QUALITY_LOG_ROUNDS.has(rounds)) {
    throw new Error(
      `invalid rounds ${JSON.stringify(fields.rounds)}: must be one of 1, 2, esc`
    )
  }

  const r1 = String(fields.r1 ?? "").trim()
  if (!QUALITY_LOG_R1.has(r1)) {
    throw new Error(
      `invalid r1 ${JSON.stringify(fields.r1)}: must be APPROVED, NEEDS_CHANGES, or NEEDS_MAJOR_CHANGES`
    )
  }

  const major = String(fields.major ?? "").trim()
  if (!QUALITY_LOG_YN.has(major)) {
    throw new Error(
      `invalid major ${JSON.stringify(fields.major)}: must be y or n`
    )
  }

  const override = String(fields.override ?? "").trim()
  if (!QUALITY_LOG_YN.has(override)) {
    throw new Error(
      `invalid override ${JSON.stringify(fields.override)}: must be y or n`
    )
  }

  let date = fields.date != null && String(fields.date).trim() !== ""
    ? String(fields.date).trim()
    : new Date().toISOString().slice(0, 10)
  // Accept full ISO datetime; use date prefix only
  if (/^\d{4}-\d{2}-\d{2}T/.test(date)) {
    date = date.slice(0, 10)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(
      `invalid date ${JSON.stringify(fields.date)}: expected ISO-8601 date (YYYY-MM-DD)`
    )
  }

  /** @type {Record<string, string>} */
  const out = {
    date,
    change,
    cluster: String(Number(clusterStr)), // normalize leading zeros
    rounds,
    r1,
    major,
    override,
  }

  // Optional enrich: accept both duration_min and durationMin / skill_hash and skillHash
  const themes = sanitizeQualityLogEnrichValue(
    fields.themes ?? fields.theme
  )
  if (themes != null) out.themes = themes

  const lenses = sanitizeQualityLogEnrichValue(fields.lenses ?? fields.lens)
  if (lenses != null) out.lenses = lenses

  const durationMin = sanitizeQualityLogEnrichValue(
    fields.duration_min ?? fields.durationMin ?? fields["duration-min"]
  )
  if (durationMin != null) {
    if (!/^\d+(\.\d+)?$/.test(durationMin)) {
      throw new Error(
        `invalid duration_min ${JSON.stringify(fields.duration_min ?? fields.durationMin)}: expected non-negative number`
      )
    }
    out.duration_min = durationMin
  }

  const skillHash = sanitizeQualityLogEnrichValue(
    fields.skill_hash ?? fields.skillHash ?? fields["skill-hash"]
  )
  if (skillHash != null) out.skill_hash = skillHash

  const adeRaw = fields.ade
  if (adeRaw !== undefined && adeRaw !== null && String(adeRaw).trim() !== "") {
    const ade = String(adeRaw).trim()
    if (!QUALITY_LOG_ADE.has(ade)) {
      throw new Error(
        `invalid ade ${JSON.stringify(fields.ade)}: must be grok, cursor, or claude`
      )
    }
    out.ade = ade
  }

  const implModel = sanitizeQualityLogEnrichValue(
    fields.impl_model ?? fields.implModel ?? fields["impl-model"]
  )
  if (implModel != null) {
    if (/[\x00-\x1F\x7F]/.test(implModel)) {
      throw new Error(
        `invalid impl_model ${JSON.stringify(fields.impl_model ?? fields.implModel)}: must not contain control characters`
      )
    }
    out.impl_model = implModel
  }

  const seatRaw =
    fields.correctness_seat ?? fields.correctnessSeat ?? fields["correctness-seat"]
  if (seatRaw !== undefined && seatRaw !== null && String(seatRaw).trim() !== "") {
    const seat = String(seatRaw).trim()
    if (!QUALITY_LOG_CORRECTNESS_SEAT.has(seat)) {
      throw new Error(
        `invalid correctness_seat ${JSON.stringify(seatRaw)}: must be sidecar or spawn`
      )
    }
    out.correctness_seat = seat
  }

  return out
}

/**
 * Format SC5 quality-log line (two spaces between fields).
 * Core fields always present in historical order. Optional enrich keys
 * (`themes`, `lenses`, `duration_min`, `skill_hash`, `ade`, `impl_model`,
 * `correctness_seat`) append only when set. Never writes `sidecar_model`.
 * @param {object} fields validated or raw fields
 * @returns {string}
 */
export function formatQualityLogLine(fields) {
  const f = validateQualityLogFields(fields)
  let line = `${f.date}  change=${f.change}  cluster=${f.cluster}  rounds=${f.rounds}  r1=${f.r1}  major=${f.major}  override=${f.override}`
  for (const key of QUALITY_LOG_ENRICH_KEYS) {
    if (f[key] != null && f[key] !== "") {
      line += `  ${key}=${f[key]}`
    }
  }
  return line
}

/**
 * Best-effort emit of firstmate_panel_completed to OpenSpec telemetry JSONL.
 * Never throws.
 * @param {ReturnType<typeof validateQualityLogFields>} fields
 * @param {string} repoRoot
 * @returns {boolean} true if a line was written
 */
export function emitFirstmatePanelTelemetry(fields, repoRoot = process.cwd()) {
  try {
    const telFile =
      process.env.OPENSPEC_TEL_FILE || defaultTelemetryPath()
    mkdirSync(dirname(telFile), { recursive: true })
    const event = {
      ts: new Date().toISOString(),
      repo: basename(resolve(repoRoot)),
      event: "firstmate_panel_completed",
      plugin: "firstmate",
      changeName: fields.change,
      cluster: Number(fields.cluster),
      rounds: fields.rounds,
      r1: fields.r1,
      major: fields.major,
      override: fields.override,
    }
    for (const key of QUALITY_LOG_ENRICH_KEYS) {
      if (fields[key] != null && fields[key] !== "") event[key] = fields[key]
    }
    appendFileSync(telFile, JSON.stringify(event) + "\n", "utf-8")
    return true
  } catch {
    return false
  }
}

/**
 * Append one validated SC5 quality-log line. Creates fleet layout + file if needed.
 * Optionally emits best-effort JSONL telemetry (default: emit).
 * Optional enrich fields (`themes`, `lenses`, `duration_min`, `skill_hash`,
 * `ade`, `impl_model`, `correctness_seat`) trail the core SC5 fields only
 * when provided; core-only remains the default. Never writes `sidecar_model`.
 *
 * @param {{
 *   change: string,
 *   cluster: number|string,
 *   rounds: string,
 *   r1: string,
 *   major: string,
 *   override: string,
 *   date?: string,
 *   themes?: string,
 *   lenses?: string,
 *   duration_min?: string|number,
 *   skill_hash?: string,
 *   ade?: string,
 *   impl_model?: string,
 *   correctness_seat?: string,
 * }} fields
 * @param {string} [repoRoot=process.cwd()]
 * @param {{ emitTelemetry?: boolean }} [opts]
 * @returns {{ line: string, path: string, telemetryEmitted: boolean }}
 */
export function appendQualityLog(fields, repoRoot = process.cwd(), opts = {}) {
  const validated = validateQualityLogFields(fields)
  const { fleetRoot: root } = createLayout(repoRoot)
  const path = join(root, "quality-log.md")
  const line = formatQualityLogLine(validated)
  appendFileSync(path, line + "\n", "utf-8")

  const emitTelemetry = opts.emitTelemetry !== false
  let telemetryEmitted = false
  if (emitTelemetry) {
    telemetryEmitted = emitFirstmatePanelTelemetry(validated, repoRoot)
  }

  return { line, path, telemetryEmitted }
}

/**
 * Parse quality-log.md for (change, cluster) pairs.
 * Ignores trailing enrich keys; works on historical core-only lines.
 * @param {string} content
 * @returns {Set<string>} keys as `change\0cluster`
 */
export function parseQualityLogPairs(content) {
  /** @type {Set<string>} */
  const pairs = new Set()
  if (!content) return pairs
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const changeM = line.match(/\bchange=(\S+)/)
    const clusterM = line.match(/\bcluster=(\d+)/)
    if (changeM && clusterM) {
      pairs.add(`${changeM[1]}\0${String(Number(clusterM[1]))}`)
    }
  }
  return pairs
}

// ── Quality-log parse + quality-summary rollups ──────────────────────────────

/** Baseline window size (SC0 locked convention: first 5 valid lines). */
export const QUALITY_SUMMARY_BASELINE_N = 5

/**
 * Map rounds token to a numeric rank for median calculation.
 * Spec: treat `esc` as ≥2 for median ranking.
 * @param {string} rounds
 * @returns {number | null}
 */
export function roundsRank(rounds) {
  const r = String(rounds ?? "").trim()
  if (r === "1") return 1
  if (r === "2") return 2
  if (r === "esc") return 2
  return null
}

/**
 * Median of a numeric array (average of two middle values when even length).
 * @param {number[]} values
 * @returns {number | null}
 */
export function medianOf(values) {
  if (!values || values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Parse one quality-log line into core SC5 fields (+ optional enrich when present).
 * Core parse ignores unknown trailing keys. Returns null for non-data lines.
 * Never throws.
 *
 * @param {string} line
 * @returns {{
 *   date: string,
 *   change: string,
 *   cluster: string,
 *   rounds: string,
 *   r1: string,
 *   major: string,
 *   override: string,
 *   themes?: string,
 *   lenses?: string,
 *   duration_min?: string,
 *   skill_hash?: string,
 *   ade?: string,
 *   impl_model?: string,
 *   correctness_seat?: string,
 * } | null}
 */
export function parseQualityLogLine(line) {
  try {
    const trimmed = String(line ?? "").trim()
    if (!trimmed || trimmed.startsWith("#")) return null

    /** @type {Record<string, string>} */
    const kv = {}
    for (const m of trimmed.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)=(\S+)/g)) {
      kv[m[1]] = m[2]
    }

    const change = kv.change
    const clusterRaw = kv.cluster
    const rounds = kv.rounds
    const r1 = kv.r1
    const major = kv.major
    const override = kv.override
    if (
      !change ||
      clusterRaw === undefined ||
      !rounds ||
      !r1 ||
      !major ||
      !override
    ) {
      return null
    }
    if (!/^\d+$/.test(clusterRaw) || Number(clusterRaw) < 1) return null
    if (!QUALITY_LOG_ROUNDS.has(rounds)) return null
    if (!QUALITY_LOG_R1.has(r1)) return null
    if (!QUALITY_LOG_YN.has(major)) return null
    if (!QUALITY_LOG_YN.has(override)) return null

    let date = ""
    const dateM = trimmed.match(/^(\d{4}-\d{2}-\d{2})\b/)
    if (dateM) date = dateM[1]
    else if (kv.date && /^\d{4}-\d{2}-\d{2}/.test(kv.date)) {
      date = kv.date.slice(0, 10)
    }

    /** @type {Record<string, string>} */
    const out = {
      date,
      change,
      cluster: String(Number(clusterRaw)),
      rounds,
      r1,
      major,
      override,
    }
    // Capture known enrich keys when present (optional; core ignores if absent)
    for (const key of QUALITY_LOG_ENRICH_KEYS) {
      if (kv[key] != null && kv[key] !== "") out[key] = kv[key]
    }
    return out
  } catch {
    return null
  }
}

/**
 * Parse all valid quality-log lines from file content (order preserved).
 * @param {string} content
 * @returns {Array<NonNullable<ReturnType<typeof parseQualityLogLine>>>}
 */
export function parseQualityLogLines(content) {
  if (!content) return []
  /** @type {Array<NonNullable<ReturnType<typeof parseQualityLogLine>>>} */
  const lines = []
  for (const raw of String(content).split(/\r?\n/)) {
    const parsed = parseQualityLogLine(raw)
    if (parsed) lines.push(parsed)
  }
  return lines
}

/**
 * Compact slice for one enrich key. Lines missing the key are excluded
 * (not coerced to `unknown`). Returns null when no line has the key.
 * @param {Array<Record<string, string>>} lines
 * @param {string} key
 * @returns {Record<string, { n: number, r1ApprovedCount: number, r1ApprovedRate: number, majorCount: number }> | null}
 */
export function sliceQualityLinesByKey(lines, key) {
  const keyed = (lines || []).filter((l) => l && l[key] != null && l[key] !== "")
  if (keyed.length === 0) return null
  /** @type {Map<string, Array<Record<string, string>>>} */
  const buckets = new Map()
  for (const line of keyed) {
    const v = String(line[key])
    if (!buckets.has(v)) buckets.set(v, [])
    buckets.get(v).push(line)
  }
  /** @type {Record<string, { n: number, r1ApprovedCount: number, r1ApprovedRate: number, majorCount: number }>} */
  const out = {}
  for (const [value, group] of buckets) {
    const r = rollupQualityLines(group)
    out[value] = {
      n: r.n,
      r1ApprovedCount: r.r1ApprovedCount,
      r1ApprovedRate: r.r1ApprovedRate,
      majorCount: r.majorCount,
    }
  }
  return out
}

/**
 * Roll up stats for a list of parsed quality-log lines.
 * @param {Array<{ rounds: string, r1: string, major: string, override: string }>} lines
 * @returns {{
 *   n: number,
 *   medianRounds: number | null,
 *   r1ApprovedCount: number,
 *   r1ApprovedRate: number,
 *   majorCount: number,
 *   majorRate: number,
 *   overrideCount: number,
 *   overrideRate: number,
 *   roundsHist: { "1": number, "2": number, "esc": number },
 * }}
 */
export function rollupQualityLines(lines) {
  const n = lines?.length ?? 0
  /** @type {{ "1": number, "2": number, "esc": number }} */
  const roundsHist = { "1": 0, "2": 0, esc: 0 }
  /** @type {number[]} */
  const ranks = []
  let r1ApprovedCount = 0
  let majorCount = 0
  let overrideCount = 0

  for (const line of lines || []) {
    const r = String(line.rounds ?? "")
    if (r === "1" || r === "2" || r === "esc") roundsHist[r]++
    const rank = roundsRank(r)
    if (rank != null) ranks.push(rank)
    if (line.r1 === "APPROVED") r1ApprovedCount++
    if (line.major === "y") majorCount++
    if (line.override === "y") overrideCount++
  }

  const rate = (count) => (n === 0 ? 0 : count / n)

  return {
    n,
    medianRounds: medianOf(ranks),
    r1ApprovedCount,
    r1ApprovedRate: rate(r1ApprovedCount),
    majorCount,
    majorRate: rate(majorCount),
    overrideCount,
    overrideRate: rate(overrideCount),
    roundsHist,
  }
}

/**
 * Summarize quality-log content string (pure; no FS).
 * When n≥5, includes baseline (first 5) and rest windows.
 *
 * @param {string} content
 * @returns {{
 *   n: number,
 *   medianRounds: number | null,
 *   r1ApprovedCount: number,
 *   r1ApprovedRate: number,
 *   majorCount: number,
 *   majorRate: number,
 *   overrideCount: number,
 *   overrideRate: number,
 *   roundsHist: { "1": number, "2": number, "esc": number },
 *   lines: Array<object>,
 *   baseline: ReturnType<typeof rollupQualityLines> | null,
 *   rest: ReturnType<typeof rollupQualityLines> | null,
 * }}
 */
export function summarizeQualityLogContent(content) {
  const lines = parseQualityLogLines(content)
  const overall = rollupQualityLines(lines)
  let baseline = null
  let rest = null
  if (lines.length >= QUALITY_SUMMARY_BASELINE_N) {
    baseline = rollupQualityLines(lines.slice(0, QUALITY_SUMMARY_BASELINE_N))
    rest = rollupQualityLines(lines.slice(QUALITY_SUMMARY_BASELINE_N))
  }
  return {
    ...overall,
    lines,
    baseline,
    rest,
    byAde: sliceQualityLinesByKey(lines, "ade"),
    byCorrectnessSeat: sliceQualityLinesByKey(lines, "correctness_seat"),
    byImplModel: sliceQualityLinesByKey(lines, "impl_model"),
  }
}

/**
 * Compute quality-log rollup metrics for a repo.
 * Reads `.openspec-fleet/quality-log.md`. Missing/empty log → zero/empty state.
 *
 * @param {string} [repoRoot=process.cwd()]
 * @returns {ReturnType<typeof summarizeQualityLogContent>}
 */
export function computeQualitySummary(repoRoot = process.cwd()) {
  const root = fleetRoot(repoRoot)
  const logPath = join(root, "quality-log.md")
  if (!existsSync(logPath)) {
    return summarizeQualityLogContent("")
  }
  try {
    return summarizeQualityLogContent(readFileSync(logPath, "utf-8"))
  } catch {
    return summarizeQualityLogContent("")
  }
}

/**
 * Compact quality summary for snapshot / JSON boards (no full line dump).
 * @param {ReturnType<typeof summarizeQualityLogContent>} summary
 * @returns {object}
 */
export function compactQualitySummary(summary) {
  if (!summary) {
    return {
      n: 0,
      medianRounds: null,
      r1ApprovedCount: 0,
      r1ApprovedRate: 0,
      majorCount: 0,
      majorRate: 0,
      overrideCount: 0,
      overrideRate: 0,
      roundsHist: { "1": 0, "2": 0, esc: 0 },
      baseline: null,
      rest: null,
    }
  }
  const pick = (s) =>
    s
      ? {
          n: s.n,
          medianRounds: s.medianRounds,
          r1ApprovedCount: s.r1ApprovedCount,
          r1ApprovedRate: s.r1ApprovedRate,
          majorCount: s.majorCount,
          majorRate: s.majorRate,
          overrideCount: s.overrideCount,
          overrideRate: s.overrideRate,
          roundsHist: s.roundsHist,
        }
      : null
  /** @type {Record<string, unknown>} */
  const out = {
    n: summary.n,
    medianRounds: summary.medianRounds,
    r1ApprovedCount: summary.r1ApprovedCount,
    r1ApprovedRate: summary.r1ApprovedRate,
    majorCount: summary.majorCount,
    majorRate: summary.majorRate,
    overrideCount: summary.overrideCount,
    overrideRate: summary.overrideRate,
    roundsHist: summary.roundsHist,
    baseline: pick(summary.baseline),
    rest: pick(summary.rest),
  }
  if (summary.byAde) out.byAde = summary.byAde
  if (summary.byCorrectnessSeat) out.byCorrectnessSeat = summary.byCorrectnessSeat
  if (summary.byImplModel) out.byImplModel = summary.byImplModel
  return out
}

/**
 * Format human-readable quality-summary stdout.
 * @param {ReturnType<typeof summarizeQualityLogContent>} summary
 * @returns {string}
 */
export function formatQualitySummaryText(summary) {
  const pct = (rate) => `${(rate * 100).toFixed(1)}%`
  const hist = (h) =>
    `1=${h["1"] ?? 0}  2=${h["2"] ?? 0}  esc=${h.esc ?? 0}`
  const block = (label, s) => {
    if (!s) return `${label}: (none)\n`
    const med =
      s.medianRounds == null ? "n/a" : String(s.medianRounds)
    return (
      `${label} (n=${s.n})\n` +
      `  medianRounds: ${med}  (esc ranked as 2 for median)\n` +
      `  r1 APPROVED: ${s.r1ApprovedCount}/${s.n} (${pct(s.r1ApprovedRate)})\n` +
      `  major: ${s.majorCount}/${s.n} (${pct(s.majorRate)})\n` +
      `  override: ${s.overrideCount}/${s.n} (${pct(s.overrideRate)})\n` +
      `  roundsHist: ${hist(s.roundsHist)}\n`
    )
  }

  let out = block("Overall", summary)
  if (summary.n >= QUALITY_SUMMARY_BASELINE_N && summary.baseline) {
    out += "\n" + block("Baseline (first 5)", summary.baseline)
    out += "\n" + block("Rest (post-baseline)", summary.rest)
  } else if (summary.n === 0) {
    out +=
      "\n(no valid quality-log lines; empty or missing .openspec-fleet/quality-log.md)\n"
  } else {
    out += `\n(baseline window requires n≥${QUALITY_SUMMARY_BASELINE_N}; currently n=${summary.n})\n`
  }

  const sliceBlock = (label, slice) => {
    if (!slice || Object.keys(slice).length === 0) return ""
    let s = `\n${label}\n`
    for (const [value, row] of Object.entries(slice)) {
      const n = row?.n ?? 0
      const r1 = row?.r1ApprovedCount ?? 0
      const rate = row?.r1ApprovedRate ?? 0
      const major = row?.majorCount ?? 0
      s += `  ${value}: n=${n}  r1 APPROVED: ${r1}/${n} (${pct(rate)})  major: ${major}\n`
    }
    return s
  }
  out += sliceBlock("By ade", summary.byAde)
  out += sliceBlock("By correctness_seat", summary.byCorrectnessSeat)
  out += sliceBlock("By impl_model", summary.byImplModel)
  return out
}

/**
 * Whether meta indicates a terminal multi-lens panel outcome.
 * @param {Record<string, string>} meta
 * @returns {boolean}
 */
export function isTerminalQualityPanel(meta) {
  if (!meta || typeof meta !== "object") return false
  const kind = (meta.kind || "").toLowerCase()
  if (kind !== "ship") return false

  const panelStatus = meta.panel_status || ""
  if (panelStatus === "complete" || panelStatus === "escalated") return true

  const panelVerdict = String(meta.panel_verdict || "").trim()
  const mergePhase = meta.merge_phase || ""
  // ready_to_land = forward write; awaiting_approval = legacy dual-read equivalent
  if (
    panelVerdict &&
    (mergePhase === "ready_to_land" ||
      mergePhase === "awaiting_approval" ||
      mergePhase === "merging" ||
      mergePhase === "merged")
  ) {
    return true
  }

  const review = meta.review || ""
  if (panelVerdict && (review === "approved" || review === "failed")) {
    return true
  }

  return false
}

/**
 * Ship tasks with terminal panel meta but no quality-log line for (change, cluster).
 * @param {string} [repoRoot=process.cwd()]
 * @returns {Array<{ taskId: string, change: string, cluster: string, panel_verdict?: string, panel_status?: string, review?: string, merge_phase?: string }>}
 */
export function listUnloggedQualityPanels(repoRoot = process.cwd()) {
  const root = fleetRoot(repoRoot)
  if (!existsSync(root)) return []

  const logPath = join(root, "quality-log.md")
  const logged = existsSync(logPath)
    ? parseQualityLogPairs(readFileSync(logPath, "utf-8"))
    : new Set()

  /** @type {Array<object>} */
  const gaps = []
  const stateDir = join(root, "state")
  if (!existsSync(stateDir)) return gaps

  for (const name of readdirSync(stateDir)) {
    if (!name.endsWith(".meta")) continue
    const taskId = name.slice(0, -".meta".length)
    if (!TASK_ID_PATTERN.test(taskId)) continue
    const meta = parseMeta(readFileSync(join(stateDir, name), "utf-8"))
    if (!isTerminalQualityPanel(meta)) continue

    const change = String(meta.change || "").trim()
    const clusterRaw = String(meta.cluster ?? "").trim()
    if (!change || !/^\d+$/.test(clusterRaw) || Number(clusterRaw) < 1) {
      // Cannot match quality-log without change+cluster; still surface as gap
      gaps.push({
        taskId,
        change: change || "",
        cluster: clusterRaw || "",
        ...(meta.panel_verdict ? { panel_verdict: meta.panel_verdict } : {}),
        ...(meta.panel_status ? { panel_status: meta.panel_status } : {}),
        ...(meta.review ? { review: meta.review } : {}),
        ...(meta.merge_phase ? { merge_phase: meta.merge_phase } : {}),
      })
      continue
    }
    const cluster = String(Number(clusterRaw))
    const key = `${change}\0${cluster}`
    if (logged.has(key)) continue

    gaps.push({
      taskId,
      change,
      cluster,
      ...(meta.panel_verdict ? { panel_verdict: meta.panel_verdict } : {}),
      ...(meta.panel_status ? { panel_status: meta.panel_status } : {}),
      ...(meta.review ? { review: meta.review } : {}),
      ...(meta.merge_phase ? { merge_phase: meta.merge_phase } : {}),
    })
  }

  return gaps
}

/**
 * Whether a task is eligible for recently_landed (without time window).
 * Ship: kind=ship + done + merge_phase=merged.
 * Scout: kind=scout + done (no merge_phase required).
 * Unknown kind never qualifies. Merge-wait / mid-merge never qualify.
 * @param {{ kind?: string, status?: string, merge_phase?: string, awaiting?: string }} t
 * @returns {boolean}
 */
export function isRecentlyLandedEligible(t) {
  const status = t.status || ""
  const mergePhase = t.merge_phase || ""
  const awaiting = t.awaiting || ""
  // Explicit exclusions for merge-wait / mid-merge
  // ready_to_land = forward readiness; awaiting_approval / merge_approval = legacy dual-read
  if (awaiting === "merge_approval") return false
  if (
    mergePhase === "ready_to_land" ||
    mergePhase === "awaiting_approval" ||
    mergePhase === "merging" ||
    mergePhase === "conflict_unresolved"
  ) {
    return false
  }
  if (status !== "done") return false
  const kind = (t.kind || "").toLowerCase()
  if (kind === "ship") {
    return mergePhase === "merged"
  }
  if (kind === "scout") {
    return true
  }
  // unknown / missing kind: not recently landed
  return false
}

// ── Named fleet meta transitions ─────────────────────────────────────────────
// Prefer these over freeform multi-key write-meta for ship/panel lifecycle.
// write-meta remains available for arbitrary keys; transitions compose on it.
// Note: write-meta merge omits do not clear — pass awaiting="" explicitly.

/**
 * Panel APPROVED / ready-to-land: successful multi-lens outcome ready for final-ship land.
 * Writes merge_phase=ready_to_land, explicit empty awaiting, review/panel keys.
 * Does NOT set status=done (ship done only after merge).
 *
 * @param {string} taskId
 * @param {string} [repoRoot=process.cwd()]
 * @param {Record<string, string>} [extra] additional key=value pairs; canonical transition keys always win
 * @returns {Record<string, string>}
 */
export function transitionPanelApproved(taskId, repoRoot = process.cwd(), extra = {}) {
  // Canonical wins over extra (extra must not override status/merge_phase/awaiting/panel_*/review)
  return writeMeta(
    taskId,
    { ...extra, ...normalizeReadyToLandPatch() },
    repoRoot
  )
}

/**
 * Implementer COMPLETE: durable implement=complete + optional summary.
 * Does NOT set status=done (ship done only after merge).
 * When summary is undefined/null, the summary key is omitted so write-meta keeps any existing value.
 *
 * @param {string} taskId
 * @param {string|null|undefined} [summary] omit (undefined/null) to leave existing summary unchanged
 * @param {string} [repoRoot=process.cwd()]
 * @param {Record<string, string>} [extra]
 * @returns {Record<string, string>}
 */
export function transitionImplementerComplete(
  taskId,
  summary,
  repoRoot = process.cwd(),
  extra = {}
) {
  /** @type {Record<string, string>} */
  const canonical = { implement: "complete" }
  if (summary !== undefined && summary !== null) {
    canonical.summary = String(summary)
  }
  // Canonical wins over extra
  return writeMeta(taskId, { ...extra, ...canonical }, repoRoot)
}

/**
 * Panel needs-changes: blocked panel (surgical or major path).
 * Verdict: NEEDS_CHANGES | NEEDS_MAJOR_CHANGES (default NEEDS_CHANGES).
 * Clears stale readiness: merge_phase none if was ready_to_land/awaiting_approval;
 * explicit empty awaiting (not merge_approval).
 *
 * @param {string} taskId
 * @param {string} [verdict="NEEDS_CHANGES"]
 * @param {string} [repoRoot=process.cwd()]
 * @param {Record<string, string>} [extra]
 * @returns {Record<string, string>}
 */
export function transitionPanelNeedsChanges(
  taskId,
  verdict = "NEEDS_CHANGES",
  repoRoot = process.cwd(),
  extra = {}
) {
  const v =
    verdict === "NEEDS_MAJOR_CHANGES" ? "NEEDS_MAJOR_CHANGES" : "NEEDS_CHANGES"
  const existing = readMeta(taskId, repoRoot)
  const mergePhase = existing.merge_phase || ""
  /** @type {Record<string, string>} */
  const canonical = {
    panel_verdict: v,
    review: "needs_changes",
    panel_status: "in_progress",
    awaiting: "",
  }
  if (mergePhase === "ready_to_land" || mergePhase === "awaiting_approval") {
    canonical.merge_phase = "none"
  }
  // Canonical wins over extra
  return writeMeta(taskId, { ...extra, ...canonical }, repoRoot)
}

/**
 * Panel escalated: failed panel after max cycles → captain decision.
 * Sets status=needs_decision, awaiting=captain_decision, review=failed.
 * Clears stale readiness merge_phase if was ready_to_land/awaiting_approval.
 *
 * @param {string} taskId
 * @param {string} [verdict="NEEDS_CHANGES"] non-APPROVED panel_verdict
 * @param {string} [repoRoot=process.cwd()]
 * @param {Record<string, string>} [extra]
 * @returns {Record<string, string>}
 */
export function transitionPanelEscalated(
  taskId,
  verdict = "NEEDS_CHANGES",
  repoRoot = process.cwd(),
  extra = {}
) {
  let v = verdict != null && String(verdict).trim() !== ""
    ? String(verdict)
    : "NEEDS_CHANGES"
  if (v === "APPROVED") v = "NEEDS_CHANGES"
  const existing = readMeta(taskId, repoRoot)
  const mergePhase = existing.merge_phase || ""
  /** @type {Record<string, string>} */
  const canonical = {
    status: "needs_decision",
    panel_status: "escalated",
    review: "failed",
    awaiting: "captain_decision",
    panel_verdict: v,
  }
  if (mergePhase === "ready_to_land" || mergePhase === "awaiting_approval") {
    canonical.merge_phase = "none"
  }
  // Canonical wins over extra
  return writeMeta(taskId, { ...extra, ...canonical }, repoRoot)
}

/**
 * Merge start: record merge_phase=merging while landing.
 * Clears awaiting if it was merge_approval (legacy readiness).
 * Does NOT set status=done.
 *
 * @param {string} taskId
 * @param {string} [repoRoot=process.cwd()]
 * @param {Record<string, string>} [extra]
 * @returns {Record<string, string>}
 */
export function transitionMergeStart(taskId, repoRoot = process.cwd(), extra = {}) {
  const existing = readMeta(taskId, repoRoot)
  /** @type {Record<string, string>} */
  const canonical = { merge_phase: "merging" }
  if ((existing.awaiting || "") === "merge_approval") {
    canonical.awaiting = ""
  }
  // Canonical wins over extra
  return writeMeta(taskId, { ...extra, ...canonical }, repoRoot)
}

/**
 * Merged: successful land — status=done, merge_phase=merged, explicit empty awaiting.
 *
 * @param {string} taskId
 * @param {string} [repoRoot=process.cwd()]
 * @param {Record<string, string>} [extra]
 * @returns {Record<string, string>}
 */
export function transitionMerged(taskId, repoRoot = process.cwd(), extra = {}) {
  // Canonical wins over extra
  return writeMeta(
    taskId,
    {
      ...extra,
      status: "done",
      merge_phase: "merged",
      awaiting: "",
    },
    repoRoot
  )
}

/** Canonical CLI transition names → handler. */
export const TRANSITION_NAMES = Object.freeze([
  "panel-approved",
  "ready-to-land",
  "implementer-complete",
  "panel-needs-changes",
  "panel-escalated",
  "merge-start",
  "merged",
])

/**
 * Dispatch a named transition by CLI-style name.
 * @param {string} name
 * @param {string} taskId
 * @param {{ summary?: string, verdict?: string, extra?: Record<string, string>, repoRoot?: string }} [opts]
 * @returns {Record<string, string>}
 */
export function runTransition(name, taskId, opts = {}) {
  const n = String(name || "").toLowerCase().replace(/_/g, "-")
  const repoRoot = opts.repoRoot ?? process.cwd()
  const extra = opts.extra && typeof opts.extra === "object" ? opts.extra : {}
  switch (n) {
    case "panel-approved":
    case "ready-to-land":
      return transitionPanelApproved(taskId, repoRoot, extra)
    case "implementer-complete":
      // Pass summary through as-is (undefined/null → omit key, keep existing)
      return transitionImplementerComplete(
        taskId,
        opts.summary,
        repoRoot,
        extra
      )
    case "panel-needs-changes":
      return transitionPanelNeedsChanges(
        taskId,
        opts.verdict || "NEEDS_CHANGES",
        repoRoot,
        extra
      )
    case "panel-escalated":
      return transitionPanelEscalated(
        taskId,
        opts.verdict || "NEEDS_CHANGES",
        repoRoot,
        extra
      )
    case "merge-start":
      return transitionMergeStart(taskId, repoRoot, extra)
    case "merged":
      return transitionMerged(taskId, repoRoot, extra)
    default:
      throw new Error(
        `Unknown transition: ${name}. Expected one of: ${TRANSITION_NAMES.join(", ")}`
      )
  }
}

/**
 * Assign task ids into bearings buckets.
 * Happy-path readiness (ready_to_land / legacy awaiting_approval / merge_approval)
 * lands in `underway` even when status is not `in_flight` (e.g. buggy status=done
 * before merge) so packages stay visible and are never unbucketed.
 * @param {Array<object>} tasks
 * @param {{ lastBearingsAt?: string | null, maxLanded?: number }} [opts]
 * @returns {{ captains_call: string[], recently_landed: string[], underway: string[], charted_next: string[] }}
 */
export function assignBuckets(tasks, opts = {}) {
  const maxLanded = opts.maxLanded ?? 20
  const lastAt = opts.lastBearingsAt ?? null

  /** @type {string[]} */
  const captains_call = []
  /** @type {string[]} */
  const underway = []
  /** @type {string[]} */
  const charted_next = []
  /** @type {Array<{ id: string, updated: string }>} */
  const landedCandidates = []

  for (const t of tasks) {
    const id = t.id
    if (!id) continue
    if (isCaptainsCall(t)) {
      captains_call.push(id)
      continue
    }
    // in_flight OR happy-path readiness (even if status drifted to done) → underway
    if (t.status === "in_flight" || isHappyPathReadiness(t)) {
      underway.push(id)
      continue
    }
    if (t.status === "queued") {
      charted_next.push(id)
      continue
    }
    if (isRecentlyLandedEligible(t)) {
      const updated = t.updated || ""
      if (lastAt && updated && updated <= lastAt) {
        // outside window
      } else {
        landedCandidates.push({ id, updated })
      }
    }
  }

  // Sort landed by updated desc, cap
  landedCandidates.sort((a, b) => {
    if (a.updated === b.updated) return 0
    return a.updated < b.updated ? 1 : -1
  })
  const recently_landed = landedCandidates
    .slice(0, maxLanded)
    .map((c) => c.id)

  return { captains_call, recently_landed, underway, charted_next }
}

/**
 * Read optional last-bearings.json `at` timestamp.
 * @param {string} root
 * @returns {string | null}
 */
function readLastBearingsAt(root) {
  const p = join(root, "last-bearings.json")
  if (!existsSync(p)) return null
  try {
    const j = JSON.parse(readFileSync(p, "utf-8"))
    return typeof j.at === "string" ? j.at : null
  } catch {
    return null
  }
}

/**
 * Build structured snapshot of backlog + meta for bearings and recovery.
 * Meta is authoritative when it disagrees with backlog.
 * Read-only: does not create `.openspec-fleet/` layout (use init / createLayout).
 * When the fleet root is missing, returns empty tasks/buckets.
 * Optionally includes compact `qualitySummary` when quality-log exists
 * (null when log absent — never fails snapshot).
 * @param {string} [repoRoot=process.cwd()]
 * @returns {{
 *   fleetRoot: string,
 *   tasks: object[],
 *   buckets: object,
 *   unloggedQualityLog: object[],
 *   qualitySummary: object | null,
 * }}
 */
export function snapshot(repoRoot = process.cwd()) {
  const root = fleetRoot(repoRoot)
  const emptyBuckets = {
    captains_call: [],
    recently_landed: [],
    underway: [],
    charted_next: [],
  }
  if (!existsSync(root)) {
    return {
      fleetRoot: root,
      tasks: [],
      buckets: emptyBuckets,
      unloggedQualityLog: [],
      qualitySummary: null,
    }
  }

  const backlogPath = join(root, "backlog.md")
  const backlogRows = existsSync(backlogPath)
    ? parseBacklog(readFileSync(backlogPath, "utf-8"))
    : []

  /** @type {Map<string, object>} */
  const byId = new Map()

  for (const row of backlogRows) {
    byId.set(row.id, {
      id: row.id,
      kind: row.kind || "",
      change: row.change || "",
      summary: row.summary || "",
      status: row.status || "",
      updated: row.updated || "",
    })
  }

  // Scan state/*.meta for tasks not in backlog + merge meta over backlog
  const stateDir = join(root, "state")
  if (existsSync(stateDir)) {
    for (const name of readdirSync(stateDir)) {
      if (!name.endsWith(".meta")) continue
      const taskId = name.slice(0, -".meta".length)
      // Skip hostile filenames from disk scan (do not throw — read-only recovery)
      if (!TASK_ID_PATTERN.test(taskId)) continue
      const meta = parseMeta(readFileSync(join(stateDir, name), "utf-8"))
      const prev = byId.get(taskId) || {
        id: taskId,
        kind: "",
        change: "",
        summary: "",
        status: "",
        updated: "",
      }
      // Meta is authoritative for status/kind and runtime fields
      const task = {
        ...prev,
        id: taskId,
        kind: meta.kind ?? prev.kind,
        change: meta.change ?? prev.change,
        summary: meta.summary ?? prev.summary,
        status: meta.status ?? prev.status,
      }
      if (meta.cluster !== undefined) task.cluster = meta.cluster
      if (meta.worktree !== undefined) task.worktree = meta.worktree
      if (meta.branch !== undefined) task.branch = meta.branch
      if (meta.subagent_id !== undefined) task.subagent_id = meta.subagent_id
      if (meta.merge_phase !== undefined) task.merge_phase = meta.merge_phase
      if (meta.awaiting !== undefined) task.awaiting = meta.awaiting
      if (meta.review !== undefined) task.review = meta.review
      // Spawn-wave meta (optional firstmate keys; freeform write-meta)
      if (meta.depends_on !== undefined) task.depends_on = meta.depends_on
      if (meta.spawn_wave !== undefined) task.spawn_wave = meta.spawn_wave
      byId.set(taskId, task)
    }
  }

  const tasks = [...byId.values()]
  const lastBearingsAt = readLastBearingsAt(root)
  const buckets = assignBuckets(tasks, { lastBearingsAt })
  const unloggedQualityLog = listUnloggedQualityPanels(repoRoot)

  // Compact qualitySummary when log file exists; null if absent (do not break snapshot)
  const logPath = join(root, "quality-log.md")
  let qualitySummary = null
  if (existsSync(logPath)) {
    try {
      qualitySummary = compactQualitySummary(computeQualitySummary(repoRoot))
    } catch {
      qualitySummary = compactQualitySummary(summarizeQualityLogContent(""))
    }
  }

  return {
    fleetRoot: root,
    tasks,
    buckets,
    unloggedQualityLog,
    qualitySummary,
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

/**
 * Parse `--key=value` and bare `key=value` argv tokens.
 * @param {string[]} args
 * @returns {{ flags: Record<string, string>, pairs: Record<string, string>, positionals: string[] }}
 */
export function parseCliArgs(args) {
  /** @type {Record<string, string>} */
  const flags = {}
  /** @type {Record<string, string>} */
  const pairs = {}
  /** @type {string[]} */
  const positionals = []
  for (const a of args) {
    if (a.startsWith("--")) {
      const body = a.slice(2)
      const eq = body.indexOf("=")
      if (eq > 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1)
      } else {
        flags[body] = "true"
      }
    } else if (a.includes("=")) {
      const eq = a.indexOf("=")
      pairs[a.slice(0, eq)] = a.slice(eq + 1)
    } else {
      positionals.push(a)
    }
  }
  return { flags, pairs, positionals }
}

function usage() {
  return `Usage:
  node fleet-state.js init [repoRoot]
  node fleet-state.js write-meta <taskId> <key=value>... [--repo=<repoRoot>]
  node fleet-state.js transition <name> <taskId> [args] [--repo=<repoRoot>]
      names: panel-approved | ready-to-land | implementer-complete
             panel-needs-changes | panel-escalated | merge-start | merged
      implementer-complete: --summary=... or summary=... (positional summary also ok)
      panel-needs-changes / panel-escalated: --verdict=NEEDS_CHANGES|NEEDS_MAJOR_CHANGES
      extra key=value pairs are merged under the transition patch (canonical wins)
  node fleet-state.js append-status <taskId> <line...> [--repo=<repoRoot>]
  node fleet-state.js update-backlog <taskId> --kind= --change= --summary= --status= [--repo=<repoRoot>]
  node fleet-state.js append-quality-log --change= --cluster= --rounds= --r1= --major= --override=
      [--date=] [--themes=] [--lenses=] [--duration-min=] [--skill-hash=]
      [--ade=] [--impl-model=] [--correctness-seat=]
      [--repo=<repoRoot>] [--no-emit-telemetry]
  node fleet-state.js quality-summary [repoRoot] [--json] [--repo=<repoRoot>]
  node fleet-state.js snapshot [repoRoot]
`
}

/**
 * Resolve optional repo root from CLI flags only (`--repo=<path>`).
 * Does **not** peel trailing positionals — freeform `append-status` lines often
 * include worktree paths that must remain part of the log line.
 * @param {{ flags: Record<string, string>, positionals: string[] }} parsed
 * @param {string} [fallback=process.cwd()]
 * @returns {{ repoRoot: string, positionals: string[] }}
 */
export function resolveCliRepoRoot(parsed, fallback = process.cwd()) {
  if (parsed.flags.repo) {
    return { repoRoot: parsed.flags.repo, positionals: parsed.positionals }
  }
  return { repoRoot: fallback, positionals: parsed.positionals }
}

/**
 * CLI main. Returns exit code.
 * @param {string[]} argv process.argv slice from command name
 * @returns {number}
 */
export function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv
  if (!cmd) {
    process.stderr.write(usage())
    return 2
  }
  try {
    switch (cmd) {
      case "init": {
        const repoRoot = rest[0] || process.cwd()
        const result = createLayout(repoRoot)
        process.stdout.write(
          JSON.stringify({ ok: true, ...result }) + "\n"
        )
        return 0
      }
      case "write-meta": {
        const taskId = rest[0]
        if (!taskId) {
          process.stderr.write("write-meta requires <taskId>\n")
          return 2
        }
        const parsed = parseCliArgs(rest.slice(1))
        const { repoRoot, positionals } = resolveCliRepoRoot(parsed)
        // positionals after taskId should not appear for write-meta (pairs only)
        void positionals
        if (Object.keys(parsed.pairs).length === 0) {
          process.stderr.write("write-meta requires at least one key=value\n")
          return 2
        }
        const meta = writeMeta(taskId, parsed.pairs, repoRoot)
        process.stdout.write(JSON.stringify({ ok: true, taskId, meta }) + "\n")
        return 0
      }
      case "transition": {
        const name = rest[0]
        const taskId = rest[1]
        if (!name || !taskId) {
          process.stderr.write(
            "transition requires <name> <taskId>\n" + usage()
          )
          return 2
        }
        const parsed = parseCliArgs(rest.slice(2))
        const { repoRoot, positionals } = resolveCliRepoRoot(parsed)
        /** @type {Record<string, string>} */
        const extra = { ...parsed.pairs }
        const n = String(name || "").toLowerCase().replace(/_/g, "-")
        /** @type {string|undefined} */
        let summary
        /** @type {string|undefined} */
        let verdict
        // Only strip summary= for implementer-complete (positional summary too)
        if (n === "implementer-complete") {
          summary =
            parsed.flags.summary !== undefined
              ? parsed.flags.summary
              : extra.summary
          if (summary !== undefined) delete extra.summary
          if (
            (summary === undefined || summary === "") &&
            positionals.length > 0
          ) {
            summary = positionals.join(" ")
          }
        }
        // Only strip verdict= for panel-needs-changes / panel-escalated
        if (n === "panel-needs-changes" || n === "panel-escalated") {
          verdict =
            parsed.flags.verdict !== undefined
              ? parsed.flags.verdict
              : extra.verdict
          if (verdict !== undefined) delete extra.verdict
        }
        try {
          const meta = runTransition(name, taskId, {
            summary,
            verdict,
            extra,
            repoRoot,
          })
          process.stdout.write(
            JSON.stringify({ ok: true, transition: name, taskId, meta }) + "\n"
          )
          return 0
        } catch (err) {
          process.stderr.write(`transition: ${err.message}\n`)
          return 2
        }
      }
      case "append-status": {
        const taskId = rest[0]
        if (!taskId) {
          process.stderr.write("append-status requires <taskId>\n")
          return 2
        }
        const parsed = parseCliArgs(rest.slice(1))
        const { repoRoot, positionals } = resolveCliRepoRoot(parsed)
        const line = positionals.join(" ")
        if (!line) {
          process.stderr.write("append-status requires a line\n")
          return 2
        }
        const written = appendStatus(taskId, line, repoRoot)
        process.stdout.write(JSON.stringify({ ok: true, taskId, line: written }) + "\n")
        return 0
      }
      case "update-backlog": {
        const taskId = rest[0]
        if (!taskId) {
          process.stderr.write("update-backlog requires <taskId>\n")
          return 2
        }
        const parsed = parseCliArgs(rest.slice(1))
        const { repoRoot } = resolveCliRepoRoot(parsed)
        const fields = {}
        if (parsed.flags.kind !== undefined) fields.kind = parsed.flags.kind
        if (parsed.flags.change !== undefined) fields.change = parsed.flags.change
        if (parsed.flags.summary !== undefined) fields.summary = parsed.flags.summary
        if (parsed.flags.status !== undefined) fields.status = parsed.flags.status
        if (parsed.flags.updated !== undefined) fields.updated = parsed.flags.updated
        const row = updateBacklog(taskId, fields, repoRoot)
        process.stdout.write(JSON.stringify({ ok: true, row }) + "\n")
        return 0
      }
      case "append-quality-log": {
        const parsed = parseCliArgs(rest)
        const { repoRoot } = resolveCliRepoRoot(parsed)
        const f = parsed.flags
        if (
          f.change === undefined ||
          f.cluster === undefined ||
          f.rounds === undefined ||
          f.r1 === undefined ||
          f.major === undefined ||
          f.override === undefined
        ) {
          process.stderr.write(
            "append-quality-log requires --change= --cluster= --rounds= --r1= --major= --override=\n"
          )
          return 2
        }
        let emitTelemetry = true
        if (f["no-emit-telemetry"] === "true") emitTelemetry = false
        if (f["emit-telemetry"] === "true") emitTelemetry = true
        try {
          /** @type {Record<string, string|undefined>} */
          const fields = {
            change: f.change,
            cluster: f.cluster,
            rounds: f.rounds,
            r1: f.r1,
            major: f.major,
            override: f.override,
            date: f.date,
          }
          // Optional enrich (trailing only; omit keeps core-only SC5 line)
          if (f.themes !== undefined) fields.themes = f.themes
          if (f.lenses !== undefined) fields.lenses = f.lenses
          if (f["duration-min"] !== undefined) {
            fields.duration_min = f["duration-min"]
          }
          if (f["skill-hash"] !== undefined) {
            fields.skill_hash = f["skill-hash"]
          }
          if (f.ade !== undefined) fields.ade = f.ade
          if (f["impl-model"] !== undefined) fields.impl_model = f["impl-model"]
          if (f["correctness-seat"] !== undefined) {
            fields.correctness_seat = f["correctness-seat"]
          }
          const result = appendQualityLog(fields, repoRoot, { emitTelemetry })
          process.stdout.write(
            JSON.stringify({
              ok: true,
              line: result.line,
              path: result.path,
              telemetryEmitted: result.telemetryEmitted,
            }) + "\n"
          )
          return 0
        } catch (err) {
          // Validation errors → exit 2 with explanation; no line written
          process.stderr.write(`append-quality-log: ${err.message}\n`)
          return 2
        }
      }
      case "quality-summary": {
        const parsed = parseCliArgs(rest)
        const { repoRoot, positionals } = resolveCliRepoRoot(parsed)
        // Prefer --repo=; else first positional; else cwd (same style as snapshot)
        const root =
          parsed.flags.repo != null
            ? repoRoot
            : positionals[0] || process.cwd()
        const summary = computeQualitySummary(root)
        if (parsed.flags.json === "true") {
          process.stdout.write(
            JSON.stringify({
              ok: true,
              repoRoot: resolve(root),
              ...compactQualitySummary(summary),
            }) + "\n"
          )
        } else {
          process.stdout.write(formatQualitySummaryText(summary))
        }
        return 0
      }
      case "snapshot": {
        const repoRoot = rest[0] || process.cwd()
        const snap = snapshot(repoRoot)
        process.stdout.write(JSON.stringify(snap) + "\n")
        return 0
      }
      default:
        process.stderr.write(`Unknown command: ${cmd}\n${usage()}`)
        return 2
    }
  } catch (err) {
    process.stderr.write(`fleet-state.js failed: ${err.message}\n`)
    return 1
  }
}

/**
 * True when this module is the process entrypoint.
 * Resolves relative argv[1] and realpaths so `node .grok/lib/fleet-state.js …`
 * and Windows path variants still run CLI main.
 * @returns {boolean}
 */
export function isMainInvocation() {
  try {
    if (!process.argv[1]) return false
    const self = fileURLToPath(import.meta.url)
    const entry = resolve(process.argv[1])
    if (self === entry) return true
    try {
      return realpathSync(self) === realpathSync(entry)
    } catch {
      // One side missing / unreadable — fall back to resolved-path compare only
      return self === entry
    }
  } catch {
    return false
  }
}

if (isMainInvocation()) {
  process.exit(main(process.argv.slice(2)))
}
