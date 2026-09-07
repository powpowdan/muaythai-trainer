function parseReviewOutput(outputStr) {
  if (!outputStr || typeof outputStr !== "string") {
    return { round: 0, verdict: "UNKNOWN", findings_high: 0, findings_medium: 0, findings_low: 0, files_mentioned: 0, files: [] }
  }

  const roundMatch = outputStr.match(/Round\s+(\d+)/)
  const round = roundMatch ? parseInt(roundMatch[1], 10) : 0

  let verdict = "UNKNOWN"
  if (/\bAPPROVED\b/.test(outputStr)) verdict = "APPROVED"
  else if (/\bNEEDS_MAJOR_CHANGES\b/.test(outputStr)) verdict = "NEEDS_MAJOR_CHANGES"
  else if (/\bNEEDS_CHANGES\b/.test(outputStr)) verdict = "NEEDS_CHANGES"
  else if (/\bNEEDS_REVISION\b/.test(outputStr)) verdict = "NEEDS_REVISION"

  const highFindings = (outputStr.match(/\[SEVERITY:\s*high\]/gi) || []).length
  const mediumFindings = (outputStr.match(/\[SEVERITY:\s*medium\]/gi) || []).length
  const lowFindings = (outputStr.match(/\[SEVERITY:\s*low\]/gi) || []).length

  const filePattern = /\*\*File:\*\*\s*(\S+)/g
  const filesSet = new Set()
  let match
  while ((match = filePattern.exec(outputStr)) !== null) {
    const raw = match[1].replace(/^`|`$/g, "")
    const filePath = raw.replace(/:L\d+.*$/, "")
    filesSet.add(filePath)
  }

  const artifactPattern = /\*\*Artifact:\*\*\s*(\S+)/g
  while ((match = artifactPattern.exec(outputStr)) !== null) {
    filesSet.add(match[1])
  }

  const files = [...filesSet]

  return {
    round,
    verdict,
    findings_high: highFindings,
    findings_medium: mediumFindings,
    findings_low: lowFindings,
    files_mentioned: files.length,
    files,
  }
}

function computeRoundSurprise(currentParsed, previousHighSeverityFiles) {
  if (currentParsed.round <= 1) return { surprise: false, newFiles: [] }

  const newFiles = currentParsed.files.filter(f => !previousHighSeverityFiles.has(f))
  return {
    surprise: newFiles.length > 0 && currentParsed.findings_high > 0,
    newFiles,
  }
}

export { parseReviewOutput, computeRoundSurprise }
