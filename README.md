# Scrapwall

**Build a fort from scrap, then hold it — a co-op siege where the horde digs toward whatever you left weakest.**

🎮 Play: https://scrapwall.benrichardson.dev

## What it is
Scrapwall is a co-op base-defence on a grid. A Core sits at the centre; in a short
calm you spend shared **scrap** to raise walls, plant auto-turrets and lay spikes, and
harvest glowing **salvage** nodes for more scrap and ammo. Then the wave comes: husks
pour in from the edges and pathfind toward the Core along the path of *least
resistance* — routing around your strong walls and **digging through the weakest one**
if that's the shortest way in. Guns auto-fire and burn the ammo you harvested; spikes
chew the crowd; you scramble to patch breaches as they open.

The tension is a budget, not a wish-list: more turrets drain the shared ammo faster
than you can harvest it, so **over-fortifying starves you**. Every wave is bigger and
the run ends when the Core falls — the fort has to out-improve the horde. It's fun
solo in the first five seconds, and it's built for friends: one shared fort, one
shared purse, and the Core's fall is everyone's.

## How to play
- **Desktop:** click a tool (Wall / Gun / Spikes / Fix / Clear), click a cell to place
  it; **click-drag to paint a wall run**; click a glowing salvage node to harvest.
  Keys **1–5** pick tools, **Space** launches the wave early, **P** pauses (solo).
- **Mobile:** the same by tap — tap a tool, tap a cell, **drag to lay a wall**, tap
  salvage to stock up, and a big **Launch wave** button when you're ready.

Three modes change the *space*, not a dial: **Outpost** (a tidy 9×9, husks from two
edges — the gentle one), **Depot** (11×11, husks from all four edges), and **Sprawl**
(a big 13×13, four edges, a heavier ramp and scattered salvage).

## Multiplayer
Live **peer-to-peer co-op** for up to 4 defenders over a shared room code — create a
room or type a friend's code. It's **co-op, not versus**: one shared fort against the
wave curve, so there's no seat to be unfair and a dropped peer just makes the run
harder. Host-authoritative: the host runs the whole world and broadcasts snapshots;
if the host leaves, a survivor is promoted and keeps the run going. No server — a
free public signaling relay only brokers the first WebRTC handshake, and nothing is
stored.

## Tech
- Vite 6 + vanilla TypeScript
- Canvas 2D rendering; weighted-Dijkstra flow-field pathing
- Shared engine: P2P netcode (Trystero), rematch protocol, procedural audio
- Vitest for logic, P2P-sync determinism, host-transfer takeover, and a **balance
  sim** that referees the difficulty ramp (AI-vs-the-horde over hundreds of seeds)
- GitHub Pages hosting

No cookies, no fingerprinting, no third-party fonts. Anonymous, cookie-less page-view
counts via Cloudflare Web Analytics.

## Local dev
```bash
npm install
npm run dev
npm test
npm run build
npm run preview
```

## License
MIT
