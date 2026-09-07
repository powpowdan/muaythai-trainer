import { existsSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Walk upward from `startDir` through the plain filesystem hierarchy,
 * ignoring `.git/` entirely, looking for a directory containing `openspec/`.
 *
 * Distinct from installers/install.mjs's resolveRepoRoot(), which stops at
 * the first ancestor with `.git/` OR `openspec/` (`.git/` winning ties) —
 * the right rule for "where does the installer run," but wrong here: a
 * child code repo's own `.git/` would stop that walk before it ever reaches
 * a parent artifact repo's `openspec/`, which is exactly the case this
 * resolver needs to handle.
 *
 * @param {string} startDir
 * @returns {string|null} the first ancestor (inclusive of startDir) containing
 *   an `openspec/` directory, or null if none exists up to the filesystem root
 */
export function findAncestorOpenspecDir(startDir) {
  let current = resolve(startDir)

  while (true) {
    const candidate = join(current, "openspec")
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return current
    }

    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

// CLI entry: invoked as `node ancestor-openspec-resolve.js <start-dir>`.
// Prints { "root": <path-or-null> } as JSON to stdout.
const isMainInvocation = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
  } catch {
    return false
  }
})()

if (isMainInvocation) {
  const startDir = process.argv[2]
  if (!startDir) {
    process.stderr.write("Usage: node ancestor-openspec-resolve.js <start-dir>\n")
    process.exit(2)
  }
  try {
    const root = findAncestorOpenspecDir(startDir)
    process.stdout.write(JSON.stringify({ root }) + "\n")
  } catch (err) {
    process.stderr.write(`ancestor-openspec-resolve.js failed: ${err.message}\n`)
    process.exit(1)
  }
}
