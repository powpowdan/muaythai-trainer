---
name: lavish-openspec
description: Turn a batch of finished lavish exploration sessions into OpenSpec proposal(s). Sweeps .lavish/*.html for ended, ungrabbed sessions, synthesizes a cross-session brief, judges whether the decisions form one cohesive proposal or several separable ones, and dispatches fresh subagent(s) to invoke openspec-propose — rooted at the nearest ancestor openspec/ project, bootstrapping one via `openspec init` if none exists. Use when lavish exploration in `.lavish/` feels done and should become OpenSpec artifact(s).
license: MIT
compatibility: opencode
metadata:
  author: openspec
  version: "1.0"
---

Mechanical handoff from finished `/lavish` exploration to OpenSpec proposals. This is deliberately **not** `openspec-explore` — it does not think alongside the user; it sweeps, synthesizes, judges complexity, and delegates all proposal writing to freshly spawned subagents so a long exploration transcript never bleeds into `openspec-propose`.

> **Note:** This variant does not reference `shared/lib/lavish-session-status.js`, `shared/lib/ancestor-openspec-resolve.js`, or `shared/lib/lavish-brief.js` — OpenCode's lib-delivery path (`copyClaudeLib()`) excludes the `opencode` target, and the other one (`copyPluginClosure()` → `.opencode/plugins/lib/`) is reserved for registered plugins, not skill-referenceable. Steps 3, 4, 6, 9, and 12 below inline the same parsing/filtering/walk logic directly as Bash/node commands instead.

**Input**: Optionally a starting directory (the repo/dir whose `.lavish/` you want swept). Defaults to the current working directory.

## Steps

1. **Resolve the lavish directory**

   `<lavish-dir>` = `<start-dir>/.lavish` (absolute path). If it does not exist, report "nothing to sweep — no `.lavish/` directory here" and STOP.

2. **Read session status**

   Run via Bash:
   ```bash
   npx lavish-axi
   ```
   Capture its stdout as `<raw-output>`. This is the whole lavish-axi server's tracked session list (may span other directories/repos entirely — it is not scoped to `<lavish-dir>`).

3. **Parse the session table inline**

   `<raw-output>` contains one line matching `sessions[N]{file,status,url,pending_prompts}:` followed by N indented, CSV-style rows (quoted where a field needs it) — this is not valid nested YAML sequence syntax, so parse it directly:
   ```bash
   node -e '
   const raw = require("fs").readFileSync(0, "utf-8")
   const lines = raw.split("\n")
   const hRe = /^sessions\[(\d+)\]\{([^}]*)\}:\s*$/
   const hIdx = lines.findIndex(l => hRe.test(l))
   if (hIdx === -1) { console.error("PARSE_ERROR: no sessions[N]{...}: header found"); process.exit(1) }
   const m = lines[hIdx].match(hRe)
   const n = Number(m[1])
   const fields = m[2].split(",").map(s => s.trim()).filter(Boolean)
   const sessions = []
   for (let i = 0; i < n; i++) {
     const line = lines[hIdx + 1 + i]
     if (line === undefined || line.trim() === "") { console.error(`PARSE_ERROR: expected ${n} rows, found only ${i}`); process.exit(1) }
     const row = []; let cur = ""; let q = false
     const s = line.trim()
     for (let j = 0; j < s.length; j++) {
       const c = s[j]
       if (q) { if (c === "\"") { if (s[j+1] === "\"") { cur += "\""; j++ } else q = false } else cur += c }
       else if (c === "\"") q = true
       else if (c === ",") { row.push(cur); cur = "" }
       else cur += c
     }
     row.push(cur)
     if (row.length !== fields.length) { console.error(`PARSE_ERROR: row ${i+1} has ${row.length} fields, expected ${fields.length}`); process.exit(1) }
     const obj = {}
     fields.forEach((f, idx) => { const v = row[idx].trim(); obj[f] = /^\d+$/.test(v) ? Number(v) : v })
     sessions.push(obj)
   }
   console.log(JSON.stringify(sessions))
   ' <<< "<raw-output>"
   ```
   On `PARSE_ERROR` (non-zero exit), also run `npx lavish-axi --version` and report the parse failure together with that version — do not proceed on unparseable output.

4. **Exclude already-grabbed sessions and compute the sweep scope — inline, no shared/lib**

   For each `<lavish-dir>/brief-*.md` file, extract its grabbed basenames:
   ```bash
   node -e '
   const fs = require("fs")
   const md = fs.readFileSync(process.argv[1], "utf-8")
   const lines = md.split("\n")
   const hIdx = lines.findIndex(l => /^##\s+Grabbed sessions\s*$/.test(l.trim()))
   const out = []
   if (hIdx !== -1) {
     for (let i = hIdx + 1; i < lines.length; i++) {
       if (/^##\s+/.test(lines[i].trim())) break
       const m = lines[i].trim().match(/^-\s+(.+\.html)\s*$/)
       if (m) out.push(m[1].trim())
     }
   }
   console.log(JSON.stringify(out))
   ' "<brief-file-path>"
   ```
   Union the results across all briefs into `<grabbed-basenames>` (a JSON array). Then compute the sweep scope:
   ```bash
   node -e '
   const path = require("path")
   const sessions = JSON.parse(process.argv[1])
   const lavishDir = path.resolve(process.argv[2])
   const grabbed = new Set(JSON.parse(process.argv[3]))
   const scope = sessions.filter(s => {
     const fp = path.resolve(String(s.file))
     return path.dirname(fp) === lavishDir && fp.toLowerCase().endsWith(".html") && !grabbed.has(path.basename(fp))
   })
   console.log(JSON.stringify(scope))
   ' '<step-3-json-array>' "<lavish-dir>" '<grabbed-basenames-json>'
   ```

5. **Nothing to sweep**

   If the sweep scope (step 4's result) is empty — either no `.lavish/*.html` files were found at all, or every one was already grabbed — report "nothing to sweep" (state which case) and STOP. Do not write a brief or spawn a subagent.

6. **Refuse on an incomplete sweep — inline**

   ```bash
   node -e 'console.log(JSON.stringify(JSON.parse(process.argv[1]).filter(s => s.status === "open")))' '<step-4-json-array>'
   ```
   If this returns any sessions, report exactly which file(s) are still open and STOP. Do not write a brief or spawn a subagent. The user should end those sessions (or run `lavish-axi end <file>`) and re-invoke this skill.

7. **Read the grabbed sessions' content**

   Every session in the sweep scope is now grabbed by this run. Read each one's `.html` file directly — the decisions and rationale from the exploration live in the artifact's own content, there is no separate log.

8. **Judge complexity yourself**

   While synthesizing the brief (next step), decide: do these sessions' decisions form one cohesive story (single proposal), or genuinely independent concerns (multiple proposals)? Make this judgment yourself — do not spawn a separate subagent to judge it. If separable, assign each resulting proposal a kebab-case change name now and write out, in prose, how each depends on or relates to its siblings.

9. **Synthesize and write the brief — inline slug computation**

    ```bash
    node -e '
    const crypto = require("crypto")
    const basenames = JSON.parse(process.argv[1])
    const existing = new Set(JSON.parse(process.argv[2]))
    const sorted = [...basenames].sort()
    const hash = crypto.createHash("sha256").update(sorted.join(",")).digest("hex").slice(0, 8)
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "")
    const slug = `${hash}-${dateStr}`
    let base = `brief-${slug}.md`
    if (existing.has(base)) {
      let n = 2
      while (existing.has(`brief-${slug}-${n}.md`)) n++
      base = `brief-${slug}-${n}.md`
    }
    console.log(JSON.stringify({ slug, filename: base }))
    ' '<grabbed-basenames-json>' '<existing-brief-basenames-json>'
    ```
    This returns `<slug>` and the target `filename` (`brief-<slug>.md`, or `brief-<slug>-2.md` etc. on a collision) — never overwrite an existing brief.

    Write the file with:
    ```markdown
    # Brief: <short human title>

    ## Grabbed sessions
    - <basename-1>.html
    - <basename-2>.html
    ...

    ## Synthesis
    <one coherent narrative reconciling each session's decisions and rationale>

    ## Cross-session dependencies
    <explicitly state any dependency between grabbed sessions, e.g. "session B's choice of X constrains session A's Y" — or "None identified." if there are none>

    ## Complexity assessment
    <Cohesive — proceeding with a single proposal.> OR
    <Separable into N proposals: <name-1> (<scope>), <name-2> (<scope>), ... Cross-references: <name-2> depends on <name-1>'s decision to ...>
    ```

10. **Dispatch — cohesive brief**

    Spawn exactly one Task subagent (`subagent_type: "general"`) — a plain fresh agent, not something inheriting the exploration context. Its only input is the brief file's path and content. Its task: invoke the `openspec-propose` skill to create one change, after first resolving the artifact-owning directory (step 12 below).

11. **Dispatch — separable brief**

    Spawn all N Task subagents (`subagent_type: "general"`) together so they run concurrently. Each subagent's prompt carries: the brief file's path, its own pre-assigned change name, its scope (which part of the synthesis is its concern), and the prose describing its relationship to any sibling(s) it must cross-reference. Pre-assign every name and relationship before spawning any of them — do not let a later subagent discover an earlier one on its own.

12. **Every subagent resolves the artifact-owning directory before calling openspec — inline, no shared/lib**

    Each subagent prompt (cohesive or separable) MUST include these sub-steps, using the same inline walk (no `shared/lib/` reference — that path isn't populated for `opencode`):
    ```bash
    node -e '
    const fs = require("fs"), path = require("path")
    let dir = path.resolve(process.argv[1])
    while (true) {
      if (fs.existsSync(path.join(dir, "openspec")) && fs.statSync(path.join(dir, "openspec")).isDirectory()) {
        console.log(JSON.stringify({ root: dir })); process.exit(0)
      }
      const parent = path.dirname(dir)
      if (parent === dir) { console.log(JSON.stringify({ root: null })); process.exit(0) }
      dir = parent
    }
    ' "<dir containing .lavish/>"
    ```
    a. If `root` is non-null: run every subsequent `openspec` command with that directory as the working directory (e.g. `cd "<root>" && openspec new change "<name>"`).
    b. If `root` is null: bootstrap one non-interactively in `<start-dir>` itself before proceeding: `cd "<start-dir>" && openspec init --tools opencode --force .`. Then treat `<start-dir>` as `<root>` for the rest of the flow.
    c. From there, follow `openspec-propose`'s own steps (create the change, generate proposal/design/tasks), using the brief (or its assigned slice) as the source content instead of asking the user what to build. If given a sibling cross-reference, record it as prose in `proposal.md`.
    d. Conclude with `STATUS: COMPLETE — <change name at <root>>` or `STATUS: BLOCKED — <reason>`.

13. **Report**

    Wait for all subagent(s). Report each one's change name, resolved root directory, and status. Point the user at `openspec status --change "<name>"` (run from the resolved root) to continue.

## Output Format

```
## Lavish → OpenSpec Handoff

Swept <lavish-dir>: grabbed N session(s) → brief-<slug>.md
Complexity: cohesive | separable into N proposals

### Results

| Change | Root | Status |
|---|---|---|
| <name> | <root> | COMPLETE |

Cross-references recorded: <name-2> ↔ <name-1> — <one-line relationship>
```

## Guardrails

- Never invoke `openspec-propose` yourself, cohesive or split — always delegate to a freshly spawned subagent (step 10/11).
- Never write a brief or spawn a subagent when the sweep scope is empty (step 5) or contains an open session (step 6).
- Never overwrite an existing `brief-*.md` — always append a numeric suffix on a slug collision.
- Never assume the artifact-owning repo is the same as the one containing `.lavish/` — always resolve via the inline ancestor walk (step 12), and only bootstrap when it returns `null`.
- Do not reference `shared/lib/lavish-session-status.js`, `shared/lib/ancestor-openspec-resolve.js`, or `shared/lib/lavish-brief.js` from this variant — they are not installed for the `opencode` target.
