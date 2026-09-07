import { fileURLToPath } from "node:url"
import { parseTaskGroups } from "./task-parser.js"

export function extractConceptKey(title) {
  const parts = title.split(/—|–|\s+-\s+/)
  return parts.length > 1 ? parts[0].trim() : title.trim()
}

export function clusterGroups(groups) {
  const clusters = []

  for (const group of groups) {
    const conceptKey = extractConceptKey(group.sectionTitle)
    const lastCluster = clusters[clusters.length - 1]

    if (lastCluster && lastCluster.conceptKey === conceptKey) {
      lastCluster.sections.push(group.sectionNumber)
      lastCluster.taskNumbers.push(...group.taskNumbers)
      lastCluster.taskList.push(...group.taskList)
      lastCluster.rawGroups.push(group)
    } else {
      clusters.push({
        conceptKey,
        sections: [group.sectionNumber],
        taskNumbers: [...group.taskNumbers],
        taskList: [...group.taskList],
        rawGroups: [group],
      })
    }
  }

  return clusters
}

function mergeClusters(target, source) {
  target.sections.push(...source.sections)
  target.taskNumbers.push(...source.taskNumbers)
  target.taskList.push(...source.taskList)
  target.rawGroups.push(...source.rawGroups)
}

function mergeClustersFront(target, source) {
  target.sections.unshift(...source.sections)
  target.taskNumbers.unshift(...source.taskNumbers)
  target.taskList.unshift(...source.taskList)
  target.rawGroups.unshift(...source.rawGroups)
}

export function absorbSingleTaskClusters(clusters) {
  if (clusters.length <= 1) {
    return clusters.map((c) => ({
      ...c,
      sections: [...c.sections],
      taskNumbers: [...c.taskNumbers],
      taskList: [...c.taskList],
      rawGroups: [...c.rawGroups],
    }))
  }

  const result = clusters.map((c) => ({
    ...c,
    sections: [...c.sections],
    taskNumbers: [...c.taskNumbers],
    taskList: [...c.taskList],
    rawGroups: [...c.rawGroups],
  }))

  for (let i = result.length - 1; i >= 1; i--) {
    if (
      result[i].taskNumbers.length <= 1 &&
      !isMetaConcept(result[i].conceptKey) &&
      !isMetaConcept(result[i - 1].conceptKey) &&
      !isDependencyConcept(result[i].conceptKey) &&
      !isDependencyConcept(result[i - 1].conceptKey)
    ) {
      mergeClusters(result[i - 1], result[i])
      result.splice(i, 1)
    }
  }

  if (
    result.length > 1 &&
    result[0].taskNumbers.length <= 1 &&
    !isMetaConcept(result[0].conceptKey) &&
    !isMetaConcept(result[1].conceptKey) &&
    !isDependencyConcept(result[0].conceptKey) &&
    !isDependencyConcept(result[1].conceptKey)
  ) {
    mergeClustersFront(result[1], result[0])
    result.shift()
  }

  return result
}

export function applyThreshold(clusters, totalTasks) {
  if (clusters.length === 1) return clusters
  if (totalTasks <= 10 || clusters.length <= 2) {
    if (clusters.length === 0) return clusters
    const merged = {
      conceptKey: "All Tasks",
      sections: [],
      taskNumbers: [],
      taskList: [],
      rawGroups: [],
    }
    for (const cluster of clusters) {
      mergeClusters(merged, cluster)
    }
    return [merged]
  }
  return clusters
}

// ---------------------------------------------------------------------------
// detectDependencies heuristics (coarse edges for dispatch / firstmate waves)
//
// Keyword match is case-insensitive on conceptKey tokens / whole words:
//   DEPENDENCY_KEYWORDS → "test", "tests", "validation", "verify", "integration"
//   Matches: "Tests", "Testing", "Test Suite", "Unit Tests", "API Tests",
//            "Integration Tests", "Validation", "Verify Outputs", etc.
//   A concept matches if any keyword equals the full key, appears as a whole
//   word, or is a prefix of any alphanumeric token (so "Testing" matches
//   via token-prefix "test").
//
// Rules:
// 1. Dependency-concept clusters (keyword match) with prior non-meta clusters
//    get dependsOn = those prior 1-based ticketGroup ids only (meta skipped).
//    This is a coarse "run after everything before me" edge, not file-level.
// 2. Implementation / product clusters almost always have dependsOn = [] and
//    may spawn in parallel (wave 0) unless authors use dependency keywords.
// 3. Meta concepts (META_PATTERNS: out-of-scope, changelog, notes) never get
//    dependsOn edges; they are also excluded from the dependsOn id list of
//    later clusters and from single-task absorb merges.
// 4. ticketGroup is always sequential 1-based (i + 1), matching cluster-tasks
//    CLI JSON and firstmate fleet meta cluster numbers.
// 5. Captains/authors SHOULD title integration/test sections with dependency
//    keywords when spawn order matters; false empty deps otherwise.
// ---------------------------------------------------------------------------
const DEPENDENCY_KEYWORDS = ["test", "tests", "validation", "verify", "integration"]

function isDependencyConcept(conceptKey) {
  const key = String(conceptKey).toLowerCase()
  const tokens = key.split(/[^a-z0-9]+/).filter(Boolean)
  return DEPENDENCY_KEYWORDS.some((k) => {
    if (key === k) return true
    // Whole-word match inside multi-word titles ("Unit Tests", "API Tests")
    if (new RegExp(`\\b${k}\\b`, "i").test(conceptKey)) return true
    // Token prefix: "Testing" / "Tests" via keyword "test"
    if (tokens.some((t) => t === k || t.startsWith(k))) return true
    return false
  })
}

// Informational/meta sections are neither absorbed into other clusters nor
// assigned dependencies, so they never inherit blocking depends-on labels.
const META_PATTERNS = [/\bout-of-scope\b/i, /\bchangelog\b/i, /\bnotes?\b/i]

function isMetaConcept(conceptKey) {
  return META_PATTERNS.some((re) => re.test(conceptKey))
}

export function detectDependencies(clusters) {
  return clusters.map((cluster, i) => {
    let dependsOn = []
    if (
      !isMetaConcept(cluster.conceptKey) &&
      isDependencyConcept(cluster.conceptKey) &&
      i > 0
    ) {
      // 1-based ticketGroups of prior clusters, excluding meta concepts
      for (let j = 1; j <= i; j++) {
        if (!isMetaConcept(clusters[j - 1].conceptKey)) {
          dependsOn.push(j)
        }
      }
    }
    return {
      ...cluster,
      dependsOn,
      ticketGroup: i + 1,
    }
  })
}

/**
 * Normalize cluster.dependsOn for wave planning.
 *
 * - null/undefined → empty deps (ready when no other blockers)
 * - number[] (or array of numeric strings) → Number() each entry
 * - CSV string "1,2" / "1, 2" → [1, 2]
 * - unparseable string, non-finite array entries, or wrong shape (object,
 *   bare number, boolean, …) → { invalid: true } so the caller fails closed
 *   (cluster goes to waiting with unmet deps)
 *
 * @param {unknown} dependsOn
 * @returns {{ deps: number[], invalid: boolean }}
 */
function normalizeDependsOn(dependsOn) {
  if (dependsOn == null) {
    return { deps: [], invalid: false }
  }

  if (Array.isArray(dependsOn)) {
    const deps = dependsOn.map((id) => Number(id))
    if (deps.some((n) => !Number.isFinite(n))) {
      return { deps: [], invalid: true }
    }
    return { deps, invalid: false }
  }

  if (typeof dependsOn === "string") {
    const trimmed = dependsOn.trim()
    if (trimmed === "") {
      return { deps: [], invalid: false }
    }
    const parts = trimmed
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "")
    if (parts.length === 0) {
      return { deps: [], invalid: true }
    }
    const deps = parts.map((s) => Number(s))
    if (deps.some((n) => !Number.isFinite(n))) {
      return { deps: [], invalid: true }
    }
    return { deps, invalid: false }
  }

  // Wrong shape: bare number, object, boolean, etc. — fail closed.
  return { deps: [], invalid: true }
}

/**
 * Pure spawn-wave planner for firstmate (and shared tooling).
 *
 * Partitions clusters into spawn-eligible vs still blocked given which
 * dependency clusters already have implementer STATUS: COMPLETE.
 *
 * @param {Array<{ dependsOn?: number[]|string, ticketGroup?: number }>} clusters
 *   Clusters from detectDependencies / clusterTasks. `dependsOn` and
 *   `ticketGroup` are 1-based cluster numbers matching cluster-tasks output.
 *   `dependsOn` may be a number array or a CSV string ("1,2"); other bad
 *   shapes fail closed (waiting).
 * @param {Iterable<number|string>|number|string|null|undefined} completedClusterIds
 *   Cluster ids (1-based) whose implementers are COMPLETE. Array, Set, or
 *   any iterable of ids; a bare number or string is treated as a single id
 *   (strings are NOT iterated char-by-char — "12" → {12}, not {1,2}).
 *   Values are coerced with Number().
 * @returns {{ ready: typeof clusters, waiting: typeof clusters }}
 *   ready   — every listed dep is in the completed set (including empty
 *             dependsOn). **May include clusters that are themselves already
 *             COMPLETE** (or still in-flight). Callers MUST filter spawn
 *             candidates as: ready minus completed minus in-flight.
 *   waiting — at least one dep not yet COMPLETE, or dependsOn unparseable /
 *             wrong shape (fail closed — never treat as wave-0 ready)
 *
 * Does not mutate inputs. Does not assign spawn_wave numbers (callers may
 * derive waves from successive release rounds). CLI JSON output is unchanged;
 * this helper is optional for skill/orchestrators.
 */
export function planSpawnWaves(clusters, completedClusterIds = []) {
  const completed = new Set()
  if (completedClusterIds != null) {
    // String is iterable by character; treat number/string as a single id.
    if (
      typeof completedClusterIds === "string" ||
      typeof completedClusterIds === "number"
    ) {
      completed.add(Number(completedClusterIds))
    } else {
      for (const id of completedClusterIds) {
        completed.add(Number(id))
      }
    }
  }

  const ready = []
  const waiting = []
  for (const cluster of clusters) {
    const { deps, invalid } = normalizeDependsOn(cluster.dependsOn)
    // invalid shape → always unmet (fail closed, never spawn as wave-0)
    const unmet =
      invalid || deps.some((id) => !completed.has(Number(id)))
    if (unmet) {
      waiting.push(cluster)
    } else {
      ready.push(cluster)
    }
  }
  return { ready, waiting }
}

export function clusterTasks(groups) {
  const totalTasks = groups.reduce(
    (sum, g) => sum + g.taskNumbers.length,
    0
  )

  let clusters = clusterGroups(groups)
  clusters = absorbSingleTaskClusters(clusters)
  clusters = applyThreshold(clusters, totalTasks)
  clusters = detectDependencies(clusters)

  return clusters
}

// CLI entry: invoked as `node cluster-tasks.js <tasks.md-path>`.
// Reads the tasks.md file, parses groups, clusters them, and writes the
// cluster array as JSON to stdout. Used by both the OpenCode GitHub-mode
// dispatcher (openspec-dispatcher.js), the local-mode dispatcher
// (openspec-dispatcher-local.js), and the Claude Code port's dispatch skill
// (.claude/skills/openspec-dispatch/SKILL.md step 4).
const isMainInvocation = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
  } catch {
    return false
  }
})()

if (isMainInvocation) {
  const tasksPath = process.argv[2]
  if (!tasksPath) {
    process.stderr.write("Usage: node cluster-tasks.js <tasks.md-path>\n")
    process.exit(2)
  }
  try {
    const groups = parseTaskGroups(tasksPath)
    const clusters = clusterTasks(groups)
    process.stdout.write(JSON.stringify(clusters) + "\n")
  } catch (err) {
    process.stderr.write(`cluster-tasks.js failed: ${err.message}\n`)
    process.exit(1)
  }
}
