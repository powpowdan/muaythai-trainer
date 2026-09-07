#!/usr/bin/env node
// ADE runtime model resolver (hooks-walk deploy).
// Locked order: payload model → Grok session summary current_model_id →
// passed slug → unknown. NEVER reads installer/config defaults
// (~/.grok/config.toml [models].default, Claude settings.json "model",
// Cursor cli-config.json selectedModel).
//
// Production encodeCwd is encodeURIComponent of the absolute cwd string
// Grok stored (summary.json `info.cwd`). That string may use Windows `\`
// or `/`; on-disk keys are URL-encoded (`C%3A%5C…` vs `E%3A%2F…`).
// Tests should inject `sessionPathFor` (or a temp GROK_HOME) so encoding
// drift does not flake unit tests.
//
// Session lookup is fail-closed: sessionId and the encoded cwd segment
// must not contain `..`, `/`, `\`, NUL, or be drive-absolute; after join,
// realpath must stay under join(grokHome, "sessions"). Unsafe lookup
// falls through to the next source (never config).
// Slugs used for `-m` / JSONL: inherit|unknown|[A-Za-z0-9][A-Za-z0-9._-]*
// (no leading `-`, length-capped). Invalid → treat as missing.

import { readFileSync, existsSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

/** @typedef {"payload" | "session" | "passed" | "unknown"} AdeModelSource */

export const ADE_MODEL_SLUG_MAX_LEN = 64
export const ADE_MODEL_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Grok on-disk session key: URL-encode of the absolute cwd string Grok used.
 * @param {unknown} cwd
 * @returns {string}
 */
export function encodeCwd(cwd) {
  return encodeURIComponent(String(cwd ?? ""))
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {() => string} [homeFn]
 * @returns {string}
 */
export function grokHomeFromEnv(env = process.env, homeFn = homedir) {
  const fromEnv = env?.GROK_HOME
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim()
  return join(homeFn(), ".grok")
}

function nonEmptyString(v) {
  if (typeof v !== "string") return null
  const s = v.trim()
  return s ? s : null
}

function tryRealpath(p) {
  if (typeof p !== "string" || !p) return null
  try {
    return realpathSync(p)
  } catch {
    try {
      return resolve(p)
    } catch {
      return null
    }
  }
}

/** Drive-absolute (`C:`, `C:\…`) or OS-absolute (`/…`, UNC). */
export function isDriveOrAbsolute(s) {
  if (typeof s !== "string" || !s) return false
  if (isAbsolute(s)) return true
  return /^[A-Za-z]:/.test(s)
}

/**
 * Path-segment used under `sessions/` (sessionId or encodeCwd(cwd)).
 * Reject `..`, `/`, `\`, NUL, drive-absolute. Empty is unsafe.
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isUnsafeSessionLookupSegment(raw) {
  if (typeof raw !== "string" || !raw) return true
  if (raw.includes("\0")) return true
  if (raw.includes("..")) return true
  if (raw.includes("/") || raw.includes("\\")) return true
  if (isDriveOrAbsolute(raw)) return true
  return false
}

/**
 * Raw payload/project cwd before encoding. Absolute paths are expected;
 * reject NUL and `..` (traversal). `/` `\` drive-absolute are neutralized
 * by encodeCwd and then re-checked as a join segment.
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isUnsafeSessionCwd(raw) {
  if (typeof raw !== "string" || !raw) return true
  if (raw.includes("\0")) return true
  if (raw.includes("..")) return true
  return false
}

function isUnderDir(abs, root) {
  if (!abs || !root) return false
  const rel = relative(root, abs)
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)) return false
  return true
}

/**
 * After join, realpath must stay under join(grokHome, "sessions").
 * @param {unknown} file
 * @param {unknown} grokHome
 * @returns {string | null}
 */
export function confineJoinedSessionFile(file, grokHome) {
  if (typeof file !== "string" || !file || file.includes("\0")) return null
  if (typeof grokHome !== "string" || !grokHome || grokHome.includes("\0")) return null
  const sessionsRoot = tryRealpath(join(grokHome, "sessions"))
  const realFile = tryRealpath(file)
  if (!sessionsRoot || !realFile) return null
  if (!isUnderDir(realFile, sessionsRoot)) return null
  return realFile
}

/**
 * Default session-summary path. Callers that need slash-variant fallbacks
 * should use `sessionSummaryCandidates` or inject `sessionPathFor`.
 * @param {{ grokHome: string, cwd: string, sessionId: string }} opts
 * @returns {string}
 */
export function defaultSessionPath({ grokHome, cwd, sessionId }) {
  return join(grokHome, "sessions", encodeCwd(cwd), sessionId, "summary.json")
}

/**
 * Candidate summary paths for Windows slash/backslash cwd drift.
 * @param {{ grokHome: string, cwd: string, sessionId: string }} opts
 * @returns {string[]}
 */
export function sessionSummaryCandidates({ grokHome, cwd, sessionId }) {
  const raw = String(cwd ?? "")
  /** @type {string[]} */
  const variants = []
  const add = (s) => {
    if (s && !variants.includes(s)) variants.push(s)
  }
  add(raw)
  add(raw.replace(/\\/g, "/"))
  add(raw.replace(/\//g, "\\"))
  return variants.map((c) => defaultSessionPath({ grokHome, cwd: c, sessionId }))
}

/**
 * Confined session-summary paths, or [] if lookup must fail closed.
 * @param {{ grokHome: string, cwd: string, sessionId: string }} opts
 * @returns {string[]}
 */
export function confinedSessionSummaryPaths({ grokHome, cwd, sessionId }) {
  if (isUnsafeSessionCwd(cwd) || isUnsafeSessionLookupSegment(sessionId)) return []
  if (isUnsafeSessionLookupSegment(encodeCwd(cwd))) return []
  if (typeof grokHome !== "string" || !grokHome || grokHome.includes("\0")) return []
  const out = []
  const seen = new Set()
  for (const file of sessionSummaryCandidates({ grokHome, cwd, sessionId })) {
    const confined = confineJoinedSessionFile(file, grokHome)
    if (confined && !seen.has(confined)) {
      seen.add(confined)
      out.push(confined)
    }
  }
  return out
}

/**
 * Allowlisted recorded token: inherit | unknown | slug.
 * Invalid / over-long / leading `-` → null (caller records unknown / omits `-m`).
 * @param {unknown} raw
 * @returns {string | null}
 */
export function allowlistedAdeModel(raw) {
  const s = nonEmptyString(raw)
  if (!s) return null
  if (s.length > ADE_MODEL_SLUG_MAX_LEN) return null
  if (s.startsWith("-")) return null
  if (s === "inherit" || s === "unknown") return s
  if (!ADE_MODEL_SLUG_RE.test(s)) return null
  return s
}

/**
 * Slug that may be passed as `grok -m`. inherit/unknown/invalid → null.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function pinableAdeSlug(raw) {
  const s = allowlistedAdeModel(raw)
  if (!s || s === "inherit" || s === "unknown") return null
  return s
}

/**
 * @param {string} file
 * @param {(path: string, enc: string) => string} readFile
 * @returns {string | null}
 */
function readCurrentModelId(file, readFile) {
  try {
    if (!file) return null
    const raw = readFile(file, "utf-8")
    const json = JSON.parse(raw)
    return allowlistedAdeModel(json?.current_model_id)
  } catch {
    return null
  }
}

function usableResolvedModel(raw) {
  const s = allowlistedAdeModel(raw)
  if (!s || s === "unknown") return null
  return s
}

/**
 * Resolve ADE runtime model. Does not read config.toml / settings.json /
 * cli-config.json at any step. Invalid slugs and unconfined session
 * lookups fall through to the next source.
 *
 * @param {{
 *   payloadModel?: unknown,
 *   cwd?: string,
 *   sessionId?: string,
 *   passed?: unknown,
 *   inherit?: boolean,
 *   grokHome?: string,
 *   env?: NodeJS.ProcessEnv,
 *   homedir?: () => string,
 *   sessionPathFor?: (opts: { grokHome: string, cwd: string, sessionId: string }) => string,
 *   readFile?: (path: string, enc: string) => string,
 *   exists?: (path: string) => boolean,
 * }} [opts]
 * @returns {{ model: string, source: AdeModelSource }}
 */
export function resolveAdeModel(opts = {}) {
  const payloadModel = usableResolvedModel(opts.payloadModel)
  if (payloadModel) return { model: payloadModel, source: "payload" }

  const sessionId = nonEmptyString(opts.sessionId)
  const cwd = nonEmptyString(opts.cwd)
  const env = opts.env || process.env
  const homeFn = typeof opts.homedir === "function" ? opts.homedir : homedir
  const grokHome = nonEmptyString(opts.grokHome) || grokHomeFromEnv(env, homeFn)
  const readFile = typeof opts.readFile === "function" ? opts.readFile : readFileSync
  const exists = typeof opts.exists === "function" ? opts.exists : existsSync

  if (sessionId && cwd && grokHome && !isUnsafeSessionCwd(cwd) && !isUnsafeSessionLookupSegment(sessionId)) {
    if (typeof opts.sessionPathFor === "function") {
      const file = opts.sessionPathFor({ grokHome, cwd, sessionId })
      const confined = confineJoinedSessionFile(file, grokHome)
      if (confined && exists(confined)) {
        const fromSession = readCurrentModelId(confined, readFile)
        if (fromSession && fromSession !== "unknown") {
          return { model: fromSession, source: "session" }
        }
      }
    } else {
      for (const file of confinedSessionSummaryPaths({ grokHome, cwd, sessionId })) {
        if (!exists(file)) continue
        const fromSession = readCurrentModelId(file, readFile)
        if (fromSession && fromSession !== "unknown") {
          return { model: fromSession, source: "session" }
        }
      }
    }
  }

  const passed = usableResolvedModel(opts.passed)
  if (passed) return { model: passed, source: "passed" }

  // Recorded token only when the caller explicitly asks (firstmate omitted
  // spawn model=). Never invented from config defaults.
  if (opts.inherit === true) return { model: "inherit", source: "passed" }

  return { model: "unknown", source: "unknown" }
}

/**
 * Attach `model` on an auto-review event only when resolution is known
 * and allowlisted (not unknown).
 * @param {object} event
 * @param {{ model?: string, source?: string } | null | undefined} resolved
 * @returns {object}
 */
export function attachKnownModel(event, resolved) {
  if (!event || typeof event !== "object") return event
  const model = allowlistedAdeModel(resolved?.model)
  const source = resolved?.source
  if (!model || model === "unknown" || source === "unknown") return event
  return { ...event, model }
}

function parseFlags(args) {
  /** @type {Record<string, string|boolean>} */
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

/**
 * CLI: `node resolve-model.mjs lookup --cwd= --session= [--payload-model=] [--passed=]`
 * Prints `model=<slug> source=<payload|session|passed|unknown>` (tokens, not JSON).
 * @param {string[]} [argv]
 * @returns {number}
 */
export function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv
  if (cmd !== "lookup") {
    process.stderr.write(
      "Usage: node resolve-model.mjs lookup --cwd= --session= [--payload-model=] [--passed=]\n"
    )
    return 2
  }
  const flags = parseFlags(rest)
  const resolved = resolveAdeModel({
    cwd: typeof flags.cwd === "string" ? flags.cwd : undefined,
    sessionId: typeof flags.session === "string" ? flags.session : undefined,
    payloadModel:
      typeof flags["payload-model"] === "string" ? flags["payload-model"] : undefined,
    passed: typeof flags.passed === "string" ? flags.passed : undefined,
    inherit: flags.inherit === true || flags.inherit === "true",
  })
  process.stdout.write(`model=${resolved.model} source=${resolved.source}\n`)
  return 0
}

const isMainModule =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMainModule) {
  process.exit(main())
}
