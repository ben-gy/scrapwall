/**
 * game.ts — the Scrapwall simulation. Pure logic, no DOM, no network.
 *
 * A grid with a Core at the centre. Between waves you spend shared scrap to raise
 * walls, guns and spikes and harvest salvage nodes; then the horde pours in from
 * the edges and pathfinds toward the Core along the path of LEAST RESISTANCE —
 * routing around strong walls and digging through the weakest barrier if that is
 * the shortest way in (a weighted Dijkstra flow-field, recomputed when the fort
 * changes). Turrets auto-fire and burn shared ammo; spikes chew the crowd.
 *
 * The HOST owns all of this via hostStep(); clients render snapshots (net-game.ts).
 * Everything random (salvage layout, spawns, kinds) comes from the shared seed, so
 * the host is reproducible and a promoted peer inherits an identical world.
 */

import { makeRng, randInt, type Rng } from '@ben-gy/game-engine/rng';
import type { Mode } from './modes';
import { tuning } from './tuning';

// ── cell types ────────────────────────────────────────────────────────────────
export const EMPTY = 0;
export const CORE = 1;
export const WALL = 2;
export const TURRET = 3;
export const SPIKES = 4;
export type CellType = 0 | 1 | 2 | 3 | 4;

// ── buildable structure catalogue ─────────────────────────────────────────────
export interface StructDef {
  type: CellType;
  cost: number;
  hp: number;
  /** Flow-field penalty a husk pays to pass this cell at full HP (scales w/ hp). */
  pen: number;
}
export const STRUCTS: Record<'wall' | 'turret' | 'spikes', StructDef> = {
  wall: { type: WALL, cost: 10, hp: 55, pen: 6 },
  turret: { type: TURRET, cost: 28, hp: 45, pen: 9 },
  spikes: { type: SPIKES, cost: 14, hp: 46, pen: 0 },
};
export type BuildKind = keyof typeof STRUCTS;

// Turret behaviour.
export const TURRET_RANGE = 3.2; // cells
export const TURRET_CD = 0.5; // seconds between shots
export const TURRET_DMG = 8;

// Spikes: damage per second to a husk standing on them; wear per husk-second.
export const SPIKE_DPS = 34;
export const SPIKE_WEAR = 10;

// Economy.
export const REPAIR_COST = 6;
export const REPAIR_HP = 26;
export const HARVEST_CHUNK = 5; // salvage removed per harvest tap
export const HARVEST_AMMO = 0.9; // ammo per unit of scrap harvested

// The 3-2-1 lead before husks actually appear, in seconds of wave time.
export const WAVE_LEAD = 2.1;

// ── husks ─────────────────────────────────────────────────────────────────────
export type HuskKind = 0 | 1 | 2; // shambler, runner, brute
interface HuskDef {
  hp: number;
  spd: number; // cells / second
  coreDmg: number;
  wallDmg: number;
  atkCd: number;
  r: number; // render radius, cells
}
export const HUSKS: HuskDef[] = [
  { hp: 20, spd: 1.5, coreDmg: 8, wallDmg: 9, atkCd: 0.6, r: 0.3 }, // shambler
  { hp: 11, spd: 2.8, coreDmg: 5, wallDmg: 5, atkCd: 0.5, r: 0.24 }, // runner
  { hp: 64, spd: 1.05, coreDmg: 15, wallDmg: 26, atkCd: 0.85, r: 0.42 }, // brute
];

export interface Husk {
  id: number;
  kind: HuskKind;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  spd: number;
  atk: number; // attack cooldown timer
  jx: number; // cluster jitter so husks don't perfectly overlap
  jy: number;
  rx: number; // render-smoothed position (clients)
  ry: number;
}

// ── contribution, for the co-op results screen ────────────────────────────────
export interface Contrib {
  built: number;
  harvested: number;
  repaired: number;
  kills: number;
}
export interface Seat {
  name: string;
  bot: boolean;
}
export interface Player {
  i: number;
  name: string;
  left: boolean;
  contrib: Contrib;
}

export type Phase = 'prep' | 'wave' | 'over';

// ── events (drained each frame for juice + net) ───────────────────────────────
export type GEvent =
  | { k: 'fire'; x: number; y: number; tx: number; ty: number }
  | { k: 'splat'; x: number; y: number; kind: HuskKind }
  | { k: 'crack'; x: number; y: number }
  | { k: 'break'; x: number; y: number }
  | { k: 'corehit'; x: number; y: number; dmg: number }
  | { k: 'harvest'; x: number; y: number }
  | { k: 'place'; x: number; y: number; t: CellType }
  | { k: 'repair'; x: number; y: number }
  | { k: 'wavestart'; wave: number }
  | { k: 'waveclear'; wave: number }
  | { k: 'lowammo' }
  | { k: 'over' };

export interface GameCfg {
  seed: number;
  mode: Mode;
  seats: Seat[];
}

export class Game {
  readonly mode: Mode;
  readonly cols: number;
  readonly rows: number;
  readonly coreIdx: number;
  readonly cx: number; // core centre, world
  readonly cy: number;

  // grid state (idx = r*cols + c)
  ct: Uint8Array; // cell type
  chp: Float32Array; // structure hp (0 if none)
  cmax: Float32Array; // structure max hp
  cown: Int8Array; // seat that placed it (-1 none)
  ccd: Float32Array; // turret cooldown
  salv: Float32Array; // remaining salvage on this cell (0 if none)
  salvBase: Float32Array; // a node's full amount, for renewable regrow

  flowNext: Int32Array; // toward-core neighbour, or -1
  private flowDirty = true;

  husks: Husk[] = [];
  scrap: number;
  ammo: number;
  coreHp: number;
  coreMax: number;

  phase: Phase = 'prep';
  wave = 0; // wave being fought, or last cleared
  reached = 0; // waves fully cleared
  prepLeft: number;
  waveT = 0; // elapsed within the current wave
  over = false;
  overReason = '';

  players: Player[];
  events: GEvent[] = [];

  private nextId = 1;
  private queue: { at: number; kind: HuskKind; hp: number; spd: number; ex: number; ey: number; jx: number; jy: number }[] = [];
  private lowAmmoWarned = false;

  constructor(cfg: GameCfg) {
    this.mode = cfg.mode;
    this.cols = cfg.mode.cols;
    this.rows = cfg.mode.rows;
    const n = this.cols * this.rows;
    this.ct = new Uint8Array(n);
    this.chp = new Float32Array(n);
    this.cmax = new Float32Array(n);
    this.cown = new Int8Array(n).fill(-1);
    this.ccd = new Float32Array(n);
    this.salv = new Float32Array(n);
    this.salvBase = new Float32Array(n);
    this.flowNext = new Int32Array(n).fill(-1);

    const cc = (this.cols - 1) / 2;
    const cr = (this.rows - 1) / 2;
    this.coreIdx = cr * this.cols + cc;
    this.cx = cc + 0.5;
    this.cy = cr + 0.5;
    this.ct[this.coreIdx] = CORE;
    this.coreHp = cfg.mode.coreHp;
    this.coreMax = cfg.mode.coreHp;
    this.chp[this.coreIdx] = this.coreHp;
    this.cmax[this.coreIdx] = this.coreMax;

    this.scrap = cfg.mode.startScrap;
    this.ammo = cfg.mode.startAmmo;
    this.prepLeft = cfg.mode.prepSecs;

    this.players = cfg.seats.map((s, i) => ({
      i,
      name: s.name,
      left: false,
      contrib: { built: 0, harvested: 0, repaired: 0, kills: 0 },
    }));

    this.seedSalvage(cfg.seed);
    this.recomputeFlow();
  }

  // ── indexing helpers ────────────────────────────────────────────────────────
  idx(c: number, r: number): number {
    return r * this.cols + c;
  }
  colOf(i: number): number {
    return i % this.cols;
  }
  rowOf(i: number): number {
    return (i / this.cols) | 0;
  }
  inBounds(c: number, r: number): boolean {
    return c >= 0 && r >= 0 && c < this.cols && r < this.rows;
  }
  cellAt(x: number, y: number): number {
    let c = Math.floor(x);
    let r = Math.floor(y);
    if (c < 0) c = 0;
    else if (c >= this.cols) c = this.cols - 1;
    if (r < 0) r = 0;
    else if (r >= this.rows) r = this.rows - 1;
    return r * this.cols + c;
  }
  /** Interior, non-core, non-salvage cells only — the border ring is a spawn/path
   *  lane you cannot wall off, so the horde always has a way in to funnel. */
  buildable(i: number): boolean {
    const c = this.colOf(i);
    const r = this.rowOf(i);
    if (c <= 0 || r <= 0 || c >= this.cols - 1 || r >= this.rows - 1) return false;
    return this.ct[i] === EMPTY && this.salv[i] <= 0;
  }
  isBlocking(i: number): boolean {
    const t = this.ct[i];
    return t === WALL || t === TURRET || t === CORE;
  }

  // ── salvage layout (deterministic) ──────────────────────────────────────────
  private seedSalvage(seed: number): void {
    const r = makeRng(seed ^ 0x9e3779b9);
    let placed = 0;
    let guard = 0;
    const want = this.mode.salvageNodes;
    while (placed < want && guard++ < 4000) {
      const c = randInt(r, 1, this.cols - 2);
      const rr = randInt(r, 1, this.rows - 2);
      const i = rr * this.cols + c;
      if (this.ct[i] !== EMPTY || this.salv[i] > 0) continue;
      // Keep salvage off the four core-adjacent cells so the Core has clear apron.
      if (Math.abs(c - this.colOf(this.coreIdx)) + Math.abs(rr - this.rowOf(this.coreIdx)) <= 1) continue;
      this.salv[i] = this.mode.salvagePer;
      this.salvBase[i] = this.mode.salvagePer;
      placed++;
    }
  }

  // ── flow-field: weighted Dijkstra from the Core outward ─────────────────────
  private entryCost(i: number): number {
    const t = this.ct[i];
    if (t === WALL || t === TURRET) {
      const def = t === WALL ? STRUCTS.wall : STRUCTS.turret;
      const frac = this.cmax[i] > 0 ? this.chp[i] / this.cmax[i] : 0;
      return 1 + def.pen * frac;
    }
    return 1; // empty / spikes / salvage / core
  }

  recomputeFlow(): void {
    const n = this.cols * this.rows;
    const dist = new Float32Array(n).fill(Infinity);
    // Simple array-based Dijkstra; n is tiny (<=169) so a linear scan is fine.
    const done = new Uint8Array(n);
    dist[this.coreIdx] = 0;
    this.flowNext.fill(-1);
    for (let k = 0; k < n; k++) {
      // pick the unfinished cell with the smallest dist
      let u = -1;
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        if (!done[i] && dist[i] < best) {
          best = dist[i];
          u = i;
        }
      }
      if (u < 0) break;
      done[u] = 1;
      const uc = u % this.cols;
      const ur = (u / this.cols) | 0;
      const nb = [
        [uc + 1, ur],
        [uc - 1, ur],
        [uc, ur + 1],
        [uc, ur - 1],
      ];
      for (const [nc, nr] of nb) {
        if (!this.inBounds(nc, nr)) continue;
        const v = nr * this.cols + nc;
        if (done[v]) continue;
        // Node-weighted Dijkstra: dist[v] is the cost for a husk STANDING at v to
        // reach the core, and the weight it pays is the cost of occupying v itself
        // (entryCost(v)) — so a wall cell is expensive to be at, and a husk routes
        // around it unless digging the (weakest) wall is genuinely shorter. Paying
        // entryCost(u) instead would make a wall cheap to stand on and lure husks
        // straight into it — the bug this replaced.
        const nd = dist[u] + this.entryCost(v);
        if (nd < dist[v]) dist[v] = nd;
      }
    }
    // next[cell] = the neighbour with the smallest dist (downhill toward core).
    for (let i = 0; i < n; i++) {
      if (i === this.coreIdx) continue;
      const c = i % this.cols;
      const r = (i / this.cols) | 0;
      let bestN = -1;
      let bestD = dist[i];
      const nb = [
        [c + 1, r],
        [c - 1, r],
        [c, r + 1],
        [c, r - 1],
      ];
      for (const [nc, nr] of nb) {
        if (!this.inBounds(nc, nr)) continue;
        const v = nr * this.cols + nc;
        if (dist[v] < bestD) {
          bestD = dist[v];
          bestN = v;
        }
      }
      this.flowNext[i] = bestN;
    }
    this.flowDirty = false;
  }

  // ── actions (host applies; validated) ───────────────────────────────────────
  tryBuild(seat: number, i: number, kind: BuildKind): boolean {
    if (this.over) return false;
    if (!this.buildable(i)) return false;
    const def = STRUCTS[kind];
    if (this.scrap < def.cost) return false;
    this.scrap -= def.cost;
    this.ct[i] = def.type;
    this.chp[i] = def.hp;
    this.cmax[i] = def.hp;
    this.cown[i] = seat;
    this.ccd[i] = 0;
    this.flowDirty = true;
    this.credit(seat, 'built', 1);
    this.events.push({ k: 'place', x: this.colOf(i) + 0.5, y: this.rowOf(i) + 0.5, t: def.type });
    return true;
  }

  repair(seat: number, i: number): boolean {
    if (this.over) return false;
    const t = this.ct[i];
    if (t !== WALL && t !== TURRET && t !== SPIKES && t !== CORE) return false;
    if (this.chp[i] >= this.cmax[i]) return false;
    if (this.scrap < REPAIR_COST) return false;
    this.scrap -= REPAIR_COST;
    const before = this.chp[i];
    this.chp[i] = Math.min(this.cmax[i], this.chp[i] + REPAIR_HP);
    if (t === CORE) this.coreHp = this.chp[i];
    if (t === WALL || t === TURRET) this.flowDirty = true;
    this.credit(seat, 'repaired', this.chp[i] - before);
    this.events.push({ k: 'repair', x: this.colOf(i) + 0.5, y: this.rowOf(i) + 0.5 });
    return true;
  }

  clearCell(seat: number, i: number): boolean {
    if (this.over) return false;
    const t = this.ct[i];
    if (t !== WALL && t !== TURRET && t !== SPIKES) return false;
    const def = t === WALL ? STRUCTS.wall : t === TURRET ? STRUCTS.turret : STRUCTS.spikes;
    this.ct[i] = EMPTY;
    this.chp[i] = 0;
    this.cmax[i] = 0;
    this.cown[i] = -1;
    this.ccd[i] = 0;
    this.scrap += Math.floor(def.cost / 2);
    this.flowDirty = true;
    void seat;
    return true;
  }

  harvest(seat: number, i: number): boolean {
    if (this.over) return false;
    if (this.salv[i] <= 0) return false;
    const amt = Math.min(HARVEST_CHUNK, this.salv[i]);
    this.salv[i] -= amt;
    this.scrap += amt;
    this.ammo += amt * HARVEST_AMMO;
    this.credit(seat, 'harvested', amt);
    this.events.push({ k: 'harvest', x: this.colOf(i) + 0.5, y: this.rowOf(i) + 0.5 });
    return true;
  }

  private credit(seat: number, key: keyof Contrib, amount: number): void {
    const p = this.players[seat];
    if (p) p.contrib[key] += amount;
  }

  /** A seat's owner left — do not delete their fort, just stop crediting them. */
  dissolve(seat: number): void {
    const p = this.players[seat];
    if (p) p.left = true;
  }

  // ── launching / clearing waves ──────────────────────────────────────────────
  launchWave(): void {
    if (this.phase !== 'prep' || this.over) return;
    this.wave += 1;
    this.phase = 'wave';
    this.waveT = 0;
    this.lowAmmoWarned = false;
    this.buildQueue(this.wave);
    this.events.push({ k: 'wavestart', wave: this.wave });
  }

  /** Defenders still in the run — scales the horde and the scrap income, so a
   *  bigger party faces a bigger horde but scavenges more to match it (and a peer
   *  leaving mid-run shrinks the horde rather than dooming the survivors). */
  activeSeats(): number {
    return Math.max(1, this.livingSeats());
  }

  private buildQueue(wave: number): void {
    this.queue = [];
    const r = makeRng((this.mode.cols * 131 + this.mode.rows) ^ (wave * 0x9e37) ^ 0xabcd1234);
    const partyMul = 1 + 0.32 * (this.activeSeats() - 1);
    const count = Math.round((this.mode.waveBase + this.mode.waveGrow * (wave - 1)) * partyMul);
    const hpRamp = Math.pow(tuning().RAMP_EXP, wave - 1);
    const spdRamp = 1 + 0.02 * (wave - 1);
    // spawn window widens a little with bigger waves but stays tense
    const window = 8 + Math.min(10, wave * 0.6);
    for (let k = 0; k < count; k++) {
      const kind = this.rollKind(wave, r);
      const def = HUSKS[kind];
      const hp = def.hp * this.mode.hpMul * hpRamp;
      const spd = def.spd * this.mode.spdMul * spdRamp;
      const [ex, ey] = this.spawnPoint(r);
      this.queue.push({
        at: WAVE_LEAD + (k / Math.max(1, count)) * window,
        kind,
        hp,
        spd,
        ex,
        ey,
        jx: (r() - 0.5) * 0.5,
        jy: (r() - 0.5) * 0.5,
      });
    }
  }

  private rollKind(wave: number, r: Rng): HuskKind {
    const runnerP = wave >= 4 ? Math.min(0.4, 0.1 + 0.04 * (wave - 4)) : 0;
    const bruteP = wave >= 6 ? Math.min(0.3, 0.05 + 0.03 * (wave - 6)) : 0;
    const v = r();
    if (v < bruteP) return 2;
    if (v < bruteP + runnerP) return 1;
    return 0;
  }

  private spawnPoint(r: Rng): [number, number] {
    const edge = this.mode.edges[randInt(r, 0, this.mode.edges.length - 1)];
    // Pick a cell along the chosen edge; husks spawn just inside it.
    if (edge === 'N') return [randInt(r, 0, this.cols - 1) + 0.5, 0.5];
    if (edge === 'S') return [randInt(r, 0, this.cols - 1) + 0.5, this.rows - 0.5];
    if (edge === 'W') return [0.5, randInt(r, 0, this.rows - 1) + 0.5];
    return [this.cols - 0.5, randInt(r, 0, this.rows - 1) + 0.5];
  }

  // ── the host tick ───────────────────────────────────────────────────────────
  hostStep(dt: number): void {
    if (this.over) return;
    if (this.phase === 'prep') {
      this.prepLeft -= dt;
      if (this.prepLeft <= 0) {
        this.prepLeft = 0;
        this.launchWave();
      }
      return;
    }
    // wave
    this.waveT += dt;
    this.spawnDue();
    if (this.flowDirty) this.recomputeFlow();
    this.stepTurrets(dt);
    this.stepHusks(dt);

    if (this.coreHp <= 0) {
      this.coreHp = 0;
      this.over = true;
      this.phase = 'over';
      this.overReason = `the Core was overrun on wave ${this.wave}`;
      this.events.push({ k: 'over' });
      return;
    }
    if (this.queue.length === 0 && this.husks.length === 0 && this.waveT > WAVE_LEAD) {
      // wave held
      this.reached = this.wave;
      this.phase = 'prep';
      this.prepLeft = this.mode.prepSecs;
      // Income scales with the party — more scavengers, more salvage between waves
      // — so a bigger fort can keep pace with the bigger horde it draws.
      this.scrap += this.mode.income * this.activeSeats();
      this.ammo += this.mode.income * this.activeSeats() * 0.5;
      this.regrowSalvage();
      this.events.push({ k: 'waveclear', wave: this.wave });
    }
  }

  private spawnDue(): void {
    for (let k = this.queue.length - 1; k >= 0; k--) {
      const q = this.queue[k];
      if (this.waveT >= q.at) {
        this.husks.push({
          id: this.nextId++,
          kind: q.kind,
          x: q.ex,
          y: q.ey,
          hp: q.hp,
          maxHp: q.hp,
          spd: q.spd,
          atk: 0,
          jx: q.jx,
          jy: q.jy,
          rx: q.ex,
          ry: q.ey,
        });
        this.queue.splice(k, 1);
      }
    }
  }

  private stepTurrets(dt: number): void {
    const n = this.cols * this.rows;
    let firedDry = false;
    for (let i = 0; i < n; i++) {
      if (this.ct[i] !== TURRET) continue;
      if (this.ccd[i] > 0) this.ccd[i] -= dt;
      if (this.ccd[i] > 0) continue;
      if (this.ammo <= 0) {
        firedDry = true;
        continue;
      }
      const tx = this.colOf(i) + 0.5;
      const ty = this.rowOf(i) + 0.5;
      // nearest husk in range
      let target: Husk | null = null;
      let bestD = TURRET_RANGE * TURRET_RANGE;
      for (const h of this.husks) {
        const d = (h.x - tx) * (h.x - tx) + (h.y - ty) * (h.y - ty);
        if (d < bestD) {
          bestD = d;
          target = h;
        }
      }
      if (!target) continue;
      this.ammo -= 1;
      this.ccd[i] = TURRET_CD;
      this.events.push({ k: 'fire', x: tx, y: ty, tx: target.x, ty: target.y });
      target.hp -= TURRET_DMG;
      if (target.hp <= 0) this.killHusk(target, this.cown[i]);
    }
    if (firedDry && this.ammo <= 0 && !this.lowAmmoWarned && this.husks.length > 0) {
      this.lowAmmoWarned = true;
      this.events.push({ k: 'lowammo' });
    }
  }

  private killHusk(h: Husk, bySeat: number): void {
    const k = this.husks.indexOf(h);
    if (k < 0) return;
    this.husks.splice(k, 1);
    if (bySeat >= 0) this.credit(bySeat, 'kills', 1);
    this.events.push({ k: 'splat', x: h.x, y: h.y, kind: h.kind });
  }

  private stepHusks(dt: number): void {
    for (let k = this.husks.length - 1; k >= 0; k--) {
      const h = this.husks[k];
      if (h.atk > 0) h.atk -= dt;
      const def = HUSKS[h.kind];
      const cc = this.cellAt(h.x, h.y);

      // spikes underfoot
      if (this.ct[cc] === SPIKES) {
        h.hp -= SPIKE_DPS * dt;
        this.chp[cc] -= SPIKE_WEAR * dt;
        if (this.chp[cc] <= 0) {
          this.ct[cc] = EMPTY;
          this.cmax[cc] = 0;
          this.flowDirty = true;
        }
        if (h.hp <= 0) {
          this.killHusk(h, -1);
          continue;
        }
      }

      const nx = this.flowNext[cc];
      if (nx < 0) {
        // No downhill neighbour (shouldn't happen off the core); idle.
        continue;
      }
      if (this.isBlocking(nx)) {
        // Attack the barrier in the way.
        if (h.atk <= 0) {
          h.atk = def.atkCd;
          if (this.ct[nx] === CORE) {
            this.coreHp -= def.coreDmg;
            this.chp[this.coreIdx] = this.coreHp;
            this.events.push({ k: 'corehit', x: this.cx, y: this.cy, dmg: def.coreDmg });
          } else {
            this.chp[nx] -= def.wallDmg;
            const bx = this.colOf(nx) + 0.5;
            const by = this.rowOf(nx) + 0.5;
            if (this.chp[nx] <= 0) {
              this.ct[nx] = EMPTY;
              this.cmax[nx] = 0;
              this.cown[nx] = -1;
              this.ccd[nx] = 0;
              this.flowDirty = true;
              this.events.push({ k: 'break', x: bx, y: by });
            } else {
              this.events.push({ k: 'crack', x: bx, y: by });
            }
          }
        }
        // press against the barrier without entering it
        const tx = this.colOf(nx) + 0.5;
        const ty = this.rowOf(nx) + 0.5;
        const ccx = this.colOf(cc) + 0.5;
        const ccy = this.rowOf(cc) + 0.5;
        const px = ccx + (tx - ccx) * 0.32 + h.jx * 0.3;
        const py = ccy + (ty - ccy) * 0.32 + h.jy * 0.3;
        h.x += (px - h.x) * Math.min(1, dt * 6);
        h.y += (py - h.y) * Math.min(1, dt * 6);
        continue;
      }

      // move toward the centre of the next cell
      const tx = this.colOf(nx) + 0.5 + h.jx;
      const ty = this.rowOf(nx) + 0.5 + h.jy;
      const dx = tx - h.x;
      const dy = ty - h.y;
      const d = Math.hypot(dx, dy) || 1;
      const move = Math.min(d, h.spd * dt); // h.spd is already mode/ramp-scaled
      h.x += (dx / d) * move;
      h.y += (dy / d) * move;
    }
  }

  private regrowSalvage(): void {
    // Salvage is RENEWABLE: each prep the nodes refill toward full, so the economy
    // is throughput-limited (how fast you can harvest in the time you have) rather
    // than total-limited. That is what makes a bigger party matter — more hands
    // drain the refilled nodes faster and keep the guns fed — and it is what lets
    // the fort keep pace with a rising wave for a while before it can't.
    for (let i = 0; i < this.salvBase.length; i++) {
      if (this.salvBase[i] > 0) this.salv[i] = this.salvBase[i];
    }
  }

  // ── snapshot helpers for a promoted client ──────────────────────────────────
  /**
   * THE TAKEOVER, sim side. A promoted peer already holds the whole world from
   * the last snapshot — cells, husks, resources, wave, phase — but NOT the
   * remaining spawn queue (clients never built one). Rebuild it deterministically
   * from the wave number (buildQueue is a pure function of it) and drop the husks
   * that have already been spawned, so the wave continues to its real end instead
   * of ending early with a half-empty horde.
   */
  resumeHostState(): void {
    if (this.phase === 'wave') {
      this.buildQueue(this.wave);
      this.queue = this.queue.filter((q) => q.at > this.waveT);
    }
    let maxId = 0;
    for (const h of this.husks) maxId = Math.max(maxId, h.id);
    this.nextId = maxId + 1;
    this.flowDirty = true;
  }

  /** Number of seated players still present. */
  livingSeats(): number {
    return this.players.filter((p) => !p.left).length;
  }
}
