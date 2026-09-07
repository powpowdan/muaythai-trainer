#!/usr/bin/env node
// Coalesce test-file edits and launch a detached headless grok correctness
// sidecar. Never blocks the writer. Fail-open. Ledger writes stay in the
// edit tree (worktree cwd), via correctness-ledger helpers.

import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
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
import {
  detectTestEdit,
  normalizeFileEditPayload,
  resolveActiveOpenSpecChange,
  toTreeRelativePath,
} from "./detect-test-edit.mjs"
import {
  hashFile,
  isSafeChangeName,
  isTestFilePath,
  readLedger,
  resolveUnderTree,
  toPosixRel,
  verdictFromFindings,
  writeLedgerRow,
} from "./correctness-ledger.mjs"
import { logEvent } from "./lib.mjs"
import {
  allowlistedAdeModel,
  pinableAdeSlug,
  resolveAdeModel,
} from "./resolve-model.mjs"

export const DEFAULT_QUIET_MS = 12_000
export const READONLY_TOOLS = "read_file,grep,list_dir"
export const DISALLOWED_TOOLS =
  "search_replace,Write,Edit,MultiEdit,run_terminal_command,Bash"
export const THIS_FILE = fileURLToPath(import.meta.url)

/** In-process waiter handles so tests can stub spawn and await coalesce. */
const inProcessWaiters = new Map()
/** Optional test override so unit tests do not write the real telemetry home. */
let sidecarTestLogEvent = null

export function setSidecarTestLogEvent(fn) {
  sidecarTestLogEvent = typeof fn === "function" ? fn : null
}

export function getQuietMs(env = process.env) {
  const raw = env?.OPENSPEC_CORRECTNESS_QUIET_MS
  if (raw == null || raw === "") return DEFAULT_QUIET_MS
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_QUIET_MS
  return Math.floor(n)
}

export function tryRealpath(p) {
  if (typeof p !== "string" || !p) return p
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

export function sidecarStateDir(tree) {
  const root = tryRealpath(tree)
  const fleet = join(root, ".openspec-fleet")
  if (existsSync(fleet)) return join(fleet, "correctness-sidecar")
  const h = createHash("sha256").update(String(root)).digest("hex").slice(0, 16)
  return join(tmpdir(), "openspec-correctness", h)
}

function sanitizeFileToken(s) {
  return String(s ?? "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80)
}

export function sidecarStatePath(tree, relPath) {
  const posix = toPosixRel(relPath)
  const digest = createHash("sha256").update(posix).digest("hex").slice(0, 12)
  const base = sanitizeFileToken(basename(posix)) || "path"
  return join(sidecarStateDir(tree), `${base}.${digest}.json`)
}

function hasDotDotSegment(p) {
  return String(p ?? "")
    .split(/[\\/]/)
    .includes("..")
}

function posixPath(p) {
  return String(p ?? "").replace(/\\/g, "/")
}

function isUnderDir(abs, root) {
  if (!abs || !root) return false
  const a = posixPath(abs)
  const r = posixPath(root).replace(/\/+$/, "")
  return a === r || a.startsWith(r + "/")
}

/**
 * Realpath-allowlist a waiter `--state=` path. Must be a `.json` file under
 * `<tree>/.openspec-fleet/correctness-sidecar/` or
 * `<tmpdir>/openspec-correctness/`. Refuses `..`, extra-tree, and non-json.
 */
export function resolveAllowedStatePath(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null
  const trimmed = raw.trim()
  if (trimmed.includes("\0")) return null
  if (hasDotDotSegment(trimmed)) return null
  if (!/\.json$/i.test(trimmed)) return null

  const abs = tryRealpath(trimmed)
  if (!abs || hasDotDotSegment(abs) || !/\.json$/i.test(abs)) return null
  if (abs.includes("\0")) return null

  const posix = posixPath(abs)
  const tmpRoot = tryRealpath(join(tmpdir(), "openspec-correctness"))
  if (tmpRoot && isUnderDir(abs, tmpRoot) && posix !== posixPath(tmpRoot)) {
    return abs
  }
  if (/\/\.openspec-fleet\/correctness-sidecar\/[^/]+\.json$/i.test(posix)) {
    return abs
  }
  return null
}

/**
 * Confine a launch path: resolveUnderTree must succeed AND isTestFilePath.
 * Realpath both sides and refuse symlink escape. Never a substitute hash.
 */
export function confineLaunchPath(tree, relPath) {
  if (typeof tree !== "string" || !tree) return null
  const rel = toPosixRel(relPath)
  if (!rel || !isTestFilePath(rel)) return null
  const abs = resolveUnderTree(tree, rel)
  if (!abs) return null
  const root = tryRealpath(tree)
  const real = tryRealpath(abs)
  if (!root || !real) return null
  const relToRoot = relative(root, real)
  if (
    !relToRoot ||
    isAbsolute(relToRoot) ||
    relToRoot === ".." ||
    relToRoot.startsWith(".." + sep)
  ) {
    return null
  }
  return { tree: root, abs: real, rel: toPosixRel(relToRoot) }
}

export function waiterKey(tree, relPath) {
  return `${tryRealpath(tree)}::${toPosixRel(relPath)}`
}

function nonEmptyString(v) {
  if (typeof v !== "string") return null
  const s = v.trim()
  return s ? s : null
}

function recordedSidecarModel(resolved) {
  const allowed = allowlistedAdeModel(resolved?.model)
  if (!allowed || resolved?.source === "unknown") return "unknown"
  return allowed
}

function sidecarResolvedModel(state = {}, opts = {}, deps = {}) {
  const resolve = typeof deps.resolveAdeModel === "function" ? deps.resolveAdeModel : resolveAdeModel
  // Session lookup cwd is payload/session cwd only — never the confined edit-tree.
  return resolve({
    payloadModel: nonEmptyString(opts.payloadModel) || nonEmptyString(state.payloadModel),
    cwd: nonEmptyString(opts.sessionCwd) || nonEmptyString(state.sessionCwd),
    sessionId: nonEmptyString(opts.sessionId) || nonEmptyString(state.sessionId),
    passed: nonEmptyString(opts.passedModel) || nonEmptyString(state.passedModel),
    sessionPathFor: deps.sessionPathFor,
  })
}

/**
 * Fail-open sidecar JSONL via hook logEvent. Never throws.
 * Sidecar events always include model (slug or unknown).
 */
export function emitSidecarEvent(name, fields = {}, deps = {}) {
  try {
    const emit =
      typeof deps.logEvent === "function"
        ? deps.logEvent
        : sidecarTestLogEvent || logEvent
    /** @type {Record<string, unknown>} */
    const event = {
      event: name,
      plugin: "correctness-sidecar",
    }
    const ade = nonEmptyString(fields.ade)
    const changeName = nonEmptyString(fields.changeName)
    const pathVal = nonEmptyString(fields.path)
    const reason = nonEmptyString(fields.reason)
    const verdict = nonEmptyString(fields.verdict)
    if (ade) event.ade = ade
    if (changeName) event.changeName = changeName
    if (pathVal) event.path = pathVal
    if (reason) event.reason = reason
    if (verdict) event.verdict = verdict
    event.model = allowlistedAdeModel(fields.model) || "unknown"
    emit(event)
  } catch {
    // fail-open
  }
}

function defaultNow() {
  return Date.now()
}

function defaultSleep(ms) {
  const n = Math.max(0, Number(ms) || 0)
  if (n === 0) return Promise.resolve()
  return new Promise((r) => setTimeout(r, n))
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readStateFile(file) {
  try {
    if (!file || !existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, "utf-8"))
    return parsed && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}

function writeStateFile(file, state) {
  const allowed = resolveAllowedStatePath(file)
  if (!allowed) return false
  mkdirSync(dirname(allowed), { recursive: true })
  writeFileSync(allowed, JSON.stringify(state, null, 2) + "\n", "utf-8")
  return true
}

function reviewedLedgerRow(tree, changeName, rel, hash) {
  if (!hash) return null
  const { rows } = readLedger(tree, changeName)
  const row = rows.find((r) => r.path === toPosixRel(rel))
  if (!row || row.hash !== hash) return null
  if (row.verdict !== "PASS" && row.verdict !== "FAIL") return null
  return row
}

function writePendingRow(tree, changeName, rel, hash) {
  if (!hash || reviewedLedgerRow(tree, changeName, rel, hash)) return
  try {
    writeLedgerRow(tree, changeName, {
      path: toPosixRel(rel),
      verdict: "PENDING",
      hash,
      updated: new Date().toISOString(),
      findings: [],
    })
  } catch {
    // fail-open
  }
}

export function buildCorrectnessBrief({ cwd, path: relPath, changeName }) {
  return [
    "You are a cold staff-engineer reviewer (CORRECTNESS lens only). You did NOT write this code.",
    `Worktree: \`${cwd}\`. Change: \`${changeName}\`. Cluster: sidecar. Panel round: 1.`,
    `Scope: the edited test file \`${relPath}\` and the production code it covers.`,
    "Read the test file and the production files it imports or covers. Do not review unrelated tree. Do not run shell or git.",
    "Severity: High (logic errors, breaking changes, crash paths); Medium (edge cases, weak contracts/tests); Low (style/nits).",
    "You MUST NOT modify test files or application source. Highlight only. Read-only tools only.",
    "Return ONLY correctness findings with [SEVERITY: high|medium|low]. No merge. No panel verdict.",
    'If there are no findings, print "No findings."',
  ].join("\n")
}

/**
 * Headless `grok -p` argv. Shape is `-p`, brief, then optional `-m`, slug.
 * Never insert `-m` between `-p` and the brief (Grok treats that as the prompt).
 * Pin only an allowlisted slug (not inherit/unknown/invalid). Unknown → no `-m`.
 * @param {string} brief
 * @param {string} [model]
 * @returns {string[]}
 */
export function grokLaunchArgs(brief, model) {
  const args = ["-p", brief]
  const slug = pinableAdeSlug(model)
  if (slug) args.push("-m", slug)
  args.push(
    "--tools",
    READONLY_TOOLS,
    "--disallowed-tools",
    DISALLOWED_TOOLS,
    "--permission-mode",
    "bypassPermissions",
    "--sandbox",
    "read-only",
  )
  return args
}

export function detachedWaiterSpawnArgs(statePath) {
  return {
    command: process.execPath,
    args: [THIS_FILE, "wait", `--state=${statePath}`],
    options: {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    },
  }
}

export function parseSidecarFindings(stdout) {
  const findings = []
  for (const raw of String(stdout ?? "").split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (!/\[SEVERITY:\s*(high|medium|low)\]/i.test(line)) continue
    findings.push(line.replace(/^[-*]\s+/, ""))
  }
  return findings
}

/**
 * Empty / untagged / null-exit stdout is not parseable and MUST NOT be PASS.
 * Explicit "No findings." with status 0 is a successful empty review.
 */
export function interpretSidecarStdout(stdout, status) {
  if (status == null) {
    return { ok: false, reason: "null-exit", write: false, findings: [] }
  }
  if (status !== 0) {
    return { ok: false, reason: "nonzero-exit", status, write: false, findings: [] }
  }
  const text = String(stdout ?? "")
  if (!text.trim()) {
    return { ok: false, reason: "empty-stdout", write: false, findings: [] }
  }
  const findings = parseSidecarFindings(text)
  if (findings.length === 0 && !/\bno findings\.?\b/i.test(text)) {
    return { ok: false, reason: "unparseable", write: false, findings: [] }
  }
  return { ok: true, reason: null, write: true, findings }
}

export function mergeFindingsIntoLedger(tree, changeName, relPath, hash, findings) {
  const list = Array.isArray(findings) ? findings.map(String) : []
  return writeLedgerRow(tree, changeName, {
    path: toPosixRel(relPath),
    verdict: verdictFromFindings(list),
    hash,
    updated: new Date().toISOString(),
    findings: list,
  })
}

function defaultSpawnGrok({ command, args, cwd, onSpawn }) {
  return new Promise((resolvePromise, reject) => {
    let child
    let settled = false
    let spawned = false
    try {
      child = spawn(command, args, {
        cwd,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (err) {
      reject(err)
      return
    }
    const markSpawned = () => {
      if (spawned) return
      spawned = true
      if (typeof onSpawn === "function") {
        try {
          onSpawn(child)
        } catch {
          // fail-open
        }
      }
    }
    // 'spawn' means the child actually started; 'error' without spawn is ENOENT.
    child.once("spawn", markSpawned)
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (d) => {
      stdout += d
    })
    child.stderr?.on("data", (d) => {
      stderr += d
    })
    child.on("error", (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      resolvePromise({ status: code, stdout, stderr })
    })
  })
}

/**
 * Spawn headless `grok -p` (read-only tools) and merge stdout into the
 * edit-tree ledger. Fail-open if grok is missing or the child errors.
 */
export async function launchSidecar(opts = {}, deps = {}) {
  let modelSlug = "unknown"
  try {
    const resolved = sidecarResolvedModel({}, opts, deps)
    modelSlug = recordedSidecarModel(resolved)
    if (typeof deps.launch === "function") {
      return await deps.launch(opts, deps)
    }
    const cwd = tryRealpath(opts.cwd || opts.tree || process.cwd())
    const changeName = opts.changeName
    const confined = confineLaunchPath(cwd, opts.path || "")
    if (!isSafeChangeName(changeName)) {
      emitSidecarEvent(
        "correctness_sidecar_skipped",
        {
          ade: opts.ade,
          changeName,
          path: opts.path,
          reason: "bad-args",
          model: modelSlug,
        },
        deps,
      )
      return { ok: false, reason: "bad-args" }
    }
    // Re-check allowlist even when opts.hash is set. Never use a hash
    // as a substitute for a confined path (escaped state.path).
    if (!confined) {
      emitSidecarEvent(
        "correctness_sidecar_skipped",
        {
          ade: opts.ade,
          changeName,
          path: opts.path,
          reason: "path-not-allowed",
          model: modelSlug,
        },
        deps,
      )
      return { ok: false, reason: "path-not-allowed" }
    }
    const hash = hashFile(confined.abs)
    if (!hash) {
      emitSidecarEvent(
        "correctness_sidecar_skipped",
        {
          ade: opts.ade,
          changeName,
          path: confined.rel,
          reason: "no-hash",
          model: modelSlug,
        },
        deps,
      )
      return { ok: false, reason: "no-hash" }
    }

    const brief = buildCorrectnessBrief({
      cwd: confined.tree,
      path: confined.rel,
      changeName,
    })
    const spawnGrok = deps.spawnGrok || defaultSpawnGrok
    let launchedEmitted = false
    const emitLaunched = () => {
      if (launchedEmitted) return
      launchedEmitted = true
      emitSidecarEvent(
        "correctness_sidecar_launched",
        {
          ade: opts.ade,
          changeName,
          path: confined.rel,
          model: modelSlug,
        },
        deps,
      )
    }
    let result
    try {
      result = await spawnGrok({
        command: "grok",
        args: grokLaunchArgs(brief, modelSlug),
        cwd: confined.tree,
        onSpawn: emitLaunched,
      })
    } catch (err) {
      const reason = err?.code === "ENOENT" ? "grok-missing" : "launch-failed"
      emitSidecarEvent(
        "correctness_sidecar_skipped",
        {
          ade: opts.ade,
          changeName,
          path: confined.rel,
          reason,
          model: modelSlug,
        },
        deps,
      )
      return {
        ok: false,
        reason,
        error: err,
      }
    }
    // Stubs that resolve without calling onSpawn still count as a successful spawn.
    if (!launchedEmitted) emitLaunched()

    const interpreted = interpretSidecarStdout(result?.stdout, result?.status)
    if (!interpreted.write) {
      emitSidecarEvent(
        "correctness_sidecar_skipped",
        {
          ade: opts.ade,
          changeName,
          path: confined.rel,
          reason: interpreted.reason,
          model: modelSlug,
        },
        deps,
      )
      return {
        ok: false,
        reason: interpreted.reason,
        status: interpreted.status ?? result?.status,
        findings: interpreted.findings,
      }
    }

    const written = mergeFindingsIntoLedger(
      confined.tree,
      changeName,
      confined.rel,
      hash,
      interpreted.findings,
    )
    const verdict = verdictFromFindings(interpreted.findings)
    emitSidecarEvent(
      "correctness_sidecar_completed",
      {
        ade: opts.ade,
        changeName,
        path: confined.rel,
        verdict,
        model: modelSlug,
      },
      deps,
    )
    return {
      ok: !written?.ignored,
      verdict,
      findings: interpreted.findings,
      ignored: !!written?.ignored,
    }
  } catch (err) {
    emitSidecarEvent(
      "correctness_sidecar_skipped",
      {
        ade: opts.ade,
        changeName: opts.changeName,
        path: opts.path,
        reason: "launch-failed",
        model: modelSlug,
      },
      deps,
    )
    return { ok: false, reason: "launch-failed", error: err }
  }
}

export function spawnDetachedWaiter(statePath, extra = {}) {
  const allowed = resolveAllowedStatePath(statePath)
  if (!allowed) {
    throw new Error("state-path-not-allowed")
  }
  const spec = detachedWaiterSpawnArgs(allowed)
  const child = spawn(spec.command, spec.args, {
    ...spec.options,
    env: extra.env || process.env,
    cwd: extra.cwd || process.cwd(),
  })
  child.on("error", () => {})
  child.unref()
  return child
}

function waiterIsLive(state, key, deps) {
  if (deps.inProcess) return inProcessWaiters.has(key)
  if (typeof deps.isPidAlive === "function") return !!deps.isPidAlive(state?.waiterPid)
  return isPidAlive(state?.waiterPid)
}

async function finishSidecar(statePath, deps) {
  const state = readStateFile(statePath)
  if (!state) return { ok: true, followUp: false }
  const confined = confineLaunchPath(state.cwd, state.path)
  const currentHash = confined ? hashFile(confined.abs) : null
  const needsFollowUp =
    !!state.dirty && !!currentHash && currentHash !== state.reviewedHash
  writeStateFile(statePath, {
    ...state,
    inflight: false,
    dirty: false,
    hash: currentHash || null,
    waiterPid: null,
  })
  if (!needsFollowUp) return { ok: true, followUp: false }
  return runAfterQuiet(statePath, deps)
}

/**
 * After the quiet window: hash-skip, take the inflight lock, launch, then
 * dirty-requeue at most one follow-up when the file hash changed.
 */
export async function runAfterQuiet(statePath, deps = {}) {
  try {
    const allowed = resolveAllowedStatePath(statePath)
    if (!allowed) return { skipped: true, reason: "state-not-allowed" }
    const state = readStateFile(allowed)
    if (!state) return { skipped: true, reason: "no-state" }

    const now = typeof deps.now === "function" ? deps.now : defaultNow
    if (Number(state.quietUntil || 0) - now() > 0) {
      return { skipped: true, reason: "quiet-pending" }
    }

    const key = deps.waiterKey
    if (state.inflight && waiterIsLive(state, key, deps)) {
      writeStateFile(allowed, { ...state, dirty: true })
      return { skipped: true, reason: "inflight" }
    }
    if (state.inflight && !waiterIsLive(state, key, deps)) {
      writeStateFile(allowed, { ...state, inflight: false, waiterPid: null })
    }

    const confined = confineLaunchPath(state.cwd, state.path)
    if (!confined) {
      emitSidecarEvent(
        "correctness_sidecar_skipped",
        {
          ade: state.ade,
          changeName: state.changeName,
          path: state.path,
          reason: "path-not-allowed",
          model: sidecarResolvedModel(state, {}, deps).model || "unknown",
        },
        deps,
      )
      return { skipped: true, reason: "path-not-allowed" }
    }
    const hash = hashFile(confined.abs)
    if (!hash) {
      emitSidecarEvent(
        "correctness_sidecar_skipped",
        {
          ade: state.ade,
          changeName: state.changeName,
          path: confined.rel,
          reason: "no-hash",
          model: sidecarResolvedModel(state, {}, deps).model || "unknown",
        },
        deps,
      )
      return { skipped: true, reason: "no-hash" }
    }
    if (reviewedLedgerRow(confined.tree, state.changeName, confined.rel, hash)) {
      writeStateFile(allowed, { ...state, waiterPid: null, inflight: false, dirty: false })
      emitSidecarEvent(
        "correctness_sidecar_skipped",
        {
          ade: state.ade,
          changeName: state.changeName,
          path: confined.rel,
          reason: "hash-skip",
          model: sidecarResolvedModel(state, {}, deps).model || "unknown",
        },
        deps,
      )
      return { skipped: true, reason: "hash-match" }
    }

    writeStateFile(allowed, {
      ...state,
      cwd: confined.tree,
      path: confined.rel,
      inflight: true,
      dirty: false,
      reviewedHash: hash,
      hash,
      waiterPid: state.waiterPid || process.pid,
    })
    writePendingRow(confined.tree, state.changeName, confined.rel, hash)

    const launch = typeof deps.launch === "function" ? deps.launch : launchSidecar
    try {
      await launch(
        {
          cwd: confined.tree,
          sessionCwd: state.sessionCwd,
          projectDir: state.projectDir,
          path: confined.rel,
          changeName: state.changeName,
          hash,
          sessionId: state.sessionId,
          payloadModel: state.payloadModel,
          ade: state.ade,
        },
        deps,
      )
    } catch {
      // fail-open
    }
    return finishSidecar(allowed, deps)
  } catch {
    return { skipped: true, reason: "error" }
  }
}

export async function waitThenLaunch(statePath, deps = {}) {
  const now = typeof deps.now === "function" ? deps.now : defaultNow
  const sleep = typeof deps.sleep === "function" ? deps.sleep : defaultSleep
  const key = deps.waiterKey
  const entry = key ? inProcessWaiters.get(key) : null
  const allowed = resolveAllowedStatePath(statePath)
  if (!allowed) return { skipped: true, reason: "state-not-allowed" }
  try {
    for (;;) {
      if (entry?.cancelled) {
        return { skipped: true, reason: "cancelled" }
      }
      const state = readStateFile(allowed)
      if (!state) return { skipped: true, reason: "no-state" }

      if (state.inflight && !waiterIsLive(state, key, deps)) {
        writeStateFile(allowed, { ...state, inflight: false, waiterPid: null })
      }

      const remaining = Number(state.quietUntil || 0) - now()
      if (remaining > 0) {
        await sleep(remaining)
        // Re-read quietUntil after every sleep. A late edit resets the
        // window; launch only when a fresh read shows it expired.
        continue
      }

      const latest = readStateFile(allowed)
      if (!latest) return { skipped: true, reason: "no-state" }
      if (Number(latest.quietUntil || 0) - now() > 0) continue

      const result = await runAfterQuiet(allowed, deps)
      if (result?.reason === "quiet-pending") continue
      return result
    }
  } catch {
    return { skipped: true, reason: "error" }
  }
}

function scheduleWaiter(statePath, state, key, deps) {
  if (waiterIsLive(state, key, deps)) {
    return { scheduled: false, already: true }
  }

  if (deps.inProcess) {
    const entry = { cancelled: false, promise: null }
    inProcessWaiters.set(key, entry)
    const promise = waitThenLaunch(statePath, { ...deps, waiterKey: key }).finally(() => {
      const cur = inProcessWaiters.get(key)
      if (cur === entry) inProcessWaiters.delete(key)
    })
    entry.promise = promise
    promise.catch(() => {})
    return { scheduled: true, already: false }
  }

  const spawnWaiter = typeof deps.spawnWaiter === "function" ? deps.spawnWaiter : spawnDetachedWaiter
  let child
  try {
    child = spawnWaiter(statePath, { cwd: state.cwd })
  } catch {
    return { scheduled: false, already: false }
  }
  const pid = child && Number.isInteger(child.pid) ? child.pid : null
  writeStateFile(statePath, { ...readStateFile(statePath), waiterPid: pid })
  return { scheduled: true, already: false, waiterPid: pid }
}

export function getInProcessWaiter(tree, relPath) {
  return inProcessWaiters.get(waiterKey(tree, relPath))?.promise || null
}

export function resetSidecarTestState() {
  for (const entry of inProcessWaiters.values()) {
    entry.cancelled = true
  }
  inProcessWaiters.clear()
}

/**
 * Record a test-file edit and coalesce into one sidecar per
 * `(realpath(cwd), path)`. Returns immediately (hook-safe).
 */
export function onTestEdit(opts = {}, deps = {}) {
  try {
    const cwdIn = opts.cwd || opts.projectDir
    const projectDir = opts.projectDir || null
    if (!cwdIn) return { ok: false, reason: "no-cwd" }

    const tree = tryRealpath(cwdIn)
    let changeName = opts.changeName
    if (!isSafeChangeName(changeName)) {
      const active = resolveActiveOpenSpecChange(tree, projectDir)
      changeName = active?.changeName
    }
    if (!isSafeChangeName(changeName)) return { ok: false, reason: "no-change" }

    const relGuess =
      toTreeRelativePath(opts.path, tree) ||
      (resolveUnderTree(tree, opts.path) ? toPosixRel(opts.path) : null)
    const confined = confineLaunchPath(tree, relGuess || opts.path)
    if (!confined) return { ok: false, reason: "not-test" }

    const hash = hashFile(confined.abs)
    if (!hash) return { ok: false, reason: "no-hash" }
    const rel = confined.rel

    const now = typeof deps.now === "function" ? deps.now : defaultNow
    const quietMs =
      deps.quietMs != null && Number.isFinite(Number(deps.quietMs))
        ? Math.max(0, Math.floor(Number(deps.quietMs)))
        : getQuietMs()

    const statePath = sidecarStatePath(tree, rel)
    const key = waiterKey(tree, rel)
    const prevRaw = readStateFile(statePath) || {}
    const liveWaiter = waiterIsLive(prevRaw, key, deps)
    // Dead/missing waiter is not inflight — clear the lock so a follow-up
    // can be scheduled (D4).
    const prev =
      prevRaw.inflight && !liveWaiter
        ? { ...prevRaw, inflight: false, waiterPid: null }
        : prevRaw
    const inflight = !!prev.inflight && liveWaiter
    const sessionId = nonEmptyString(opts.sessionId) || nonEmptyString(prev.sessionId)
    const payloadModel = nonEmptyString(opts.payloadModel) || nonEmptyString(prev.payloadModel)
    const sessionCwd =
      nonEmptyString(opts.sessionCwd) ||
      nonEmptyString(opts.payloadCwd) ||
      nonEmptyString(prev.sessionCwd)
    const ade = nonEmptyString(opts.ade) || nonEmptyString(prev.ade)
    const next = {
      cwd: tree,
      sessionCwd,
      projectDir,
      path: rel,
      changeName,
      hash,
      quietUntil: now() + quietMs,
      inflight,
      dirty: inflight || liveWaiter ? true : !!prev.dirty,
      reviewedHash: prev.reviewedHash || null,
      waiterPid: prev.waiterPid || null,
      sessionId,
      payloadModel,
      ade,
    }
    writeStateFile(statePath, next)
    writePendingRow(tree, changeName, rel, hash)

    const modelSlug = sidecarResolvedModel(next, opts, deps).model || "unknown"
    if (inflight) {
      emitSidecarEvent(
        "correctness_sidecar_skipped",
        {
          ade,
          changeName,
          path: rel,
          reason: "quiet-window",
          model: modelSlug,
        },
        deps,
      )
      return {
        ok: true,
        tree,
        path: rel,
        changeName,
        hash,
        inflight: true,
        dirty: true,
        scheduled: false,
        statePath,
      }
    }

    const sched = scheduleWaiter(statePath, next, key, deps)
    if (sched.already) {
      emitSidecarEvent(
        "correctness_sidecar_skipped",
        {
          ade,
          changeName,
          path: rel,
          reason: "quiet-window",
          model: modelSlug,
        },
        deps,
      )
    } else {
      emitSidecarEvent(
        "correctness_sidecar_armed",
        {
          ade,
          changeName,
          path: rel,
          model: modelSlug,
        },
        deps,
      )
    }
    return {
      ok: true,
      tree,
      path: rel,
      changeName,
      hash,
      inflight: false,
      dirty: !!next.dirty,
      scheduled: !!sched.scheduled,
      alreadyScheduled: !!sched.already,
      statePath,
    }
  } catch {
    return { ok: false, reason: "error" }
  }
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

function readStdin() {
  return new Promise((done) => {
    let data = ""
    process.stdin.setEncoding("utf-8")
    process.stdin.on("data", (chunk) => (data += chunk))
    process.stdin.on("end", () => done(data))
    process.stdin.on("error", () => done(data))
  })
}

/**
 * Combined detect + onTestEdit. Closed wiring: the PostToolUse hook target
 * is `node correctness-sidecar.mjs arm [ade]` (stdin = PostToolUse JSON),
 * not detect-only. Cluster 4 installer should invoke this `arm` CLI.
 */
export function armFromDetect(toolName, toolInput, ctx = {}, deps = {}) {
  try {
    const detected = detectTestEdit(toolName, toolInput, ctx)
    if (!detected) return { armed: false }
    const results = []
    for (const p of detected.paths) {
      results.push(
        onTestEdit(
          {
            cwd: detected.tree,
            sessionCwd: ctx.sessionCwd || ctx.cwd,
            projectDir: ctx.projectDir,
            path: p,
            changeName: detected.changeName,
            sessionId: ctx.sessionId,
            payloadModel: ctx.payloadModel,
            ade: ctx.ade,
          },
          deps,
        ),
      )
    }
    return { armed: true, detected, results }
  } catch {
    return { armed: false }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv
  const flags = parseFlags(rest)
  try {
    if (cmd === "wait") {
      const state = typeof flags.state === "string" ? flags.state : ""
      const allowed = resolveAllowedStatePath(state)
      if (!allowed) return 0
      await waitThenLaunch(allowed)
      return 0
    }
    if (cmd === "on-edit") {
      onTestEdit({
        cwd: flags.cwd,
        sessionCwd: flags.sessionCwd || flags["session-cwd"] || flags.payloadCwd,
        projectDir: flags.projectDir || flags.project || null,
        path: flags.path,
        changeName: flags.change || flags.changeName,
        sessionId: flags.session || flags.sessionId,
        payloadModel: flags.model || flags["payload-model"],
        ade: flags.ade,
      })
      return 0
    }
    if (cmd === "launch") {
      await launchSidecar({
        cwd: flags.cwd,
        sessionCwd: flags.sessionCwd || flags["session-cwd"] || flags.payloadCwd,
        path: flags.path,
        changeName: flags.change || flags.changeName,
        hash: flags.hash || undefined,
        sessionId: flags.session || flags.sessionId,
        payloadModel: flags.model || flags["payload-model"],
        ade: flags.ade,
      })
      return 0
    }
    if (cmd === "arm") {
      const raw = await readStdin()
      if (!raw || !String(raw).trim()) return 0
      let payload
      try {
        payload = JSON.parse(raw)
      } catch {
        return 0
      }
      const adeFromArgv = rest.find((a) => !a.startsWith("--")) || process.argv[2] || null
      const norm = normalizeFileEditPayload(payload, adeFromArgv)
      const sessionId =
        payload.sessionId ||
        payload.session_id ||
        payload.conversation_id ||
        payload.conversationId ||
        payload.generation_id ||
        payload.generationId ||
        process.env.GROK_SESSION_ID ||
        null
      const payloadModel = typeof payload.model === "string" ? payload.model : undefined
      armFromDetect(norm.toolName, norm.toolInput, {
        ade: norm.ade,
        projectDir: norm.projectDir,
        cwd: norm.cwd,
        sessionCwd: norm.cwd,
        sessionId,
        payloadModel,
      })
      return 0
    }
  } catch {
    return 0
  }
  return 0
}

const isMainModule =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMainModule) {
  main().then((code) => process.exit(code ?? 0), () => process.exit(0))
}
