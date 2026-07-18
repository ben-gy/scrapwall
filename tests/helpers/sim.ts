/**
 * helpers/sim.ts — headless run driver for the difficulty-curve sim.
 *
 * A co-op game's "balance" is its difficulty curve (principle #18, and the idea
 * itself said "tune the wave curve with a sim, don't eyeball it"). So this plays
 * full runs with AI hands (bot.ts) against the real Game host loop and reports how
 * many waves the fort held. Deterministic in the seed: seeded rng everywhere, a
 * synthetic fixed-step clock, no wall time.
 *
 * A "party of N" is N sets of hands acting on the ONE shared base — exactly the
 * co-op scaling the game has (more friends, more hands per prep-second, shared
 * purse and map, so it is sublinear).
 */

import { Game, type Seat } from '../../src/game';
import { botAct } from '../../src/bot';
import { makeRng, type Rng } from '../../src/engine/rng';
import type { Mode } from '../../src/modes';

export interface RunResult {
  waves: number; // waves fully held
  steps: number;
  kills: number;
  built: number;
  timedOut: boolean;
}

export interface RunOpts {
  seed: number;
  mode: Mode;
  party: number;
  hz?: number;
  maxWave?: number;
  maxSteps?: number;
}

const BOT_INTERVAL = 0.32; // seconds between a hand's actions

export function playRun(opts: RunOpts): RunResult {
  const hz = opts.hz ?? 60;
  const step = 1 / hz;
  const maxWave = opts.maxWave ?? 20;
  const maxSteps = opts.maxSteps ?? hz * 60 * 20; // ~20 sim-minutes, plenty to end

  const seats: Seat[] = Array.from({ length: opts.party }, (_, i) => ({ name: `B${i}`, bot: true }));
  const g = new Game({ seed: opts.seed, mode: opts.mode, seats });

  const rngs: Rng[] = seats.map((_, i) => makeRng(opts.seed ^ (0x1234 * (i + 1))));
  const timers = seats.map(() => 0);

  let steps = 0;
  while (!g.over && steps < maxSteps && g.reached < maxWave) {
    g.hostStep(step);
    for (let s = 0; s < seats.length; s++) {
      timers[s] -= step;
      if (timers[s] <= 0) {
        botAct(g, s, rngs[s]);
        timers[s] += BOT_INTERVAL;
      }
    }
    g.events.length = 0; // drop events; nothing renders here
    steps++;
  }

  let kills = 0;
  let built = 0;
  for (const p of g.players) {
    kills += p.contrib.kills;
    built += p.contrib.built;
  }
  return { waves: g.reached, steps, kills, built, timedOut: !g.over && g.reached >= maxWave };
}

export interface CurveResult {
  runs: number;
  /** P(hold at least N waves) for N = 1..maxN. */
  hold: number[];
  medianWaves: number;
  meanWaves: number;
  timeoutRate: number;
  meanKills: number;
  meanBuilt: number;
}

export function curve(
  n: number,
  opts: { mode: Mode; party: number; hz?: number; maxN?: number },
): CurveResult {
  const maxN = opts.maxN ?? 20;
  const holdCount = new Array(maxN + 1).fill(0);
  const waves: number[] = [];
  let timeouts = 0;
  let kills = 0;
  let built = 0;
  for (let i = 0; i < n; i++) {
    const r = playRun({
      seed: 5000 + i * 13 + opts.party * 907,
      mode: opts.mode,
      party: opts.party,
      hz: opts.hz,
      maxWave: maxN,
    });
    waves.push(r.waves);
    for (let w = 1; w <= maxN; w++) if (r.waves >= w) holdCount[w]++;
    if (r.timedOut) timeouts++;
    kills += r.kills;
    built += r.built;
  }
  waves.sort((a, b) => a - b);
  return {
    runs: n,
    hold: holdCount.map((c) => c / n),
    medianWaves: waves[Math.floor(waves.length / 2)],
    meanWaves: waves.reduce((a, b) => a + b, 0) / n,
    timeoutRate: timeouts / n,
    meanKills: kills / n,
    meanBuilt: built / n,
  };
}

export function report(name: string, c: CurveResult): string {
  const r = c.hold.map((p, i) => (i > 0 && i % 2 === 0 ? `w${i}:${(p * 100).toFixed(0)}%` : null)).filter(Boolean);
  return `${name}: median ${c.medianWaves}, mean ${c.meanWaves.toFixed(1)}, timeouts ${(c.timeoutRate * 100).toFixed(0)}% | ${r.join(' ')}`;
}
