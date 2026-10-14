## Why

Measured over 200 generated moderate combos: 37% end in an elbow, 31% in a knee, only 3% are pure boxing, and a double jab never occurs. The grammar's `finisher` role structurally forbids punch endings, its uniform finisher pool makes elbows a third of all finishes, and `jab` (a light strike) cannot appear in power slots — so the bread-and-butter punch chains of pad work (1-1-2, 1-2-1-2, 1-2-3-kick) are unreachable. Clinch weapons also appear immediately after jabs with no closing narrative. Combos should tell a range story: box at range, close deliberately, exit.

## What Changes

- Rebuild combo templates around four range-phase families with target mix: **boxing** ~30% (punches only, jab chainable anywhere), **boxing→kick** ~35% (punch chain into a kick finish that returns to range), **close** ~25% (punch chain into knee/elbow finish, existing elbow-lock and step-out behavior intact), **range** ~10% (jab/teep play).
- Punch chains become first-class: jab fills any punch-slot position, enabling 1-2-1-2 and 1-1-2-3 rhythms.
- Add `double-jab` as a new first-class catalog move (own "double jab" voice clip, own toggle). Adjacency: `double-jab ↔ jab` legal (triple jab, voiced as two clips), `double-jab → double-jab` banned. No other doubles.
- Elbow and knee presence drops via draw weights (elbows to ~8-10% of combos; kick finishes outnumber knee finishes). Direct `jab → elbow`/`jab → knee` stays legal but heavily down-weighted.
- Long pure-boxing combos (up to 6 strikes) become available at moderate intensity; clinch/kick families keep the tighter per-intensity caps.
- Combo duration estimates and word-level callout spacing account for per-move duration weights (`double-jab` ≈ 1.5× a single strike).
- Family mix is uniform across intensities for v1, structured so per-intensity dials can be added later without redesign.

Non-goals: uppercuts (still excluded), double-teep as a unit, trailing `back` after clinch-finish combos (step-out stays mid-combo after elbows, as today), per-intensity family mixes.

## Capabilities

### New Capabilities

(none — combo generation is already specified under `workout-generation`)

### Modified Capabilities

- `workout-generation`: natural-sequencing requirements extended with range-phase family mix targets, punch-chain rules, and the `double-jab` unit; combo-length requirements gain the moderate-intensity boxing exemption; new requirements for family distribution and clinch-weapon rarity.
- `callout-playback`: word-level beat timing requirement updated so per-word spacing follows per-move duration weights instead of a uniform strike tempo.

## Impact

- `packages/engine/src/grammar.ts` — template/role system rebuilt around range-phase families; new weights; `double-jab` adjacency rules.
- `packages/engine/src/catalog.ts` — new `double-jab` entry with duration weight field.
- `packages/engine/src/scheduler.ts` — duration estimate uses per-move duration weights.
- `packages/engine/src/voice.ts` + `app/audio/voice-manifest.ts` — "double jab" clip joins the generated vocabulary (`scripts/gen-voice.mjs`).
- `app/audio/Mp3Speaker.ts` + `app/playback/PlaybackController.ts` — per-word offsets for duration-weighted words.
- `app/index.tsx` — no structural change; the punch-group toggle picks up `double-jab` automatically from the catalog.
- Tests in `packages/engine/tests/` — existing range-rule tests stay; new distribution, punch-chain, and double-jab invariants.
