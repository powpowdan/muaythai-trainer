## ADDED Requirements

### Requirement: Range-phase combination families
Combos SHALL be drawn from four families that mirror range phases, and each family SHALL be reachable at every intensity level with the same target mix (v1):

- **Boxing**: punch strikes only (jab chainable anywhere, including the `double-jab` unit)
- **Boxing→kick**: a punch chain finishing with a kick, which returns the practitioner to range
- **Close**: a punch chain finishing in knee or elbow work (existing elbow-lock and step-out behavior applies)
- **Range**: jab and teep play only

#### Scenario: Family distribution holds at moderate intensity
- **WHEN** at least 100 combos are generated at moderate intensity
- **THEN** pure boxing combos make up at least 20%, punch-chain-to-kick combos at least 25%, and clinch-finish combos at most 35%

#### Scenario: Punch endings exist
- **WHEN** at least 100 combos are generated at any intensity
- **THEN** some combos end with a punch strike

#### Scenario: Family mix is uniform across intensities
- **WHEN** at least 100 combos are generated at each intensity level
- **THEN** each family remains reachable at every intensity

### Requirement: Clinch weapons close the distance
Knees and elbows SHALL be expressed through the close family and draw weights rather than appearing freely: elbows SHALL appear in a small minority of combos, and among combos that finish with a non-punch strike, kick finishes SHALL be the most common and elbow finishes the least common.

#### Scenario: Elbows are a garnish
- **WHEN** at least 100 combos are generated at any intensity
- **THEN** fewer than 15% of combos contain any elbow

#### Scenario: Kick finishes dominate non-punch finishes
- **WHEN** at least 100 combos containing a non-punch final strike are generated
- **THEN** kick finishes outnumber knee finishes, and knee finishes outnumber elbow finishes

### Requirement: Punch chains carry the combo
The jab SHALL be chainable at any position within a combo's punch section (not only as the opener), so boxing rhythms such as 1-2-1-2 and 1-1-2-3 are reachable. Strikes immediately following a jab SHALL favor punches; a direct jab-to-elbow or jab-to-knee transition SHALL remain legal but rare.

#### Scenario: Jab chains mid-combo
- **WHEN** at least 100 combos are generated at any intensity
- **THEN** some combos contain a jab that follows another punch strike

#### Scenario: Post-jab continuations favor boxing
- **WHEN** at least 100 combos are generated at any intensity
- **THEN** punches make up the majority of strikes that directly follow a jab

#### Scenario: Jab straight to clinch is rare
- **WHEN** at least 100 combos are generated at any intensity
- **THEN** elbows and knees combined make up a small minority (under 20%) of strikes that directly follow a jab

### Requirement: Double jab unit
A `double-jab` move SHALL exist in the catalog as a first-class unit with its own spoken callout ("double jab"), its own display text, and its own move toggle. A doubled jab SHALL always be emitted as this unit, never as two adjacent `jab` entries. The unit MAY directly precede or follow a `jab` (voiced as two clips, e.g. triple jab), but SHALL NOT be adjacent to another `double-jab`.

#### Scenario: Double jab occurs
- **WHEN** at least 100 combos are generated with default moves enabled
- **THEN** some combos contain the `double-jab` unit

#### Scenario: No raw jab pairs
- **WHEN** any number of combos is generated
- **THEN** no combo contains two adjacent `jab` entries; doubled jabs always appear as the `double-jab` unit

#### Scenario: Quadruple jab never generated
- **WHEN** any number of combos is generated
- **THEN** no combo contains two adjacent `double-jab` entries

## MODIFIED Requirements

### Requirement: Natural combination sequencing
The engine SHALL apply sequencing rules so generated combinations feel natural to a trained practitioner:

- No two consecutive same-side power strikes within a combo, except explicitly allowed repeats (double teep) and consecutive elbow/knee strikes (rotation carries through in close range)
- Doubled jabs SHALL be emitted as the `double-jab` unit, not as repeated `jab` entries (see Double jab unit)
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

### Requirement: Combo length scales with intensity
The engine SHALL bound combination length by intensity: low intensity 2–4 strikes, moderate intensity 2–5 strikes, high intensity 2–6 strikes. Boxing-family combos at moderate intensity MAY extend to 6 strikes, since punches chain faster than clinch or kicking work; all other families keep the per-intensity caps. Length counts catalog units: a `double-jab` counts as one strike slot.

#### Scenario: Length bounds at high intensity
- **WHEN** a workout is generated at the highest intensity
- **THEN** every generated combo has between 2 and 6 strikes

#### Scenario: Length bounds at low intensity
- **WHEN** a workout is generated at the lowest intensity
- **THEN** every generated combo has between 2 and 4 strikes

#### Scenario: Long boxing chains at moderate intensity
- **WHEN** at least 100 combos are generated at moderate intensity
- **THEN** some pure-punch combos reach 5 or 6 strikes, while every non-boxing combo stays within 2–5 strikes
