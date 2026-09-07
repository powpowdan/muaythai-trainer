import { execSync } from "node:child_process"

function runGh(args, opts = {}) {
  const cmd = `gh ${args}`
  try {
    const result = execSync(cmd, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
      timeout: opts.timeout || 30000,
      cwd: opts.cwd,
    })
    return { ok: true, stdout: result.trim(), stderr: "" }
  } catch (err) {
    const stdout = err.stdout?.trim() || ""
    const stderr = err.stderr?.trim() || ""
    const status = err.status
    if (status === 403 || stderr.includes("403")) {
      throw new GitHubApiError("Rate limited or forbidden by GitHub API", 403, stderr)
    }
    if (status === 429 || stderr.includes("429")) {
      throw new GitHubApiError("GitHub API rate limit exceeded", 429, stderr)
    }
    if (status === 404 || stderr.includes("404")) {
      throw new GitHubApiError("GitHub resource not found", 404, stderr)
    }
    throw new GitHubApiError(`gh command failed: ${stderr || err.message}`, status, stderr)
  }
}

class GitHubApiError extends Error {
  constructor(message, status, details) {
    super(message)
    this.name = "GitHubApiError"
    this.status = status
    this.details = details
  }
}

export function validateGhCli() {
  try {
    runGh("auth status")
    return true
  } catch (err) {
    if (err.message.includes("not found") || err.message.includes("ENOENT")) {
      throw new Error(
        "gh CLI is not installed. Install it from https://cli.github.com/ and authenticate with `gh auth login`."
      )
    }
    throw new Error(
      `gh CLI is not authenticated. Run \`gh auth login\` to authenticate.\nDetails: ${err.message}`
    )
  }
}

function getRepoFromGitRemote() {
  try {
    const url = execSync("git remote get-url origin", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
    const match = url.match(/[/:]([^/]+\/[^/]+?)(?:\.git)?$/)
    if (!match) return null
    const parts = match[1].split("/")
    return { owner: parts[0], repo: parts[1] }
  } catch {
    return null
  }
}

export function getGitHubConfig() {
  const token = process.env.GITHUB_TOKEN
  if (!token) {
    throw new Error("Missing GitHub configuration. Set the GITHUB_TOKEN environment variable.")
  }

  const remote = getRepoFromGitRemote()
  const owner = process.env.GITHUB_OWNER || remote?.owner || "MaVictor"
  const repo = process.env.GITHUB_REPO || remote?.repo

  if (!repo) {
    throw new Error("Could not determine repository. Ensure you are in a git repo with a GitHub remote, or set GITHUB_REPO.")
  }

  return { token, owner, repo }
}

function repoFlag() {
  const { owner, repo } = getGitHubConfig()
  return `--repo ${owner}/${repo}`
}

export function createIssue(title, body, labels = []) {
  const labelArg = labels.length > 0 ? `--label "${labels.join(",")}"` : ""
  const escapedTitle = title.replace(/"/g, '\\"')
  const escapedBody = body.replace(/"/g, '\\"')
  const result = runGh(
    `issue create --title "${escapedTitle}" --body "${escapedBody}" ${labelArg} ${repoFlag()} --json number,url,title`
  )
  return JSON.parse(result.stdout)
}

export function listIssues(filters = {}) {
  const parts = ["issue list", repoFlag(), "--json number,title,labels,state,assignees,url"]

  if (filters.labels) {
    parts.push(`--label "${filters.labels}"`)
  }
  if (filters.state) {
    parts.push(`--state ${filters.state}`)
  }
  if (filters.assignee) {
    parts.push(`--assignee ${filters.assignee}`)
  }
  if (filters.search) {
    parts.push(`--search "${filters.search}"`)
  }
  if (filters.limit) {
    parts.push(`--limit ${filters.limit}`)
  }

  const result = runGh(parts.join(" "))
  return JSON.parse(result.stdout)
}

export function updateIssue(number, updates) {
  const parts = [`issue edit ${number}`, repoFlag()]

  if (updates.title) {
    parts.push(`--title "${updates.title.replace(/"/g, '\\"')}"`)
  }
  if (updates.body) {
    parts.push(`--body "${updates.body.replace(/"/g, '\\"')}"`)
  }
  if (updates.state) {
    parts.push(`--state ${updates.state}`)
  }
  if (updates.addAssignees) {
    parts.push(`--add-assignee ${updates.addAssignees}`)
  }
  if (updates.removeAssignees) {
    parts.push(`--remove-assignee ${updates.removeAssignees}`)
  }

  const result = runGh(parts.join(" "))
  return { ok: true }
}

export function addLabels(number, labels) {
  const labelStr = labels.join(",")
  runGh(`issue edit ${number} ${repoFlag()} --add-label "${labelStr}"`)
  return { ok: true }
}

export function removeLabels(number, labels) {
  const labelStr = labels.join(",")
  runGh(`issue edit ${number} ${repoFlag()} --remove-label "${labelStr}"`)
  return { ok: true }
}

export function createComment(number, body) {
  const escapedBody = body.replace(/"/g, '\\"')
  const result = runGh(`issue comment ${number} ${repoFlag()} --body "${escapedBody}" --json id`)
  return JSON.parse(result.stdout)
}

export function listPRs(filters = {}) {
  const parts = ["pr list", repoFlag(), "--json number,title,labels,headRefName,state,url"]

  if (filters.state) {
    parts.push(`--state ${filters.state}`)
  }
  if (filters.labels) {
    parts.push(`--label "${filters.labels}"`)
  }
  if (filters.search) {
    parts.push(`--search "${filters.search}"`)
  }
  if (filters.limit) {
    parts.push(`--limit ${filters.limit}`)
  }

  const result = runGh(parts.join(" "))
  return JSON.parse(result.stdout)
}

export function mergePR(number) {
  const result = runGh(`pr merge ${number} ${repoFlag()} --squash --delete-branch --json state`)
  return JSON.parse(result.stdout)
}

export function getPRDiff(number) {
  const result = runGh(`pr diff ${number} ${repoFlag()}`)
  return result.stdout
}

export function getAuthenticatedUser() {
  const result = runGh("api user --jq .login")
  return result.stdout.trim()
}

export function getIssue(number) {
  const result = runGh(
    `issue view ${number} ${repoFlag()} --json number,title,labels,state,assignees,url,body,createdAt,updatedAt`
  )
  return JSON.parse(result.stdout)
}

export function getPR(number) {
  const result = runGh(
    `pr view ${number} ${repoFlag()} --json number,title,labels,headRefName,state,url,body`
  )
  return JSON.parse(result.stdout)
}

export { GitHubApiError, runGh }
