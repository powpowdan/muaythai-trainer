#!/usr/bin/env node
import { logEvent } from "./lib.mjs"

const raw = process.argv[2]
if (!raw) {
  process.stderr.write("emit-telemetry: event argument required\n")
  process.exit(1)
}

let event
try {
  event = JSON.parse(raw)
} catch {
  process.stderr.write(`emit-telemetry: invalid JSON: ${raw}\n`)
  process.exit(1)
}

logEvent(event)
