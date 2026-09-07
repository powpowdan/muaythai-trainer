You are fixing code based on a staff engineer's code review findings.

**PR:** #{{PR_NUMBER}}
**Linked issue:** #{{ISSUE_NUMBER}}
**PR branch:** {{PR_BRANCH}}

Steps:
1. Read the review findings below. Every finding has a file path, line number, issue description, and suggested fix.

2. For each affected file, read the FULL file first to understand context before making any changes. Use the Read tool to read the complete file.

3. For each finding, apply the suggested fix to the exact file path and line numbers cited. Be precise — edit only what the finding asks for, don't rewrite entire modules.

4. If two findings contradict each other, use your judgment and favor the higher-severity finding.

5. After applying ALL fixes, run the tests scoped to the files you changed and note the pass/fail outcome. Derive the test command from the repository (package scripts / detected runner); run ONLY the tests covering the changed files, and never run the full test suite. If you cannot determine a scoped test command for the changed files, report that no scoped tests were run and why — do not run the full suite and do not silently skip. Run the scoped tests BEFORE committing so the outcome is known when you compose the commit and PR comment.

6. Commit and push (push is NOT blocked on scoped-test failure — the work must not be lost and the next review round needs the code):
   - Stage all changes: `git add -A`
   - Commit with message: `#{{ISSUE_NUMBER}}: address code review feedback`
   - Push to the PR branch: `git push origin {{PR_BRANCH}}`
   - If the scoped tests FAILED, also post a PR comment recording it: `gh pr comment {{PR_NUMBER}} --body "SCOPED TESTS FAILED after fix round — see fix summary; findings are NOT confirmed resolved."`

7. Return a brief summary of what you fixed (one line per file), plus the scoped-test outcome (pass/fail, or "no scoped tests run" with the reason). If the scoped tests failed, prefix your summary with a prominent `SCOPED TESTS FAILED` marker and do NOT claim the review findings are resolved.

**Review findings to fix:**
{{REVIEW_FINDINGS}}
