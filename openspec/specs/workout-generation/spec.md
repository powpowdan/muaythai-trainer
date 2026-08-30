## Purpose

Defines the workout engine: the move catalog, the combo grammar that sequences strikes into natural-sounding combinations, and the scheduler that paces callouts into a precise per-round timeline from a workout config.


### Requirement: Move catalog completeness
Every strike, defense, and movement cue the engine can emit SHALL be defined in a catalog where each move has a unique identifier, a stance side (lead, rear, or neutral), a type (punch, kick, knee, elbow, defense, movement), a power level, a spoken-callout text, and a display text. The engine SHALL NOT emit any move not present in the catalog.

#### Scenario: Catalog integrity check
- **WHEN** the catalog is loaded
- **THEN** every entry has all required fields populated, callout text is speakable (numbers spelled as words, e.g. "one" not "1"), and no two entries share an identifier

### Requirement: Respect user move selection
The engine SHALL only generate callouts using moves enabled in the workout config.

#### Scenario: Disabled move never called
- **WHEN** a workout is generated with any move disabled
- **THEN** the resulting timeline contains zero callouts referencing the disabled move, including inside multi-strike combos

### Requirement: Natural combination sequencing
The engine SHALL apply sequencing rules so generated combinations feel natural to a trained practitioner:

- No two consecutive same-side power strikes within a combo, except explicitly allowed repeats (double jab, double teep) and consecutive elbow/knee strikes (rotation carries through in close range)
- A kick SHALL NOT be immediately followed by a kick from the same side
- Elbows and knees SHALL only appear at intensity levels where they are enabled
- Combos SHALL open with a lead-side or neutral setup move (e.g. jab, teep, feint) at least 70% of the time

#### Scenario: No same-side power strike chain
- **WHEN** any number of workouts is generated at any intensity
- **THEN** no combo contains consecutive same-side power strikes outside the allowed-repeat and elbow/knee-chain exceptions

#### Scenario: Same-side clinch chains are legal
- **WHEN** combos containing elbow or knee strikes are generated
- **THEN** same-side elbow-into-knee and knee-into-elbow chains can occur

#### Scenario: Lead-side openings dominate
- **WHEN** at least 20 combos are generated
- **THEN** at least 70% open with a lead-side or neutral setup move

### Requirement: Elbow lock on close-range weapons
After an elbow within a combo, the engine SHALL only allow another elbow, a knee, the `back` step-out cue, or — rarely — a hook to directly follow. Punches other than the hook, kicks, and teeps SHALL NOT directly follow an elbow.

#### Scenario: No range strike directly after an elbow
- **WHEN** any number of workouts is generated at any intensity
- **THEN** no combo contains a non-hook punch, kick, or teep immediately after an elbow

#### Scenario: Clinch chains remain reachable
- **WHEN** at least 50 combos containing an elbow are generated
- **THEN** some contain an elbow immediately followed by an elbow or knee

#### Scenario: Post-elbow hooks are rare
- **WHEN** at least 50 combos containing an elbow are generated
- **THEN** hooks make up a small minority (under 15%) of strikes directly following an elbow

### Requirement: Voiced step-out resumes range work
The engine MAY insert the `back` step-out cue inside a combo immediately after an elbow, letting subsequent strikes resume from range. The insertion SHALL NOT consume a combo-length slot, SHALL occur at most once per combo, SHALL only ever follow an elbow, and SHALL NOT be immediately followed by another `back` or an elbow.

#### Scenario: Back only appears after an elbow
- **WHEN** any number of workouts is generated
- **THEN** every `back` inside a combo immediately follows an elbow, and no combo contains more than one `back`

#### Scenario: Range resumes after back
- **WHEN** a combo contains an elbow followed by `back`
- **THEN** the move after `back` is a range strike (never an elbow or another `back`)

#### Scenario: Disabled back is never inserted
- **WHEN** the step-back move is disabled in the workout config
- **THEN** no combo contains the `back` cue

### Requirement: Knees do not lock the range
A knee SHALL leave the practitioner free to continue at any range: punches and elbows after a knee remain fully weighted, while kicks after a knee SHALL be uncommon and teeps after a knee SHALL be rarer still, expressed as draw weights rather than bans.

#### Scenario: Post-knee continuations favor close work
- **WHEN** at least 100 combos containing a non-terminal knee are generated
- **THEN** punches, elbows, and knees make up the large majority (over 85%) of strikes directly following a knee, and teeps are the rarest continuation (under 5%)

### Requirement: Combo length scales with intensity
The engine SHALL bound combination length by intensity: low intensity 2–4 strikes, high intensity 2–6 strikes.

#### Scenario: Length bounds at high intensity
- **WHEN** a workout is generated at the highest intensity
- **THEN** every generated combo has between 2 and 6 strikes

#### Scenario: Length bounds at low intensity
- **WHEN** a workout is generated at the lowest intensity
- **THEN** every generated combo has between 2 and 4 strikes

### Requirement: Callout density scales with intensity
The number of callouts per round SHALL increase monotonically with the intensity setting: a round generated at higher intensity SHALL schedule at least as many callouts as the same round at lower intensity.

#### Scenario: Density is monotonic
- **WHEN** identical round configs are generated at each intensity level from lowest to highest
- **THEN** callout counts per round form a non-decreasing sequence

### Requirement: Timeline exactness
The scheduler SHALL produce a timeline where every callout event has a start time, every callout fits entirely within a working round (no callout crosses the round-end bell), rest periods contain no strike callouts, and bell events occur exactly at round and rest boundaries.

#### Scenario: No callout crosses the bell
- **WHEN** a timeline is generated for any config
- **THEN** no callout event ends after its round's end time

#### Scenario: Rest is quiet
- **WHEN** a rest period occurs in the timeline
- **THEN** it contains no strike callouts (round announcements and rest cues are permitted)

### Requirement: Deterministic generation from seed
Given the same workout config and generation seed, the engine SHALL produce an identical timeline, so sessions are reproducible when reporting feel issues.

#### Scenario: Reproducible workout
- **WHEN** the same config and seed are used to generate two workouts
- **THEN** both timelines are identical event by event
