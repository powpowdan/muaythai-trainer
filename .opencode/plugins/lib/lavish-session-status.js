import { execSync } from "node:child_process"
import { fileURLToPath } from "node:url"

// lavish-axi's bare invocation prints one line per top-level key. A "table"
// key looks like `name[N]{field1,field2,...}:` followed by N indented,
// CSV-style rows (quoted where a field needs it) — this is NOT valid nested
// YAML sequence syntax (no `- ` item markers), so a generic YAML parser
// would just fold the rows into one blob string. This targets that exact
// shape directly instead.
const TABLE_HEADER_RE = /^sessions\[(\d+)\]\{([^}]*)\}:\s*$/

export class LavishSessionStatusError extends Error {
  constructor(message) {
    super(message)
    this.name = "LavishSessionStatusError"
  }
}

/** Split one CSV-style row, honoring double-quoted fields with doubled-quote escapes. */
function splitTableRow(line) {
  const fields = []
  let current = ""
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        current += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ",") {
      fields.push(current)
      current = ""
    } else {
      current += ch
    }
  }
  fields.push(current)
  return fields
}

function coerceField(value) {
  const trimmed = value.trim()
  return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed
}

/**
 * Parse lavish-axi's bare-invocation output into a structured session list.
 * Pure function — no shell-out — so it stays directly unit-testable.
 *
 * @param {string} rawOutput
 * @returns {Array<Record<string, string|number>>}
 * @throws {LavishSessionStatusError} on any shape lavish-axi did not document
 */
export function parseSessionTable(rawOutput) {
  const lines = String(rawOutput ?? "").split("\n")
  const headerIndex = lines.findIndex((line) => TABLE_HEADER_RE.test(line))

  if (headerIndex === -1) {
    throw new LavishSessionStatusError(
      "lavish-axi output has no \"sessions[N]{...}:\" table header — unrecognized output shape"
    )
  }

  const match = lines[headerIndex].match(TABLE_HEADER_RE)
  const expectedCount = Number(match[1])
  const fieldNames = match[2].split(",").map((f) => f.trim()).filter(Boolean)

  if (fieldNames.length === 0) {
    throw new LavishSessionStatusError(
      "lavish-axi sessions table header lists no fields — unrecognized output shape"
    )
  }

  const sessions = []
  for (let i = 0; i < expectedCount; i++) {
    const line = lines[headerIndex + 1 + i]
    if (line === undefined || line.trim() === "") {
      throw new LavishSessionStatusError(
        `lavish-axi sessions table header declared ${expectedCount} row(s) but only ${i} were found`
      )
    }

    const rawFields = splitTableRow(line.trim())
    if (rawFields.length !== fieldNames.length) {
      throw new LavishSessionStatusError(
        `lavish-axi sessions table row ${i + 1} has ${rawFields.length} field(s), expected ${fieldNames.length} (${fieldNames.join(",")}): ${line.trim()}`
      )
    }

    const session = {}
    fieldNames.forEach((name, idx) => {
      session[name] = coerceField(rawFields[idx])
    })
    sessions.push(session)
  }

  return sessions
}

function getLavishAxiVersion() {
  try {
    return execSync("npx lavish-axi --version", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    }).trim()
  } catch {
    return "unknown"
  }
}

/**
 * Run bare `npx lavish-axi` and return its parsed session list.
 * @returns {Array<Record<string, string|number>>}
 * @throws {LavishSessionStatusError}
 */
export function getLavishSessionStatus() {
  let rawOutput
  try {
    rawOutput = execSync("npx lavish-axi", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    })
  } catch (err) {
    throw new LavishSessionStatusError(
      `npx lavish-axi failed to run: ${err.stderr?.trim() || err.message} (installed lavish-axi version: ${getLavishAxiVersion()})`
    )
  }

  try {
    return parseSessionTable(rawOutput)
  } catch (err) {
    throw new LavishSessionStatusError(
      `${err.message} (installed lavish-axi version: ${getLavishAxiVersion()})`
    )
  }
}

// CLI entry: invoked as `node lavish-session-status.js`. Prints the parsed
// session list as JSON to stdout, matching cluster-tasks.js's CLI shape.
const isMainInvocation = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
  } catch {
    return false
  }
})()

if (isMainInvocation) {
  try {
    process.stdout.write(JSON.stringify(getLavishSessionStatus()) + "\n")
  } catch (err) {
    process.stderr.write(`lavish-session-status.js failed: ${err.message}\n`)
    process.exit(1)
  }
}
