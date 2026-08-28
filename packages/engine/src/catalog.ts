import type { Move } from './types';

// Muay Thai move catalog. Sides are stance-relative (lead/rear), never
// left/right. Punches are called by number (gym convention: 1-6); kicks,
// knees, elbows, defenses and movement are called by name. Lead and rear
// variants share a callout word — the side distinction exists for the
// grammar's sequencing rules, not for the voice.
export const CATALOG: Move[] = [
  // Punches: jab, cross, hook by name; lead/rear hooks share the word
  // (side is implied by sequence — same pattern as kicks). Uppercuts cut.
  { id: 'jab', side: 'lead', type: 'punch', power: 'light', calloutText: 'jab', displayText: 'jab' },
  { id: 'cross', side: 'rear', type: 'punch', power: 'power', calloutText: 'cross', displayText: 'cross' },
  { id: 'lead-hook', side: 'lead', type: 'punch', power: 'power', calloutText: 'hook', displayText: 'hook' },
  { id: 'rear-hook', side: 'rear', type: 'punch', power: 'power', calloutText: 'hook', displayText: 'hook' },
  // Kicks
  { id: 'rear-kick', side: 'rear', type: 'kick', power: 'power', calloutText: 'kick', displayText: 'kick' },
  { id: 'lead-kick', side: 'lead', type: 'kick', power: 'power', calloutText: 'kick', displayText: 'kick' },
  { id: 'lead-teep', side: 'lead', type: 'kick', power: 'light', calloutText: 'teep', displayText: 'teep' },
  { id: 'rear-teep', side: 'rear', type: 'kick', power: 'light', calloutText: 'teep', displayText: 'teep' },
  // Knees
  { id: 'rear-knee', side: 'rear', type: 'knee', power: 'power', calloutText: 'knee', displayText: 'knee' },
  { id: 'lead-knee', side: 'lead', type: 'knee', power: 'power', calloutText: 'knee', displayText: 'knee' },
  // Elbows
  { id: 'lead-elbow', side: 'lead', type: 'elbow', power: 'power', calloutText: 'elbow', displayText: 'elbow' },
  { id: 'rear-elbow', side: 'rear', type: 'elbow', power: 'power', calloutText: 'elbow', displayText: 'elbow' },
  // Defense
  { id: 'slip', side: 'neutral', type: 'defense', power: 'light', calloutText: 'slip', displayText: 'slip' },
  { id: 'roll', side: 'neutral', type: 'defense', power: 'light', calloutText: 'roll', displayText: 'roll' },
  { id: 'check', side: 'neutral', type: 'defense', power: 'light', calloutText: 'check', displayText: 'check' },
  { id: 'block', side: 'neutral', type: 'defense', power: 'light', calloutText: 'block', displayText: 'block' },
  // Movement
  { id: 'switch', side: 'neutral', type: 'movement', power: 'light', calloutText: 'switch', displayText: 'switch' },
  { id: 'step-back', side: 'neutral', type: 'movement', power: 'light', calloutText: 'back', displayText: 'back' },
  { id: 'pressure', side: 'neutral', type: 'movement', power: 'light', calloutText: 'forward', displayText: 'fwd' },
];

export const MOVES_BY_ID: ReadonlyMap<string, Move> = new Map(CATALOG.map((m) => [m.id, m]));
