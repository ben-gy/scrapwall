/**
 * turrets.test.ts — the guns shoot the thing that is killing you.
 *
 * The bug this pins, reported by a player on a shipped build: "the last zombie is
 * never shot by my guns and kills the house."
 *
 * Turrets picked the husk nearest to THEMSELVES. Husks stack — the flow field
 * funnels a column into one cell and nothing pushes them apart — so three of them
 * sit within a jitter's width of each other, every gun in the battery locks
 * whichever is a hair closer, and the ones directly behind it are never ANY gun's
 * nearest. They stand at the Core at full HP, swinging, while the whole fort
 * shoots past them. Measured in a real run: 8 seconds of free hits on the Core
 * with 1,721 ammo in the bank and six guns in range.
 *
 * These are hand-built boards, not a sim: the geometry that triggers it is exact,
 * so the test is exact.
 */

import { describe, expect, it } from 'vitest';
import { Game, HUSKS, TURRET_DMG, TURRET_RANGE, type Husk, type HuskKind } from '../src/game';
import { MODES } from '../src/modes';

/** A game with a full purse, parked in a wave, with no spawn queue of its own. */
function board() {
  const g = new Game({ seed: 1, mode: MODES.depot, seats: [{ name: 'A', bot: false }] });
  g.scrap = 9999;
  g.ammo = 9999;
  g.launchWave();
  g.husks.length = 0;
  (g as unknown as { queue: unknown[] }).queue = [];
  return g;
}

/** Drop a husk at an exact spot, with no jitter, so the geometry is the test. */
function place(g: Game, id: number, x: number, y: number, kind: HuskKind = 0, hp?: number): Husk {
  const def = HUSKS[kind];
  const h: Husk = {
    id,
    kind,
    x,
    y,
    hp: hp ?? def.hp,
    maxHp: hp ?? def.hp,
    spd: 0, // parked: movement is not what is under test
    atk: 0,
    jx: 0,
    jy: 0,
    rx: x,
    ry: y,
  };
  g.husks.push(h);
  return h;
}

const STEP = 1 / 60;

describe('a turret shoots the biggest threat in range, not the closest to itself', () => {
  it('the husk AT THE CORE is shot, even when a decoy is sitting on the gun', () => {
    const g = board();
    // Core is (5,5); its centre is (5.5, 5.5).
    const gun = g.idx(3, 6);
    expect(g.tryBuild(0, gun, 'turret')).toBe(true);

    // The decoy is right on top of the gun — nearest to it by far, but out on the
    // flank. The attacker is in contact with the Core.
    const decoy = place(g, 1, 3.5, 6.5);
    const attacker = place(g, 2, 5.5, 6.5);

    // Both are genuinely in range, so this is a choice, not a reachability quirk.
    for (const h of [decoy, attacker]) {
      expect(Math.hypot(h.x - 3.5, h.y - 6.5)).toBeLessThanOrEqual(TURRET_RANGE);
    }
    expect(Math.hypot(decoy.x - 3.5, decoy.y - 6.5)).toBeLessThan(
      Math.hypot(attacker.x - 3.5, attacker.y - 6.5),
    );

    g.hostStep(STEP);

    expect(attacker.hp, 'the husk hitting the Core must be the one that gets shot').toBe(
      attacker.maxHp - TURRET_DMG,
    );
    expect(decoy.hp, 'the flank decoy must be ignored while the Core is in contact').toBe(
      decoy.maxHp,
    );
  });

  it('a queue is served from the FRONT — the deepest husk dies first', () => {
    // The reported bug in miniature. A column of husks funnelling into the Core,
    // arranged so depth order is the exact OPPOSITE of distance-to-the-gun: the
    // one about to hit the Core is the FURTHEST from the turret. Under "nearest
    // to me" the gun chews the tail of the queue while the head kills the Core.
    const g = board();
    const gun = g.idx(5, 8); // centre (5.5, 8.5); Core centre is (5.5, 5.5)
    expect(g.tryBuild(0, gun, 'turret')).toBe(true);

    const head = place(g, 1, 5.5, 6.5); // deepest  — gun distance 2.0
    const middle = place(g, 2, 5.5, 7.0); //          gun distance 1.5
    const tail = place(g, 3, 5.5, 7.5); // shallowest — gun distance 1.0

    for (const h of [head, middle, tail]) {
      expect(Math.hypot(h.x - 5.5, h.y - 8.5)).toBeLessThanOrEqual(TURRET_RANGE);
    }

    const order: number[] = [];
    for (let k = 0; k < 60 * 12; k++) {
      const alive = new Set(g.husks.map((h) => h.id));
      g.hostStep(STEP);
      for (const h of [head, middle, tail]) {
        if (alive.has(h.id) && !g.husks.some((x) => x.id === h.id)) order.push(h.id);
      }
      g.events.length = 0;
      if (g.husks.length === 0) break;
    }

    expect(g.husks.length, 'the whole queue should be cleared').toBe(0);
    expect(order, 'front of the queue first: deepest, then middle, then tail').toEqual([1, 2, 3]);
  });

  it('the gun re-aims as soon as something gets closer to the Core', () => {
    const g = board();
    expect(g.tryBuild(0, g.idx(5, 7), 'turret')).toBe(true);
    const far = place(g, 1, 5.5, 8.5); // sitting on the gun's doorstep
    g.hostStep(STEP);
    expect(far.hp, 'with nothing deeper in, the near husk is the right target').toBe(
      far.maxHp - TURRET_DMG,
    );

    // Now something breaks through and reaches the Core.
    const deep = place(g, 2, 5.5, 6.5);
    const farHpBefore = far.hp;
    for (let k = 0; k < 60; k++) {
      g.hostStep(STEP);
      g.events.length = 0;
    }
    expect(deep.hp, 'the deeper threat must now take the fire').toBeLessThan(deep.maxHp);
    expect(far.hp, 'and the shallow one must be dropped while it does').toBe(farHpBefore);
  });

  it('ties on depth go to the wounded husk, so the battery finishes one off', () => {
    const g = board();
    expect(g.tryBuild(0, g.idx(5, 4), 'turret')).toBe(true);
    // Same distance from the Core, mirrored either side of it.
    const healthy = place(g, 1, 4.5, 5.5);
    const wounded = place(g, 2, 6.5, 5.5);
    wounded.hp = 5;
    expect(Math.hypot(healthy.x - g.cx, healthy.y - g.cy)).toBeCloseTo(
      Math.hypot(wounded.x - g.cx, wounded.y - g.cy),
      10,
    );

    g.hostStep(STEP);
    expect(wounded.hp, 'the wounded one should be finished, not left at 5hp').toBeLessThanOrEqual(0);
    expect(healthy.hp).toBe(healthy.maxHp);
  });

  it('nothing out of range is shot, however urgent it is', () => {
    const g = board();
    // A gun in the far corner, and a husk on the Core it cannot possibly reach.
    expect(g.tryBuild(0, g.idx(1, 1), 'turret')).toBe(true);
    const attacker = place(g, 1, 5.5, 6.5);
    expect(Math.hypot(attacker.x - 1.5, attacker.y - 1.5)).toBeGreaterThan(TURRET_RANGE);
    const ammo = g.ammo;
    g.hostStep(STEP);
    expect(attacker.hp).toBe(attacker.maxHp);
    expect(g.ammo, 'and no ammo is wasted reaching for it').toBe(ammo);
  });
});
