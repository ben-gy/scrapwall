# Game Plan: Scrapwall

## Overview
- **Name:** Scrapwall
- **Repo name:** scrapwall
- **Tagline:** Build a fort from scrap, then hold it — a co-op siege where the horde digs toward whatever you left weakest.
- **Genre (directory category):** strategy

## Core Loop
A Core sits at the centre of a grid. In a short **prep lull** you spend shared **scrap** to raise
walls, plant auto-turrets and lay spikes, and harvest glowing salvage nodes for more scrap + ammo.
Then the **wave** comes: husks pour in from the map edges and pathfind toward the Core, but they
follow the path of *least resistance* — routing around strong walls and digging through the weakest
barrier if that's the shortest way in. Turrets auto-fire (burning shared ammo), spikes chew the
crowd, and you scramble to repair breaches and keep harvesting mid-fight. Clear the wave, prep again,
survive the next one. Every wave is bigger; salvage gets scarcer. **Over-fortifying starves you:**
more turrets drain the shared ammo pool faster than you can harvest it, so the fort is a budget, not
a wish-list. The run ends when the Core falls. Score = waves held.

## Controls
- **Desktop:** click a toolbar tool (Wall / Gun / Spikes / Fix / Clear), click a cell to apply;
  click-drag to paint a wall line; click a glowing salvage node to harvest; number keys 1–5 pick
  tools; Space/Enter to launch the wave early; P to pause.
- **Mobile:** the same, by tap. Tap a tool, tap a cell. **Drag to paint a wall run.** Tap salvage
  nodes to harvest. A big **LAUNCH WAVE** button ends prep early. No D-pad, no avatar — it's a
  board game, so it's tap/drag (patterns/drag.ts thresholds).

## Multiplayer
- **Mode:** live P2P.
- **Shape:** **co-op** (players vs the game). Why this and not versus/shared-world: a base defence is
  cooperative by its nature — one shared fort, one shared scrap+ammo economy, one Core whose fall is
  everyone's fall. The fun is *dividing the labour* under a ticking prep clock (who walls, who
  harvests, who mans repairs) and scrambling together when a wall breaks. Versus would be forced and
  would need two bases; shared-world has no stakes. Co-op also has **no seat-fairness problem** (the
  base is shared, not seated) and a dropped peer just makes the run **harder**, never broken.
- **If co-op:** the opponent is the **wave curve** — husk count, HP and speed ramp every wave, and
  salvage thins, so the fort has to out-improve the horde. Players share **one fate** (Core falls =
  run over) — there is no per-player elimination to trivialise. What stops one strong player soloing
  it: the shared prep clock caps how much *one* pair of hands can build+harvest before the wave, and
  the ammo economy means a solo builder can't also keep the guns fed — a bigger party literally has
  more hands per prep second. Tension without anyone being able to lose *to* anyone: the Core's HP
  bar and the breach you didn't repair in time.
- **If live P2P:** players 2–4; topology **host-authoritative star**. The host owns the whole world
  — grid/structures, the flow-field, husk sim, turret fire, the shared scrap+ammo ledger, the Core,
  the wave machine — and broadcasts a compact snapshot at ~10Hz (`snap`). Clients send **actions**
  (`act`: build/repair/clear/harvest at a cell) and a `ready` to launch the wave; the host validates
  against the shared purse and applies. Clients render snapshots (husks interpolated) and show a
  transient "pending" ghost on a tapped cell for instant feel. Channels: `snap`, `act`, plus the
  engine's `rv`/`rs`/`rq` (rematch) and `__h`/`ping` (net). Late joiner: drops in at the next prep
  (its snapshot rebuilds the whole base). **Host leaves:** net.ts promotes exactly one survivor and
  fires `onHostChange`; the promoted peer already holds the full world from the last snapshot, so
  `session.setHost(true)` just resumes the sim + broadcast (one-line takeover, `takeover.test.ts`).
- **End of round → rematch (MANDATORY):** uses `patterns/rematch.ts` (`createRounds`) and never
  touches the room — the Net + mesh stay up; a rematch is a vote + a new round number + a fresh seed
  and the frozen roster. Waiting player sees "N ready · starting in Ns" with a visible grace
  countdown; a decliner/closed tab is dropped and the round starts without them (grace, no deadlock);
  if the **host** leaves at results the promoted peer runs the rematch inheriting no tally. Persists
  across rounds: a **match best** (deepest wave held). "Back to lobby" (does not leave the room) and
  "Menu" both offered.

## Juice Plan
- Procedural SFX: turret *chak* on fire, husk *splat* on death, wall *crack* on hit + *crunch* on
  break, Core *thud* + alarm when breached, scrap *ding* on harvest, place *thunk*, wave-start
  klaxon, wave-cleared chime, low-ammo warble.
- Particles: turret muzzle flash + tracer line, husk death burst (green ichor), wall-break debris,
  harvest sparkle, Core-hit shockwave.
- Screen shake on Core hits and wall breaks (scaled, respects `prefers-reduced-motion`). Red vignette
  pulse as Core HP drops. Score/`+scrap` pops. Tweened structure placement (scale-in) and Core-hp bar.
- Colour-blind-safe: husks by SHAPE as well as colour (round shambler, spiky runner, big square
  brute); structures by icon.

## Style Direction
**Vibe:** brutalist-industrial, rust & ember against a cold night.
**Palette:** night `#0b1220`, steel `#243244`, amber build-light `#f0b429`, hot turret `#ff8c42`,
husk ichor `#6ee7b7` (teal-green, distinct from amber for red/green-blind), core `#56b4e9`,
breach-red `#ff6b6b`. Amber vs teal vs sky-blue is a colour-blind-safe triad; shapes back it up.
**Theme:** dark.
**Reference feel:** the calm-then-storm rhythm of a tower-defence like a good Kingdom-Rush minute,
the tactile grid of a builder — feel only, no IP.

## Technical Architecture
- **Stack:** vanilla TypeScript + Vite.
- **Render:** Canvas 2D (many husks, tracers, particles; grid drawn on canvas; tap→cell via
  getBoundingClientRect).
- **Engine modules copied from patterns/:** net, rematch, lobby, rng, loop (concept), sound, storage,
  mobile, identity, drag.
- **Persistence:** localStorage settings + best-wave board via storage.ts.

## Non-Goals
- No avatars / no twin-stick — it's a tap/drag board game.
- No live AI-teammate backfill for missing humans (a dropped peer just = harder run); bots exist for
  the balance sim only.
- No public matchmaking board (private rooms only — it's a play-with-friends co-op).

## How To Play (player-facing copy)
Build a fort around your Core from scrap, then hold off the husks. In the calm, tap a tool and tap a
cell to build walls, guns and spikes — drag to lay a wall run — and tap glowing salvage to stock up.
Then LAUNCH the wave: husks swarm the Core and dig through your weakest wall, guns burn ammo you
harvested, and you patch breaches on the fly. Survive as many waves as you can. Play solo, or share a
room code and hold the line together.
