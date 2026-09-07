// Mechanics for the shutdown-routine skill: read the stow flashcard TSV, track
// keep/drop/rewrite decisions in a sidecar, and upsert the survivors into Anki
// via AnkiConnect.
//
// The skill invokes this as a CLI (`node anki-import.js <subcommand>`) rather
// than importing it, matching cluster-tasks.js and fleet-state.js. That keeps
// HTML-bearing card text out of shell argv — every subcommand that needs card
// content reads it from disk or stdin and emits JSON on stdout.
//
// Imports must stay same-directory only: this file is listed in the installer's
// CLAUDE_LIB_FILES closure, which is validated at install time.

import { createHash } from "node:crypto"
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

export const SIDECAR_NAME = ".anki-decisions.json"
export const DEFAULT_DECK = "Stow"
export const ANKI_CONNECT_URL = "http://127.0.0.1:8765"
export const ANKI_CONNECT_VERSION = 6

// Cold launch to first AnkiConnect response measured at ~5s on macOS; poll
// rather than sleeping a fixed interval.
const LAUNCH_POLL_INTERVAL_MS = 2000
const LAUNCH_TIMEOUT_MS = 30000
const REQUEST_TIMEOUT_MS = 15000

// ── Arming ───────────────────────────────────────────────────────────────────

// Gates the flashcard stages only. The skill's stow stage runs regardless —
// see the shutdown-routine spec, "The gate scopes the flashcard stages".
export function readArming(env = process.env) {
  if (env.ENABLE_STOW_FLASHCARDS !== "true") {
    return { armed: false, reason: "disabled" }
  }
  const raw = env.STOW_FLASHCARDS_PATH
  if (!raw) return { armed: false, reason: "path-unset" }

  let stat
  try {
    stat = statSync(raw)
  } catch {
    return { armed: false, reason: "path-missing", path: raw }
  }
  if (stat.isFile()) return { armed: true, writeTarget: raw }
  if (stat.isDirectory()) return { armed: true, writeTarget: join(raw, "pending.tsv") }
  return { armed: false, reason: "path-unusable", path: raw }
}

// ── TSV parsing ──────────────────────────────────────────────────────────────

// Stow's row-identity rule, applied to Front only — Front is both what we store
// and what we search for, so the two can never diverge. Back is not an identity
// key and is never normalized. Collapses all whitespace rather than only spaces:
// a TSV Front can hold neither a tab (the separator) nor a newline (stow forbids
// them), but a hand-built finalFront can, and neither may reach a search term.
export function normalizeFront(front) {
  return front.trim().replace(/\s+/g, " ")
}

// Hash-only normalization, never applied to what Anki receives.
function normalizeForHash(back, tags) {
  const b = back.trim().replace(/\s+/g, " ")
  const t = tags.trim().split(/\s+/).filter(Boolean).sort().join(" ")
  // NUL-delimited: a space would let content drift across the Back/Tags
  // boundary and hash identically.
  return `${b}\u0000${t}`
}

export function contentHash(back, tags) {
  return createHash("sha256").update(normalizeForHash(back, tags), "utf8").digest("hex")
}

export function parseTsv(text) {
  const rows = []
  const malformed = []
  let deckFromHeader = null

  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    if (line.startsWith("#")) {
      const m = /^#deck:(.*)$/.exec(line)
      if (m) deckFromHeader = m[1].trim() || null
      continue
    }
    const fields = line.split("\t")
    if (fields.length !== 3) {
      malformed.push(line)
      continue
    }
    const [front, back, tags] = fields
    const normalizedFront = normalizeFront(front)
    // An empty Front is not a usable identity key: buildFrontQuery("") yields
    // `Front:`, which matches every note whose Front is empty and would
    // silently overwrite an unrelated one.
    if (!normalizedFront) {
      malformed.push(line)
      continue
    }
    rows.push({
      front,
      normalizedFront,
      back,
      tags,
      contentHash: contentHash(back, tags),
    })
  }
  return { rows, malformed, deckFromHeader }
}

// Snapshot-read: the write target is appended by concurrent stow runs, so the
// whole run works from one in-memory copy. Rows landing later wait for the
// next invocation. The target is never written by this module.
export function readWriteTarget(writeTarget) {
  if (!existsSync(writeTarget)) {
    return { rows: [], malformed: [], deckFromHeader: null, missing: true }
  }
  return { ...parseTsv(readFileSync(writeTarget, "utf-8")), missing: false }
}

// ── Sidecar ──────────────────────────────────────────────────────────────────

export function sidecarPathFor(writeTarget) {
  return join(dirname(writeTarget), SIDECAR_NAME)
}

// A missing sidecar means "no decisions yet". A malformed one is an error:
// silently starting from empty would re-review every card and overwrite the
// user's hand edits.
export function readSidecar(sidecarPath) {
  if (!existsSync(sidecarPath)) return { version: 1, decisions: [] }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(sidecarPath, "utf-8"))
  } catch (err) {
    throw new Error(`sidecar at ${sidecarPath} is not valid JSON: ${err.message}`)
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.decisions)) {
    throw new Error(`sidecar at ${sidecarPath} is missing a "decisions" array`)
  }
  return { version: parsed.version ?? 1, decisions: parsed.decisions }
}

// Written via a temp file and renamed, because writeFileSync truncates in
// place: an interrupt mid-write would leave a truncated sidecar, which
// readSidecar (correctly) refuses to parse — permanently losing the only
// record of every decision ever made. Rename is atomic within a directory, and
// the temp file always shares the sidecar's directory.
export function writeSidecar(sidecarPath, sidecar) {
  const tmpPath = `${sidecarPath}.tmp`
  try {
    writeFileSync(tmpPath, JSON.stringify(sidecar, null, 2) + "\n", "utf-8")
    renameSync(tmpPath, sidecarPath)
  } catch (err) {
    // Don't strand a partial temp file beside the sidecar on ENOSPC.
    try { rmSync(tmpPath, { force: true }) } catch { /* cleanup is best-effort */ }
    throw err
  }
}

export function findRecord(sidecar, normalizedFront) {
  return sidecar.decisions.find((d) => d.originalFront === normalizedFront) ?? null
}

// Orphans are only ever reported by the run that created them, so without a
// read-back they vanish from view while the notes stay in Anki. Nothing clears
// previousFinalFronts — deletion is manual — so every entry stays outstanding.
//
// The one exclusion: a Front a record has since returned to (A → B → A) is the
// live note again, not an orphan. Reporting it would tell the user to delete
// the note this run just pushed, destroying its Anki scheduling history — the
// one thing this module cannot recreate.
export function listOrphans(sidecar) {
  return sidecar.decisions.flatMap((d) =>
    (d.previousFinalFronts ?? [])
      .filter((front) => front !== d.finalFront)
      .map((front) => ({ front, originalFront: d.originalFront })),
  )
}

// ── Classification ───────────────────────────────────────────────────────────

// Classify only; never act. Conducting a review is the skill's job.
//
// The two hashes answer different questions and are compared against different
// things. contentHash is decision-time state: it records the row a rewrite was
// derived from, so it can say whether that rewrite is still faithful. It does
// NOT advance when a push succeeds, so it can never answer "is Anki current?"
// — comparing it to the row would leave a pushed card reading as changed
// forever and re-pushing on every run. Currency is importedHash against the row
// in hand.
export function classifyRow(row, record) {
  if (!record) return { action: "review", reason: "undecided" }
  if (record.decision === "drop") return { action: "skip", reason: "dropped" }

  if (record.decision === "rewrite" && record.contentHash !== row.contentHash) {
    return { action: "reopen", reason: "rewrite-source-changed" }
  }
  if (record.importedHash && record.importedHash === row.contentHash) {
    return { action: "unchanged", reason: "already-current" }
  }
  return {
    action: "push",
    reason: record.importedHash ? "content-changed" : "import-outstanding",
  }
}

export function classifySnapshot(rows, sidecar) {
  return rows.map((row) => {
    const record = findRecord(sidecar, row.normalizedFront)
    return { row, record, ...classifyRow(row, record) }
  })
}

// ── Decision records ─────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().slice(0, 10)
}

// Re-deciding a card that already reached Anki under a different Front orphans
// that note. This module never deletes notes, so the superseded Front is
// retained and surfaced for the user to remove by hand — dropping it on the
// floor would lose the only handle on it.
export function upsertDecision(sidecar, row, verdict, { decidedBy = "auto", finalFront, finalBack } = {}) {
  const existing = findRecord(sidecar, row.normalizedFront)
  // finalFront is normalized like originalFront so the two identity keys are
  // derived the same way — otherwise a whitespace-only edit reads as a Front
  // change, and the value stored in Anki diverges from what we search for.
  const resolvedFront =
    verdict === "drop" ? undefined : finalFront != null ? normalizeFront(finalFront) : row.normalizedFront
  // Mirrors how finalBack is assigned below: a rewrite that omits finalBack
  // keeps the stored one, a keep clears it.
  const resolvedBack =
    verdict === "drop"
      ? undefined
      : finalBack !== undefined
        ? finalBack
        : verdict === "keep"
          ? undefined
          : existing?.finalBack

  const record = existing ?? {
    originalFront: row.normalizedFront,
    previousFinalFronts: [],
  }

  const superseded = existing?.finalFront
  const wasImported = Boolean(existing?.importedHash)
  const orphaned = wasImported && superseded && superseded !== resolvedFront ? superseded : null
  // Deduplicated: an A → B → A → B cycle re-orphans the same Front, and a
  // repeated entry just re-reports one note as several.
  if (orphaned && !(record.previousFinalFronts ?? []).includes(orphaned)) {
    record.previousFinalFronts = [...(record.previousFinalFronts ?? []), orphaned]
  }
  // The pushed payload is finalFront + finalBack, but classifyRow only compares
  // importedHash against the row's contentHash. A re-decision that changes
  // either field without changing the row would otherwise read as `unchanged`
  // and never reach Anki — so treat the card as un-imported under its new
  // payload. For a Front change that also means the old note is an orphan.
  if (wasImported && (superseded !== resolvedFront || existing?.finalBack !== resolvedBack)) {
    delete record.importedHash
    delete record.importedAt
  }

  record.decision = verdict
  record.contentHash = row.contentHash
  record.decidedAt = today()
  record.decidedBy = decidedBy

  if (verdict === "drop") {
    delete record.finalFront
    delete record.finalBack
  } else {
    record.finalFront = resolvedFront
    if (resolvedBack === undefined) delete record.finalBack
    else record.finalBack = resolvedBack
  }

  if (!existing) sidecar.decisions.push(record)
  return { record, orphaned }
}

export function recordImportSuccess(sidecar, normalizedFront, pushedHash) {
  const record = findRecord(sidecar, normalizedFront)
  if (!record) return null
  record.importedHash = pushedHash
  record.importedAt = today()
  return record
}

// ── AnkiConnect ──────────────────────────────────────────────────────────────

// A bounded timeout matters here: Anki can be up but wedged mid-sync, and an
// unbounded fetch would hang the whole ritual with no way out.
export async function ankiConnect(action, params = {}, url = ANKI_CONNECT_URL) {
  const res = await fetch(url, {
    method: "POST",
    body: JSON.stringify({ action, version: ANKI_CONNECT_VERSION, params }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  // A refusal (e.g. an AnkiConnect configured with an apiKey, which this module
  // never sends) answers with a non-JSON body, so report the status rather than
  // letting it surface as an opaque parse error.
  if (!res.ok) throw new Error(`AnkiConnect ${action}: HTTP ${res.status} ${res.statusText}`)
  const json = await res.json()
  if (json.error) throw new Error(`AnkiConnect ${action}: ${json.error}`)
  return json.result
}

// Keeps the failure message so callers can tell "nothing is listening" from
// "Anki is up and refusing us" — only the former is fixable by launching Anki.
export async function probeAnki(url = ANKI_CONNECT_URL) {
  try {
    await ankiConnect("version", {}, url)
    return { reachable: true }
  } catch (err) {
    return { reachable: false, error: err.message }
  }
}

export async function isReachable(url = ANKI_CONNECT_URL) {
  return (await probeAnki(url)).reachable
}

// Launching is macOS-only on purpose. Guessing a launch command per platform is
// worse than telling the user to start Anki themselves, and decisions are
// already on disk by the time this runs.
export async function ensureAnkiReachable({ url = ANKI_CONNECT_URL, platform = process.platform } = {}) {
  // The first probe's error travels with every failure below: a launch that
  // "times out" against an already-running Anki is a refusal, not an absence,
  // and the two need different fixes.
  const probe = await probeAnki(url)
  if (probe.reachable) return { reachable: true, launched: false }
  if (platform !== "darwin") {
    return { reachable: false, launched: false, reason: "manual-start-required", detail: probe.error }
  }

  // A failed `open` (Anki not installed, or renamed) is worth reporting now
  // rather than as a 30-second poll that mysteriously times out.
  const launch = spawnSync("open", ["-a", "Anki"])
  if (launch.status !== 0) {
    const detail = (launch.stderr?.toString() || launch.error?.message || "").trim()
    return { reachable: false, launched: false, reason: "launch-failed", detail }
  }

  const deadline = Date.now() + LAUNCH_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, LAUNCH_POLL_INTERVAL_MS))
    if (await isReachable(url)) return { reachable: true, launched: true }
  }
  return { reachable: false, launched: true, reason: "timeout", detail: probe.error }
}

export function resolveDeck({ envDeck, deckFromHeader } = {}) {
  const fromEnv = (envDeck ?? "").trim()
  if (fromEnv) return fromEnv
  const fromHeader = (deckFromHeader ?? "").trim()
  if (fromHeader) return fromHeader
  return DEFAULT_DECK
}

// `*` and `_` are live wildcards in Anki search — verified against a real
// collection, where `Front:*st_le*` matched 156 notes and the escaped form
// matched none. Leaving them raw over-matches, which trips the ambiguity
// refusal below and silently blocks a legitimate card while looking like a
// duplicate that does not exist.
export function escapeSearchTerm(value) {
  return value.replace(/[\\"*_:]/g, (c) => `\\${c}`)
}

// One quoted term. Unquoted, a multi-word Front ANDs its words and matches
// notes that merely contain them all.
export function buildFrontQuery(finalFront) {
  return `"Front:${escapeSearchTerm(finalFront)}"`
}

export function splitTags(tags) {
  return tags.trim().split(/\s+/).filter(Boolean)
}

// Front is always finalFront so the stored key and the searched key are
// identical. Back is verbatim — a rewritten Back when one exists, otherwise
// straight from the TSV. Neither field is ever HTML-escaped; stow already
// emitted intentional markup under its #html:true header.
export function noteFor({ deck, finalFront, back, tags }) {
  return {
    deckName: deck,
    modelName: "Basic",
    fields: { Front: finalFront, Back: back },
    tags: splitTags(tags),
    options: { allowDuplicate: false, duplicateScope: "deck" },
  }
}

export async function ensureDeck(deck, url = ANKI_CONNECT_URL) {
  const decks = await ankiConnect("deckNames", {}, url)
  if (decks.includes(deck)) return { created: false }
  await ankiConnect("createDeck", { deck }, url)
  return { created: true }
}

// Zero hits adds, one hit updates, two or more refuses. Refusing matters:
// picking one arbitrarily is how a divergent duplicate gets entrenched, and an
// over-matching query reaches this path too.
export async function upsertNote(note, url = ANKI_CONNECT_URL) {
  const query = buildFrontQuery(note.fields.Front)
  const hits = await ankiConnect("findNotes", { query }, url)

  if (hits.length > 1) {
    return { outcome: "ambiguous", front: note.fields.Front, count: hits.length }
  }
  if (hits.length === 1) {
    await ankiConnect(
      "updateNote",
      { note: { id: hits[0], fields: note.fields, tags: note.tags } },
      url,
    )
    return { outcome: "updated", noteId: hits[0] }
  }
  // A duplicate rejection here means Anki's own check (which strips HTML) saw a
  // collision the Front search did not. Never retry with allowDuplicate — that
  // manufactures the exact divergent note the ambiguity refusal prevents.
  const noteId = await ankiConnect("addNote", { note }, url)
  return { outcome: "added", noteId }
}

export async function syncCollection(url = ANKI_CONNECT_URL) {
  try {
    await ankiConnect("sync", {}, url)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const SUBCOMMANDS = ["arming", "snapshot", "classify", "decide", "import", "sync"]
export const VERDICTS = ["keep", "drop", "rewrite"]

async function runCli(argv) {
  const [subcommand] = argv
  const arming = readArming()

  if (subcommand === "arming") return arming
  if (!arming.armed) return { error: "not-armed", ...arming }

  const { writeTarget } = arming
  const sidecarPath = sidecarPathFor(writeTarget)

  switch (subcommand) {
    case "snapshot": {
      const snapshot = readWriteTarget(writeTarget)
      return { writeTarget, sidecarPath, ...snapshot }
    }
    case "classify": {
      const snapshot = readWriteTarget(writeTarget)
      const sidecar = readSidecar(sidecarPath)
      const classified = classifySnapshot(snapshot.rows, sidecar)
      return {
        writeTarget,
        sidecarPath,
        // Arming accepts a directory and synthesizes pending.tsv without
        // checking it exists, so "stow never wrote the file" is reachable and
        // must not read as "nothing new to review".
        missing: snapshot.missing,
        malformed: snapshot.malformed.length,
        orphans: listOrphans(sidecar),
        deck: resolveDeck({
          envDeck: process.env.STOW_ANKI_DECK,
          deckFromHeader: snapshot.deckFromHeader,
        }),
        // Rows headed for review carry their Back and Tags: the reviewer judges
        // long-term value on the whole card, and a `rewrite` must restate only
        // what the card already asserted. Rows needing no judgment stay trimmed
        // so a 25-card deck does not emit 25 full Backs for nothing.
        cards: classified.map(({ row, action, reason, record }) => {
          const card = {
            originalFront: row.normalizedFront,
            action,
            reason,
            contentHash: row.contentHash,
            decision: record?.decision ?? null,
            finalFront: record?.finalFront ?? null,
          }
          if (action === "review" || action === "reopen") {
            card.back = row.back
            card.tags = row.tags
            if (action === "reopen") {
              card.storedFinalFront = record?.finalFront ?? null
              card.storedFinalBack = record?.finalBack ?? null
            }
          }
          return card
        }),
      }
    }
    // Verdicts arrive as JSON on stdin, never as argv — card text carries HTML.
    case "decide": {
      const verdicts = JSON.parse(readFileSync(0, "utf-8"))
      const snapshot = readWriteTarget(writeTarget)
      const sidecar = readSidecar(sidecarPath)
      const byFront = new Map(snapshot.rows.map((r) => [r.normalizedFront, r]))
      const orphans = []
      const unmatched = []
      const stale = []
      const invalid = []
      let applied = 0

      // Every finalFront already spoken for, so a second verdict cannot land on
      // the same Anki note. Seeded from records this batch is not re-deciding.
      const claimedFronts = new Map(
        sidecar.decisions.filter((d) => d.finalFront).map((d) => [d.finalFront, d.originalFront]),
      )

      for (const v of verdicts) {
        // A null or non-object element would throw on the very first property
        // read, escaping the loop and discarding every decision already applied
        // in this batch — the exact loss the per-verdict buckets exist to stop.
        if (!v || typeof v !== "object") {
          invalid.push({ front: null, decision: null, reason: "invalid-verdict" })
          continue
        }
        // An unrecognized verdict is neither drop nor rewrite, so recording it
        // would classify the card as `push` and import it as if it were kept —
        // the opposite outcome for a mistyped `drop`.
        if (!VERDICTS.includes(v.decision)) {
          invalid.push({ front: v.originalFront ?? null, decision: v.decision ?? null, reason: "unknown-decision" })
          continue
        }
        // The caller hand-builds this JSON, so an omitted or non-string Front
        // is a realistic entry. Reject it into the same per-verdict bucket:
        // letting normalizeFront throw would escape the loop and discard every
        // decision already applied to the in-memory sidecar.
        if (typeof v.originalFront !== "string" || !normalizeFront(v.originalFront)) {
          invalid.push({ front: v.originalFront ?? null, decision: v.decision, reason: "invalid-front" })
          continue
        }
        // finalFront becomes an identity key too, so it gets the same guard: a
        // non-string throws one level down in upsertDecision, and an empty one
        // yields a `Front:` query that matches every empty-Front note.
        if (v.finalFront != null && (typeof v.finalFront !== "string" || !normalizeFront(v.finalFront))) {
          invalid.push({ front: v.originalFront, decision: v.decision, reason: "invalid-final-front" })
          continue
        }
        const normalizedOriginal = normalizeFront(v.originalFront)
        const row = byFront.get(normalizedOriginal)
        // Never drop a verdict silently — an unmatched Front means the reviewer
        // judged something this run cannot find, which the caller must see.
        if (!row) {
          unmatched.push(v.originalFront)
          continue
        }
        // Two rows can rewrite to the same Front — the same insight minted
        // twice, or a rewrite landing on another row's verbatim Front. Each
        // would then find exactly one note and update it, so the ambiguity
        // refusal never fires and the second card silently clobbers the first.
        const resolvedFinal =
          v.decision === "drop" ? null : normalizeFront(v.finalFront ?? normalizedOriginal)
        if (resolvedFinal) {
          const claimant = claimedFronts.get(resolvedFinal)
          if (claimant !== undefined && claimant !== normalizedOriginal) {
            invalid.push({
              front: v.originalFront,
              decision: v.decision,
              reason: "duplicate-final-front",
            })
            continue
          }
          claimedFronts.set(resolvedFinal, normalizedOriginal)
        }
        // classify, decide, and import are separate processes, so a concurrent
        // stow can refine a row inside the review window. Recording the verdict
        // against content the reviewer never saw would also mean a rewrite's
        // reopen guard never fires for that refinement, so reject it instead.
        if (v.contentHash && v.contentHash !== row.contentHash) {
          stale.push(v.originalFront)
          continue
        }
        const { orphaned } = upsertDecision(sidecar, row, v.decision, {
          decidedBy: v.decidedBy ?? "auto",
          finalFront: v.finalFront,
          finalBack: v.finalBack,
        })
        if (orphaned) orphans.push(orphaned)
        applied += 1
      }
      writeSidecar(sidecarPath, sidecar)
      return { applied, orphans, unmatched, stale, invalid, sidecarPath }
    }
    case "import": {
      const snapshot = readWriteTarget(writeTarget)
      const sidecar = readSidecar(sidecarPath)
      const deck = resolveDeck({
        envDeck: process.env.STOW_ANKI_DECK,
        deckFromHeader: snapshot.deckFromHeader,
      })

      const classified = classifySnapshot(snapshot.rows, sidecar)
      const result = { deck, added: 0, updated: 0, unchanged: 0, ambiguous: [], failed: [] }
      const pushes = classified.filter((c) => c.action === "push")
      result.unchanged = classified.filter((c) => c.action === "unchanged").length

      // Nothing to write means nothing to reach for. Contacting Anki — and
      // worse, creating a deck — on a run with no work is a visible side effect
      // for no gain.
      if (pushes.length === 0) return result

      const reach = await ensureAnkiReachable()
      if (!reach.reachable) return { error: "anki-unreachable", ...reach, deck }

      await ensureDeck(deck)

      for (const { row, record } of pushes) {
        const note = noteFor({
          deck,
          finalFront: record.finalFront,
          back: record.finalBack ?? row.back,
          tags: row.tags,
        })
        // Per-card isolation: one bad card must not abandon the rest, and a
        // failure leaves importedHash unwritten so the next run retries it.
        try {
          const outcome = await upsertNote(note)
          if (outcome.outcome === "ambiguous") {
            result.ambiguous.push({ front: outcome.front, count: outcome.count })
            continue
          }
          recordImportSuccess(sidecar, row.normalizedFront, row.contentHash)
          result[outcome.outcome === "added" ? "added" : "updated"] += 1
        } catch (err) {
          result.failed.push({ front: record.finalFront, error: err.message })
        }
      }

      writeSidecar(sidecarPath, sidecar)
      return result
    }
    case "sync":
      return await syncCollection()
    default:
      throw new Error(`unknown subcommand "${subcommand ?? ""}" (expected one of: ${SUBCOMMANDS.join(", ")})`)
  }
}

// Resolves relative argv[1] and realpaths both sides so a symlinked config dir
// (`node ~/.claude/lib/anki-import.js …` where ~/.claude is a link) still runs
// the CLI instead of exiting 0 with empty stdout, which reads as an empty
// success rather than an error.
const isMainInvocation = (() => {
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
})()

if (isMainInvocation) {
  runCli(process.argv.slice(2))
    .then((result) => process.stdout.write(JSON.stringify(result) + "\n"))
    .catch((err) => {
      process.stderr.write(`anki-import.js failed: ${err.message}\n`)
      process.exit(1)
    })
}
