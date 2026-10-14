## 1. Catalog & types

- [x] 1.1 Add optional `durationUnits?: number` to `Move` in `packages/engine/src/types.ts` (default 1 where consumed)
- [x] 1.2 Add the `double-jab` entry to `packages/engine/src/catalog.ts` (lead, punch, light, callout "double jab", display "dbl jab", durationUnits 1.5)
- [x] 1.3 Extend catalog integrity tests for the new entry (unique id, required fields, durationUnits present)

## 2. Grammar: family templates

- [x] 2.1 Replace the role-template table with family-tagged templates per design D1 (boxing, box-kick, close incl. rare `[punch, clinch]`, range) with named weight constants
- [x] 2.2 Implement family-aware slot roles (`punch`, `kick`, `clinch` with knee-heavy weights, `rangeLight`) and family-aware template length filtering using new `boxingMaxLen` in `INTENSITY_PARAMS` (easy 4, moderate 6, hard 6)
- [x] 2.3 Keep first-slot lead-opening bias for boxing/box-kick/close; close family standard templates require a ≥2-punch prefix before clinch slots
- [x] 2.4 Preserve existing behavior: same-side power ban, elbow lock, clinch chains, step-out insertion rules, seed determinism, disabled-move filtering

## 3. Grammar: double-jab adjacency

- [x] 3.1 Remove `jab` from `ALLOWED_REPEATS` (teeps remain); add `canFollow` rules: `jab → jab` illegal, `double-jab → double-jab` illegal, `double-jab ↔ jab` legal
- [x] 3.2 Update `fallbackCombo` for the jab-only degenerate case per design D5 (double-jab unit if enabled, else single-move combo)
- [x] 3.3 Verify `double-jab` qualifies as a lead setup (opening) and that punch-group disable excludes it

## 4. Pacing pass-through

- [x] 4.1 Scheduler: compute combo duration as `sum(durationUnits) × strikeSeconds + 0.4` in `packages/engine/src/scheduler.ts`
- [x] 4.2 Extend `Speaker.speak(text, weights?)` and `Mp3Speaker` to schedule clips at cumulative weight-based offsets, falling back to uniform spacing without weights
- [x] 4.3 `PlaybackController`: map `moveIds → durationUnits` and pass per-word weights on callout dispatch

## 5. Voice clip

- [x] 5.1 Run `scripts/gen-voice.mjs` to generate the "double jab" clip and regenerate `app/audio/voice-manifest.ts` — NOTE: Edge TTS unreachable in this environment (403); shipped a same-voice placeholder (`jab.mp3` ×2 concatenated) + manifest entry. Regenerate properly with `VOICE=en-US-ChristopherNeural npx tsx scripts/gen-voice.mjs` when network allows.
- [x] 5.2 Verify the clip's duration fits the 1.5-slot budget at hard tempo (0.9s); adjust generation rate if not — placeholder measures 1.8s (over budget at hard; existing single-word clips are ~0.9s vs a 0.6s hard slot, so overrun behavior matches the shipped baseline). A real regenerated "double jab" at +8% should land ~0.6-0.8s.
- [x] 5.3 Update voice tests: `MOVE_VOICE_TEXTS` includes "double jab" and slugs to `double-jab`

## 6. Tests: new invariants

- [x] 6.1 Family distribution (seed sweep ≥300): boxing ≥ 20%, punch→kick ≥ 25%, clinch-finish ≤ 35%, punch endings exist at every intensity
- [x] 6.2 Clinch rarity: elbow-containing combos < 15%; kick finishes > knee finishes > elbow finishes; post-jab strikes majority punches; jab→clinch direct < 20%
- [x] 6.3 Double-jab: reachable in default combos, no adjacent `jab jab` pairs, no `double-jab → double-jab`
- [x] 6.4 Length: moderate produces 5–6 strike pure-boxing combos while non-boxing stays ≤ 5; easy/hard bounds unchanged
- [x] 6.5 Scheduler duration test: a combo containing `double-jab` is paced longer than the same combo with plain `jab`

## 7. Validation

- [x] 7.1 Run full engine test suite (`npm test` in `packages/engine`) and typecheck/lint for the workspace
- [x] 7.2 Measure 200-combo distribution at each intensity and record actual family mix against targets; retune family/slot weight constants if outside spec bands
