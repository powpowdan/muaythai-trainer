---
name: stow
description: Sweep the current conversation for durable knowledge - user preferences, project facts, operational gotchas, and unfinished next steps - and file each through explicit instructions, existing local conventions, or the private `.stow-notes.md` fallback, so nothing is lost when the session ends. Optionally, when env-armed, also mint a few Anki-importable flashcards for human study. Use when the user invokes /stow, asks to save or write down what was learned this session, or before a context reset or long break.
user-invocable: true
---

<!-- maintainers: this is the public, installer-facing skill. Keep it standalone, with no private project paths or host-specific tool assumptions. Continuity routing must not invent note systems. Exception: the optional Anki flashcard pass may use documented env gating (ENABLE_STOW_FLASHCARDS + STOW_FLASHCARDS_PATH) as a personal opt-in; that path stays inert unless both conditions hold and never invents the flashcard store. -->

# stow

Sweep this conversation for durable knowledge that only exists in chat right now, and write it through the user's explicit instructions, this project's existing local conventions, or the private `.stow-notes.md` fallback in the current directory.
The goal is a conversation that is safe to end, reset, or hand off because everything durable has already been captured on disk, not left stranded in the transcript.
Everything this skill files for **continuity** goes to a local file by default; it only ever reaches an external system such as an issue tracker when you have explicitly said to use one.

**Continuity is always primary.** An optional **Anki flashcard pass** (human study, not agent continuity) runs only when env-armed — see step 7. Unarmed installs behave exactly as continuity-only stow.

## What it does

1. **Sweep the conversation for uncaptured durable knowledge.**
   Read back over the session and look for:
   - User preferences: a working-style, tooling, formatting, or approval preference the user stated in passing rather than through a config file.
   - Project facts: build, test, deploy, architecture, or convention facts about the current project that would help anyone (or any agent) working in it later.
   - Operational gotchas: a sharp edge, workaround, recurring mistake, or non-obvious cause discovered while working here.
   - Undone next steps: anything left open or agreed to that has not yet been written down anywhere.

2. **Discover the host's existing conventions before deciding where anything goes.**
   Don't assume a destination - look for what's actually there, roughly in this order:
   - A project-level memory file, such as `CLAUDE.md`, `AGENTS.md`, or an equivalent at the repo root or nearby.
   - A user-level (global) memory file the running agent reads across projects, if one exists and is readable.
   - A `TODO`, `BACKLOG`, `NOTES`, or similarly named plain file already tracked in the project.
   This step is about local files only, not remote systems.
   Do not scan for or infer an issue tracker here - see the priority order in step 3.

3. **Route each finding using this fixed priority order, local-first.**
   1. **Highest - an explicit instruction wins.** If the user has explicitly said, earlier in this conversation or as a standing choice previously recorded in the discovered user-level memory file (see step 4), to use a particular system for this kind of finding - including an external tracker - route it there.
      This is the *only* path to an external or public system: an issue tracker, a hosted project board, a ticketing system, or similar.
      A configured git host remote, a `.github/`/`.gitlab/` folder, or any other signal that a tracker probably exists is never by itself grounds to file anything there - never route externally on inference.
   2. **Otherwise - the local system the user already uses.** Route to whatever local memory/backlog convention this project or user already has for that kind of finding: the discovered project memory file (`CLAUDE.md`/`AGENTS.md`) for project facts and operational gotchas, an existing `TODO`/`BACKLOG`/`NOTES` file for undone next steps, or a discovered user-level memory file for user preferences *when one happens to be accessible* - a global memory file is a bonus if the running agent can reach one, never an assumption or a requirement.
      Among local durable-finding writes, this tier is the only one that writes findings into a tracked, shared file, and the only one that may write outside the current directory - it only fires when that destination was already an established convention the user (or their agent) already has access to, never a path this skill invents itself.
   3. **Fallback - the default prescribed private file, in the current directory.** If no existing local convention fits, don't improvise a location or invent an ad hoc filename.
      Before writing it in a git worktree, verify that `.stow-notes.md` is not already tracked in the index.
      If it is tracked, do not append private findings there, do not describe it as private, and report that the tier-3 fallback is blocked until the user chooses a safe destination.
      In a non-git directory, treat this as a local private file by filesystem scope.
      After the tracked-file check passes, create or append to `.stow-notes.md` in the current directory, for every finding-kind including user preferences.
      This file always lives inside the current working directory, never a user-level or home-directory path, so the fallback works even for agents sandboxed to the current directory.
      Then keep it out of git: create or append a `.stow-notes.md` line in a `.gitignore` file **in the current directory** - an ordinary file at that path, so this stays fully in-directory even inside a linked worktree, unlike git's internal exclude mechanism, which can resolve outside the working directory there.
      Leave staging or committing that `.gitignore` line to the user, same as everything else this skill writes.
      If even the `.gitignore` write fails, don't block or error - still create `.stow-notes.md` and tell the user to ignore it manually.
   Tiers 2 and 3 are always local; only tier 1 - an explicit instruction - ever reaches an external or public system.
   Tier 2 is the only tier that lands durable findings in a tracked/shared file; tier 3 keeps stowed findings in the private `.stow-notes.md` file only after confirming it is not already tracked, and confines any optional `.gitignore` metadata edit to the current directory.

4. **When it's genuinely ambiguous between two existing conventions, ask once - then remember the answer.**
   If more than one discovered local convention plausibly fits a finding, ask the user once, plainly, which one they want that kind of note to live in going forward.
   The same applies if the user gives an explicit instruction to use a tracker or other non-local system going forward rather than just for one item right now.
   Once they answer, offer to remember it for next time: with their explicit permission, record a short standing note of that choice in the discovered (or newly agreed) user-level memory file, so the same question - or the same tracker instruction - doesn't need to be repeated in this project.
   Always ask before adding that note - never establish the convention silently on your own judgment.
   When nothing existing fits at all (not merely ambiguous), that's tier 3, not this step - use the `.stow-notes.md` fallback from step 3 instead of asking, for any finding-kind.

5. **Write only into locations that already exist as a real convention, the `.stow-notes.md` fallback from step 3 (plus its line in a current-directory `.gitignore`), or a destination the user just approved in step 4.**
   Do not invent new shared files, new folders, or new tracker categories the project doesn't already have, and do not pick an ad hoc filename or location for the fallback - `.stow-notes.md` in the current directory is the one prescribed default.
   If even that fallback is unwritable and the user doesn't want to establish a new convention, say so plainly and leave that finding unfiled rather than fabricate a destination for it.

6. **Curate, don't just append.**
   When a finding overlaps or supersedes something already recorded, prefer editing or replacing the existing note over piling on a duplicate.

7. **Optional Anki flashcard pass (human study — gated, default off).**
   This step does **not** replace continuity routing. Prefs, project facts, gotchas, and next steps still go through steps 1–6 even when cards are also minted from related insights.
   Cards are for the human (Anki spaced repetition), not for the next agent session, and not for `.openspec-fleet/learnings.md`.

   ### 7a. Gate-first early-exit (portable checks)

   Evaluate the gate as a discrete step **after** continuity work is done (or clearly separate from it). Continuity is never blocked by flashcards.

   1. Read `ENABLE_STOW_FLASHCARDS` with a host-appropriate check:
      - PowerShell: `$env:ENABLE_STOW_FLASHCARDS`
      - POSIX sh/bash: `printf '%s' "$ENABLE_STOW_FLASHCARDS"`
      - Or any ADE-equivalent env read
   2. Treat **only** the exact string `true` as enabled (not `1`, `yes`, `TRUE`, or empty).
   3. **If not exactly `true`:** stop the flashcard path immediately.
      - Do **not** probe `STOW_FLASHCARDS_PATH`
      - Do **not** invent cards “for later”
      - Do **not** mention Anki or flashcards in the verdict solely because of this skip
      - Proceed to step 8 (continuity verdict only)
   4. **If exactly `true`:** classify `STOW_FLASHCARDS_PATH` as existing regular file, existing directory, or missing/other — without creating anything:
      - PowerShell: `Test-Path -LiteralPath $p -PathType Leaf` / `Container`
      - POSIX: `test -f "$p"` / `test -d "$p"`
      - Or Node `fs.stat` / ADE path tools
   5. **If enable is `true` but path is unset, missing, or neither a regular file nor a directory:** do not mint cards; do not create the path; record one short armed-but-unusable line for step 8 (e.g. “Flashcards: path missing or unusable — no cards written”).
   6. **Only when both arming conditions hold** may you resolve a write target, invent card candidates, or read/write the TSV.

   ### 7b. Write-target resolution

   | `STOW_FLASHCARDS_PATH` | Write target |
   |------------------------|--------------|
   | Existing regular file | That file |
   | Existing directory | `pending.tsv` inside that directory via platform path join (`path.join`, `[IO.Path]::Combine`, or careful `"$dir/pending.tsv"` / `"$dir\pending.tsv"`) |
   | Missing / other | No minting (see 7a.5) |

   Never create the root path named by `STOW_FLASHCARDS_PATH`. You **may** create `pending.tsv` inside a directory that already exists when that file is missing.

   Prefer a private user-owned inbox (outside the repo) so study cards are not accidentally committed. Do not invent a project-local deck path for the user.

   ### 7c. Anki TSV format (UTF-8, Basic, deck `Stow`)

   Output is plain text for Anki text import (Anki 2.1.54+ file headers recommended). Tab field separator. Note type **Basic** only. Deck name fixed: **`Stow`**. No GUID column. No cloze or other note types.

   Required header block (six lines), written **once** only when the write target is empty or missing a valid header at the **start of the file**:

   ```text
   #separator:Tab
   #html:true
   #notetype:Basic
   #deck:Stow
   #columns:Front	Back	Tags
   #tags column:3
   ```

   Valid header block: those six `#` lines appear at the start of the file (optional blank lines around the block allowed; **no** data rows before the header). After headers, each data row is exactly three tab-separated fields: `Front`, `Back`, `Tags`.

   | Target state | Action |
   |--------------|--------|
   | Empty / missing `pending.tsv` (directory case) | Write full header block once, then data rows |
   | Valid header already at start | Append or in-place update **data rows only** — never duplicate headers |
   | Non-empty but partial/foreign headers, wrong layout, or data rows without the six required lines first | **Refuse write** for this pass; report failure in the armed verdict; do **not** prepend headers mid-file or rewrite non-conforming user data |

   ### 7d. Field escaping

   Each data row is three tab-separated fields. Inside Front, Back, and Tags:

   1. **Never emit a raw tab** (`U+0009`). Replace with spaces or rephrase; if the insight cannot be expressed without embedding a tab, **drop the card**.
   2. **Never emit raw newlines** (`\n` / `\r`). With `#html:true`, normalize newlines to `<br>`; otherwise rephrase to a single line. If neither is safe, **drop the card**.
   3. **HTML metacharacters:** when using intentional HTML (`<br>`, `<code>…</code>`), escape accidental prose metacharacters (`&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;` except deliberate tags). Prefer plain prose.
   4. **Unsafe cards are dropped**, not written as broken rows. Dropped cards do not count as successful writes.

   The Back's `Problem:` / `Change:` / `Why:` beats (7e) are multi-line by nature — **join them with `<br>`**, never raw newlines, or rule 2 drops the whole card.

   ### 7e. Selectivity and write cap

   - At most **five data-row writes** (append **or** in-place replace) per armed stow. **Updates count** toward the five.
   - Include only insights appropriate for human spaced-repetition study — likely forgotten without review on the order of **~30 days**.
   - Prefer causal **why**, portable **gotcha**, **procedure**, and **contrast** over “we edited file X” or ephemeral task status.
   - **Zero cards** is valid when nothing meets the bar — do not invent filler.
   - **Never** card secrets, credentials, tokens, or private URLs.

   **Card shape.** Author every card as a self-contained micro-story — answerable and re-connectable to its origin when reviewed cold weeks later:

   - **Front** uses the canonical form `<situation> — <question>`: a one-sentence situational **anchor** naming where the insight came from, a space-em-dash-space delimiter (` — `), then the question the card tests. The fixed shape keeps the Front byte-reproducible, so the same insight re-mints to a Front that exact-matches its existing row (see 7g).
   - **Anchor stays atomic** — a single scene-setting sentence; the card still tests **one idea**. "More context" means the anchor plus the causal chain, not a multi-fact dump or a session chronicle.
   - **Back** is authored as labeled beats drawn from `Problem:` / `Change:` / `Why:`, in that order — what the problem or goal was, what was decided or done, and the durable reason. `Why:` is the minimum. When a beat genuinely has no content (a pure gotcha where nothing was changed), **omit** it rather than padding with filler; every beat present keeps its label and order.
   - Join the beats with `<br>` (HTML mode) — raw newlines drop the card (7d).

   **Good vs bad examples** — Good cards use the canonical `<situation> — <question>` Front and a `Problem:/Change:/Why:` Back with beats joined by `<br>`:

   | Good (quiz-worthy) | Bad (do not card) |
   |--------------------|-------------------|
   | `Front: remy analytics enum — Why add a new value instead of deleting an unused one from a shared field? / Back: Problem: a menu-action value looked unused, so deleting it seemed like clean-up.<br>Change: kept it and added a new value instead.<br>Why: the code branch it labels still exists, so deleting forces overloading another value (one string, two meanings) or emitting nothing (losing the denominator for the rest); adding costs no new event or volume.` | `Why is deleting an enum value bad?` — no anchor: worse for *what*, which field? |
   | `Front: Anki Front-field search — What breaks if an underscore in the query is left unescaped? / Back: Problem: underscore and asterisk are live Anki wildcards; underscore matches any single char.<br>Why: an identifier like final_tests_passed over-matches, so the duplicate-guard refuses the card and it silently never imports — presenting as a duplicate that does not exist. Escape it and wrap the term.` — pure gotcha, no `Change:` beat | “We edited SKILL.md today.” / a raw API token |

   ### 7f. Tag schema

   Every card’s Tags field (space-separated) **must** include:

   | Tag | Rule |
   |-----|------|
   | `stow` | Always |
   | `project::<slug>` | Sanitized project/directory name when available; else `project::unknown` |
   | `topic::<path>` | 1–3 hierarchical segments with `::` (each segment sanitized) |
   | `kind::<enum>` | Exactly one of: `fact`, `why`, `procedure`, `contrast`, `gotcha` |

   Optional: `source::YYYY-MM` for the current stow month.

   **Slug / segment sanitization** (for `project::<slug>` and each topic segment):

   - Lowercase ASCII.
   - Each character outside `[a-z0-9_-]` becomes `-`.
   - Collapse consecutive `-` to one; strip leading/trailing `-`.
   - Max 48 characters; truncate if longer.
   - Empty after sanitization → `unknown` for project slug; drop empty topic segments.
   - Topic: sanitize each segment, strip empties, clamp to 1–3 segments; if none remain → `topic::general`.
   - Tags field must not contain raw tabs or newlines (same field rules as Front/Back).

   You choose Front/Back text and concrete `topic::*` / `kind::*` values. Schema, deck, format, cap, and gate are fixed by this skill.

   ### 7g. Curation (exact Front match only)

   Before writing, read the existing write target when it exists.

   - **Row identity** = exact Front match after trivial whitespace normalization (trim ends; collapse internal runs of spaces to one space).
   - On match: update Back and/or Tags **in place**; **do not rewrite Front** for the same fact; do not append a duplicate.
   - On no match: append a new data row (subject to the write cap).
   - Do **not** use fuzzy “supersedes” judgment to merge or rewrite different Fronts.
   - Prefer stable, self-contained Front wording so Anki “update if first field matches” stays useful on re-import. The canonical `<situation> — <question>` Front (7e) is what makes this hold: its anchor names the **situation** (subsystem/feature/task), never a volatile file path or line number, so the same insight re-mints to a byte-identical Front and updates in place instead of duplicating.

   ### 7h. Flashcard outcomes for the verdict (step 8)

   Record one of:

   | Situation | What to report in step 8 |
   |-----------|--------------------------|
   | Enable not exactly `true` | Nothing flashcard-related |
   | Enable `true`, path missing/unusable | One short armed-but-unusable line; no cards |
   | Armed, N≥1 data-row writes | N, resolved write path, remind user to **import the TSV into Anki** |
   | Armed, 0 cards | Flashcard pass ran; zero cards (nothing durable enough) |
   | Armed, write failed (incl. foreign headers) | Failure reason; continuity result unaffected |

8. **Finish with an honest safe-to-end verdict and a resume pointer for the next session.**
   Tell the user, in plain language, what was captured and where, what could not be captured (and why), and whether the conversation is now safe to end or reset - i.e. whether every durable finding from this sweep now lives on disk or in an explicitly requested tracker rather than only in this chat.
   If something could not be captured yet, say so explicitly instead of reporting the session fully safe.
   If anything landed in the `.stow-notes.md` private fallback, say so explicitly - note that it is private and confined to this project, and that it can be promoted into a shared, tracked file later if the user wants it more widely visible.
   In a git repo, report the ignore protection according to what actually happened: if the `.gitignore` write succeeded, say that a `.stow-notes.md` line was added to a current-directory `.gitignore` to keep it out of git, awaiting the user's own commit; if the `.gitignore` write failed, say that `.stow-notes.md` was still written but the user must ignore it manually before relying on git to hide it from status or commits.
   If the tier-3 fallback was blocked because `.stow-notes.md` was already tracked, say that no private fallback was written and that the session is not fully safe to reset until the user chooses another destination or confirms that tracked file is acceptable.
   If a user preference specifically landed there because no user-level memory file was discovered, add the one extra caveat: it now applies to this project only; this skill's own tier-3 default never writes outside the current directory, so if the user wants that preference to follow them across every project, they need to copy it into their own global/user-level memory file themselves.
   Include flashcard reporting from step 7h when applicable. Flashcard write failure does **not** undo continuity captures; note partial failure clearly. Flashcard success alone does not require listing the TSV in the agent RESUME POINTER unless the user wants to resume card curation — continuity resume files remain the default pointer set.
   The real payoff of stowing is not this session, it's the next one: close with a short, copy-pasteable RESUME POINTER naming exactly which files a fresh session should load to pick this back up cold, e.g. `To pick this back up in a new session, load: CLAUDE.md (project conventions), .stow-notes.md (private notes, not shared)`.
   List only the continuity files this sweep actually wrote or updated; skip the pointer if nothing was written.

## What this skill does not do

It does not invent a new note-taking system, initialize version control, or commit/push anything on the user's behalf beyond editing a file the discovered convention already made writable, creating the `.stow-notes.md` fallback from step 3 and its line in a current-directory `.gitignore`, or using a destination the user explicitly approved.
It never stages or commits that `.gitignore` line itself - the edit lands in the working tree only, for the user to review and commit like any other change.
Its own tier-3 default never writes durable findings outside the current working directory, and its optional `.gitignore` metadata edit is also confined to that directory.
Among local durable-finding writes, tier 2 is the only exception, and only because it targets a destination the user's own existing convention already established, never one this skill invents.
It never files credentials, secrets, or other sensitive material - only knowledge that's safe to keep in plain text wherever it lands.
It never files anything to an issue tracker, hosted board, or other external/public system on its own inference - that only ever happens on the user's explicit say-so, per the hard rule in step 3.

**Flashcard pass specifically does not:**

- Run when `ENABLE_STOW_FLASHCARDS` is not exactly `true` (silent skip — no Anki chatter).
- Create `STOW_FLASHCARDS_PATH` or invent a project deck location.
- Use AnkiConnect or require Anki to be running during stow.
- Generate cloze notes or note types other than Basic.
- Write cards into `.openspec-fleet/learnings.md` or replace continuity destinations for prefs, facts, gotchas, or next steps.
- Auto-import into Anki — the user imports the TSV (File → Import) when ready.
