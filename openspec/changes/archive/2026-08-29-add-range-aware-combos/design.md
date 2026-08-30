## Context

The grammar (`packages/engine/src/grammar.ts`) generates combos from weighted role templates, filling each slot via `roleCandidates` + `canFollow` filtering with uniform `weightedPick`. Sequencing today is purely pairwise (side/power/type) with no distance concept, producing unrealistic shapes like `jab cross elbow teep`. Elbows imply a step-in; once in close, only elbows and knees (and a rare short hook) make sense until the practitioner steps back out.

Playback and voice need no work: `PlaybackController.dispatchEvent` maps every combo move id through the generic catalog lookup, and "back" already has a voice clip (it ships as a standalone cue today). The scheduler's duration math already scales with `moveIds.length`, so a free-inserted `back` automatically gets a strike slot of timing. All work is in the grammar.

## Goals / Non-Goals

**Goals:**

- Make range-illegal sequences unrepresentable in generated combos (hard bans in `canFollow`).
- Express rarity (post-elbow hook, post-knee kick/teep) as draw weights, not bans, so tuning never requires touching constraints.
- Insert a voiced `back` step-out after elbows as a free (non-slot-consuming) exit that lets a combo resume range work.
- Preserve determinism: same seed + config ⇒ identical timeline, unchanged.

**Non-Goals:**

- Phase-based templates (range phase → optional clinch tail). Deliberate follow-up if clinch shapes feel off after testing this change; the pairwise rules here are compatible with that evolution.
- Voiced step-in (`forward` cue inside combos) — the elbow call itself implies the step.
- Scheduler reset cues after clinch-finished combos (the practitioner resets naturally in the breath between callouts).
- Weighted transitions beyond the post-elbow/post-knee cases listed above (no general transition-weight matrix).

## Decisions

### D1: Range as pairwise rules, not a tracked state machine

The elbow lock, `back` transitions, and re-entry ban are all expressible as pairwise `canFollow` rules: "after elbow, allow only {elbow, knee, hook}"; "`back` only after elbow"; "after `back`, ban elbow and `back`". No hidden range variable is needed because `back` itself is the escape edge — `elbow → back → cross` is legal pairwise while `elbow → cross` stays banned.

- Alternative: explicit range state (range/clinch) threaded through the fill loop. Rejected for now — more code, same generated shapes, and it conflicts with the knee-as-hybrid decision (knees exit on their own, so a binary state fits poorly).
- Known consequence: `elbow, knee, cross` remains legal (knee is a door back out). Accepted — realistic on a bag (knee, frame off, punch). Phase-based templates (Non-Goal) would tighten this if desired later.

### D2: Rarity via a context-aware weight function on the existing `weightedPick`

Replace the uniform `() => 1` weight with `candidateWeight(prev, move)`:

| prev → next | weight |
|---|---|
| elbow → elbow/knee | 1.0 |
| elbow → hook | 0.15 |
| knee → punch/elbow/knee | 1.0 |
| knee → kick | 0.35 |
| knee → teep | 0.1 |
| everything else | 1.0 |

Weights affect only draw probability, never legality, so `validateCombo` and `canFollow` stay the sole source of truth for constraints. Alternatives: full transition-weight matrix (overkill — three special cases), or banning rare transitions (wrong — user chose "rare", not "never").

### D3: `back` as a free insertion pass after pushing an elbow

After the fill loop pushes an elbow and the template still has remaining slots, roll `rng() < BACK_EXIT_CHANCE` (start at 0.4, tunable constant). On success, push `step-back` and continue filling the remaining slots; the pairwise rules handle what may follow. Mechanics:

- **Free insertion**: `back` does not consume a template slot; combo length can exceed the template's slot count by at most one. Intensity length caps apply to slots, so this stays bounded.
- **Cap of one per combo**: track a boolean; no second insertion.
- **Role bypass**: `back` is injected directly rather than drawn from slot candidates, so it never competes with role-filtered strikes (it would never pass the `power`/`finisher` filters as a light movement).
- **Disabled moves**: the grammar must not insert `back` when `step-back` is in `disabledMoveIds`. `generateCombo` currently receives only the pre-filtered strikes pool, so its signature grows an options parameter (or the fill checks a passed-in flag) carrying whether `step-back` is enabled. `generateCombos` has the config and passes it through.
- Alternative: `back` as a template slot role. Rejected — rigid placement (only specific template positions), and consumes a strike slot the user wants kept for strikes.
- Alternative: post-processing append (`elbow elbow` + suffix `back`). Rejected — the whole point is letting range work *continue* after the step-out, which requires mid-fill insertion.

### D4: Clinch exemption for the same-side power rule

Skip the same-side power check when both prev and next are elbow/knee type. `rear-elbow → rear-knee` becomes legal — the rotation carries through on a bag. Identical-strike repeats (lead-elbow → lead-elbow) remain banned by the existing identical-power rule; `ALLOWED_REPEATS` is unchanged, so "elbow elbow" callouts keep alternating internally while the voice just says "elbow".

### D5: No catalog or voice changes

Sides are never spoken (one "elbow"/"knee" clip; the lead/rear split exists only for grammar sequencing), and `step-back`'s callout/display/clip already exist for standalone cues. A `Move.range` field was considered to make the concept first-class but deferred: today type maps 1:1 to range behavior, and YAGNI until a close-range punch (e.g. uppercut) joins the catalog.

## Risks / Trade-offs

- [Weight tuning drifts from gym reality] → Weights are named constants in one table (D2) plus `BACK_EXIT_CHANCE`; re-tune without touching logic. Scenarios in the spec pin coarse bounds only (minority/majority), not exact rates.
- [`back` insertion starves the fill in narrow move sets] → If remaining slots can't legally fill after an inserted `back` (e.g. only elbows enabled), the attempt fails and the existing retry loop (8 attempts) regenerates without `back`; the fallback combo path is untouched. Worst case is unchanged pre-existing behavior for degenerate enabled-sets.
- [Free insertion lengthens hard-intensity combos by one] → Duration math scales automatically; scheduler's bell-safety check already guards fit. At most one extra slot, bounded by the cap.
- [Statistical spec scenarios could flake] → Post-elbow-hook and post-knee scenarios use wide margins (15%/70%) over large samples; if flaky in CI, test the weight function directly (unit) and keep property tests for the hard bans only.
- [Same seed produces different workouts than pre-change builds] → Expected and accepted: generation is explicitly non-stable across engine versions; determinism is only promised within a build.

## Open Questions

- Exact `BACK_EXIT_CHANCE` value (0.4 starting point) — tune during bag testing; a named constant makes this a one-line tweak after the change lands.
