/**
 * balance.test.ts — is the difficulty curve actually a curve?
 *
 * Scrapwall is co-op, so it has no seat-fairness or snowball problem — the risk it
 * DOES have is the one the idea named: the wave ramp. Two ways it dies, and both
 * are invisible to unit tests and to the few minutes you spend playing it:
 *
 *   1. A cliff — the fort trivially holds forever, or falls on wave 1. No game.
 *   2. An immortal fort — a maxed turret carpet out-DPSes the horde forever and
 *      the run never ends. This one is real and specific: turret DPS is bounded,
 *      husk HP grows GEOMETRICALLY (tuning.RAMP_EXP), so the fort is eventually
 *      out-scaled — and that geometric term is the ONLY thing guaranteeing it. The
 *      sim caught the disease during tuning: a 76-turret carpet held to the cap
 *      with no ramp until the fort was capped and the ramp steepened.
 *
 * The AI hands (bot.ts) are not a perfect player — a real player leaks husks and
 * takes Core damage a wave or two earlier — but they are a CONSISTENT one, and the
 * point is the SHAPE of the curve, not the absolute wave. Every draw is seeded, so
 * these numbers are deterministic: a bound that moves, moved for a reason.
 */

import { describe, expect, it } from 'vitest';
import { curve } from './helpers/sim';
import { MODES } from '../src/modes';
import { withTuning } from '../src/tuning';

const N = 40;
const MAXN = 20;

const depot1 = curve(N, { mode: MODES.depot, party: 1, maxN: MAXN });
const depot2 = curve(N, { mode: MODES.depot, party: 2, maxN: MAXN });
const depot4 = curve(N, { mode: MODES.depot, party: 4, maxN: MAXN });
const outpost2 = curve(N, { mode: MODES.outpost, party: 2, maxN: MAXN });
const sprawl2 = curve(N, { mode: MODES.sprawl, party: 2, maxN: MAXN });

const ALL = [depot1, depot2, depot4, outpost2, sprawl2] as const;

describe('the run is not a wave-1 cliff', () => {
  for (const [name, c] of [
    ['Depot solo', depot1],
    ['Depot duo', depot2],
    ['Depot four', depot4],
    ['Outpost duo', outpost2],
    ['Sprawl duo', sprawl2],
  ] as const) {
    it(`${name}: the fort almost always holds the opening waves`, () => {
      expect(c.hold[2]).toBeGreaterThan(0.9);
      expect(c.hold[4]).toBeGreaterThan(0.8);
      expect(c.meanWaves).toBeGreaterThan(4);
    });
  }
});

describe('the ramp resolves — no immortal fort, every run ends', () => {
  for (const [name, c] of ALL.map((c, i) => [['Depot1', 'Depot2', 'Depot4', 'Outpost2', 'Sprawl2'][i], c] as const)) {
    it(`${name}: the horde eventually overwhelms the fort`, () => {
      // Nobody should still be standing at the sim cap — the geometric husk ramp
      // has to out-scale even a maxed fort. The immortal-carpet bug was 100% here.
      expect(c.timeoutRate, 'a run that never ends is the failure this guards').toBeLessThan(0.05);
      expect(c.hold[18], 'almost nobody reaches wave 18').toBeLessThan(0.15);
    });
  }

  it('the ramp is monotone — deeper waves are never easier', () => {
    for (const c of ALL) {
      for (let w = 3; w <= MAXN; w++) expect(c.hold[w]).toBeLessThanOrEqual(c.hold[w - 1] + 1e-9);
    }
  });

  it('the decline is a RAMP, not a step — there is a contested middle', () => {
    // A step function (100% then 0%) means every wave before the cliff was a
    // foregone conclusion. A real ramp has waves that some runs hold and some
    // do not — assert each party has such a contested zone.
    for (const c of [depot1, depot2, depot4, sprawl2]) {
      const contested = c.hold.some((p) => p > 0.12 && p < 0.9);
      expect(contested, 'expected a wave held by some runs but not all').toBe(true);
    }
  });
});

describe('the party is playable at every size — no pathological seat', () => {
  it('every party gets a real run and none is trivial', () => {
    for (const c of [depot1, depot2, depot4]) {
      expect(c.meanWaves).toBeGreaterThan(5);
      expect(c.meanWaves).toBeLessThan(16);
    }
    // The horde scales with the party but so does the income, so the four keep
    // roughly pace with the solo rather than being crushed or coasting.
    expect(depot4.meanWaves).toBeGreaterThan(depot1.meanWaves - 5);
    expect(depot4.meanWaves).toBeLessThan(depot1.meanWaves + 3);
  });

  it('a bigger party fells far more husks — it IS holding a bigger horde', () => {
    // The whole point of the horde scaling: four defenders are not playing the
    // solo game, they are holding a wall against much more.
    expect(depot4.meanKills).toBeGreaterThan(depot1.meanKills * 1.2);
  });
});

describe('the three modes are genuinely different games', () => {
  it('Outpost is the gentle one, Sprawl the brutal one', () => {
    // Structural spread: Outpost (small, two edges) holds noticeably longer than
    // Sprawl (big, four edges, heavier ramp). If they converge, two modes are one.
    expect(outpost2.meanWaves).toBeGreaterThan(sprawl2.meanWaves + 2);
  });

  it('the modes carry different grids and spawn geometry', () => {
    expect(MODES.sprawl.cols).toBeGreaterThan(MODES.depot.cols);
    expect(MODES.depot.cols).toBeGreaterThan(MODES.outpost.cols);
    expect(MODES.outpost.edges.length).toBeLessThan(MODES.depot.edges.length);
  });
});

describe('the constant the termination rests on', () => {
  it('RAMP_EXP is load-bearing: flatten it and the fort becomes immortal', () => {
    // Pin it, per principle #18. The geometric husk-HP term is the ONLY thing
    // keeping a maxed fort's bounded DPS from holding the line forever. Flatten it
    // to 1.0 and the deep tail returns: far more runs reach the sim cap alive and
    // never end. This test exists so "let's make the late waves less spongey"
    // cannot quietly re-arm the immortal-fort trap.
    const loose = withTuning({ RAMP_EXP: 1.0 }, () =>
      curve(30, { mode: MODES.depot, party: 2, maxN: MAXN }),
    );
    const shipped = curve(30, { mode: MODES.depot, party: 2, maxN: MAXN });
    expect(loose.hold[18]).toBeGreaterThan(shipped.hold[18]);
    expect(loose.timeoutRate + loose.meanWaves).toBeGreaterThan(
      shipped.timeoutRate + shipped.meanWaves,
    );
  });
});
