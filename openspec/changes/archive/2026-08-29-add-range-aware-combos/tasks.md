## 1. Pairwise range rules in `canFollow`

- [x] 1.1 Add elbow lock: after an elbow-type move, only elbow, knee, and hook types may directly follow (ban non-hook punches, kicks, teeps)
- [x] 1.2 Add `step-back` transition rules: `back` may only follow an elbow; an elbow or another `back` may not immediately follow a `back`
- [x] 1.3 Exempt elbow/knee chains from the same-side power rule (both prev and next are elbow or knee type)

## 2. Context-aware draw weights

- [x] 2.1 Add a `candidateWeight(prev, next)` function implementing the design table (elbow→hook 0.15; knee→kick 0.35; knee→teep 0.1; default 1.0) as named constants
- [x] 2.2 Replace the uniform `() => 1` weight in `generateCombo`'s `weightedPick` call with the context-aware function (weights affect draw probability only, never legality)

## 3. Free `back` insertion

- [x] 3.1 Thread `step-back`-enabled status from `generateCombos`/scheduler into `generateCombo` (options parameter or flag; signature change is internal to the engine package)
- [x] 3.2 After the fill loop pushes an elbow, if template slots remain, no `back` was inserted yet, and `step-back` is enabled: roll `rng() < BACK_EXIT_CHANCE` (0.4, named constant) and push `step-back` without consuming a slot
- [x] 3.3 Confirm `validateCombo` accepts `step-back` ids via `MOVES_BY_ID` and that the fill's next-slot filtering uses the pairwise rules from task 1.2

## 4. Tests

- [x] 4.1 Property test across many seeds, intensities, and enabled-move sets: no non-hook punch, kick, or teep immediately follows an elbow; `back` only appears immediately after an elbow; at most one `back` per combo; no elbow or `back` immediately after a `back`
- [x] 4.2 Presence tests: elbow→elbow and elbow→knee chains still occur; same-side elbow→knee chains occur; punches after knees occur (lock did not over-restrict)
- [x] 4.3 Statistical tests with wide margins: post-elbow strikes are hooks under 15% of the time; post-knee strikes are punches/elbows over 70% of the time (if flaky, unit-test `candidateWeight` directly and keep property tests for hard bans)
- [x] 4.4 `back` respects `disabledMoveIds`: with `step-back` disabled, no generated combo contains it
- [x] 4.5 Existing grammar tests still pass unchanged in their assertions that don't involve the new rules (no regressions in length bounds, opener bias, determinism)

## 5. Verification

- [x] 5.1 Run the engine test suite (`packages/engine/tests`) and confirm all green
- [x] 5.2 Run repo lint/typecheck; export surface of `packages/engine/src/index.ts` unchanged unless the options param requires a type addition
