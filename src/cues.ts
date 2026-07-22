/**
 * cues.ts — Scrapwall's own sound patches.
 *
 * These used to require a forked copy of the whole engine `sound.ts`, purely
 * because `SfxName` was a closed union of platformer cues. Engine v1.3.0 takes
 * game patches through `createSfx({ patches })`, so all that survives is the
 * table itself — which is the only part that was ever game-specific.
 */

import type { Patch } from '@ben-gy/game-engine/sound';

export const CUES: Record<string, Patch> = {
  select: { type: 'triangle', freq: [520, 760], dur: 0.07, gain: 0.18 },
  place: { type: 'square', freq: [200, 120], dur: 0.09, gain: 0.22, noise: true },
  nope: { type: 'sawtooth', freq: [180, 100], dur: 0.12, gain: 0.18 },
  harvest: { type: 'square', freq: [740, 1180], dur: 0.1, gain: 0.16 },
  fire: { type: 'square', freq: [420, 180], dur: 0.05, gain: 0.12, noise: true },
  splat: { type: 'sawtooth', freq: [260, 70], dur: 0.14, gain: 0.2, noise: true },
  crack: { type: 'sawtooth', freq: [320, 160], dur: 0.06, gain: 0.16, noise: true },
  break: { type: 'sawtooth', freq: [200, 40], dur: 0.34, gain: 0.3, noise: true },
  corehit: { type: 'sawtooth', freq: [150, 50], dur: 0.28, gain: 0.34, noise: true },
  repair: { type: 'triangle', freq: [360, 620], dur: 0.12, gain: 0.16 },
  wavestart: { type: 'sawtooth', freq: [120, 300], dur: 0.5, gain: 0.28 },
  waveclear: { type: 'triangle', freq: [520, 1040], dur: 0.42, gain: 0.24 },
  lowammo: { type: 'square', freq: [660, 440], dur: 0.16, gain: 0.16 },
  beat: { type: 'square', freq: [440, 520], dur: 0.09, gain: 0.2 },
  go: { type: 'triangle', freq: [620, 1240], dur: 0.32, gain: 0.26 },
  over: { type: 'sawtooth', freq: [300, 80], dur: 0.6, gain: 0.32, noise: true },
  win: { type: 'triangle', freq: [520, 1180], dur: 0.5, gain: 0.26 },
};
