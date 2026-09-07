import { extname, dirname } from "node:path"

const LOGIC_EXTS = new Set([".js", ".ts", ".tsx", ".jsx", ".py", ".go", ".rs", ".c", ".cpp", ".h", ".java"])
const CONFIG_EXTS = new Set([".json", ".yaml", ".yml", ".toml", ".xml", ".ini", ".env"])
const DOC_EXTS = new Set([".md", ".txt", ".rst", ".adoc"])
const BINARY_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".zip", ".gz", ".tar", ".bin", ".pdf", ".mp4", ".mp3", ".avi", ".mov"])
const TEST_PATTERNS = [/\.test\./, /\.spec\./, /\/__tests__\//, /(?:^|\/)tests?\//, /\/spec\//, /\/test-/, /^tests?\//]

function classifyFile(filePath) {
  const ext = extname(filePath).toLowerCase()
  const isTest = TEST_PATTERNS.some(p => p.test(filePath))

  if (isTest) return "test"
  if (BINARY_EXTS.has(ext)) return "binary"
  if (LOGIC_EXTS.has(ext)) return "logic"
  if (CONFIG_EXTS.has(ext)) return "config"
  if (DOC_EXTS.has(ext)) return "docs"
  return "logic"
}

function parseDiffStat(statOutput) {
  if (!statOutput || !statOutput.trim()) {
    return { score: 0, risk: "none", files: 0, logicFiles: 0, testFiles: 0, totalLines: 0, directories: 0 }
  }

  const lines = statOutput.trim().split("\n")
  const fileEntries = []

  for (const line of lines) {
    const summaryMatch = line.match(/(\d+) files? changed/)
    if (summaryMatch) break

    const parts = line.split("|")
    if (parts.length < 2) continue

    const filePath = parts[0].trim()
    if (!filePath) continue

    const changePart = parts[1].trim()
    const isBinary = changePart.startsWith("Bin")

    let lineCount = 0

    if (!isBinary) {
      const numMatch = changePart.match(/^(\d+)/)
      lineCount = numMatch ? parseInt(numMatch[1], 10) : 0
    }

    const category = classifyFile(filePath)
    fileEntries.push({ filePath, lineCount, isBinary, category })
  }

  const files = fileEntries.length
  if (files === 0) {
    return { score: 0, risk: "none", files: 0, logicFiles: 0, testFiles: 0, totalLines: 0, directories: 0 }
  }

  const logicFiles = fileEntries.filter(f => f.category === "logic").length
  const testFiles = fileEntries.filter(f => f.category === "test").length
  const totalLines = fileEntries.reduce((sum, f) => sum + f.lineCount, 0)
  const dirs = new Set(fileEntries.map(f => dirname(f.filePath)))

  let score = files * 2 + totalLines * 0.05

  const logicRatio = logicFiles / files
  if (logicRatio > 0.5) score *= 1.5

  if (testFiles === 0 && logicFiles > 0) score *= 1.3

  score = Math.round(score * 100) / 100

  let risk
  if (score === 0) risk = "none"
  else if (score < 10) risk = "low"
  else if (score < 30) risk = "medium"
  else risk = "high"

  return { score, risk, files, logicFiles, testFiles, totalLines, directories: dirs.size }
}

export { parseDiffStat, classifyFile }
