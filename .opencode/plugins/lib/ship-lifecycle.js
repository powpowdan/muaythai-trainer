/**
 * ship-lifecycle.js — pure ship lifecycle predicates over fleet meta.
 *
 * No filesystem I/O. Used by firstmate for implementer COMPLETE, dual-read
 * ready-to-land, merge eligibility, captains-call classification, and
 * spawn-wave dependency release. fleet-state.js re-exports these and owns
 * FS-aware named transitions that write multi-key invariants.
 */

/** Terminal review values that imply implementer work finished (fallback COMPLETE). */
export const TERMINAL_REVIEW_VALUES = Object.freeze([
  "approved",
  "needs_changes",
  "failed",
])

/**
 * Canonical meta patch for panel APPROVED / ready-to-land.
 * Callers MUST pass this through write-meta so `awaiting=` is an explicit empty
 * write (omit does not clear under merge semantics).
 * @returns {Record<string, string>}
 */
export function normalizeReadyToLandPatch() {
  return {
    merge_phase: "ready_to_land",
    awaiting: "",
    review: "approved",
    panel_status: "complete",
    panel_verdict: "APPROVED",
  }
}

/**
 * Durable implementer COMPLETE from fleet meta.
 *
 * Order:
 * 1. Prefer `implement=complete` (case-sensitive)
 * 2. Else if `implement` empty/unset: non-empty summary, OR terminal review
 *    (`approved|needs_changes|failed`), OR `status=done`
 * 3. `review=pending` alone is never COMPLETE
 *
 * @param {{ implement?: string, summary?: string, review?: string, status?: string } | null | undefined} meta
 * @returns {boolean}
 */
export function isImplementerComplete(meta) {
  if (!meta || typeof meta !== "object") return false
  const implement = meta.implement != null ? String(meta.implement) : ""
  if (implement === "complete") return true
  if (implement !== "") return false

  const summary = meta.summary != null ? String(meta.summary).trim() : ""
  if (summary !== "") return true

  const review = meta.review != null ? String(meta.review) : ""
  if (TERMINAL_REVIEW_VALUES.includes(review)) return true

  const status = meta.status != null ? String(meta.status) : ""
  if (status === "done") return true

  return false
}

/**
 * Happy-path merge readiness (not fully merged) — dual-read of forward + legacy tokens.
 * Forward write: merge_phase=ready_to_land (awaiting cleared).
 * Legacy dual-read: merge_phase=awaiting_approval or awaiting=merge_approval.
 * These are NOT captains_call rubber-stamps under closed-loop default.
 *
 * @param {{ status?: string, awaiting?: string, merge_phase?: string } | null | undefined} t
 * @returns {boolean}
 */
export function isHappyPathReadiness(t) {
  if (!t || typeof t !== "object") return false
  const mergePhase = t.merge_phase || ""
  const awaiting = t.awaiting || ""
  return (
    mergePhase === "ready_to_land" ||
    mergePhase === "awaiting_approval" ||
    awaiting === "merge_approval"
  )
}

/**
 * Whether a task belongs in captains_call bucket.
 * Happy-path merge readiness (`ready_to_land`, and legacy dual-read
 * `awaiting_approval` / `merge_approval`) is NOT captains_call — those are
 * ready-to-land under closed-loop default, not rubber-stamp merge waits.
 * Real human gates — including captain-requested **ask-before-merge** — MUST use
 * `status=needs_decision` (or blocked/failed/conflict_unresolved/merging/aborted).
 *
 * @param {{ status?: string, awaiting?: string, merge_phase?: string } | null | undefined} t
 * @returns {boolean}
 */
export function isCaptainsCall(t) {
  if (!t || typeof t !== "object") return false
  const status = t.status || ""
  const mergePhase = t.merge_phase || ""
  // ask-before-merge and other real human gates: status=needs_decision
  if (status === "needs_decision") return true
  if (status === "blocked") return true
  if (status === "failed") return true
  // ready_to_land / legacy awaiting_approval / merge_approval: NOT captains_call
  if (mergePhase === "conflict_unresolved") return true
  if (mergePhase === "merging") return true
  if (mergePhase === "aborted") return true
  return false
}

/**
 * Merge eligibility: implementer COMPLETE **and** (panel APPROVED or live override).
 * Override replaces the APPROVED requirement only — it never waives COMPLETE.
 * Historical quality-log `override=y` is not an input here.
 *
 * @param {object | null | undefined} meta
 * @param {{ override?: boolean }} [opts]
 * @returns {boolean}
 */
export function isMergeEligible(meta, opts = {}) {
  if (!isImplementerComplete(meta)) return false
  const override = opts && opts.override === true
  if (override) return true
  const verdict =
    meta && meta.panel_verdict != null ? String(meta.panel_verdict) : ""
  return verdict === "APPROVED"
}

/**
 * Wave-release gate: every listed dependency cluster id has implementer-COMPLETE meta.
 * Ids are compared with `String(id)` on both list entries and map keys so numeric
 * `1` and string `"1"` match. Missing meta for a dep id yields false.
 *
 * @param {Array<string|number>} dependsOnIds
 * @param {Record<string, object>|Map<string|number, object>|null|undefined} metaByClusterId
 * @returns {boolean}
 */
export function depsImplementersComplete(dependsOnIds, metaByClusterId) {
  if (!Array.isArray(dependsOnIds) || dependsOnIds.length === 0) {
    // No deps → vacuously complete (wave-0 / no wait)
    return true
  }
  if (!metaByClusterId || typeof metaByClusterId !== "object") return false

  const lookup = (id) => {
    const key = String(id)
    if (metaByClusterId instanceof Map) {
      if (metaByClusterId.has(key)) return metaByClusterId.get(key)
      // also try numeric key if map was built with numbers
      const asNum = Number(key)
      if (!Number.isNaN(asNum) && metaByClusterId.has(asNum)) {
        return metaByClusterId.get(asNum)
      }
      return undefined
    }
    if (Object.prototype.hasOwnProperty.call(metaByClusterId, key)) {
      return metaByClusterId[key]
    }
    // plain object may have been keyed with numbers that stringify differently
    for (const k of Object.keys(metaByClusterId)) {
      if (String(k) === key) return metaByClusterId[k]
    }
    return undefined
  }

  for (const id of dependsOnIds) {
    const meta = lookup(id)
    if (meta == null) return false
    if (!isImplementerComplete(meta)) return false
  }
  return true
}
