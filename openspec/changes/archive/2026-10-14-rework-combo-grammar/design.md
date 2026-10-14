## Context

The grammar (`packages/engine/src/grammar.ts`) draws role templates (`open/power/any/finisher`), fills slots with `canFollow` constraint filtering, and weights a few transitions for rarity. The `finisher` role is defined as non-punch power, which structurally excludes punch endings; the power pool mixes punches with clinch weapons uniformly; and `jab` (light) cannot enter power slots, so punch chains never form. The scheduler paces combos as `moveIds.length × strikeSeconds`, and `Mp3Speaker` spaces word clips uniformly at `i × strikeSeconds`. See proposal.md for the measured baseline and motivation.

## Goals / Non-Goals

**Goals:**

- Combos that read as range stories: box at range, finish with a kick (returns to range) or close for clinch work
- A tunable family mix with the distribution invariants of the delta spec enforceable in tests
- `double-jab` as one catalog unit flowing through grammar, voice, toggles, and pacing without special cases scattered across layers
- Keep every existing naturalness rule (same-side power ban, elbow lock, step-out, lead-open bias, determinism, seed reproducibility)

**Non-Goals:**

- Uppercuts, double-teep units, trailing `back` exits, per-intensity family mixes (structure permits them later)
- Any change to playback transport, audio pooling, or UI beyond passing word durations through

## Decisions

### D1. Families are template attributes, not post-hoc classification

Each template becomes `{ family, slots, weight }` where family ∈ `boxing | box-kick | close | range`. Family weights realize the mix directly at template draw time:

```
boxing   w=3.0   (~30%)   slots: punch… (1–5 slots)
box-kick w=3.5   (~35%)   slots: punch… + kick
close    w=2.5   (~25%)   slots: punch(≥2)… + clinch(+1 optional)   + rare [punch, clinch] w≈0.3
range    w=1.0   (~10%)   slots: rangeLight × 2–3
```

- `punch` role: any `type: 'punch'` move (jab, double-jab, cross, hooks). Same-side-power and rotation rules still filter via `canFollow`; draw weights tune rhythm (cross/hooks 1.0, jab 0.8, double-jab 0.4).
- `kick` role: lead/rear roundhouse kicks only (teeps are range tools, not finishers).
- `clinch` role: knees (weight 1.0) and elbows (weight 0.35) — elbow rarity comes from here plus the close family's share, landing elbows in ~8–10% of combos.
- `rangeLight` role: jab, teeps, double-jab.
- First slot of boxing/box-kick/close keeps the existing `leadOpeningBias` setup behavior.
- The rare `[punch, clinch]` close template keeps `jab → elbow` / `jab → knee` legal-but-rare, per the spec's "direct transition remains legal" requirement; the ≥2-punch prefix on standard close templates restores the closing narrative.

Alternative considered: keep the old role grammar and reweight `candidateWeight` only. Rejected: the `finisher ≠ punch` definition and light-jab exclusion are structural; weight tweaks cannot make 1-2-1-2 reachable or punch endings possible.

### D2. Moderate boxing cap via a per-family length allowance

`INTENSITY_PARAMS` gains `boxingMaxLen` (easy 4, moderate 6, hard 6) alongside `maxLen`. Template length filtering uses the family-aware cap, so long pure-boxing chains appear at moderate while clinch/kick/range families keep `maxLen`. No new intensity semantics; caps stay strike-units where `double-jab` counts as one unit.

### D3. `double-jab` is one catalog unit with a duration weight

- Catalog: `{ id: 'double-jab', side: 'lead', type: 'punch', power: 'light', calloutText: 'double jab', displayText: 'dbl jab', durationUnits: 1.5 }`.
- `Move` gains optional `durationUnits?: number` (default 1) — the single source of pacing truth for multi-strike words.
- Grammar: remove `jab` from `ALLOWED_REPEATS` (teeps stay). New `canFollow` cases: `jab → jab` illegal (doubling is expressed by the unit), `double-jab → double-jab` illegal, `double-jab ↔ jab` legal (triple jab, voiced as two clips). Because the unit is lead+light, it naturally qualifies as a setup/opening (1-1-2 opens correctly).
- Voice: `MOVE_VOICE_TEXTS` derives from the catalog, so `'double jab'` joins the vocabulary automatically; regenerate clips/manifest via `scripts/gen-voice.mjs` (slug `double-jab`). No manifest or speaker lookup changes.
- Toggles: `app/index.tsx` groups by move type from the catalog — the unit appears in the punch group automatically, and the punch-group disable filter includes it.

Render-time collapse (grammar emits `jab, jab`, speaker merges) was rejected: two layers would need to know the pattern, and the user-facing catalog/toggle would not represent the attack as distinct.

### D4. Pacing flows `durationUnits` through scheduler and speaker

- Scheduler: combo duration becomes `sum(move.durationUnits) × strikeSeconds + 0.4` instead of `moveIds.length × …`.
- Speaker: `Speaker.speak(text, weights?)` gains optional per-word weights (parallel to the comma-split words); `Mp3Speaker` schedules clips at cumulative offsets instead of `i × strikeSeconds`, falling back to uniform spacing when weights are absent. TTS fallback path ignores weights (whole-utterance anyway).
- `PlaybackController` computes weights from `moveIds → durationUnits` and passes them through. The `Speaker` interface stays a thin optional param — no transport/pooling changes.

### D5. Degenerate-config fallback

With `jab → jab` banned, the single-enabled-strike fallback (`[x, x]`) must special-case jab: if only jab is enabled, emit `[double-jab]` when it is also enabled; otherwise emit a single `[jab]` callout and let the scheduler's existing short-combo guard handle it (a jab-only config is already degenerate today). All other single-strike cases keep the doubled pattern (teep-teep remains legal).

## Risks / Trade-offs

- [Distribution drift after constraint filtering] → Centralize all mix weights as named constants next to the templates; statistical tests use generous bands (spec floors/ceilings) over seed sweeps, mirroring the existing 300-seed test pattern.
- ["double jab" clip too long for hard tempo] → `durationUnits: 1.5` buys 0.9s at hard (0.6s base); generate the clip at the existing brisk voice rate. Verify clip length post-generation; adjust the rate if it exceeds the slot.
- [Elbows at easy intensity for beginners] → Accepted for v1 per the uniform-mix decision; the family-weight structure makes a per-intensity dial a constant change later.
- [Existing users' persisted `disabledMoveIds`] → New id defaults to enabled; punch-group disables already filter by catalog type so they subsume the unit. No migration needed.

## Migration Plan

Engine-first, all behind the existing package boundary: catalog + grammar + scheduler changes with tests, then voice regeneration (`scripts/gen-voice.mjs`), then speaker/controller weight pass-through. Rollback is reverting the engine change; the extra `double-jab.mp3` and optional `durationUnits`/`weights` params are inert without it.

## Open Questions

- Exact draw weights for punch-slot rhythm (cross/hooks vs jab vs double-jab) — tune after measuring real output distribution; bands in tests are wide enough to survive tuning.
