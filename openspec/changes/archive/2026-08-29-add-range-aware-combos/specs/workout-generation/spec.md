## MODIFIED Requirements

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

## ADDED Requirements

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
