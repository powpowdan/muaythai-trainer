#!/usr/bin/env node
// Per-change correctness ledger: parse/serialize, test-path heuristic, hash,
// stale-write ignore, and the firstmate green predicate.
// Deployed by the installer hooks walk (not shared/lib / CLAUDE_LIB_FILES).
//
// Cycle-1 skip is invalid when correctness-ledger.md itself is in the cluster
// diff: an implementer-authored PASS+hash is untrusted input, not an
// independent review. Hash-match ≠ independent correctness seat.

import { createHash, randomBytes } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path"
import { fileURLToPath } from "node:url"

export const LEDGER_FILENAME = "correctness-ledger.md"
export const HASH_HEX_LEN = 16
export const HASH_FILE_MAX_BYTES = 8 * 1024 * 1024

const CHANGE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/i
const VERDICTS = new Set(["PASS", "FAIL", "PENDING"])
const TABLE_HEADER_RE = /^\|\s*test\s*\|\s*verdict\s*\|\s*hash\s*\|\s*updated\s*\|$/i
const TABLE_SEP_RE = /^\|[\s-:|]+\|$/
const TABLE_ROW_RE =
  /^\|\s*([^|]+?)\s*\|\s*(PASS|FAIL|PENDING)\s*\|\s*([0-9a-fA-F]+)\s*\|\s*([^|]+?)\s*\|$/i

/** Single-segment OpenSpec change names only — reject traversal before join. */
export function isSafeChangeName(changeName) {
  return (
    typeof changeName === "string" &&
    changeName.length > 0 &&
    !changeName.includes("..") &&
    !changeName.includes("/") &&
    !changeName.includes("\\") &&
    CHANGE_NAME_RE.test(changeName)
  )
}

/** Normalize separators for comparisons; does not resolve on disk. */
export function toPosixRel(p) {
  return String(p ?? "").replace(/\\/g, "/")
}

/** Strip leading `./` and collapse `/./` so `./foo.test.mjs` ≡ `foo.test.mjs`. */
export function normalizeRelPath(p) {
  let s = toPosixRel(p).trim()
  if (!s) return ""
  while (s.startsWith("./")) s = s.slice(2)
  s = s.replace(/\/\.\//g, "/")
  if (s === ".") return ""
  return s
}

/** Refuse `..`, absolute, NUL, and extra-tree rel paths (logical check). */
export function isSafeTestRelPath(relPath) {
  if (typeof relPath !== "string" || !relPath || relPath.includes("\0")) return false
  if (isAbsolute(relPath)) return false
  if (/^[a-zA-Z]:[\\/]/.test(relPath)) return false
  const n = normalizeRelPath(relPath)
  if (!n || isAbsolute(n) || /^[a-zA-Z]:[\\/]/.test(n)) return false
  if (n.split("/").some((seg) => seg === "..")) return false
  return true
}

/**
 * Treat as a test file when the path matches any of (case-insensitive):
 * `*.test.*`, `*.spec.*`, `*_test.*`, a `__tests__` segment, or a `tests` segment.
 * The ledger file, `node_modules`, and `__test_*` temp segments do not match.
 */
export function isTestFilePath(filePath) {
  if (typeof filePath !== "string" || !filePath) return false
  const posix = normalizeRelPath(filePath) || toPosixRel(filePath)
  if (!posix || posix === "." || posix === "..") return false
  const segments = posix.split("/").filter((s) => s && s !== ".")
  if (segments.length === 0) return false
  if (segments.some((s) => s === ".." || s === "node_modules")) return false
  if (segments.some((s) => s.toLowerCase().startsWith("__test_"))) return false
  const base = segments[segments.length - 1]
  if (base.toLowerCase() === LEDGER_FILENAME) return false

  const lowerSegs = segments.map((s) => s.toLowerCase())
  if (lowerSegs.some((s) => s === "__tests__" || s === "tests")) return true

  const lowerBase = base.toLowerCase()
  if (lowerBase.includes(".test.")) return true
  if (lowerBase.includes(".spec.")) return true
  if (/_test\./i.test(base)) return true
  return false
}

/**
 * Filter a full cluster-diff path list to test files.
 * Callers MUST pass the complete diff (tests and non-tests); this is the
 * only binding that prevents a test-only subset from hiding omitted files.
 */
export function collectTestPathsFromList(paths) {
  const seen = new Set()
  const out = []
  for (const raw of Array.isArray(paths) ? paths : []) {
    if (typeof raw !== "string" || !raw) continue
    const n = normalizeRelPath(raw)
    if (!isTestFilePath(n) && !isTestFilePath(raw)) continue
    const key = n || toPosixRel(raw)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

/** SHA-256 hex truncated to 16 chars (design D6). */
export function hashContent(content) {
  const buf = Buffer.isBuffer(content)
    ? content
    : Buffer.from(content ?? "", "utf-8")
  return createHash("sha256").update(buf).digest("hex").slice(0, HASH_HEX_LEN)
}

/**
 * Hash a regular file only. Symlinks/junctions/dirs are refused.
 * Reads are capped at `maxBytes` (default HASH_FILE_MAX_BYTES).
 */
export function hashFile(absPath, { maxBytes = HASH_FILE_MAX_BYTES } = {}) {
  if (typeof absPath !== "string" || !absPath) return null
  try {
    const st = lstatSync(absPath)
    if (st.isSymbolicLink() || !st.isFile()) return null
    const cap = Number(maxBytes)
    if (!Number.isFinite(cap) || st.size > cap) return null
    return hashContent(readFileSync(absPath))
  } catch {
    return null
  }
}

function tryRealpath(absPath) {
  try {
    return realpathSync(absPath)
  } catch {
    return null
  }
}

function isInsideRoot(rootAbs, candidateAbs) {
  const root = resolve(rootAbs)
  const cand = resolve(candidateAbs)
  if (root === cand) return true
  const rel = relative(root, cand)
  return Boolean(rel) && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep)
}

/** True when an existing symlink/junction ancestor resolves outside `treeReal`. */
function symlinkAncestorEscapes(treeReal, absPath) {
  let cur = resolve(absPath)
  const root = resolve(treeReal)
  const seen = new Set()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    if (existsSync(cur)) {
      try {
        const st = lstatSync(cur)
        if (st.isSymbolicLink()) {
          const real = tryRealpath(cur)
          if (!real || !isInsideRoot(root, real)) return true
        }
      } catch {
        return true
      }
    }
    if (cur === root || cur === dirname(cur)) break
    cur = dirname(cur)
  }
  return false
}

/**
 * Resolve the ledger file under `<tree>/openspec/changes/<change>/`.
 * Refuses symlink/junction escape. Optional mkdir of the change folder.
 */
export function resolveAllowedLedgerFile(tree, changeName, { mkdir = false } = {}) {
  if (typeof tree !== "string" || !tree) return null
  if (!isSafeChangeName(changeName)) return null
  if (!existsSync(tree)) return null
  const treeReal = tryRealpath(tree)
  if (!treeReal) return null

  const changeDir = join(resolve(tree), "openspec", "changes", changeName)
  const file = join(changeDir, LEDGER_FILENAME)

  if (symlinkAncestorEscapes(treeReal, file)) return null
  if (existsSync(changeDir)) {
    const changeReal = tryRealpath(changeDir)
    if (!changeReal || !isInsideRoot(treeReal, changeReal)) return null
  }

  if (mkdir) {
    mkdirSync(changeDir, { recursive: true })
    if (symlinkAncestorEscapes(treeReal, file)) return null
    const changeReal = tryRealpath(changeDir)
    if (!changeReal || !isInsideRoot(treeReal, changeReal)) return null
  }

  if (existsSync(file)) {
    try {
      const st = lstatSync(file)
      if (st.isSymbolicLink()) {
        const dest = tryRealpath(file)
        const changeReal = tryRealpath(changeDir)
        if (!dest || !changeReal) return null
        if (!isInsideRoot(treeReal, dest) || !isInsideRoot(changeReal, dest)) return null
      } else {
        const dest = tryRealpath(file)
        if (!dest || !isInsideRoot(treeReal, dest)) return null
      }
    } catch {
      return null
    }
  }

  return file
}

/** Resolve rel under tree; null if it escapes the tree. */
export function resolveUnderTree(tree, relPath) {
  if (typeof tree !== "string" || !tree) return null
  if (!isSafeTestRelPath(relPath)) return null
  const root = resolve(tree)
  const abs = resolve(root, relPath)
  const rel = relative(root, abs)
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)) return null
  return abs
}

export function ledgerPath(tree, changeName) {
  if (typeof tree !== "string" || !tree) return null
  if (!isSafeChangeName(changeName)) return null
  return join(tree, "openspec", "changes", changeName, LEDGER_FILENAME)
}

function looksHighOrMedium(text) {
  const t = String(text ?? "")
  if (/\[SEVERITY:\s*(high|medium)\]/i.test(t)) return true
  if (/\[(?:HIGH|MEDIUM)(?:\/[^\]]*)?\]/i.test(t)) return true
  if (/\bseverity\s*[:=]\s*(high|medium)\b/i.test(t)) return true
  if (/(?:^|[\s*])(?:HIGH|MEDIUM)\s*[:—-]/i.test(t)) return true
  if (/\b(high|medium)\s+(severity|finding|risk|issue)\b/i.test(t)) return true
  if (/\b(severity|finding|risk|issue)\s+(high|medium)\b/i.test(t)) return true
  return false
}

function severityFromFinding(f) {
  if (typeof f === "string") {
    const tagged = f.match(/\[SEVERITY:\s*(high|medium|low)\]/i)
    if (tagged) return tagged[1].toLowerCase()
    if (looksHighOrMedium(f)) return "high"
    return "unknown"
  }
  if (f && typeof f === "object") {
    const sev = String(f.severity ?? "").toLowerCase()
    if (sev === "high" || sev === "medium" || sev === "low") return sev
    const text = String(f.text ?? f.message ?? f.finding ?? f.title ?? "")
    if (looksHighOrMedium(`${sev} ${text}`)) return "high"
    return "unknown"
  }
  return "unknown"
}

/**
 * PASS when there are no high/medium findings (low-only allowed).
 * FAIL when any finding is high or medium.
 * Fail-closed: unknown / untagged wording is FAIL, never PASS.
 */
export function verdictFromFindings(findings) {
  const list = Array.isArray(findings) ? findings : []
  if (list.length === 0) return "PASS"
  for (const f of list) {
    const sev = severityFromFinding(f)
    if (sev === "high" || sev === "medium") return "FAIL"
    if (sev === "low") continue
    return "FAIL"
  }
  return "PASS"
}

function escapeCell(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
}

function unescapeCell(s) {
  return String(s).replace(/\\\|/g, "|").replace(/\\\\/g, "\\")
}

function escapeFinding(s) {
  return String(s)
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
}

function unescapeFinding(s) {
  return String(s).replace(/\\\|/g, "|")
}

function normalizeRow(row) {
  const verdict = String(row?.verdict ?? "").toUpperCase()
  return {
    path: normalizeRelPath(row?.path ?? ""),
    verdict: VERDICTS.has(verdict) ? verdict : "PENDING",
    hash: String(row?.hash ?? "").toLowerCase(),
    updated: String(row?.updated ?? ""),
    findings: Array.isArray(row?.findings) ? row.findings.map(String) : [],
  }
}

/**
 * Parse only the ledger table section (header → first non-row).
 * Injected `| PASS |` lines in findings or prose are ignored.
 */
export function parseLedger(markdown) {
  const rows = []
  const byPath = new Map()
  let inTable = false
  let tableDone = false
  let currentPath = null

  for (const rawLine of String(markdown ?? "").split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "")

    if (!tableDone) {
      if (TABLE_HEADER_RE.test(line)) {
        inTable = true
        continue
      }
      if (inTable && TABLE_SEP_RE.test(line)) continue
      if (inTable) {
        const table = line.match(TABLE_ROW_RE)
        if (table) {
          const path = normalizeRelPath(unescapeCell(table[1].trim()))
          if (!path || path.toLowerCase() === "test") continue
          const row = normalizeRow({
            path,
            verdict: table[2],
            hash: table[3],
            updated: table[4].trim(),
            findings: [],
          })
          rows.push(row)
          byPath.set(row.path, row)
          continue
        }
        inTable = false
        tableDone = true
      }
    }

    const heading = line.match(/^##\s+(.+?)\s*$/)
    if (heading) {
      currentPath = normalizeRelPath(unescapeCell(heading[1].trim()))
      continue
    }
    if (currentPath && /^\s*-\s+/.test(line)) {
      const row = byPath.get(currentPath)
      if (row) row.findings.push(unescapeFinding(line.replace(/^\s*-\s+/, "")))
    }
  }

  return { rows }
}

export function serializeLedger(ledger) {
  const rows = Array.isArray(ledger?.rows) ? ledger.rows.map(normalizeRow) : []
  const lines = [
    "# Correctness ledger",
    "",
    "| test | verdict | hash | updated |",
    "|------|---------|------|---------|",
  ]
  for (const r of rows) {
    lines.push(
      `| ${escapeCell(r.path)} | ${r.verdict} | ${r.hash} | ${escapeCell(r.updated)} |`
    )
  }
  for (const r of rows) {
    if (!r.findings.length) continue
    lines.push("")
    lines.push(`## ${escapeCell(r.path)}`)
    lines.push("")
    for (const f of r.findings) {
      lines.push(`- ${escapeFinding(String(f).replace(/^- /, ""))}`)
    }
  }
  lines.push("")
  return lines.join("\n")
}

function atomicWriteFile(dest, content) {
  const dir = dirname(dest)
  const tmp = join(
    dir,
    `.${basename(dest)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  )
  writeFileSync(tmp, content, "utf-8")
  try {
    renameSync(tmp, dest)
  } catch {
    try {
      copyFileSync(tmp, dest)
    } finally {
      try {
        unlinkSync(tmp)
      } catch {
        // best-effort
      }
    }
  }
}

export function readLedger(tree, changeName) {
  const file = resolveAllowedLedgerFile(tree, changeName, { mkdir: false })
  if (!file || !existsSync(file)) return { rows: [] }
  try {
    return parseLedger(readFileSync(file, "utf-8"))
  } catch {
    return { rows: [] }
  }
}

/**
 * Replace the ledger on disk. Each incoming row is dropped (existing kept)
 * when `ignoreStaleWrite` says its hash does not match the on-disk test file.
 */
export function writeLedger(tree, changeName, ledger) {
  const file = resolveAllowedLedgerFile(tree, changeName, { mkdir: true })
  if (!file) return false

  const incoming = Array.isArray(ledger?.rows) ? ledger.rows.map(normalizeRow) : []
  const existing = readLedger(tree, changeName)
  const existingByPath = new Map(existing.rows.map((r) => [r.path, r]))
  const rows = []
  for (const row of incoming) {
    if (!row.path || !isSafeTestRelPath(row.path)) continue
    if (ignoreStaleWrite(tree, row.path, row.hash)) {
      const prev = existingByPath.get(row.path)
      if (prev) rows.push(prev)
      continue
    }
    rows.push(row)
  }

  atomicWriteFile(file, serializeLedger({ rows }))
  const writtenReal = tryRealpath(file)
  const treeReal = tryRealpath(tree)
  if (!writtenReal || !treeReal || !isInsideRoot(treeReal, writtenReal)) return false
  return true
}

/**
 * A write whose hash does not match the current on-disk file MUST be ignored.
 * Missing file or unreadable path is treated as stale.
 * @returns {boolean} true when the write must be dropped
 */
export function ignoreStaleWrite(tree, testRelPath, writeHash) {
  if (typeof writeHash !== "string" || !writeHash) return true
  const abs = resolveUnderTree(tree, testRelPath)
  if (!abs) return true
  const current = hashFile(abs)
  return current == null || current !== writeHash
}

/** Upsert a row unless ignoreStaleWrite says the hash is stale. Atomic write. */
export function writeLedgerRow(tree, changeName, row) {
  const incoming = normalizeRow(row)
  if (!incoming.path || !isSafeChangeName(changeName)) {
    return { ignored: true }
  }
  if (!isSafeTestRelPath(incoming.path) || resolveUnderTree(tree, incoming.path) == null) {
    return { ignored: true }
  }
  if (ignoreStaleWrite(tree, incoming.path, incoming.hash)) {
    return { ignored: true }
  }
  const ledger = readLedger(tree, changeName)
  const rows = ledger.rows.filter((r) => r.path !== incoming.path)
  rows.push(incoming)
  const ok = writeLedger(tree, changeName, { rows })
  return { ignored: !ok }
}

function rowIsStale(tree, row) {
  const current = hashFile(resolveUnderTree(tree, row.path) || "")
  return current == null || current !== row.hash
}

function isLedgerArtifactPath(p) {
  const n = normalizeRelPath(p)
  const segs = n.split("/").filter(Boolean)
  const base = (segs[segs.length - 1] || "").toLowerCase()
  return base === LEDGER_FILENAME
}

function rowFindingsAreCleanPass(row) {
  return verdictFromFindings(row.findings) === "PASS"
}

/**
 * Cycle-1 skip predicate.
 *
 * `changedPaths` is the **full cluster diff** (tests and non-tests), e.g.
 * `git diff --name-only` vs merge-base/`main`. Internally filtered with
 * `isTestFilePath`. Callers MUST NOT pass a test-only subset when other
 * test files appear in the same diff — omitted never-reviewed tests are
 * then invisible (caller contract). CLI: prefer `--diff=`; `--tests=`
 * must already be the complete `isTestFilePath` list from that diff.
 *
 * Green when every listed test path has a matching-hash PASS whose
 * findings are free of high/medium (fail-closed), and no FAIL / PENDING
 * / stale row remains for a path still in that set. Empty changed-test
 * list is not green. Leftover FAIL/PENDING/stale rows for paths **not**
 * in `changedPaths` do not block (deleted-file leftovers).
 *
 * Skip is invalid when `correctness-ledger.md` is in `changedPaths`.
 */
export function isCorrectnessLedgerGreen(tree, changeName, changedPaths) {
  if (!isSafeChangeName(changeName)) return false
  if (typeof tree !== "string" || !tree) return false
  const listed = Array.isArray(changedPaths) ? changedPaths : []

  if (listed.some(isLedgerArtifactPath)) return false

  const testPaths = collectTestPathsFromList(listed)
  if (testPaths.length === 0) return false

  const testSet = new Set(testPaths)
  const ledger = readLedger(tree, changeName)
  const byPath = new Map(ledger.rows.map((r) => [normalizeRelPath(r.path), r]))

  for (const p of testPaths) {
    const row = byPath.get(normalizeRelPath(p))
    if (!row || row.verdict !== "PASS") return false
    if (!rowFindingsAreCleanPass(row)) return false
    if (rowIsStale(tree, row)) return false
  }

  for (const row of ledger.rows) {
    const p = normalizeRelPath(row.path)
    if (!testSet.has(p) || !isTestFilePath(p)) continue
    if (row.verdict === "FAIL" || row.verdict === "PENDING") return false
    if (rowIsStale(tree, row)) return false
    if (row.verdict === "PASS" && !rowFindingsAreCleanPass(row)) return false
  }

  return true
}

/** Alias: callers pass the raw git-diff path list (not a test-only subset). */
export function isCorrectnessLedgerGreenFromDiff(tree, changeName, allDiffPaths) {
  return isCorrectnessLedgerGreen(tree, changeName, allDiffPaths)
}

function parseFlags(args) {
  const flags = {}
  for (const a of args) {
    if (!a.startsWith("--")) continue
    const eq = a.indexOf("=")
    if (eq === -1) {
      flags[a.slice(2)] = true
      continue
    }
    flags[a.slice(2, eq)] = a.slice(eq + 1)
  }
  return flags
}

function splitPathList(raw) {
  if (typeof raw !== "string" || !raw) return []
  return raw.split(",").map((s) => s.trim()).filter(Boolean)
}

/**
 * CLI: `node correctness-ledger.mjs green --tree= --change= --diff=a,b`
 * `--diff=` MUST be the full cluster diff (tests and non-tests).
 * `--tests=` is the test list and MUST already be complete; it is unioned
 * with `--diff=` when both are set.
 */
export function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv
  if (cmd !== "green") {
    process.stderr.write(
      "Usage: node correctness-ledger.mjs green --tree=<dir> --change=<name> --diff=a,b [--tests=a,b]\n"
    )
    return 2
  }
  const flags = parseFlags(rest)
  const tree = typeof flags.tree === "string" && flags.tree ? flags.tree : process.cwd()
  const change = typeof flags.change === "string" ? flags.change : ""
  const diff = splitPathList(flags.diff)
  const tests = splitPathList(flags.tests)
  const changedPaths = diff.length > 0 ? [...diff, ...tests] : tests
  const green = isCorrectnessLedgerGreen(tree, change, changedPaths)
  process.stdout.write(JSON.stringify({ green }) + "\n")
  return green ? 0 : 1
}

const isMainModule =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMainModule) {
  process.exit(main())
}
