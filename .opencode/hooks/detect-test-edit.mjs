#!/usr/bin/env node
// PostToolUse hook: arm a correctness sidecar when a test file is edited
// under an active OpenSpec change. Never blocks (always exit 0). Never writes
// propose/apply pending-review state — that stays in detect.mjs + Stop.
//
// Installer: `node detect-test-edit.mjs grok` with matcher
// `search_replace|Write|Edit|MultiEdit`.
//
// Ledger module is cluster-1: load dynamically so a missing file still exits 0.

import { existsSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative, resolve, isAbsolute, sep } from "node:path"
import { fileURLToPath } from "node:url"

const FILE_EDIT_TOOLS = new Set(["search_replace", "write", "edit", "multiedit"])

const PATH_KEYS = ["file_path", "filePath", "path", "file", "target_file", "targetFile"]

const CHANGE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/i
const DISPATCH_WORKTREES = ".dispatch-worktrees"

let ledgerMod = undefined

function isSafeChangeName(changeName) {
  return (
    typeof changeName === "string" &&
    changeName.length > 0 &&
    !changeName.includes("..") &&
    !changeName.includes("/") &&
    !changeName.includes("\\") &&
    CHANGE_NAME_RE.test(changeName)
  )
}

function toPosixRel(p) {
  return String(p ?? "").replace(/\\/g, "/")
}

function resolveUnderTree(tree, relPath) {
  if (typeof tree !== "string" || !tree) return null
  if (typeof relPath !== "string" || !relPath) return null
  if (relPath.includes("\0")) return null
  const root = resolve(tree)
  const abs = resolve(root, relPath)
  const rel = relative(root, abs)
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)) return null
  return abs
}

async function loadLedgerModule() {
  if (ledgerMod !== undefined) return ledgerMod
  try {
    ledgerMod = await import("./correctness-ledger.mjs")
  } catch (err) {
    console.error(
      "detect-test-edit: correctness-ledger.mjs unavailable; fail-open",
      err && err.message ? err.message : err,
    )
    ledgerMod = null
  }
  return ledgerMod
}

function isFileEditTool(toolName) {
  return typeof toolName === "string" && FILE_EDIT_TOOLS.has(toolName.toLowerCase())
}

function pushPath(out, value) {
  if (typeof value === "string" && value && !value.includes("\0")) out.push(value)
}

/** Collect edited paths from Grok/Claude file-edit payloads (tolerant keys). */
export function extractEditedPaths(toolInput = {}) {
  const out = []
  if (!toolInput || typeof toolInput !== "object") return out
  for (const key of PATH_KEYS) pushPath(out, toolInput[key])
  const edits = toolInput.edits || toolInput.Edits
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (!edit || typeof edit !== "object") continue
      for (const key of PATH_KEYS) pushPath(out, edit[key])
    }
  }
  return [...new Set(out)]
}

function isEmptyResult(value) {
  if (value == null) return true
  if (typeof value === "string") return !value.trim()
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === "object") return Object.keys(value).length === 0
  return false
}

function resultFieldLooksFailed(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  if (value.error || value.toolError || value.tool_error) return true
  if (value.is_error === true || value.isError === true) return true
  if (value.success === false || value.ok === false) return true
  return false
}

/**
 * Ignore unsuccessful / empty tool results when the payload has an error or
 * result field. Missing those fields is treated as success (unit callers).
 */
export function isUnsuccessfulOrEmptyToolResult(payload) {
  if (!payload || typeof payload !== "object") return false
  if (payload.error || payload.toolError || payload.tool_error) return true
  if (payload.is_error === true || payload.isError === true) return true
  if (payload.success === false || payload.ok === false) return true

  const resultKeys = ["result", "tool_response", "toolResponse", "tool_result", "toolResult"]
  for (const key of resultKeys) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) continue
    const value = payload[key]
    if (isEmptyResult(value) || resultFieldLooksFailed(value)) return true
  }
  return false
}

function listActiveChanges(tree) {
  if (typeof tree !== "string" || !tree) return []
  const changesDir = join(tree, "openspec", "changes")
  if (!existsSync(changesDir)) return []
  let entries
  try {
    entries = readdirSync(changesDir, { withFileTypes: true })
  } catch {
    return []
  }
  const names = []
  for (const ent of entries) {
    const name = ent.name
    if (name === "archive") continue
    if (!isSafeChangeName(name)) continue
    try {
      if (!ent.isDirectory()) continue
    } catch {
      continue
    }
    names.push(name)
  }
  return names
}

/** Walk parents until `openspec/changes` exists. */
export function findOpenSpecTree(start) {
  if (typeof start !== "string" || !start) return null
  let dir
  try {
    dir = resolve(start)
  } catch {
    return null
  }
  const seen = new Set()
  while (dir && !seen.has(dir)) {
    seen.add(dir)
    const changesDir = join(dir, "openspec", "changes")
    try {
      if (existsSync(changesDir) && statSync(changesDir).isDirectory()) return dir
    } catch {
      // keep walking
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

export function changeNameFromDispatchPath(p) {
  if (typeof p !== "string" || !p) return null
  let resolved
  try {
    resolved = resolve(p)
  } catch {
    return null
  }
  const segs = toPosixRel(resolved).split("/").filter(Boolean)
  const i = segs.lastIndexOf(DISPATCH_WORKTREES)
  if (i === -1 || i + 1 >= segs.length) return null
  const name = segs[i + 1]
  return isSafeChangeName(name) ? name : null
}

function pickOwningChange(tree, cwd, projectDir) {
  const active = listActiveChanges(tree)
  if (active.length === 0) return null
  const fromPath =
    changeNameFromDispatchPath(cwd) || changeNameFromDispatchPath(projectDir)
  if (fromPath && active.includes(fromPath)) return fromPath
  if (active.length === 1) return active[0]
  return null
}

/**
 * Owning change: `.dispatch-worktrees/<change>/…` when that dir exists, else
 * the sole active change. Multiple active dirs with no owner → null (no row).
 */
export function resolveActiveOpenSpecChange(cwd, projectDir) {
  const tree =
    findOpenSpecTree(cwd) ||
    (projectDir && projectDir !== cwd ? findOpenSpecTree(projectDir) : null)
  if (!tree) return null
  const changeName = pickOwningChange(tree, cwd, projectDir)
  if (!changeName) return null
  return { changeName, tree }
}

/**
 * Relativize an edited path to `tree`; null if it escapes.
 * Relative paths resolve against `cwd` (payload cwd), then must stay under tree.
 */
export function toTreeRelativePath(raw, tree, cwd = tree) {
  if (typeof raw !== "string" || !raw || typeof tree !== "string" || !tree) return null
  if (raw.includes("\0")) return null
  const root = resolve(tree)
  const base = typeof cwd === "string" && cwd ? cwd : tree
  let abs
  try {
    abs = isAbsolute(raw) ? resolve(raw) : resolve(base, raw)
  } catch {
    return null
  }
  const rel = relative(root, abs)
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)) return null
  return toPosixRel(rel)
}

function readExistingRows(ledger, tree, changeName) {
  if (typeof ledger.readLedger === "function") {
    try {
      return ledger.readLedger(tree, changeName)
    } catch {
      return { rows: [] }
    }
  }
  return { rows: [] }
}

function writePendingRows(ledger, tree, changeName, relPaths) {
  let pendingWritten = false
  const updated = new Date().toISOString()
  const existing = readExistingRows(ledger, tree, changeName)
  const byPath = new Map((existing.rows || []).map((r) => [r.path, r]))

  for (const rel of relPaths) {
    const abs = resolveUnderTree(tree, rel)
    const hash = abs ? ledger.hashFile(abs) : null
    if (!hash) continue
    const prev = byPath.get(rel)
    if (
      prev &&
      prev.hash === hash &&
      (prev.verdict === "PASS" || prev.verdict === "FAIL")
    ) {
      continue
    }
    try {
      const result = ledger.writeLedgerRow(tree, changeName, {
        path: rel,
        verdict: "PENDING",
        hash,
        updated,
      })
      if (!result.ignored) pendingWritten = true
    } catch {
      // fail-open
    }
  }
  return pendingWritten
}

/**
 * Detect a test-file edit under an active OpenSpec change.
 * MAY write ledger PENDING. MUST NOT write propose/apply pending-review state.
 *
 * @returns {Promise<{ armed: true, path: string, paths: string[], changeName: string, tree: string, pendingWritten: boolean } | null>}
 */
export async function detectTestEdit(toolName, toolInput = {}, { ade, projectDir, cwd, payload } = {}) {
  void ade
  try {
    if (!isFileEditTool(toolName)) return null
    if (isUnsuccessfulOrEmptyToolResult(payload)) return null

    const ledger = await loadLedgerModule()
    if (!ledger || typeof ledger.isTestFilePath !== "function") return null

    const active = resolveActiveOpenSpecChange(cwd, projectDir)
    if (!active) return null

    const { changeName, tree } = active
    const matched = []
    for (const raw of extractEditedPaths(toolInput)) {
      const rel = toTreeRelativePath(raw, tree, cwd)
      if (!rel || !ledger.isTestFilePath(rel)) continue
      matched.push(rel)
    }
    if (matched.length === 0) return null

    const pendingWritten = writePendingRows(ledger, tree, changeName, matched)
    return {
      armed: true,
      path: matched[0],
      paths: matched,
      changeName,
      tree,
      pendingWritten,
    }
  } catch {
    return null
  }
}

function readStdin() {
  return new Promise((done) => {
    let data = ""
    process.stdin.setEncoding("utf-8")
    process.stdin.on("data", (chunk) => (data += chunk))
    process.stdin.on("end", () => done(data))
    process.stdin.on("error", () => done(data))
  })
}

/** Grok camelCase + Claude snake_case PostToolUse payloads. */
export function normalizeFileEditPayload(payload = {}, adeFromArgv = null) {
  const toolName = payload.toolName || payload.tool_name || null
  const toolInput = payload.toolInput || payload.tool_input || {}
  const projectDir =
    payload.workspaceRoot ||
    payload.workspace_roots?.[0] ||
    payload.workspaceRoots?.[0] ||
    payload.projectDir ||
    process.env.GROK_WORKSPACE_ROOT ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd()
  const cwd = payload.cwd || process.cwd()
  const ade =
    adeFromArgv ||
    (typeof payload.toolName === "string" || payload.workspaceRoot ? "grok" : "claude")
  return { ade, toolName, toolInput, projectDir, cwd }
}

async function main() {
  try {
    const raw = await readStdin()
    if (!raw || !String(raw).trim()) {
      process.exit(0)
    }
    let payload
    try {
      payload = JSON.parse(raw)
    } catch {
      process.exit(0)
    }
    const ledger = await loadLedgerModule()
    if (!ledger) {
      process.exit(0)
    }
    const adeFromArgv = process.argv[2] || null
    const { ade, toolName, toolInput, projectDir, cwd } = normalizeFileEditPayload(
      payload,
      adeFromArgv,
    )
    await detectTestEdit(toolName, toolInput, { ade, projectDir, cwd, payload })
  } catch {
    // fail-open
  }
  process.exit(0)
}

const isMainModule =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMainModule) {
  main()
}
