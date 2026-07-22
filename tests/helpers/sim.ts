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

import { Game, type Seat, TURRET_RANGE } from '../../src/game';
import { botAct } from '../../src/bot';
import { makeRng, type Rng } from '@ben-gy/game-engine/rng';
import type { Mode } from '../../src/modes';

export interface RunResult {
  waves: number; // waves fully held
  steps: number;
  kills: number;
  built: number;
  timedOut: boolean;
  /**
   * Shots fired at a husk while a husk CLOSER TO THE CORE stood in the same
   * turret's range — i.e. the gun shot past the more urgent threat. Must be 0.
   *
   * This is a MECHANISM measure, not an outcome measure, and it exists because
   * every outcome measure was blind to the bug that shipped: turrets picked the
   * husk nearest to THEMSELVES, so a husk in a stack was never any gun's nearest
   * and hammered the Core untouched for up to 8 seconds. In the curve that reads
   * as "the fort fell a wave earlier" — indistinguishable from intended
   * difficulty, and comfortably inside every bound in balance.test.ts.
   *
   * Deliberately a count of RULE VIOLATIONS rather than a duration. The obvious
   * metric — "how long did a husk sit at the Core taking no fire" — cannot carry
   * a zero-tolerance bound, because deep in a run that time is honest: a wave-14
   * brute soaks ~29 shots, so the husk queued behind it really does stand there
   * for ten seconds and the battery is working perfectly. Auditing each shot
   * against the priority rule has no such grey zone: shooting past a closer
   * threat is wrong on wave 1 and wrong on wave 20.
   */
  misTargetedShots: number;
}

/** A husk's position as of the last completed frame, for auditing shots. */
interface Seen {
  id: number;
  x: number;
  y: number;
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
  let misTargetedShots = 0;
  const r2 = TURRET_RANGE * TURRET_RANGE;
  const coreD2 = (x: number, y: number): number => (x - g.cx) ** 2 + (y - g.cy) ** 2;
  // Husk positions as of the END of the previous frame. hostStep runs turrets
  // BEFORE it moves husks, so these are exactly the positions the guns aimed at
  // this frame. Husks that spawn mid-frame are missing from the snapshot, which
  // is harmless: they appear on the border ring, so they are always FARTHER from
  // the Core than anything already inside and can never be the closer threat a
  // gun should have preferred.
  let seen: Seen[] = [];

  while (!g.over && steps < maxSteps && g.reached < maxWave) {
    g.hostStep(step);

    // Audit every shot against the priority rule from the outside.
    //
    // Only husks that were still alive at the END of the frame count as a missed
    // better target. A battery fires many shots per frame, so a husk the audit
    // saw at the top of the frame may already have been killed by an earlier gun
    // by the time a later one fires — blaming that gun for "shooting past" a
    // corpse is the audit's bug, not the game's. Requiring the witness to have
    // survived makes a violation mean what it says: the better target was there
    // for the whole frame and the gun shot something else.
    const aliveNow = new Set(g.husks.map((h) => h.id));
    for (const e of g.events) {
      if (e.k !== 'fire') continue;
      const shotAt = coreD2(e.tx, e.ty);
      for (const h of seen) {
        if (!aliveNow.has(h.id)) continue;
        const dx = h.x - e.x;
        const dy = h.y - e.y;
        if (dx * dx + dy * dy > r2) continue; // not this gun's problem
        if (coreD2(h.x, h.y) < shotAt - 1e-6) {
          misTargetedShots++;
          break;
        }
      }
    }
    seen = g.husks.map((h) => ({ id: h.id, x: h.x, y: h.y }));

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
  return {
    waves: g.reached,
    steps,
    kills,
    built,
    timedOut: !g.over && g.reached >= maxWave,
    misTargetedShots,
  };
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
  /** Total across every run — see RunResult.misTargetedShots. Must be 0. */
  misTargetedShots: number;
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
  let misTargetedShots = 0;
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
    misTargetedShots += r.misTargetedShots;
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
    misTargetedShots,
  };
}

export function report(name: string, c: CurveResult): string {
  const r = c.hold.map((p, i) => (i > 0 && i % 2 === 0 ? `w${i}:${(p * 100).toFixed(0)}%` : null)).filter(Boolean);
  return `${name}: median ${c.medianWaves}, mean ${c.meanWaves.toFixed(1)}, timeouts ${(c.timeoutRate * 100).toFixed(0)}% | ${r.join(' ')}`;
}
