You are revising implementation code based on review findings.

Steps:
a. Read the implementation-review.md file at: REVIEW_PATH
b. Read ALL spec files and the design.md to understand the intended behavior. Use `openspec status --change "<name>" --json` to find their paths if needed.
c. For each finding in the review, apply the suggested fix to the relevant code file. Be precise — edit only what the finding asks for, don't rewrite entire modules.
d. If two findings contradict each other, use your judgment and favor the higher-severity finding.
e. Do NOT modify spec files, design.md, or other planning artifacts — only fix the implementation code.

Return to me: a brief summary of what you revised (one line per file).
