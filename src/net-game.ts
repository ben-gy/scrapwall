/**
 * net-game.ts — one Session drives a run, solo or peer-to-peer.
 *
 * ONE path, deliberately (rhythm-relay shipped broken because its co-op shape got
 * bespoke netcode with host transfer never wired in). Solo here is simply "a
 * Session whose net is undefined": the same code, unable to drift from the
 * multiplayer one.
 *
 * ── authority ────────────────────────────────────────────────────────────────
 * Host-authoritative star. The HOST runs the whole world in `game.hostStep`:
 * the wave machine, husk spawns + flow-field pathing, turret fire, the shared
 * scrap/ammo ledger, the Core. It broadcasts a compact full snapshot at ~10Hz.
 *
 * A CLIENT sends only ACTIONS (`act`: build/repair/clear/harvest a cell, or launch
 * the wave) and renders the snapshot it receives. Because a client's Game holds
 * the whole fort (rebuilt from each snapshot), a promoted peer reconstructs
 * nothing — `setHost(true)` rebuilds only the deterministic spawn queue and
 * resumes stepping + broadcasting. That is the takeover, and it is a few lines.
 *
 * ── the clock ────────────────────────────────────────────────────────────────
 * The prep timer and the wave both advance in hostStep off wall time; the run's
 * END is state (`game.over` when the Core falls), not a clock, so a backgrounded
 * host cannot hang it — main.ts pumps off setInterval, not rAF alone.
 */

import { Game, type GEvent, type CellType, EMPTY, CORE, WALL, TURRET, SPIKES, type BuildKind } from './game';
import type { Net, PeerId } from './engine/net';

/** Host -> all: the whole fort + horde, small enough to send at 10Hz. */
interface Snap {
  ph: number; // phase code
  w: number; // wave
  pl: number; // prep left (x10)
  wt: number; // wave elapsed (x10)
  sc: number; // scrap
  am: number; // ammo
  ch: number; // core hp
  chm: number; // core max
  ov: number; // over 1/0
  rs?: string;
  /** structures: [idx, type, hp] */
  C: number[];
  /** salvage: [idx, amount] */
  V: number[];
  /** husks: [id, kind, x*10, y*10, hp] */
  M: number[];
  /** events since last snap, encoded — see encodeEv */
  E: number[][];
}

/** Client -> host: an action on a cell (or launch the wave). */
interface ActMsg {
  k: number; // 0 build, 1 repair, 2 clear, 3 harvest, 4 launch wave
  c?: number; // cell idx
  t?: number; // build kind: 0 wall, 1 turret, 2 spikes
}

const PHASES = ['prep', 'wave', 'over'] as const;
const BUILD_KINDS: BuildKind[] = ['wall', 'turret', 'spikes'];

export interface SessionSeat {
  id?: PeerId;
  bot: boolean;
}

export interface SessionCfg {
  game: Game;
  /** The local player's seat, or -1 for a pure spectator / headless. */
  me: number;
  seats: SessionSeat[];
  /** Absent = solo. */
  net?: Net;
  /** True if this peer starts the round as host. Ignored when solo. */
  host?: boolean;
  seed: number;
  onEnd: () => void;
  onHostChange?: (isHost: boolean) => void;
}

export interface Session {
  pump(nowMs: number): void;
  /** Local player: apply/queue an action. */
  act(kind: 'build' | 'repair' | 'clear' | 'harvest', cell: number, build?: BuildKind): void;
  /** Local player: launch the current wave now (skip remaining prep). */
  launch(): void;
  /** Events to play locally this frame (host + client both drain here). */
  drainFx(): GEvent[];
  setHost(isHost: boolean): void;
  onPeerLeave(id: PeerId): void;
  isHost(): boolean;
  destroy(): void;
}

const W_HZ = 10;
const STEP = 1 / 60;
const MAX_CATCHUP = 8;

export function createSession(cfg: SessionCfg): Session {
  const { game: g, me, seats, net } = cfg;
  let host = net ? !!cfg.host : true;

  const seatOf = new Map<PeerId, number>();
  for (const [i, s] of seats.entries()) if (s.id) seatOf.set(s.id, i);

  let started = 0;
  let last = 0;
  let acc = 0;
  let wAcc = 0;
  let ended = false;

  const fxBuf: GEvent[] = [];
  const netBuf: GEvent[] = [];

  // ── wire ──────────────────────────────────────────────────────────────────

  const sendSnap = net?.channel<Snap>('snap', (msg, from) => {
    if (host || from !== net.host()) return;
    applySnap(msg);
  });

  const sendAct = net?.channel<ActMsg>('act', (msg, from) => {
    if (!host) return;
    const seat = seatOf.get(from);
    if (seat == null) return;
    applyAct(seat, msg);
  });

  function applyAct(seat: number, msg: ActMsg): void {
    switch (msg.k) {
      case 0:
        if (msg.c != null && msg.t != null) g.tryBuild(seat, msg.c, BUILD_KINDS[msg.t] ?? 'wall');
        break;
      case 1:
        if (msg.c != null) g.repair(seat, msg.c);
        break;
      case 2:
        if (msg.c != null) g.clearCell(seat, msg.c);
        break;
      case 3:
        if (msg.c != null) g.harvest(seat, msg.c);
        break;
      case 4:
        g.launchWave();
        break;
    }
  }

  // ── snapshot ────────────────────────────────────────────────────────────────

  function buildSnap(): Snap {
    const C: number[] = [];
    const V: number[] = [];
    for (let i = 0; i < g.ct.length; i++) {
      const t = g.ct[i];
      if (t === WALL || t === TURRET || t === SPIKES) C.push(i, t, Math.round(g.chp[i]));
      if (g.salv[i] > 0) V.push(i, Math.round(g.salv[i]));
    }
    const M: number[] = [];
    for (const h of g.husks) M.push(h.id, h.kind, Math.round(h.x * 10), Math.round(h.y * 10), Math.round(h.hp));
    const E = netBuf.map(encodeEv);
    netBuf.length = 0;
    const snap: Snap = {
      ph: PHASES.indexOf(g.phase),
      w: g.wave,
      pl: Math.round(g.prepLeft * 10),
      wt: Math.round(g.waveT * 10),
      sc: Math.round(g.scrap),
      am: Math.round(g.ammo),
      ch: Math.round(g.coreHp),
      chm: g.coreMax,
      ov: g.over ? 1 : 0,
      C,
      V,
      M,
      E,
    };
    if (g.over) snap.rs = g.overReason;
    return snap;
  }

  function applySnap(s: Snap): void {
    // reset every non-core cell, then lay the structures down from the snapshot
    for (let i = 0; i < g.ct.length; i++) {
      if (g.ct[i] === CORE) continue;
      g.ct[i] = EMPTY;
      g.chp[i] = 0;
      g.cmax[i] = 0;
      g.ccd[i] = 0;
      g.salv[i] = 0;
    }
    for (let k = 0; k + 2 < s.C.length; k += 3) {
      const i = s.C[k];
      const t = s.C[k + 1] as CellType;
      g.ct[i] = t;
      g.chp[i] = s.C[k + 2];
      g.cmax[i] = t === WALL ? 55 : t === TURRET ? 45 : 46;
    }
    for (let k = 0; k + 1 < s.V.length; k += 2) g.salv[s.V[k]] = s.V[k + 1];

    g.phase = PHASES[s.ph] ?? 'prep';
    g.wave = s.w;
    g.reached = Math.max(g.reached, s.ph === 0 ? s.w : s.w - 1);
    g.prepLeft = s.pl / 10;
    g.waveT = s.wt / 10;
    g.scrap = s.sc;
    g.ammo = s.am;
    g.coreHp = s.ch;
    g.coreMax = s.chm;
    g.chp[g.coreIdx] = s.ch;
    g.cmax[g.coreIdx] = s.chm;
    g.over = s.ov === 1;
    if (s.rs) g.overReason = s.rs;

    // husks by id, so render smoothing (rx,ry) survives between snaps
    const byId = new Map(g.husks.map((h) => [h.id, h]));
    const next: typeof g.husks = [];
    for (let k = 0; k + 4 < s.M.length; k += 5) {
      const id = s.M[k];
      const x = s.M[k + 2] / 10;
      const y = s.M[k + 3] / 10;
      const existing = byId.get(id);
      if (existing) {
        existing.x = x;
        existing.y = y;
        existing.hp = s.M[k + 4];
        next.push(existing);
      } else {
        next.push({
          id,
          kind: s.M[k + 1] as 0 | 1 | 2,
          x,
          y,
          hp: s.M[k + 4],
          maxHp: s.M[k + 4],
          spd: 0,
          atk: 0,
          jx: 0,
          jy: 0,
          rx: x,
          ry: y,
        });
      }
    }
    g.husks = next;

    for (const e of s.E) {
      const ev = decodeEv(e);
      if (ev) fxBuf.push(ev);
    }

    if (g.over && !ended) {
      ended = true;
      cfg.onEnd();
    }
  }

  function moveEvents(): void {
    if (g.events.length === 0) return;
    for (const e of g.events) {
      fxBuf.push(e);
      netBuf.push(e);
    }
    if (netBuf.length > 80) netBuf.splice(0, netBuf.length - 80);
    g.events.length = 0;
  }

  return {
    pump(nowMs) {
      if (ended && host) return;
      if (!started) {
        started = nowMs;
        last = nowMs;
        if (host && net) broadcast();
        return;
      }
      const dt = Math.min(0.25, (nowMs - last) / 1000);
      last = nowMs;

      if (host) {
        acc += dt;
        let steps = 0;
        while (acc >= STEP && steps < MAX_CATCHUP) {
          g.hostStep(STEP);
          acc -= STEP;
          steps++;
        }
        if (steps >= MAX_CATCHUP) acc = 0;
        moveEvents();

        wAcc += dt;
        if (net && wAcc >= 1 / W_HZ) {
          wAcc = 0;
          broadcast();
        }
      }

      if (g.over && !ended) {
        ended = true;
        cfg.onEnd();
      }
    },

    act(kind, cell, build) {
      if (me < 0 || g.over) return;
      if (host) {
        if (kind === 'build') g.tryBuild(me, cell, build ?? 'wall');
        else if (kind === 'repair') g.repair(me, cell);
        else if (kind === 'clear') g.clearCell(me, cell);
        else g.harvest(me, cell);
        return;
      }
      const k = kind === 'build' ? 0 : kind === 'repair' ? 1 : kind === 'clear' ? 2 : 3;
      const msg: ActMsg = { k, c: cell };
      if (kind === 'build') msg.t = BUILD_KINDS.indexOf(build ?? 'wall');
      sendAct?.(msg);
    },

    launch() {
      if (g.over) return;
      if (host) g.launchWave();
      else sendAct?.({ k: 4 });
    },

    drainFx() {
      return fxBuf.splice(0, fxBuf.length);
    },

    setHost(isHost) {
      if (isHost === host) return;
      host = isHost;
      if (host) {
        // THE TAKEOVER. This peer already holds the whole fort from the last
        // snapshot; rebuild the deterministic spawn queue for the current wave and
        // start driving + broadcasting.
        g.resumeHostState();
        acc = 0;
        wAcc = 0;
        ended = g.over;
        broadcast();
      }
      cfg.onHostChange?.(host);
    },

    onPeerLeave(id) {
      const i = seatOf.get(id);
      if (i == null) return;
      g.dissolve(i);
    },

    isHost: () => host,

    destroy() {
      ended = true;
      (sendSnap as unknown as { off?: () => void })?.off?.();
      (sendAct as unknown as { off?: () => void })?.off?.();
    },
  };

  function broadcast(): void {
    if (!net || !host) return;
    sendSnap?.(buildSnap());
  }
}

// ── event (de)serialization for the snapshot ─────────────────────────────────
function encodeEv(e: GEvent): number[] {
  switch (e.k) {
    case 'fire':
      return [0, r1(e.x), r1(e.y), r1(e.tx), r1(e.ty)];
    case 'splat':
      return [1, r1(e.x), r1(e.y), e.kind];
    case 'crack':
      return [2, r1(e.x), r1(e.y)];
    case 'break':
      return [3, r1(e.x), r1(e.y)];
    case 'corehit':
      return [4, r1(e.x), r1(e.y), Math.round(e.dmg)];
    case 'harvest':
      return [5, r1(e.x), r1(e.y)];
    case 'place':
      return [6, r1(e.x), r1(e.y), e.t];
    case 'repair':
      return [7, r1(e.x), r1(e.y)];
    case 'wavestart':
      return [8, e.wave];
    case 'waveclear':
      return [9, e.wave];
    case 'lowammo':
      return [10];
    case 'over':
      return [11];
  }
}

function decodeEv(a: number[]): GEvent | null {
  switch (a[0]) {
    case 0:
      return { k: 'fire', x: a[1] / 10, y: a[2] / 10, tx: a[3] / 10, ty: a[4] / 10 };
    case 1:
      return { k: 'splat', x: a[1] / 10, y: a[2] / 10, kind: a[3] as 0 | 1 | 2 };
    case 2:
      return { k: 'crack', x: a[1] / 10, y: a[2] / 10 };
    case 3:
      return { k: 'break', x: a[1] / 10, y: a[2] / 10 };
    case 4:
      return { k: 'corehit', x: a[1] / 10, y: a[2] / 10, dmg: a[3] };
    case 5:
      return { k: 'harvest', x: a[1] / 10, y: a[2] / 10 };
    case 6:
      return { k: 'place', x: a[1] / 10, y: a[2] / 10, t: a[3] as CellType };
    case 7:
      return { k: 'repair', x: a[1] / 10, y: a[2] / 10 };
    case 8:
      return { k: 'wavestart', wave: a[1] };
    case 9:
      return { k: 'waveclear', wave: a[1] };
    case 10:
      return { k: 'lowammo' };
    case 11:
      return { k: 'over' };
    default:
      return null;
  }
}

function r1(v: number): number {
  return Math.round(v * 10);
}
