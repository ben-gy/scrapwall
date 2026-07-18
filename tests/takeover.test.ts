/**
 * takeover.test.ts — CONTRACT GATE: the host leaving must not freeze the run.
 *
 * The automated half of the gate (the other half is closing the host tab in the
 * two-tab smoke test). It exists because rhythm-relay shipped with host transfer
 * impossible-by-construction — createNet called with no onHostChange — and every
 * test was green.
 *
 * Scrapwall is a host-authoritative STAR: a client renders snapshots and does not
 * run the horde sim, so an orphaned client that is NEVER promoted genuinely would
 * not advance. That is fine, because net.ts promotes EXACTLY ONE survivor the
 * instant the host leaves (host-election.test.ts). This proves the other half: the
 * promoted peer takes over, keeps the sim running, and can still reach game-over.
 *
 * The design that makes it testable: createSession takes an optional net, so it
 * runs with no network, no relay, no browser. Promotion is setHost(true) — exactly
 * what net.ts's onHostChange calls.
 */

import { describe, expect, it, vi } from 'vitest';
import { createSession, type SessionSeat } from '../src/net-game';
import { Game, type Seat, WAVE_LEAD } from '../src/game';
import { MODES } from '../src/modes';
import type { Net, PeerId } from '../src/engine/net';

function silentNet(selfId: PeerId, host: PeerId | null, sent?: Record<string, unknown[]>): Net {
  return {
    selfId,
    peers: () => [selfId],
    host: () => host,
    isHost: () => host === selfId,
    hostSettled: () => host !== null,
    count: () => 1,
    channel: <T>(name: string) => {
      const send = ((d: T) => {
        if (sent) (sent[name] ??= []).push(d);
      }) as ((d: T, to?: PeerId | PeerId[]) => void) & { off: () => void };
      send.off = () => {};
      return send;
    },
    ping: async () => 0,
    leave: async () => {},
  };
}

const seats = (n: number): Seat[] => Array.from({ length: n }, (_, i) => ({ name: `P${i}`, bot: false }));
const sseats = (n: number): SessionSeat[] => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, bot: false }));

function mk(isHost: boolean, party = 1) {
  const g = new Game({ seed: 5, mode: MODES.outpost, seats: seats(party) });
  const onEnd = vi.fn();
  const onHostChange = vi.fn();
  const sent: Record<string, unknown[]> = {};
  const s = createSession({
    game: g,
    me: 0,
    seats: sseats(party),
    net: silentNet('p0', isHost ? 'p0' : 'other', sent),
    host: isHost,
    seed: 5,
    onEnd,
    onHostChange,
  });
  return { g, s, onEnd, onHostChange, sent };
}

function pump(s: { pump: (n: number) => void }, from: number, secs: number, stepMs = 16): number {
  let t = from;
  const end = from + secs * 1000;
  while (t < end) {
    s.pump(t);
    t += stepMs;
  }
  s.pump(t);
  return t;
}

describe('before promotion, a client does not drive the world', () => {
  it('does not advance the prep clock or spawn a horde — that is the host job', () => {
    const { g, s } = mk(false);
    pump(s, 1000, 5);
    expect(g.prepLeft).toBe(MODES.outpost.prepSecs); // untouched
    expect(g.husks).toHaveLength(0);
    expect(g.over).toBe(false);
  });

  it('never narrates the world', () => {
    const { s, sent } = mk(false);
    pump(s, 1000, 3);
    expect(sent.snap ?? [], 'a guest must not broadcast snapshots').toHaveLength(0);
  });
});

describe('after promotion, the survivor takes over and the run can finish', () => {
  it('setHost(true) makes it host', () => {
    const { s, onHostChange } = mk(false);
    expect(s.isHost()).toBe(false);
    s.setHost(true);
    expect(s.isHost()).toBe(true);
    expect(onHostChange).toHaveBeenCalledWith(true);
  });

  it('starts driving the sim the moment it is promoted', () => {
    const { g, s } = mk(false);
    pump(s, 1000, 2);
    expect(g.prepLeft).toBe(MODES.outpost.prepSecs); // inert as a client
    s.setHost(true);
    pump(s, 3000, 3);
    expect(g.prepLeft).toBeLessThan(MODES.outpost.prepSecs); // now advancing
  });

  it('starts BROADCASTING the world — the duty that actually transfers', () => {
    const { s, sent } = mk(false);
    pump(s, 1000, 3);
    expect(sent.snap ?? []).toHaveLength(0);
    s.setHost(true);
    pump(s, 4000, 2);
    expect((sent.snap ?? []).length, 'a promoted host must broadcast').toBeGreaterThan(0);
  });

  it('the run can still REACH game-over after the host vanishes', () => {
    // The point is that the board is NOT frozen. We launch the wave and let the
    // undefended Core be overrun in bounded time — a promoted host must drive to
    // `over`.
    const { g, s, onEnd } = mk(false);
    s.setHost(true);
    g.launchWave(); // skip the prep wait
    pump(s, 4000, WAVE_LEAD + 40);
    expect(g.over).toBe(true);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('demotion is honoured too — two hosts must never both narrate', () => {
    const { s, onHostChange } = mk(true);
    expect(s.isHost()).toBe(true);
    s.setHost(false);
    expect(s.isHost()).toBe(false);
    expect(onHostChange).toHaveBeenCalledWith(false);
  });

  it('setHost is idempotent', () => {
    const { s, onHostChange } = mk(false);
    s.setHost(true);
    s.setHost(true);
    s.setHost(true);
    expect(onHostChange).toHaveBeenCalledTimes(1);
  });
});

describe('a peer leaving degrades, never freezes', () => {
  it("marks the leaver's seat as left", () => {
    const { g, s } = mk(true, 2);
    s.onPeerLeave('p1');
    expect(g.players[1].left).toBe(true);
  });

  it('ignores a leave from someone who was never seated', () => {
    const { g, s } = mk(true, 2);
    const before = g.players.map((p) => p.left);
    s.onPeerLeave('a-stranger');
    expect(g.players.map((p) => p.left)).toEqual(before);
  });

  it('a two-player run continues after one leaves, and the host can finish it', () => {
    const { g, s, onEnd } = mk(true, 2);
    s.onPeerLeave('p1');
    expect(g.players[0].left).toBe(false);
    g.launchWave();
    pump(s, 0, WAVE_LEAD + 40);
    expect(g.over).toBe(true);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});

describe('solo is the same code path', () => {
  it('runs with no net at all, advances the wave machine, and reaches an ending', () => {
    const g = new Game({ seed: 9, mode: MODES.outpost, seats: seats(1) });
    const onEnd = vi.fn();
    const s = createSession({ game: g, me: 0, seats: sseats(1), seed: 9, onEnd });
    expect(s.isHost()).toBe(true);
    s.launch(); // start the wave
    pump(s, 0, WAVE_LEAD + 40);
    expect(g.over).toBe(true);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('the local player can act — building spends scrap and places a structure', () => {
    const g = new Game({ seed: 9, mode: MODES.outpost, seats: seats(1) });
    const s = createSession({ game: g, me: 0, seats: sseats(1), seed: 9, onEnd: vi.fn() });
    const cell = g.idx(2, 2);
    const before = g.scrap;
    s.act('build', cell, 'wall');
    expect(g.ct[cell]).not.toBe(0);
    expect(g.scrap).toBeLessThan(before);
  });
});
