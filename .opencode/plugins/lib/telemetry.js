import { appendFileSync, mkdirSync } from "node:fs"
import { join, dirname, basename } from "node:path"
import { homedir } from "node:os"
import { spawn } from "node:child_process"

export function logEvent(event, baseDir = process.cwd()) {
  try {
    const telFile = process.env.OPENSPEC_TEL_FILE || join(homedir(), ".opencode", "workflow", ".openspec-telemetry.jsonl")
    mkdirSync(dirname(telFile), { recursive: true })
    const line = JSON.stringify({ ts: new Date().toISOString(), repo: basename(baseDir), ...event }) + "\n"
    appendFileSync(telFile, line, "utf-8")
    if (event.event === "merge" || event.event === "merge_failed") {
      try {
        const child = spawn('node', [join(homedir(), '.vsm', 'health-check.js')], { detached: true, stdio: 'ignore' })
        child.on('error', () => {})
        child.unref()
      } catch {}
    }
  } catch {}
}
