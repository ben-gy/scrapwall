/**
 * modes.ts — the three shapes a run of Scrapwall can take.
 *
 * A mode must change how the game PLAYS, not just a number. The spread here is
 * structural — the GRID and where the horde comes from:
 *
 *  - Outpost   small 9x9 fort, husks from only two edges (top & bottom). You can
 *              actually wall a corridor and funnel them, so it is a tidy puzzle of
 *              a defence. The gentlest ramp; the place to learn the verbs.
 *  - Depot     11x11 with husks from ALL FOUR edges — no back wall to lean on, the
 *              threat is everywhere at once, so it is about reading which side is
 *              weakest each wave and spending there. The standard game.
 *  - Sprawl    a big 13x13, four edges, a faster, heavier ramp and salvage that is
 *              plentiful but SPREAD OUT, so someone has to leave the core to gather
 *              it. Built for a party dividing the map, brutal solo.
 *
 * The numbers below are the levers the balance sim (tests/balance.test.ts)
 * referees. The mode a room plays is the HOST's, frozen into the round start
 * (see rematch.ts), so two peers can never disagree about the fort they defend.
 */

export type Edge = 'N' | 'S' | 'E' | 'W';

export interface Mode {
  id: string;
  name: string;
  /** One line, player-facing. */
  blurb: string;
  /** Grid columns and rows (odd, so there is a true centre for the Core). */
  cols: number;
  rows: number;
  /** Which edges the horde spawns from. */
  edges: Edge[];
  /** Seconds of the calm build phase before each wave. */
  prepSecs: number;
  /** Shared scrap and ammo the party opens with. */
  startScrap: number;
  startAmmo: number;
  /** Core hit points. */
  coreHp: number;
  /** Husks in wave 1. */
  waveBase: number;
  /** Extra husks per wave (linear part of the ramp). */
  waveGrow: number;
  /** Husk HP / speed multipliers — compound with the per-wave ramp. */
  hpMul: number;
  spdMul: number;
  /** How many salvage nodes seed onto the map, and how rich each is. */
  salvageNodes: number;
  salvagePer: number;
  /** Passive scrap delivered at the top of each prep phase. */
  income: number;
}

export const MODES: Record<string, Mode> = {
  outpost: {
    id: 'outpost',
    name: 'Outpost',
    blurb: 'A tidy 9×9 · husks from two edges · funnel them and hold — the gentle one.',
    cols: 9,
    rows: 9,
    edges: ['N', 'S'],
    prepSecs: 20,
    startScrap: 60,
    startAmmo: 30,
    coreHp: 170,
    waveBase: 5,
    waveGrow: 2.6,
    hpMul: 1.04,
    spdMul: 1,
    salvageNodes: 5,
    salvagePer: 55,
    income: 10,
  },
  depot: {
    id: 'depot',
    name: 'Depot',
    blurb: 'An 11×11 with husks from ALL sides — no back wall, read the weakest edge.',
    cols: 11,
    rows: 11,
    edges: ['N', 'S', 'E', 'W'],
    prepSecs: 19,
    startScrap: 75,
    startAmmo: 36,
    coreHp: 200,
    waveBase: 6,
    waveGrow: 3.1,
    hpMul: 1.06,
    spdMul: 1.03,
    salvageNodes: 7,
    salvagePer: 50,
    income: 12,
  },
  sprawl: {
    id: 'sprawl',
    name: 'Sprawl',
    blurb: 'A big 13×13 · four edges · a heavy ramp and scattered salvage — split up or die.',
    cols: 13,
    rows: 13,
    edges: ['N', 'S', 'E', 'W'],
    prepSecs: 22,
    startScrap: 90,
    startAmmo: 42,
    coreHp: 230,
    waveBase: 7,
    waveGrow: 3.0,
    hpMul: 1.09,
    spdMul: 1.06,
    salvageNodes: 11,
    salvagePer: 44,
    income: 14,
  },
};

export const DEFAULT_MODE = MODES.depot;

export const MODE_LIST: Mode[] = [MODES.outpost, MODES.depot, MODES.sprawl];

/** Room cap. Co-op has no seat-fairness problem, so this is purely about mesh
 *  size — a full WebRTC mesh is N^2 connections, and 4 keeps a phone cool. */
export const MAX_PLAYERS = 4;

/**
 * Resolve a mode id that arrived off the wire or out of storage.
 *
 * `MODES[id] || DEFAULT` is a trap: 'constructor' and 'toString' are truthy
 * inherited properties, so an untrusted id can hand the generator an object with
 * no `cols`. Object.hasOwn is the guard, and an unknown id falls back rather than
 * reaching the sim as undefined.
 */
export function modeOf(id: unknown): Mode {
  if (typeof id === 'string' && Object.hasOwn(MODES, id)) return MODES[id];
  return DEFAULT_MODE;
}
