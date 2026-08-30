## Why

Initial bag testing revealed the combo grammar has no concept of distance: it generates sequences like `jab cross elbow teep` that are impossible without teleporting. Elbows require a step in, and once in close, punches, kicks, hooks, and teeps don't make sense until you step back out. A trained practitioner hearing these callouts stumbles; the combos break the illusion of a real fight.

## What Changes

- **Elbow lock**: after an elbow, only elbow, knee, or a rare hook may directly follow. Punches, kicks, and teeps are banned immediately after an elbow.
- **Voiced step-out**: the `step-back` movement cue may be inserted inside a combo after an elbow ("elbow, elbow, back, cross"), letting the combo continue from range. Insertion is free (does not consume a template slot), capped at one per combo, and honors the disabled-moves config.
- **Exit constraints**: `back` may only follow an elbow; elbow and `back` may not immediately follow `back` (no ping-pong shuffling).
- **Clinch same-side exemption**: the same-side power rule no longer applies to elbow/knee chains, so `rear-elbow → rear-knee` becomes legal (rotation carries through on a bag).
- **Post-knee downweighting**: knees stay hybrid — punches and elbows follow at full weight, kicks are rare, teeps very rare. Rarity is expressed as draw weights, not bans.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `workout-generation`: the "Natural combination sequencing" requirement gains range-aware constraints (elbow lock, `back` exit mechanics, clinch same-side exemption, post-knee weighting). All other requirements (catalog, determinism, density, timeline exactness) are unchanged; `back` inside combos is already covered by "Respect user move selection".

## Impact

- `packages/engine/src/grammar.ts` — `canFollow` gains range rules; `generateCombo` gains the `back` insertion pass and context-aware candidate weights.
- `packages/engine/src/scheduler.ts` — no behavioral change expected (duration already scales with `moveIds.length`), but `generateCombo`'s signature may grow to carry the disabled-moves set for `back`.
- `packages/engine/tests/grammar.test.ts` — new property/scenario tests for range constraints.
- Playback, voice clips, catalog — zero changes ("back" clip and generic callout path already exist).
