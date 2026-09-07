/**
 * panel-metrics.js — best-effort pure extraction from panel-findings markdown.
 *
 * Offline / ship-path safe: never throws on unstructured text.
 * Used by fleet-state quality-summary / optional append enrich (soft).
 *
 * Lenses: correctness | security | tests (and aliases like tests_repro).
 * Themes: fixed keyword map (tests, security, path/allowlist, merge/meta,
 *   packaging/install, docs, contracts/api).
 */

/** Canonical multi-lens tags (firstmate 3+1). */
export const PANEL_LENSES = ["correctness", "security", "tests"]

/**
 * Fixed theme keyword map: theme id → list of case-insensitive match patterns.
 * Patterns may be plain substrings (matched as whole-word-ish or literal).
 */
export const PANEL_THEME_KEYWORDS = {
  tests: ["test", "tests", "repro", "coverage", "fixture", "assert"],
  security: [
    "security",
    "injection",
    "xss",
    "csrf",
    "auth",
    "authorization",
    "secret",
    "credential",
    "path traversal",
    "sanitize",
  ],
  "path/allowlist": [
    "allowlist",
    "path escape",
    "path traversal",
    "fleet root",
    "taskid",
    "task id",
    "workdir",
    "worktree path",
  ],
  "merge/meta": [
    "merge_phase",
    "merge phase",
    "ready_to_land",
    "auto-merge",
    "automerge",
    "merge gate",
    "quality-log",
    "quality log",
    "fleet-state",
    "fleet state",
    "panel_verdict",
    "override",
  ],
  "packaging/install": [
    "installer",
    "install.mjs",
    "dry-run",
    "manifest",
    "payload",
    "packaging",
    "reinstall",
    "bin/",
    "skill.md",
  ],
  docs: [
    "documentation",
    "readme",
    "docs/",
    "captain-decision",
    "agents.md",
    "skill doc",
    "one-pager",
  ],
  "contracts/api": [
    "api contract",
    "public api",
    "breaking change",
    "cli flag",
    "export function",
    "schema",
    "spec.md",
    "requirement:",
  ],
}

/**
 * Normalize lens token to one of PANEL_LENSES or null.
 * @param {string} raw
 * @returns {string | null}
 */
export function normalizeLens(raw) {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, "_")
  if (!s) return null
  if (s === "correctness" || s === "correct") return "correctness"
  if (s === "security" || s === "sec") return "security"
  if (
    s === "tests" ||
    s === "test" ||
    s === "tests_repro" ||
    s === "testsrepro" ||
    s === "repro"
  ) {
    return "tests"
  }
  return null
}

/**
 * Count severity tokens in freeform panel text (best-effort).
 * Recognizes [high/…], **HIGH**, HIGH correctness, severity: high, etc.
 * @param {string} text
 * @returns {{ high: number, medium: number, low: number }}
 */
export function countSeverities(text) {
  const counts = { high: 0, medium: 0, low: 0 }
  if (!text) return counts
  const s = String(text)

  // Bracket tags: [high/correctness], [medium], [low/docs]
  const bracket = s.matchAll(/\[\s*(high|medium|low|med|sev)\b/gi)
  for (const m of bracket) {
    const t = m[1].toLowerCase()
    if (t === "high") counts.high++
    else if (t === "medium" || t === "med") counts.medium++
    else if (t === "low") counts.low++
  }

  // Standalone severity words near finding markers
  // HIGH correctness / **HIGH** / severity: high / n_high=
  const word = s.matchAll(
    /(?:^|[\s*\[(,])(?:SEVERITY[:\s]+)?(HIGH|MEDIUM|LOW|MED)\b/gi
  )
  for (const m of word) {
    const t = m[1].toLowerCase()
    if (t === "high") counts.high++
    else if (t === "medium" || t === "med") counts.medium++
    else if (t === "low") counts.low++
  }

  // METRICS footer: n_high=… n_medium=… n_low=…
  const nHigh = s.match(/\bn_high\s*=\s*(\d+)/i)
  const nMed = s.match(/\bn_medium\s*=\s*(\d+)/i)
  const nLow = s.match(/\bn_low\s*=\s*(\d+)/i)
  if (nHigh) counts.high = Math.max(counts.high, Number(nHigh[1]))
  if (nMed) counts.medium = Math.max(counts.medium, Number(nMed[1]))
  if (nLow) counts.low = Math.max(counts.low, Number(nLow[1]))

  return counts
}

/**
 * Extract lens tags from panel text.
 * @param {string} text
 * @returns {string[]} unique canonical lenses in stable order
 */
export function extractLenses(text) {
  /** @type {Set<string>} */
  const found = new Set()
  if (!text) return []
  const s = String(text)

  // [high/correctness], [medium/security], [low/tests]
  for (const m of s.matchAll(
    /\[\s*(?:high|medium|low|med)?\s*[/|,]?\s*(correctness|security|tests(?:_repro)?|correct|sec|repro)\s*\]/gi
  )) {
    const lens = normalizeLens(m[1])
    if (lens) found.add(lens)
  }

  // HIGH correctness / medium security (word forms)
  for (const m of s.matchAll(
    /\b(?:high|medium|low|med)\s+[/|]?\s*(correctness|security|tests(?:_repro)?)\b/gi
  )) {
    const lens = normalizeLens(m[1])
    if (lens) found.add(lens)
  }

  // lens=correctness or lenses=correctness,security,tests
  for (const m of s.matchAll(/\blenses?\s*=\s*([^\s\n]+)/gi)) {
    for (const part of m[1].split(/[,+|]/)) {
      const lens = normalizeLens(part)
      if (lens) found.add(lens)
    }
  }

  // Bare lens names in structured headers: **correctness**, ## Security lens
  for (const name of PANEL_LENSES) {
    const re = new RegExp(
      `(?:^|[\\s#*_\\[(,])${name}(?:\\s+lens)?(?:$|[\\s:*_\\])/,])`,
      "i"
    )
    if (re.test(s)) found.add(name)
  }
  // tests_repro alias
  if (/\btests[_\s-]?repro\b/i.test(s)) found.add("tests")

  return PANEL_LENSES.filter((l) => found.has(l))
}

/**
 * Extract theme keywords via fixed map (substring, case-insensitive).
 * @param {string} text
 * @returns {string[]} theme ids present
 */
export function extractThemes(text) {
  if (!text) return []
  const lower = String(text).toLowerCase()
  /** @type {string[]} */
  const out = []
  for (const [theme, keywords] of Object.entries(PANEL_THEME_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw.toLowerCase())) {
        out.push(theme)
        break
      }
    }
  }
  return out
}

/**
 * Best-effort panel verdict from markdown (APPROVED / NEEDS_CHANGES / …).
 * @param {string} text
 * @returns {string | null}
 */
export function extractVerdict(text) {
  if (!text) return null
  const s = String(text)
  const m =
    s.match(/\bverdict\s*[=:]\s*(APPROVED|NEEDS_CHANGES|NEEDS_MAJOR_CHANGES)\b/i) ||
    s.match(
      /\*\*Verdict:\*\*\s*(APPROVED|NEEDS_CHANGES|NEEDS_MAJOR_CHANGES)\b/i
    ) ||
    s.match(
      /\bpanel_verdict\s*=\s*(APPROVED|NEEDS_CHANGES|NEEDS_MAJOR_CHANGES)\b/i
    ) ||
    s.match(
      /\b(?:final\s+)?verdict\b[^A-Z\n]{0,40}\b(APPROVED|NEEDS_CHANGES|NEEDS_MAJOR_CHANGES)\b/i
    )
  return m ? m[1].toUpperCase().replace(/needs_changes/i, (x) => x.toUpperCase()) : null
}

/**
 * Pure best-effort metrics from panel-findings (or revision-note) text.
 * Never throws; missing structure → empty/partial fields.
 *
 * @param {string} text
 * @returns {{
 *   verdict: string | null,
 *   severity: { high: number, medium: number, low: number },
 *   lenses: string[],
 *   themes: string[],
 * }}
 */
export function extractPanelMetrics(text) {
  try {
    const raw = text == null ? "" : String(text)
    let verdict = extractVerdict(raw)
    // Normalize verdict casing for known tokens
    if (verdict) {
      const u = verdict.toUpperCase()
      if (u === "APPROVED") verdict = "APPROVED"
      else if (u === "NEEDS_CHANGES") verdict = "NEEDS_CHANGES"
      else if (u === "NEEDS_MAJOR_CHANGES") verdict = "NEEDS_MAJOR_CHANGES"
    }
    return {
      verdict,
      severity: countSeverities(raw),
      lenses: extractLenses(raw),
      themes: extractThemes(raw),
    }
  } catch {
    return {
      verdict: null,
      severity: { high: 0, medium: 0, low: 0 },
      lenses: [],
      themes: [],
    }
  }
}
