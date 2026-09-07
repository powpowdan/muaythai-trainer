---
name: auto-code-review
description: Staff engineer code review of modified or committed code on the current branch. No OpenSpec needed — just diff your work and get a review.
license: MIT
metadata:
  author: openspec
  version: "1.0"
---

Run a staff engineer code review on your current work.

**What it reviews:**
- If you have uncommitted changes: reviews `git diff` (staged + unstaged)
- If your branch has commits ahead of `main`: reviews `git diff main...HEAD`
- If both exist: reviews everything

**Steps**

1. **Determine what to review**

   The `auto-code-review` plugin will detect when this skill is invoked and inject an orchestrator prompt into your session after it goes idle. The orchestrator will:
   - Determine the right diff scope automatically from arguments
   - Launch a review → fix → review loop (max 3 rounds)

2. **Review loop (max 3 rounds)**

   A review subagent reads all changed files and evaluates:
   - **Correctness**: logic errors, off-by-one, wrong assumptions
   - **Edge cases**: null/undefined handling, empty states, boundary conditions
   - **Error handling**: are failures caught? are error messages useful?
   - **Security**: injection, auth issues, data exposure
   - **Performance**: N+1 queries, unnecessary allocations, algorithmic concerns
   - **Readability**: naming, function size, cognitive complexity
   - **Patterns**: consistency with the rest of the codebase, proper use of abstractions
   - **Testing**: are the changes testable? are critical paths covered?

   If findings are returned (NEEDS_CHANGES or NEEDS_MAJOR_CHANGES), a fix subagent applies the suggested fixes, then a new review subagent re-reviews. This repeats up to 3 rounds.

3. **Output**

   - If APPROVED: review summary is presented, code is ready to commit
   - If still NEEDS_CHANGES after 3 rounds: outstanding issues are presented for manual resolution

**Usage**
```
/auto-code-review          # review everything changed on this branch
/auto-code-review staged   # review only staged changes
/auto-code-review HEAD~3   # review the last 3 commits
```

**Guardrails**
- No OpenSpec dependency — works on any git repo
- Fixes are not auto-committed — left unstaged for the next review round
- Max 3 rounds — if issues persist, the author takes over manually
