const REQUIRED_LABELS = ["reviewed", "approved", "code-reviewed"]

export default {
  id: "merge-gate",
  server: async ({ client, $, directory }) => {
    return {
      "tool.execute.before": async (input) => {
        if (input.tool !== "bash") return

        const command = input.args?.command
        if (!command || typeof command !== "string") return

        const match = command.match(/\bgh\s+pr\s+merge\s+(\d+)/)
        if (!match) return

        const prNumber = match[1]

        let labels
        try {
          const result = await $`gh pr view ${prNumber} --json labels`
          const parsed = JSON.parse(result.stdout)
          labels = (parsed.labels || []).map((l) => l.name)
        } catch (err) {
          throw new Error(
            `MERGE BLOCKED: PR #${prNumber} label check failed. Could not verify labels: ${err.message}. All of reviewed, approved, code-reviewed are required before merge.`
          )
        }

        const missing = REQUIRED_LABELS.filter((label) => !labels.includes(label))

        if (missing.length > 0) {
          throw new Error(
            `MERGE BLOCKED: PR #${prNumber} is missing labels: ${missing.join(", ")}. All of reviewed, approved, code-reviewed are required before merge.`
          )
        }
      },
    }
  },
}
