## Purpose

Defines the screen where the user configures a workout before starting it, and how that configuration persists between sessions.


### Requirement: Configure workout structure
The user SHALL be able to set the number of rounds, round duration, and rest duration using bounded controls that prevent invalid combinations.

#### Scenario: Adjusting round count
- **WHEN** the user changes the number of rounds
- **THEN** the setting is reflected immediately and used by the next generated workout

#### Scenario: Bounded values
- **WHEN** the user adjusts any structural setting
- **THEN** the control restricts choices to a sensible predefined range (e.g. rounds 1–12, round duration 1–5 minutes, rest 15–120 seconds)

### Requirement: Configure intensity
The user SHALL be able to select an intensity level from a small ordinal set (e.g. easy, moderate, hard), which drives combo length and callout density in the engine.

#### Scenario: Intensity selection
- **WHEN** the user selects an intensity before starting
- **THEN** the generated workout's combo lengths and callout counts reflect that intensity per the workout-generation requirements

### Requirement: Select moves
The user SHALL be able to enable or disable individual moves and move groups (punches, kicks, knees, elbows, defense, movement). Disabled moves SHALL not appear in generated workouts.

#### Scenario: Disabling a move group
- **WHEN** the user disables the elbows group and starts a workout
- **THEN** no elbow callouts occur during the session

#### Scenario: Guard against empty selection
- **WHEN** the user attempts to start a workout with no strikes enabled
- **THEN** the app prevents starting and indicates that at least one strike must be enabled

### Requirement: Configuration persists
The app SHALL persist the last-used workout configuration and restore it on next launch.

#### Scenario: Restart restores settings
- **WHEN** the user closes the app and relaunches it
- **THEN** all workout settings match what was last used
