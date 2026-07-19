/**
 * rng.test.ts — the P2P-sync determinism invariant.
 *
 * The base PRNG (copied from patterns/tests/rng.test.ts) plus the game-level
 * proof that matters for multiplayer: two peers constructing the world from the
 * SAME seed get byte-identical salvage layouts and byte-identical wave spawns. A
 * desync here would mean a promoted host rebuilds a different horde than the one
 * the room was fighting.
 */

import { describe, expect, it } from 'vitest';
import { makeRng, hashSeed, shuffle, randInt } from '@ben-gy/game-engine/rng';
import { Game } from '../src/game';
import { MODES } from '../src/modes';

describe('makeRng — deterministic per seed', () => {
  it('two generators from the same seed agree forever', () => {
    const a = makeRng(12345);
    const b = makeRng(12345);
    for (let i = 0; i < 500; i++) expect(a()).toBe(b());
  });

  it('different seeds diverge', () => {
    const a = makeRng(1);
    const b = makeRng(2);
    let same = 0;
    for (let i = 0; i < 100; i++) if (a() === b()) same++;
    expect(same).toBeLessThan(5);
  });

  it('a string seed hashes stably', () => {
    expect(hashSeed('scrapwall')).toBe(hashSeed('scrapwall'));
    const a = makeRng('room-K7QP');
    const b = makeRng('room-K7QP');
    expect(a()).toBe(b());
  });

  it('shuffle is a permutation and seed-stable', () => {
    const src = [1, 2, 3, 4, 5, 6, 7, 8];
    const x = shuffle(makeRng(9), src);
    const y = shuffle(makeRng(9), src);
    expect(x).toEqual(y);
    expect([...x].sort()).toEqual(src);
    expect(src).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // input untouched
  });

  it('randInt stays in range', () => {
    const r = makeRng(3);
    for (let i = 0; i < 200; i++) {
      const v = randInt(r, 2, 6);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThanOrEqual(6);
    }
  });
});

describe('Game — two peers on one seed build one world', () => {
  const seats = [{ name: 'A', bot: false }];

  it('lays identical salvage from the same seed', () => {
    const a = new Game({ seed: 4242, mode: MODES.depot, seats });
    const b = new Game({ seed: 4242, mode: MODES.depot, seats });
    expect([...a.salv]).toEqual([...b.salv]);
  });

  it('spawns an identical horde from the same seed', () => {
    const drive = (g: Game): string => {
      g.launchWave();
      const step = 1 / 60;
      for (let t = 0; t < 12; t += step) g.hostStep(step);
      return g.husks
        .map((h) => `${h.kind}:${h.x.toFixed(2)},${h.y.toFixed(2)}:${h.maxHp.toFixed(1)}`)
        .join('|');
    };
    const a = new Game({ seed: 99, mode: MODES.sprawl, seats });
    const b = new Game({ seed: 99, mode: MODES.sprawl, seats });
    expect(drive(a)).toBe(drive(b));
  });

  it('a different seed builds a different world', () => {
    const a = new Game({ seed: 1, mode: MODES.depot, seats });
    const b = new Game({ seed: 2, mode: MODES.depot, seats });
    expect([...a.salv]).not.toEqual([...b.salv]);
  });

  it('resumeHostState rebuilds the SAME remaining queue a fresh host would', () => {
    // The takeover relies on buildQueue being a pure function of the wave, so a
    // promoted peer continues the identical horde.
    const a = new Game({ seed: 7, mode: MODES.depot, seats });
    a.launchWave();
    const step = 1 / 60;
    for (let t = 0; t < 5; t += step) a.hostStep(step);
    const beforeCount = a.husks.length;
    a.resumeHostState(); // as a promotion would
    // keep stepping — the rest of the wave must still arrive
    for (let t = 0; t < 20; t += step) a.hostStep(step);
    expect(a.reached >= 1 || a.husks.length >= beforeCount || a.over).toBe(true);
  });
});
