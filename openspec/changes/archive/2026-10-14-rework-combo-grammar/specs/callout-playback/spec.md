## MODIFIED Requirements

### Requirement: Word-level beat timing
Combo callouts SHALL play one clip per move word, spaced at the engine's strike tempo for the current intensity, so each word lands on its strike beat rather than drifting at whole-phrase speech pace. Words that voice multiple strikes (e.g. "double jab") SHALL be allotted proportionally more time: each subsequent word's start offset SHALL account for the duration of the words before it, not merely its index.

#### Scenario: Combo words land on the beat
- **WHEN** a combo callout ("one, two, kick") is dispatched during a hard-intensity workout
- **THEN** each word's clip starts within 250ms of its scheduled position (cumulative per-word durations at the current strike tempo)

#### Scenario: Doubled words get room
- **WHEN** a combo callout containing "double jab" is dispatched at any intensity
- **THEN** the word after "double jab" starts later than a single-strike word would have, proportional to the doubled strike duration
