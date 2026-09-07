#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs"
import { parseTaskGroups } from "./task-parser.js"
import { clusterTasks } from "./cluster-tasks.js"
import {
  createIssue as defaultCreateIssue,
  getGitHubConfig,
  validateGhCli,
} from "./github-api.js"

function stripAnnotations(title) {
  return title.replace(/\s*\[(Issue|Part of Issue) #\d+\]\s*/g, "").trim()
}

export async function generateTickets(changeName, tasksMdPath, deps = {}) {
  const {
    createIssue = defaultCreateIssue,
    getConfig = getGitHubConfig,
    validate = validateGhCli,
  } = deps

  getConfig()
  validate()

  const groups = parseTaskGroups(tasksMdPath)
  if (groups.length === 0) {
    console.log("No task sections found in tasks.md")
    return []
  }

  const clusters = clusterTasks(groups)

  const ANNOTATION_RE = /\[(?:Issue|Part of Issue) #\d+\]/

  const clusterFullyAnnotated = (c) =>
    c.rawGroups.every((g) => ANNOTATION_RE.test(g.sectionTitle))

  const clusterPrimaryAnnotated = (c) =>
    c.rawGroups.length > 0 && ANNOTATION_RE.test(c.rawGroups[0].sectionTitle)

  const clusterPartiallyAnnotated = (c) =>
    c.rawGroups.some((g) => ANNOTATION_RE.test(g.sectionTitle)) &&
    !clusterFullyAnnotated(c) &&
    !clusterPrimaryAnnotated(c)

  const clusterHasIssue = (c) =>
    clusterFullyAnnotated(c) || clusterPrimaryAnnotated(c)

  const alreadyGenerated = clusters.filter(clusterHasIssue)
  if (alreadyGenerated.length === clusters.length) {
    console.log("Tickets already exist for all clusters. Skipping.")
    return []
  }

  if (alreadyGenerated.length > 0) {
    console.log(
      `Some clusters already have tickets (${alreadyGenerated.length}/${clusters.length}). Generating missing ones.`
    )
  }

  let content = readFileSync(tasksMdPath, "utf-8")
  const created = []

  for (const cluster of clusters) {
    let orphanedIssueNum = null
    if (clusterPartiallyAnnotated(cluster)) {
      const match = cluster.rawGroups
        .map((g) => g.sectionTitle.match(/(?:Issue|Part of Issue) #(\d+)/))
        .find(Boolean)
      orphanedIssueNum = match ? match[1] : null
      console.log(`WARN: cluster "${cluster.conceptKey}" is partially annotated${orphanedIssueNum ? ` (orphaned issue #${orphanedIssueNum})` : ""} — regenerating`)
    }
    if (clusterHasIssue(cluster)) {
      console.log(`Skipping cluster "${cluster.conceptKey}" — already has issue number`)
      continue
    }

    const title = `[openspec] ${cluster.conceptKey}`
    const body = [
      `Change: ${changeName}`,
      "",
      "Tasks:",
      ...cluster.taskList,
    ].join("\n")

    const firstTask = cluster.taskNumbers[0]
    const lastTask = cluster.taskNumbers[cluster.taskNumbers.length - 1]
    const taskRangeLabel =
      firstTask === lastTask
        ? `tasks:${firstTask}`
        : `tasks:${firstTask}-${lastTask}`

    const labels = [
      `openspec:${changeName}`,
      "status:open",
      taskRangeLabel,
      `ticket-group:${cluster.ticketGroup}`,
    ]

    if (cluster.dependsOn && cluster.dependsOn.length > 0) {
      labels.push(`depends-on:${cluster.dependsOn.join("-")}`)
    }

    console.log(`Creating issue: ${title}`)
    const issue = createIssue(title, body, labels)
    console.log(`  Created issue #${issue.number}: ${issue.url}`)
    if (orphanedIssueNum) {
      console.log(`WARN: orphaned issue #${orphanedIssueNum} needs manual closure — regenerated as #${issue.number}`)
    }

    let updated = content
    let replaced = 0
    for (let i = 0; i < cluster.rawGroups.length; i++) {
      const group = cluster.rawGroups[i]
      const oldHeader = group.rawLines[0]
      const newHeader = `## ${group.sectionNumber}. ${stripAnnotations(group.sectionTitle)} ${i === 0 ? `[Issue #${issue.number}]` : `[Part of Issue #${issue.number}]`}`
      if (!updated.includes(oldHeader)) {
        console.error(`WARN: header not found in tasks.md, issue #${issue.number} may be orphaned: ${JSON.stringify(oldHeader)}`)
      } else {
        updated = updated.replace(oldHeader, newHeader)
        replaced++
      }
    }
    if (replaced !== cluster.rawGroups.length) {
      throw new Error(`Issue #${issue.number} created but only ${replaced}/${cluster.rawGroups.length} headers annotated`)
    }

    content = updated
    try {
      writeFileSync(tasksMdPath, content, "utf-8")
    } catch (err) {
      console.error(`FATAL: issue #${issue.number} created but failed to write tasks.md (prior issues: ${created.map(i => '#' + i.number).join(",")}): ${err.message}`)
      console.error(`NOTE: re-running will create a duplicate issue #${issue.number}. Manually annotate tasks.md or close the orphaned issue before retrying.`)
      throw err
    }

    created.push(issue)
  }

  if (created.length > 0) {
    console.log(`Updated ${tasksMdPath} with issue numbers`)
  }

  return created
}

const args = process.argv.slice(2)
const changeIndex = args.indexOf("--change")
if (changeIndex !== -1 && args[changeIndex + 1]) {
  const changeName = args[changeIndex + 1]
  const tasksMdPath = args.find((a) => a.endsWith("tasks.md")) || null

  if (!tasksMdPath) {
    console.error("Usage: ticket-generator.js --change <name> <path-to-tasks.md>")
    process.exit(1)
  }

  generateTickets(changeName, tasksMdPath).catch((err) => {
    console.error(`Error: ${err.message}`)
    process.exit(1)
  })
}
