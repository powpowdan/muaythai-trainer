import { readFileSync } from "node:fs"

export function parseTaskGroups(tasksMdPath) {
  let content
  try {
    content = readFileSync(tasksMdPath, "utf-8")
  } catch (err) {
    if (err.code === "ENOENT") {
      return []
    }
    throw err
  }

  const lines = content.split("\n")
  const groups = []
  let currentGroup = null

  for (const line of lines) {
    const sectionMatch = line.match(/^##\s+(\d+)\.\s+(.+)$/)
    if (sectionMatch) {
      if (currentGroup) {
        groups.push(currentGroup)
      }
      const sectionNum = sectionMatch[1]
      const sectionTitle = sectionMatch[2].trim()
      currentGroup = {
        sectionNumber: parseInt(sectionNum, 10),
        sectionTitle,
        taskNumbers: [],
        taskList: [],
        rawLines: [line],
      }
      continue
    }

    if (currentGroup) {
      currentGroup.rawLines.push(line)
      const taskMatch = line.match(/^- \[[ x]\]\s+(\d+\.\d+)\s+/)
      if (taskMatch) {
        currentGroup.taskNumbers.push(taskMatch[1])
        currentGroup.taskList.push(line)
      }
    }
  }

  if (currentGroup) {
    groups.push(currentGroup)
  }

  return groups
}
