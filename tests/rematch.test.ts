/**
 * rematch.test.ts — the multi-round protocol, driven with N simulated peers.
 *
 *  - COVERED: our round protocol. Votes, quorum, monotonic round numbers, the
 *    frozen roster, the host's mode travelling frozen, host handover mid-results.
 *  - NOT COVERED: the transport bug. A fake bus sits ABOVE Trystero's room cache,
 *    so it cannot contain that defect — net-lifecycle.test.ts and
 *    trystero-rejoin.test.ts own it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRounds, type RoundInfo } from '@ben-gy/game-engine/rematch';
import type { Net, PeerId } from '@ben-gy/game-engine/net';
import { MODES } from '../src/modes';

class Bus {
  peers = new Map<PeerId, Map<string, Set<(d: unknown, from: PeerId) => void>>>();
  /** onPeersChange subscribers, per peer. */
  watchers = new Map<PeerId, Set<(peers: PeerId[]) => void>>();
  join(id: PeerId): void {
    this.peers.set(id, new Map());
    this.watchers.set(id, new Set());
    this.announce();
  }
  part(id: PeerId): void {
    this.peers.delete(id);
    this.watchers.delete(id);
    this.announce();
  }
  /** Every join and leave is a roster change — rematch.ts times its start off these. */
  announce(): void {
    const roster = this.roster();
    for (const set of this.watchers.values()) for (const cb of [...set]) cb(roster);
  }
  watch(id: PeerId, cb: (peers: PeerId[]) => void): () => void {
    const set = this.watchers.get(id)!;
    set.add(cb);
    return () => set.delete(cb);
  }
  roster(): PeerId[] {
    return [...this.peers.keys()].sort();
  }
  send(from: PeerId, name: string, data: unknown, to?: PeerId | PeerId[]): void {
    const targets = to ? (Array.isArray(to) ? to : [to]) : this.roster().filter((p) => p !== from);
    for (const t of targets) {
      for (const h of this.peers.get(t)?.get(name) ?? []) h(data, from);
    }
  }
  on(id: PeerId, name: string, h: (d: unknown, from: PeerId) => void): () => void {
    const chans = this.peers.get(id)!;
    if (!chans.has(name)) chans.set(name, new Set());
    chans.get(name)!.add(h);
    return () => chans.get(name)!.delete(h);
  }
}

function mockNet(bus: Bus, selfId: PeerId): Net {
  bus.join(selfId);
  return {
    selfId,
    peers: () => bus.roster(),
    host: () => bus.roster()[0] ?? null,
    isHost: () => bus.roster()[0] === selfId,
    hostSettled: () => true,
    hostEpoch: () => 1,
    count: () => bus.roster().length,
    onPeersChange: (cb) => bus.watch(selfId, cb),
    takeover: () => {},
    netDiag: () => ({
      selfId,
      host: bus.roster()[0] ?? null,
      epoch: 1,
      settled: true,
      peers: bus.roster(),
      relaySockets: {},
      turn: false,
    }),
    channel<T>(name: string, onReceive: (d: T, from: PeerId) => void) {
      const off = bus.on(selfId, name, onReceive as (d: unknown, from: PeerId) => void);
      const send = ((data: T, to?: PeerId | PeerId[]) => bus.send(selfId, name, data, to)) as ((
        data: T,
        to?: PeerId | PeerId[],
      ) => void) & { off: () => void };
      send.off = off;
      return send;
    },
    ping: async () => 0,
    leave: async () => bus.part(selfId),
  };
}

const modeOf = (i: RoundInfo): string | undefined => (i.opts as { mode?: string } | undefined)?.mode;

interface Seat {
  id: PeerId;
  net: Net;
  rounds: ReturnType<typeof createRounds>;
  got: RoundInfo[];
}

/**
 * Walk past the roster-settle window.
 *
 * Engine v1.1.0 refuses to freeze a roster until it has held still for
 * ROSTER_SETTLE_MS (4s), and re-attempts the deferred start on a 1.5s poll.
 * That is the fix for players being "ejected" at round start: the host used to
 * freeze the roster from its own partial view of a still-forming mesh, so
 * whoever was one handshake behind was simply not in the round. Every table
 * here is built in a single tick, which looks exactly like a mesh mid-burst, so
 * we age the clock past the window (4s + the next poll tick) before voting.
 * From that point the protocol is synchronous again and the assertions below
 * read as they always did.
 */
const settle = (): void => {
  vi.advanceTimersByTime(6000);
};

/**
 * End the round on every seat, then wait out the FRESH settle window.
 *
 * `finish()` deliberately re-arms `lastRosterChangeAt`, so a rematch after a
 * long game cannot start instantly on whoever the host happens to be able to
 * see at that moment — the same partial-roster freeze, one round later.
 */
const finishRound = (ss: Seat[] = seats): void => {
  ss.forEach((s) => s.rounds.finish());
  settle();
};

function table(ids: PeerId[], opts: { minPlayers?: number; modes?: Record<string, string> } = {}): Seat[] {
  const bus = new Bus();
  const built = ids.map((id) => {
    const net = mockNet(bus, id);
    const seat: Seat = { id, net, rounds: null as never, got: [] };
    seat.rounds = createRounds({
      net,
      playerName: id.toUpperCase(),
      minPlayers: opts.minPlayers ?? 2,
      roundOpts: opts.modes ? () => ({ mode: opts.modes![id] }) : undefined,
      onRound: (info) => seat.got.push(info),
    });
    return seat;
  });
  settle();
  return built;
}

let seats: Seat[];
beforeEach(() => {
  // Fake timers everywhere: the start protocol is now time-aware, so a test
  // that cannot move the clock cannot start a round at all.
  vi.useFakeTimers();
  seats = [];
});
afterEach(() => {
  // Also discards the resync polls of every table this test built.
  vi.useRealTimers();
});

describe('createRounds — starting a round', () => {
  it('starts once every peer has voted, with one host and an identical seed', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    expect(seats.map((s) => s.got.length)).toEqual([1, 1]);
    expect(seats[0].got[0].seed).toBe(seats[1].got[0].seed);
    expect(seats.filter((s) => s.got[0].isHost)).toHaveLength(1);
    expect(seats[0].got[0].round).toBe(1);
  });

  it('freezes ONE roster into the start, so player indices match on every peer', () => {
    seats = table(['b', 'a', 'c'], { minPlayers: 3 });
    seats.forEach((s) => s.rounds.vote());
    const rosters = seats.map((s) => s.got[0].players.map((p) => `${p.id}:${p.name}`));
    expect(rosters[0]).toEqual(rosters[1]);
    expect(rosters[1]).toEqual(rosters[2]);
    expect(rosters[0]).toEqual(['a:A', 'b:B', 'c:C']);
  });

  it('waits below quorum', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 3 });
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    expect(seats.every((s) => s.got.length === 0)).toBe(true);
    seats[2].rounds.vote();
    expect(seats.every((s) => s.got.length === 1)).toBe(true);
  });

  it('fills a full 4-player table with one seed and one roster', () => {
    seats = table(['a', 'b', 'c', 'd'], { minPlayers: 4 });
    seats.forEach((s) => s.rounds.vote());
    expect(seats.map((s) => s.got.length)).toEqual([1, 1, 1, 1]);
    const seeds = new Set(seats.map((s) => s.got[0].seed));
    expect(seeds.size).toBe(1);
    for (const s of seats) expect(s.got[0].players.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(seats.filter((s) => s.got[0].isHost)).toHaveLength(1);
  });

  it('lets the host start early with go(), leaving a non-voter out of the roster', () => {
    seats = table(['a', 'b', 'c']);
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    expect(seats[0].got.length).toBe(0);
    seats[0].rounds.go();
    expect(seats[0].got[0].players.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('ignores a start from a peer that is not the host', () => {
    seats = table(['a', 'b']);
    seats[1].net.channel('rs', () => {})({
      round: 1,
      seed: 42,
      roster: [{ id: 'b', name: 'B' }],
    } as never);
    expect(seats.every((s) => s.got.length === 0)).toBe(true);
  });
});

describe("createRounds — the host's mode travels frozen", () => {
  it("gives every peer the HOST's mode, not the one their own menu is set to", () => {
    // The guest is sitting on Sprawl. It must play the host's Outpost, because a
    // mode decides the GRID SIZE and spawn edges: a guest laying a 13x13 world off
    // the same seed as the host's 9x9 is two peers in different forts.
    seats = table(['a', 'b'], { modes: { a: 'outpost', b: 'sprawl' } });
    seats.forEach((s) => s.rounds.vote());
    expect(seats[0].net.isHost()).toBe(true);
    for (const s of seats) expect(modeOf(s.got[0])).toBe('outpost');
    for (const s of seats) expect(MODES[modeOf(s.got[0])!].cols).toBe(9);
  });

  it('follows the mode when the HOST is the one on Sprawl', () => {
    seats = table(['a', 'b'], { modes: { a: 'sprawl', b: 'outpost' } });
    seats.forEach((s) => s.rounds.vote());
    for (const s of seats) expect(modeOf(s.got[0])).toBe('sprawl');
    expect(MODES.sprawl.cols).toBe(13);
  });

  it('carries the mode into every rematch, not just the first round', () => {
    seats = table(['a', 'b'], { modes: { a: 'depot', b: 'sprawl' } });
    seats.forEach((s) => s.rounds.vote());
    finishRound();
    seats.forEach((s) => s.rounds.vote());
    for (const s of seats) expect(modeOf(s.got[1])).toBe('depot');
  });

  it("gossips the host's mode into every peer's state, before any round starts", () => {
    seats = table(['a', 'b'], { modes: { a: 'sprawl', b: 'outpost' } });
    for (const s of seats) expect(s.rounds.state().hostOpts).toEqual({ mode: 'sprawl' });
  });

  it('hands back an undefined opts when a game does not use them', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    expect(seats[0].got[0].opts).toBeUndefined();
    expect(seats[1].got[0].opts).toBeUndefined();
  });
});

describe('createRounds — the rematch (the bug this all exists for)', () => {
  it('runs a second round in the SAME room, both peers together, one host', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    finishRound();
    seats.forEach((s) => s.rounds.vote());
    expect(seats.map((s) => s.got.length)).toEqual([2, 2]);
    expect(seats[0].got[1].round).toBe(2);
    expect(seats[0].got[1].seed).toBe(seats[1].got[1].seed);
    expect(seats.filter((s) => s.got[1].isHost)).toHaveLength(1);
    expect(seats[0].got[1].seed).not.toBe(seats[0].got[0].seed);
  });

  it('lets a peer that LEFT and rejoined mid-match ready up again', () => {
    const bus = new Bus();
    const mk = (id: PeerId) => {
      const net = mockNet(bus, id);
      const seat: Seat = { id, net, rounds: null as never, got: [] };
      seat.rounds = createRounds({
        net,
        playerName: id.toUpperCase(),
        minPlayers: 2,
        onRound: (info) => seat.got.push(info),
      });
      return seat;
    };
    const a = mk('a');
    let b = mk('b');
    settle();
    a.rounds.vote();
    b.rounds.vote();
    expect(a.got[0].round).toBe(1);
    b.rounds.destroy();
    void b.net.leave();
    a.rounds.finish();
    b = mk('b');
    // The leave and the rejoin are both roster changes, so the host re-arms the
    // settle window; the rematch is allowed only once the room is quiet again.
    settle();
    a.rounds.vote();
    b.rounds.vote();
    expect(b.got.length, 'the rejoiner reached a new round').toBe(1);
    expect(a.got.length).toBe(2);
    expect(a.got[1].round).toBe(2);
    expect(b.got[0].round).toBe(2);
    expect(a.got[1].seed).toBe(b.got[0].seed);
    expect([a, b].filter((s) => s.got[s.got.length - 1].isHost)).toHaveLength(1);
  });

  it("keeps both peers in each other's roster across the rematch", () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    finishRound();
    seats.forEach((s) => s.rounds.vote());
    for (const s of seats) {
      expect(s.got[1].players.map((p) => p.id)).toEqual(['a', 'b']);
      expect(s.net.count()).toBe(2);
    }
  });

  it('ignores a stale or duplicated start rather than restarting a live round', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    const seed = seats[0].got[0].seed;
    seats[0].net.channel('rs', () => {})({
      round: 1,
      seed: 999,
      roster: [{ id: 'a', name: 'A' }],
    } as never);
    expect(seats[1].got.length).toBe(1);
    expect(seats[1].got[0].seed).toBe(seed);
  });

  it('does not start a rematch while a round is still being played', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    seats.forEach((s) => s.rounds.vote());
    expect(seats[0].got.length).toBe(1);
  });

  it('drops the vote of a peer who leaves, and still rematches the rest', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    finishRound();
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    expect(seats[0].got.length).toBe(1);
    seats[2].net.leave();
    settle(); // a departure is a roster change; wait it out before freezing again
    seats[0].rounds.vote();
    expect(seats[0].got[1].players.map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('createRounds — host handover', () => {
  it('promotes the next peer and still starts when the host leaves at results', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    finishRound();
    expect(seats[0].net.isHost()).toBe(true);
    seats[0].net.leave();
    expect(seats[1].net.isHost()).toBe(true);
    settle(); // the promoted host waits out the same window before it freezes a roster
    seats[1].rounds.vote();
    seats[2].rounds.vote();
    expect(seats[1].got.length).toBe(2);
    expect(seats[1].got[1].players.map((p) => p.id)).toEqual(['b', 'c']);
    expect(seats[1].got[1].isHost).toBe(true);
    expect(seats[2].got[1].isHost).toBe(false);
    expect(seats[1].got[1].seed).toBe(seats[2].got[1].seed);
  });
});

describe('createRounds — never deadlock waiting for a vote that never comes', () => {
  it('starts anyway once the grace countdown expires, without the silent player', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    finishRound();
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    expect(seats[0].got.length).toBe(1);
    const s = seats[0].rounds.state();
    expect(s.startsInMs).not.toBeNull();
    expect(s.startsInMs!).toBeGreaterThan(0);
    vi.advanceTimersByTime(8100);
    expect(seats[0].got.length).toBe(2);
    expect(seats[0].got[1].players.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('goes immediately when everyone votes, with no countdown', () => {
    seats = table(['a', 'b'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    finishRound();
    seats.forEach((s) => s.rounds.vote());
    expect(seats[0].got.length).toBe(2);
    expect(seats[0].rounds.state().startsInMs).toBeNull();
  });

  it('lets the host force the rematch immediately with go()', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    finishRound();
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    seats[0].rounds.go();
    expect(seats[0].got.length).toBe(2);
  });

  it('cancels the countdown if quorum is lost again', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    finishRound();
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    expect(seats[0].rounds.state().startsInMs!).toBeGreaterThan(0);
    seats[1].rounds.unvote();
    expect(seats[0].rounds.state().startsInMs).toBeNull();
    vi.advanceTimersByTime(8100);
    expect(seats[0].got.length).toBe(1);
  });

  it('a peer who readies up mid-countdown still lands in the roster', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    finishRound();
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    seats[2].rounds.vote();
    expect(seats[2].got.length).toBe(2);
    expect(seats[2].got[1].players.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('createRounds — teardown', () => {
  it('stops answering once destroyed', () => {
    seats = table(['a', 'b']);
    seats[1].rounds.destroy();
    seats.forEach((s) => s.rounds.vote());
    expect(seats[1].got.length).toBe(0);
  });
});
