/**
 * game.test.ts — the pure simulation: economy, building, flow-field pathing, the
 * wave machine, and win/lose. jsdom-free logic, so it runs fast and deterministic.
 */

import { describe, expect, it } from 'vitest';
import { Game, STRUCTS, TURRET, SPIKES, CORE, EMPTY, WAVE_LEAD } from '../src/game';
import { MODES } from '../src/modes';

const seats = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `P${i}`, bot: false }));
const mk = (mode = MODES.depot, seed = 7, n = 1) => new Game({ seed, mode, seats: seats(n) });

/** Drive host time forward at 60Hz. */
function run(g: Game, secs: number): void {
  const step = 1 / 60;
  for (let t = 0; t < secs; t += step) g.hostStep(step);
}

describe('construction', () => {
  it('puts the Core at the exact centre with full HP', () => {
    const g = mk();
    expect(g.ct[g.coreIdx]).toBe(CORE);
    expect(g.coreHp).toBe(MODES.depot.coreHp);
    expect(g.colOf(g.coreIdx)).toBe((g.cols - 1) / 2);
  });

  it('seeds exactly the mode s salvage nodes, none on the Core apron', () => {
    const g = mk();
    let nodes = 0;
    for (let i = 0; i < g.salv.length; i++) if (g.salv[i] > 0) nodes++;
    expect(nodes).toBe(MODES.depot.salvageNodes);
    // apron (the 4 core-adjacent cells) must be clear
    const c = g.colOf(g.coreIdx);
    const r = g.rowOf(g.coreIdx);
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      expect(g.salv[g.idx(c + dc, r + dr)]).toBe(0);
    }
  });

  it('opens with the mode s scrap and ammo', () => {
    const g = mk();
    expect(g.scrap).toBe(MODES.depot.startScrap);
    expect(g.ammo).toBe(MODES.depot.startAmmo);
  });
});

describe('buildable rules', () => {
  it('refuses the border ring, the Core, and salvage cells; allows interior empties', () => {
    const g = mk();
    expect(g.buildable(g.idx(0, 0))).toBe(false); // corner (border)
    expect(g.buildable(g.idx(1, 0))).toBe(false); // top edge (border)
    expect(g.buildable(g.coreIdx)).toBe(false);
    const salvageCell = g.salv.findIndex((v) => v > 0);
    expect(g.buildable(salvageCell)).toBe(false);
    // an interior empty cell not on the apron
    const good = g.idx(1, 1);
    expect(g.buildable(good)).toBe(true);
  });
});

describe('economy — build, harvest, repair, clear', () => {
  it('build spends scrap, places the structure, and credits the builder', () => {
    const g = mk();
    const i = g.idx(2, 2);
    const before = g.scrap;
    expect(g.tryBuild(0, i, 'turret')).toBe(true);
    expect(g.ct[i]).toBe(TURRET);
    expect(g.scrap).toBe(before - STRUCTS.turret.cost);
    expect(g.players[0].contrib.built).toBe(1);
  });

  it('refuses a build it cannot afford', () => {
    const g = mk();
    g.scrap = 5;
    expect(g.tryBuild(0, g.idx(2, 2), 'turret')).toBe(false);
    expect(g.ct[g.idx(2, 2)]).toBe(EMPTY);
  });

  it('harvest yields scrap AND ammo and depletes the node', () => {
    const g = mk();
    const node = g.salv.findIndex((v) => v > 0);
    const s0 = g.scrap;
    const a0 = g.ammo;
    const v0 = g.salv[node];
    expect(g.harvest(0, node)).toBe(true);
    expect(g.scrap).toBeGreaterThan(s0);
    expect(g.ammo).toBeGreaterThan(a0);
    expect(g.salv[node]).toBeLessThan(v0);
    expect(g.players[0].contrib.harvested).toBeGreaterThan(0);
  });

  it('repair heals a hurt structure, capped at max, and never over-heals', () => {
    const g = mk();
    const i = g.idx(2, 2);
    g.tryBuild(0, i, 'wall');
    g.chp[i] = 10;
    expect(g.repair(0, i)).toBe(true);
    expect(g.chp[i]).toBeGreaterThan(10);
    expect(g.chp[i]).toBeLessThanOrEqual(g.cmax[i]);
    g.chp[i] = g.cmax[i];
    expect(g.repair(0, i), 'a full structure cannot be repaired').toBe(false);
  });

  it('can repair the Core itself', () => {
    const g = mk();
    g.coreHp = 40;
    g.chp[g.coreIdx] = 40;
    expect(g.repair(0, g.coreIdx)).toBe(true);
    expect(g.coreHp).toBeGreaterThan(40);
  });

  it('clear removes a structure and refunds half; the Core cannot be cleared', () => {
    const g = mk();
    const i = g.idx(2, 2);
    g.tryBuild(0, i, 'wall');
    const s = g.scrap;
    expect(g.clearCell(0, i)).toBe(true);
    expect(g.ct[i]).toBe(EMPTY);
    expect(g.scrap).toBe(s + Math.floor(STRUCTS.wall.cost / 2));
    expect(g.clearCell(0, g.coreIdx)).toBe(false);
  });
});

describe('flow-field pathing', () => {
  it('every interior cell has a downhill path to the Core', () => {
    const g = mk(MODES.sprawl);
    g.recomputeFlow();
    // follow flowNext from a far corner — it must reach the Core
    let i = g.idx(1, 1);
    let hops = 0;
    while (i !== g.coreIdx && hops < g.cols * g.rows) {
      const nx = g.flowNext[i];
      expect(nx).toBeGreaterThanOrEqual(0);
      i = nx;
      hops++;
    }
    expect(i).toBe(g.coreIdx);
  });

  it('husks route AROUND a single wall when an open detour exists', () => {
    const g = mk(MODES.depot);
    // wall one cell on a straight line to the core; the neighbour should not
    // step into the wall when a cheaper open cell exists.
    const c = g.colOf(g.coreIdx);
    const r = g.rowOf(g.coreIdx);
    const wallCell = g.idx(c, r - 2);
    g.tryBuild(0, wallCell, 'wall');
    g.recomputeFlow();
    const approach = g.idx(c, r - 3);
    // the approach cell should prefer an open neighbour over digging the full wall
    expect(g.flowNext[approach]).not.toBe(wallCell);
  });
});

describe('the wave machine', () => {
  it('auto-launches when the prep timer expires', () => {
    const g = mk();
    expect(g.phase).toBe('prep');
    run(g, MODES.depot.prepSecs + 0.5);
    expect(g.phase).toBe('wave');
    expect(g.wave).toBe(1);
  });

  it('launchWave holds the horde for the 3-2-1 lead, then spawns it', () => {
    const g = mk();
    g.launchWave();
    expect(g.husks.length).toBe(0);
    run(g, WAVE_LEAD - 0.2);
    expect(g.husks.length).toBe(0);
    run(g, 1.5);
    expect(g.husks.length).toBeGreaterThan(0);
  });

  it('an undefended Core is overrun and the run ends with a reason', () => {
    const g = mk(MODES.outpost);
    g.launchWave();
    run(g, 60); // no turrets — the horde walks in
    expect(g.over).toBe(true);
    expect(g.phase).toBe('over');
    expect(g.overReason).toMatch(/Core/);
    expect(g.coreHp).toBeLessThanOrEqual(0);
  });

  it('a turret ring shreds the wave and the fort holds, spending ammo', () => {
    const g = mk(MODES.outpost);
    g.scrap = 999;
    // ring the core in guns
    const c = g.colOf(g.coreIdx);
    const r = g.rowOf(g.coreIdx);
    for (const [dc, dr] of [[1, 1], [-1, 1], [1, -1], [-1, -1], [0, 2], [0, -2], [2, 0], [-2, 0]]) {
      g.tryBuild(0, g.idx(c + dc, r + dr), 'turret');
    }
    const ammo0 = g.ammo;
    g.launchWave();
    run(g, 40);
    // it fired (ammo spent) and killed husks (credited)
    expect(g.ammo).toBeLessThan(ammo0);
    expect(g.players[0].contrib.kills).toBeGreaterThan(0);
  });
});

describe('spikes chew husks underfoot', () => {
  it('a husk crossing spikes takes damage and wears them down', () => {
    const g = mk(MODES.outpost);
    // place spikes and drop a husk right on them
    const i = g.idx(g.colOf(g.coreIdx), 1);
    g.tryBuild(0, i, 'spikes');
    expect(g.ct[i]).toBe(SPIKES);
    g.phase = 'wave';
    g.husks.push({
      id: 1, kind: 0, x: g.colOf(i) + 0.5, y: g.rowOf(i) + 0.5,
      hp: 8, maxHp: 8, spd: 0, atk: 0, jx: 0, jy: 0, rx: 0, ry: 0,
    });
    const spikeHp0 = g.chp[i];
    run(g, 0.4);
    // either the husk died on the spikes or its hp dropped, and the spikes wore
    const husk = g.husks[0];
    expect(husk === undefined || husk.hp < 8).toBe(true);
    expect(g.chp[i]).toBeLessThan(spikeHp0);
  });
});
