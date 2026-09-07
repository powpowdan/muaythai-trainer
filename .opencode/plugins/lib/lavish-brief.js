import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const GRABBED_HEADING_RE = /^##\s+Grabbed sessions\s*$/
const GRABBED_ITEM_RE = /^-\s+(.+\.html)\s*$/

/**
 * Parse the "## Grabbed sessions" bullet list out of one brief's markdown
 * content. Stops at the next `##` heading (or EOF).
 *
 * @param {string} briefMarkdown
 * @returns {string[]} basenames listed as grabbed by this brief
 */
export function parseGrabbedBasenames(briefMarkdown) {
  const lines = String(briefMarkdown ?? "").split("\n")
  const headingIndex = lines.findIndex((line) => GRABBED_HEADING_RE.test(line.trim()))
  if (headingIndex === -1) return []

  const grabbed = []
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^##\s+/.test(line.trim())) break
    const match = line.trim().match(GRABBED_ITEM_RE)
    if (match) grabbed.push(match[1].trim())
  }
  return grabbed
}

/**
 * Narrow lavish-session-status.js's full (server-wide) session list down to
 * this sweep's scope: sessions physically inside `lavishDir` and not already
 * named as grabbed by any prior brief.
 *
 * @param {Array<{file: string, status: string}>} sessions
 * @param {string} lavishDir
 * @param {Iterable<string>} grabbedBasenames
 * @returns {Array<{file: string, status: string}>}
 */
export function filterSweepScope(sessions, lavishDir, grabbedBasenames = []) {
  const resolvedLavishDir = resolve(lavishDir)
  const grabbed = new Set(grabbedBasenames)

  return sessions.filter((session) => {
    const filePath = resolve(String(session.file))
    if (dirname(filePath) !== resolvedLavishDir) return false
    if (!filePath.toLowerCase().endsWith(".html")) return false
    return !grabbed.has(basename(filePath))
  })
}

/** Sessions in the sweep scope that are still open (blocks the whole sweep). */
export function findOpenSessions(sweepScope) {
  return sweepScope.filter((session) => session.status === "open")
}

/**
 * Slug for `brief-<slug>.md`: a short hash of the sorted grabbed basenames,
 * joined with the UTC date — informative on sight, and an accidental
 * identical-input collision (same grabbed set, same day) is the only case
 * that can produce a repeat. SHA-256 (truncated) is used purely for a
 * filename discriminator here, not as a security boundary.
 *
 * @param {string[]} basenames grabbed `.html` basenames (any order)
 * @param {Date} [utcDate]
 * @returns {string}
 */
export function computeBriefSlug(basenames, utcDate = new Date()) {
  const sorted = [...basenames].sort()
  const hash = createHash("sha256").update(sorted.join(",")).digest("hex").slice(0, 8)
  const dateStr = utcDate.toISOString().slice(0, 10).replace(/-/g, "")
  return `${hash}-${dateStr}`
}

/**
 * Pick a brief filename that doesn't collide with an existing one, appending
 * a numeric suffix (`-2`, `-3`, ...) rather than overwriting.
 *
 * @param {string} slug
 * @param {Iterable<string>} existingBriefBasenames basenames already present in `.lavish/`
 * @returns {string} a basename, e.g. "brief-<slug>.md" or "brief-<slug>-2.md"
 */
export function resolveBriefFilename(slug, existingBriefBasenames = []) {
  const existing = new Set(existingBriefBasenames)
  const base = `brief-${slug}.md`
  if (!existing.has(base)) return base

  let n = 2
  while (existing.has(`brief-${slug}-${n}.md`)) n++
  return `brief-${slug}-${n}.md`
}

// CLI entry: `node lavish-brief.js <subcommand>`, JSON on stdin, JSON on stdout.
// Subcommands: filter-scope, find-open, parse-grabbed, compute-slug, resolve-filename.
function runCli(subcommand) {
  const input = JSON.parse(readFileSync(0, "utf-8") || "{}")

  switch (subcommand) {
    case "filter-scope":
      return filterSweepScope(input.sessions, input.lavishDir, input.grabbedBasenames)
    case "find-open":
      return findOpenSessions(input.sweepScope)
    case "parse-grabbed":
      return parseGrabbedBasenames(input.markdown)
    case "compute-slug":
      return computeBriefSlug(input.basenames, input.utcDate ? new Date(input.utcDate) : undefined)
    case "resolve-filename":
      return resolveBriefFilename(input.slug, input.existingBriefBasenames)
    default:
      throw new Error(`unknown subcommand "${subcommand}" (expected one of: filter-scope, find-open, parse-grabbed, compute-slug, resolve-filename)`)
  }
}

const isMainInvocation = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
  } catch {
    return false
  }
})()

if (isMainInvocation) {
  const subcommand = process.argv[2]
  if (!subcommand) {
    process.stderr.write("Usage: node lavish-brief.js <filter-scope|find-open|parse-grabbed|compute-slug|resolve-filename>\n")
    process.exit(2)
  }
  try {
    process.stdout.write(JSON.stringify(runCli(subcommand)) + "\n")
  } catch (err) {
    process.stderr.write(`lavish-brief.js failed: ${err.message}\n`)
    process.exit(1)
  }
}
