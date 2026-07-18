/**
 * bot.ts — a competent-but-not-perfect pair of hands for the co-op fort.
 *
 * Its real job is to REFEREE the difficulty curve (tests/balance.test.ts,
 * principle #18): a co-op game's balance IS its ramp, and the only way to know
 * the ramp is a curve — not a cliff, not an immortal fort — is to have a
 * consistent AI play hundreds of seeded runs and measure the shape.
 *
 * The policy is deliberately simple and greedy: repair what is breaking, keep
 * scrap and ammo flowing off salvage, ring the Core in guns and back them with
 * walls. A real player builds smarter and goes a wave or two deeper; the point is
 * the SHAPE of the curve, held constant across seeds, not the absolute wave.
 *
 * A "party of N" is modelled as N of these acting in parallel on the ONE shared
 * base — which is exactly the co-op scaling the game has: more friends, more
 * hands per prep-second, but a shared purse and a shared map, so it is sublinear.
 */

import { Game, STRUCTS, TURRET, WALL, SPIKES, CORE, type BuildKind } from './game';
import type { Rng } from './engine/rng';

function countType(g: Game, type: number): number {
  let c = 0;
  for (let i = 0; i < g.ct.length; i++) if (g.ct[i] === type) c++;
  return c;
}

/** Chebyshev distance from the Core. */
function ring(g: Game, i: number): number {
  return Math.max(Math.abs(g.colOf(i) - g.colOf(g.coreIdx)), Math.abs(g.rowOf(i) - g.rowOf(g.coreIdx)));
}

/** First buildable empty cell at a given Core-ring distance, or -1. */
function slotAtRing(g: Game, dist: number): number {
  const n = g.cols * g.rows;
  for (let i = 0; i < n; i++) {
    if (g.buildable(i) && ring(g, i) === dist) return i;
  }
  return -1;
}

function richestNode(g: Game): number {
  let best = -1;
  let bestV = 0;
  for (let i = 0; i < g.salv.length; i++) {
    if (g.salv[i] > bestV) {
      bestV = g.salv[i];
      best = i;
    }
  }
  return best;
}

/** Most-damaged wall/turret/core below a threshold fraction, or -1. */
function worstDamaged(g: Game, below: number): number {
  const n = g.cols * g.rows;
  let worst = -1;
  let worstFrac = below;
  for (let i = 0; i < n; i++) {
    const t = g.ct[i];
    if (t !== WALL && t !== TURRET && t !== SPIKES && t !== CORE) continue;
    if (g.cmax[i] <= 0) continue;
    const frac = g.chp[i] / g.cmax[i];
    if (frac < worstFrac) {
      worstFrac = frac;
      worst = i;
    }
  }
  return worst;
}

/**
 * Perform at most one action for `seat`. Returns true if it acted. The sim calls
 * this on a fixed cadence per bot; each call is one "move" of the hands.
 */
export function botAct(g: Game, seat: number, rng: Rng): boolean {
  if (g.over) return false;

  // 1. Something is breaking — patch it before it falls.
  const hurt = worstDamaged(g, 0.5);
  if (hurt >= 0 && g.scrap >= STRUCTS.wall.cost) return g.repair(seat, hurt);

  // 2. Keep the purse and the magazine full. The magazine target scales with how
  //    many guns we run — a gun you cannot feed is worse than no gun (it cost
  //    scrap AND it drains the shared pool). Harvest when either runs thin.
  const turrets = countType(g, TURRET);
  const scrapWant = 45;
  const ammoWant = 20 + turrets * 10;
  if (g.scrap < scrapWant || g.ammo < ammoWant) {
    const node = richestNode(g);
    if (node >= 0) return g.harvest(seat, node);
  }

  // 3. Build the fort OUTWARD in layers, spending whatever scrap the party has
  //    harvested. There is no hard structure cap — so a bigger party (more hands
  //    harvesting → more scrap) simply affords a bigger fort and holds deeper.
  //    That is the co-op scaling; the grid's finite in-range slots plus the
  //    geometric husk ramp still guarantee the fort is eventually out-scaled.
  const FORT: { ring: number; kind: BuildKind }[] = [
    // Guns first, ring by ring — but each is skipped below if the magazine can't
    // feed it, in which case the walls behind them get built instead. So a
    // resource-rich party (more harvesters) sustains more guns and holds deeper,
    // while a starved fort falls back to walls to buy time.
    { ring: 1, kind: 'turret' },
    { ring: 2, kind: 'turret' },
    { ring: 3, kind: 'turret' },
    { ring: 4, kind: 'turret' },
    { ring: 2, kind: 'wall' },
    { ring: 3, kind: 'wall' },
    { ring: 4, kind: 'wall' },
    { ring: 5, kind: 'wall' },
  ];
  // A dash of spikes on the outer approach for area denial.
  if (rng() < 0.08 && g.scrap >= STRUCTS.spikes.cost + 20) {
    const s = slotAtRing(g, 3);
    if (s >= 0) return g.tryBuild(seat, s, 'spikes');
  }
  // Only add a gun if (a) the magazine can sustain one more — a gun you cannot
  // feed makes the run WORSE — and (b) the fort is not already as big as a sane
  // defender would build it. The cap grows with the party and the wave (you
  // expand over time) but stays finite, so the geometric husk ramp always
  // eventually out-scales the fort's DPS and the run ends.
  const maxGuns = Math.min(28, 4 + g.wave + (g.activeSeats() - 1) * 3);
  const canFeedAnotherGun = turrets < maxGuns && g.ammo >= (turrets + 1) * 12;
  for (const layer of FORT) {
    if (layer.kind === 'turret' && !canFeedAnotherGun) continue;
    if (g.scrap < STRUCTS[layer.kind].cost) continue;
    const slot = slotAtRing(g, layer.ring);
    if (slot >= 0) return g.tryBuild(seat, slot, layer.kind);
  }
  void SPIKES;

  // 4. Fort is as big as it can get right now — bank scrap and ammo for the next
  //    wave off the richest node.
  const node = richestNode(g);
  if (node >= 0) return g.harvest(seat, node);
  return false;
}
