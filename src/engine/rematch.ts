/**
 * rematch.ts — multi-round sessions inside ONE living P2P room.
 *
 * The problem this exists to solve: the obvious way to write "Play again" is to
 * leave the room and rejoin it. That is a trap. Trystero memoizes joinRoom on
 * appId+roomId while room.leave() defers its teardown ~99ms, so a same-tick
 * rejoin aliases the dying room: no relay subscription, no announce loop, an
 * empty peer map. Every peer then elects ITSELF host and sits alone in a room
 * with the right code. It is deterministic, it is permanent, and it looks
 * exactly like "we're both the host and can't see each other".
 *
 * So: never leave. Keep one Net for the room's whole life and version the
 * rounds inside it. This module owns that protocol.
 *
 * COPY THIS FILE into src/engine/ alongside net.ts.
 */

import type { Net, PeerId, Unsubscribe } from './net';

export interface RoundPlayer {
  id: PeerId;
  name: string;
}

export interface RoundInfo<O = unknown> {
  /** 1-based. Increments per rematch; never repeats. */
  round: number;
  /** Shared RNG seed — identical on every peer (see rng.ts). */
  seed: number;
  /** Frozen, ordered roster. Index N is player N on EVERY peer. */
  players: RoundPlayer[];
  /** True if this peer is the authoritative host for this round. */
  isHost: boolean;
  /**
   * The host's game settings for this round. Travels WITH the start for the same
   * reason the roster does: a setting each peer reads from its own UI is a
   * setting two peers can disagree about.
   */
  opts: O;
}

export type RoundPhase = 'waiting' | 'playing';

export interface RoundsState {
  round: number;
  phase: RoundPhase;
  votes: RoundPlayer[];
  present: RoundPlayer[];
  voted: boolean;
  isHost: boolean;
  canStart: boolean;
  hostOpts: unknown;
  startsInMs: number | null;
}

export interface RoundsConfig {
  net: Net;
  playerName: string;
  minPlayers?: number;
  autoStart?: boolean;
  graceMs?: number;
  roundOpts?: () => unknown;
  onRound: (info: RoundInfo) => void;
  onChange?: (state: RoundsState) => void;
}

export interface Rounds {
  vote(): void;
  unvote(): void;
  go(): void;
  finish(): void;
  state(): RoundsState;
  destroy(): void;
}

interface VoteMsg {
  round: number;
  name: string;
  in: boolean;
  cur?: number;
  opts?: unknown;
}

interface StartMsg {
  round: number;
  seed: number;
  roster: RoundPlayer[];
  opts?: unknown;
}

export function createRounds(config: RoundsConfig): Rounds {
  const { net, onRound } = config;
  const minPlayers = config.minPlayers ?? 2;
  const autoStart = config.autoStart ?? true;

  const graceMs = config.graceMs ?? 8000;
  const now = (): number => Date.now();

  let round = 0;
  let phase: RoundPhase = 'waiting';
  const votes = new Map<PeerId, { name: string; in: boolean }>();
  const names = new Map<PeerId, string>([[net.selfId, config.playerName]]);
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let graceEndsAt = 0;
  const opts = new Map<PeerId, unknown>();

  const next = (): number => round + 1;

  function player(id: PeerId): RoundPlayer {
    return { id, name: names.get(id) ?? '…' };
  }

  function present(): RoundPlayer[] {
    return net.peers().map(player);
  }

  function voters(): RoundPlayer[] {
    const here = new Set(net.peers());
    return net
      .peers()
      .filter((id) => here.has(id) && votes.get(id)?.in)
      .map(player);
  }

  function state(): RoundsState {
    return {
      round,
      phase,
      votes: voters(),
      present: present(),
      voted: !!votes.get(net.selfId)?.in,
      isHost: net.isHost(),
      canStart: net.isHost() && voters().length >= minPlayers,
      hostOpts: net.isHost() ? config.roundOpts?.() : (opts.get(net.host() ?? '') ?? null),
      startsInMs: graceEndsAt ? Math.max(0, graceEndsAt - now()) : null,
    };
  }

  const changed = (): void => config.onChange?.(state());

  // ── wire ──────────────────────────────────────────────────────────────────
  // 'rv' vote, 'rs' host start, 'rq' resync request. All <= 12 bytes.

  const sendVote = net.channel<VoteMsg>('rv', (msg, from) => {
    names.set(from, msg.name);
    if (msg.opts !== undefined) opts.set(from, msg.opts);

    if (from === net.host() && phase !== 'playing' && msg.cur != null && msg.cur > round) {
      const mine = votes.get(net.selfId)?.in ?? false;
      round = msg.cur;
      votes.clear();
      if (mine) {
        votes.set(net.selfId, { name: config.playerName, in: true });
        sendVote({ round: next(), name: config.playerName, in: true, cur: round, opts: config.roundOpts?.() });
      }
      changed();
    }

    if (msg.round !== next()) return;
    votes.set(from, { name: msg.name, in: msg.in });
    changed();
    maybeAutoStart();
  });

  const sendStart = net.channel<StartMsg>('rs', (msg, from) => {
    if (from !== net.host()) return;
    begin(msg);
  });

  const sendResync = net.channel<null>('rq', (_d, from) => {
    const mine = votes.get(net.selfId);
    sendVote(
      { round: next(), name: config.playerName, in: mine?.in ?? false, cur: round, opts: config.roundOpts?.() },
      from,
    );
  });

  function begin(msg: StartMsg): void {
    if (msg.round <= round) return;
    clearGrace();
    round = msg.round;
    phase = 'playing';
    votes.clear();
    for (const p of msg.roster) names.set(p.id, p.name);
    changed();
    onRound({
      round: msg.round,
      seed: msg.seed,
      players: msg.roster,
      isHost: net.isHost(),
      opts: msg.opts,
    });
  }

  function go(): void {
    if (!net.isHost() || phase === 'playing') return;
    const roster = voters();
    if (roster.length < minPlayers) return;
    const seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
    const msg: StartMsg = { round: next(), seed, roster, opts: config.roundOpts?.() };
    sendStart(msg);
    begin(msg);
  }

  function maybeAutoStart(): void {
    if (!autoStart || !net.isHost() || phase === 'playing') return;
    const yes = voters();
    if (yes.length < minPlayers) return clearGrace();
    if (yes.length === present().length) {
      clearGrace();
      return go();
    }

    if (graceTimer) return;
    graceEndsAt = now() + graceMs;
    graceTimer = setTimeout(() => {
      graceTimer = undefined;
      graceEndsAt = 0;
      if (net.isHost() && phase !== 'playing' && voters().length >= minPlayers) go();
    }, graceMs);
    changed();
  }

  function clearGrace(): void {
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = undefined;
    graceEndsAt = 0;
  }

  const poll = setInterval(() => {
    if (phase !== 'playing') {
      sendResync(null);
      changed();
      maybeAutoStart();
    }
  }, 1500);

  votes.set(net.selfId, { name: config.playerName, in: false });
  sendVote({ round: next(), name: config.playerName, in: false, cur: round, opts: config.roundOpts?.() });
  sendResync(null);

  return {
    vote() {
      if (phase === 'playing') return;
      votes.set(net.selfId, { name: config.playerName, in: true });
      sendVote({ round: next(), name: config.playerName, in: true, cur: round, opts: config.roundOpts?.() });
      changed();
      maybeAutoStart();
    },

    unvote() {
      votes.set(net.selfId, { name: config.playerName, in: false });
      sendVote({ round: next(), name: config.playerName, in: false, cur: round, opts: config.roundOpts?.() });
      changed();
    },

    go,

    finish() {
      if (phase !== 'playing') return;
      phase = 'waiting';
      votes.clear();
      clearGrace();
      changed();
    },

    state,

    destroy() {
      clearInterval(poll);
      clearGrace();
      (sendVote as unknown as { off: Unsubscribe }).off();
      (sendStart as unknown as { off: Unsubscribe }).off();
      (sendResync as unknown as { off: Unsubscribe }).off();
    },
  };
}
