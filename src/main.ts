/**
 * main.ts — bootstrap and screen wiring. Owns no game logic.
 *
 * Shape: menu -> (solo | room entry -> lobby) -> countdown -> run (prep + waves)
 * -> results -> (rematch inside the same room | back to lobby | menu).
 *
 * The rule that governs this file: ONE ROOM PER SESSION. The Net is created once
 * on entering a room and lives until you leave for the menu. "Play again" never
 * touches it — rematch.ts versions runs inside the living room.
 */

// feedback:begin (managed by hub/scripts/feedback/backfill.mjs)
import { mountFeedback } from './feedback';
mountFeedback();
// feedback:end

import './styles/mobile.css';
import './styles/main.css';

import { Game, STRUCTS, WALL, TURRET, SPIKES, CORE, type Seat, type BuildKind, type GEvent } from './game';
import { MODE_LIST, MAX_PLAYERS, modeOf, DEFAULT_MODE, type Mode } from './modes';
import { createSession, type Session, type SessionSeat } from './net-game';
import { createRenderer } from './render';
import { createFx, seatColor, huskColor, PALETTE } from './fx';
import { createSfx, type SfxName } from './sound';
import { startCountdown, type Countdown } from './countdown';
import {
  summarize,
  tallyRun,
  emptyTally,
  renderSummary,
  shareText,
  type MatchTally,
} from './results';
import { createStore } from './engine/storage';
import { createNet, type Net } from './engine/net';
import { createRounds, type Rounds } from './engine/rematch';
import { resolveName, withName } from './engine/identity';
import { hardenViewport } from './engine/mobile';
import {
  createLobby,
  createRoomEntry,
  normalizeRoomCode,
  clearRoomInUrl,
  setRoomInUrl,
} from './engine/lobby';
import { newSeed } from './engine/rng';

hardenViewport();

const store = createStore('scrapwall');
const app = document.querySelector<HTMLDivElement>('#app')!;

const CREW = ['Rust', 'Vale', 'Cinder', 'Bolt', 'Ash', 'Wren', 'Nix', 'Fen'];

const sfx = createSfx(store.get('muted', false));
let myName = resolveName(store, () => CREW[0]);

type ToolId = 'wall' | 'turret' | 'spikes' | 'fix' | 'clear';
interface Tool {
  id: ToolId;
  label: string;
  cost: number;
  key: string;
}
const TOOLS: Tool[] = [
  { id: 'wall', label: 'Wall', cost: STRUCTS.wall.cost, key: '1' },
  { id: 'turret', label: 'Gun', cost: STRUCTS.turret.cost, key: '2' },
  { id: 'spikes', label: 'Spike', cost: STRUCTS.spikes.cost, key: '3' },
  { id: 'fix', label: 'Fix', cost: 6, key: '4' },
  { id: 'clear', label: 'Clear', cost: 0, key: '5' },
];

let net: Net | null = null;
let rounds: Rounds | null = null;
let session: Session | null = null;
let game: Game | null = null;
let countdown: Countdown | null = null;
let tally: MatchTally = emptyTally();
let mySeat = 0;
let roomCode = '';
let mode: Mode = modeOf(store.get('mode', DEFAULT_MODE.id));
let deepLinkUsed = false;
let tool: ToolId = 'wall';

const el = (html: string): HTMLElement => {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild as HTMLElement;
};

const FOOTER = `<footer class="site-footer">
  Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a>
  · <a class="hub-link" href="https://hub.benrichardson.dev" target="_blank" rel="noopener">more games, tools &amp; sites</a>
</footer>`;

function shell(inner: string): void {
  app.innerHTML = `<div class="main-content">${inner}</div>${FOOTER}`;
  const hub = app.querySelector<HTMLAnchorElement>('.hub-link');
  if (hub) hub.href = withName('https://hub.benrichardson.dev', myName);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

// ── menu ────────────────────────────────────────────────────────────────────

function showMenu(): void {
  teardownRoom();
  clearRoomInUrl();
  document.body.classList.remove('playing');

  shell(`
    <div class="menu">
      <h1 class="title">Scrap<span>wall</span></h1>
      <p class="tagline">Build a fort from scrap, then hold it.<br/>The horde digs toward whatever you left weakest.</p>

      <div class="modes" role="radiogroup" aria-label="Mode">
        ${MODE_LIST.map(
          (m) => `<button class="mode${m.id === mode.id ? ' on' : ''}" role="radio"
            aria-checked="${m.id === mode.id}" data-mode="${m.id}">
            <b>${m.name}</b><span>${esc(m.blurb)}</span></button>`,
        ).join('')}
      </div>

      <div class="menu-actions">
        <button class="btn primary" id="play">Play</button>
        <button class="btn" id="friends">Play with friends</button>
      </div>

      <label class="namebox">Your name
        <input id="name" maxlength="12" value="${esc(myName)}" autocomplete="off" spellcheck="false" />
      </label>

      <div class="menu-links">
        <button class="btn ghost" id="how">How to play</button>
        <button class="btn ghost" id="about">About</button>
        <button class="btn ghost" id="mute">${sfx.muted() ? 'Sound off' : 'Sound on'}</button>
      </div>
      <p class="best">${bestLine()}</p>
    </div>`);

  for (const b of app.querySelectorAll<HTMLElement>('.mode')) {
    b.addEventListener('click', () => {
      mode = modeOf(b.dataset.mode);
      store.set('mode', mode.id);
      sfx.unlock();
      sfx.play('select');
      showMenu();
    });
  }

  app.querySelector('#play')!.addEventListener('click', () => {
    sfx.unlock();
    startSolo();
  });
  app.querySelector('#friends')!.addEventListener('click', () => {
    sfx.unlock();
    showRoomEntry();
  });
  app.querySelector('#how')!.addEventListener('click', () => showHelp());
  app.querySelector('#about')!.addEventListener('click', showAbout);
  app.querySelector('#mute')!.addEventListener('click', () => {
    sfx.setMuted(!sfx.muted());
    store.set('muted', sfx.muted());
    sfx.unlock();
    sfx.play('select');
    showMenu();
  });

  const name = app.querySelector<HTMLInputElement>('#name')!;
  name.addEventListener('change', () => {
    myName = name.value.trim().slice(0, 12) || CREW[0];
    store.set('name', myName);
    name.value = myName;
  });

  if (!store.get('seen-help', false)) showHelp();
}

function bestLine(): string {
  const best = store.get<number>(`best:${mode.id}`, 0);
  return best > 0 ? `Best ${mode.name} run: ${best} wave${best === 1 ? '' : 's'} held` : '';
}

// ── help / about ────────────────────────────────────────────────────────────

function modal(title: string, body: string): void {
  const m = el(`<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-card">
      <h2>${esc(title)}</h2>
      ${body}
      <button class="btn primary modal-x">Got it</button>
    </div>
  </div>`);
  document.body.appendChild(m);
  const close = (): void => m.remove();
  m.querySelector('.modal-x')!.addEventListener('click', close);
  m.addEventListener('click', (e) => {
    if (e.target === m) close();
  });
}

function showHelp(): void {
  store.set('seen-help', true);
  modal(
    'How to play',
    `<ul class="how">
      <li><b>Build in the calm.</b> Pick a tool, tap a cell to place it — <b>drag to lay a wall run</b>. Walls slow the horde, <b>Guns</b> auto-fire (they burn ammo), <b>Spikes</b> chew whatever walks over them.</li>
      <li><b>Harvest salvage.</b> Tap the glowing teal nodes for scrap <i>and</i> ammo. Guns are useless without ammo, so keep harvesting — over-build and you'll run dry mid-wave.</li>
      <li><b>Hold the wave.</b> Husks pour in and take the path of least resistance — they dig through your <i>weakest</i> wall. Tap <b>Fix</b> to patch breaches (and the Core) as they come.</li>
      <li><b>Co-op:</b> one shared fort, one shared purse. Split the work — someone walls, someone harvests, someone mans repairs. The Core's fall is everyone's.</li>
    </ul>
    <p class="how-ctl">Keys <b>1–5</b> pick tools · <b>Space</b> launches the wave early · <b>P</b> pauses (solo).</p>`,
  );
}

function showAbout(): void {
  modal(
    'About Scrapwall',
    `<p>A co-op base-defence built from scrap. Wall your Core, feed your guns, and hold off an ever-worsening horde that always finds the weak point.</p>
     <p>Play solo, or share a room code with up to ${MAX_PLAYERS} friends and hold the line together.</p>
     <p class="fine">Multiplayer is <b>peer-to-peer</b>: your browsers talk directly over WebRTC and there is no game server. A free public signaling relay only brokers the first handshake — after that nothing about your run touches anyone's server, and nothing is stored.</p>
     <p class="fine">No cookies, no fingerprinting, no third-party fonts. Anonymous, cookie-less page-view counts via Cloudflare Web Analytics.</p>
     <p class="fine">Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a>.</p>`,
  );
}

// ── room entry + lobby ──────────────────────────────────────────────────────

function showRoomEntry(): void {
  teardownRoom();
  document.body.classList.remove('playing');
  shell('<div class="screen" id="entry"></div>');
  createRoomEntry({
    container: app.querySelector<HTMLElement>('#entry')!,
    onSubmit: (code, created) => enterRoom(normalizeRoomCode(code), created),
    onCancel: showMenu,
    subtitle: `Start a room and share the code, or type a friend's. Up to ${MAX_PLAYERS} defenders.`,
  });
}

function enterRoom(code: string, created: boolean): void {
  teardownRoom();
  roomCode = code;
  setRoomInUrl(code);

  net = createNet(
    { appId: 'scrapwall', roomId: code, claimHost: created },
    {
      onHostChange: (_id, isSelfHost) => {
        session?.setHost(isSelfHost);
        if (session && isSelfHost) flashHud("The host left — you're holding the line now");
      },
      onPeerLeave: (id) => session?.onPeerLeave(id),
    },
  );

  rounds = createRounds({
    net,
    playerName: myName,
    minPlayers: 2,
    roundOpts: () => ({ mode: mode.id }),
    onRound: (info) => {
      const opts = info.opts as { mode?: unknown } | undefined;
      startRun(info.seed, modeOf(opts?.mode), info.players, info.isHost);
    },
  });

  showLobby();
}

let cleanupLobby: (() => void) | null = null;

function showLobby(): void {
  if (!net || !rounds) return showMenu();
  document.body.classList.remove('playing');
  shell('<div class="screen" id="lobby"></div>');
  const box = app.querySelector<HTMLElement>('#lobby')!;
  const lobby = createLobby({
    container: box,
    net,
    rounds,
    roomCode,
    minPlayers: 2,
    maxPlayers: MAX_PLAYERS,
    onCancel: showMenu,
  });

  const strip = el('<div class="lobby-mode"></div>');
  box.appendChild(strip);
  const paint = (): void => {
    if (!rounds || !net) return;
    const s = rounds.state();
    const hostOpts = s.hostOpts as { mode?: unknown } | null;
    const shown = modeOf(hostOpts?.mode);
    strip.innerHTML = net.isHost()
      ? `<span class="lm-label">Your map (everyone defends this)</span>
         <div class="lm-modes">${MODE_LIST.map(
           (m) => `<button class="lm${m.id === mode.id ? ' on' : ''}" data-mode="${m.id}">${m.name}</button>`,
         ).join('')}</div>
         <span class="lm-blurb">${esc(mode.blurb)}</span>`
      : hostOpts
        ? `<span class="lm-label">The host picked</span>
           <div class="lm-modes"><button class="lm on" disabled>${shown.name}</button></div>
           <span class="lm-blurb">${esc(shown.blurb)}</span>`
        : `<span class="lm-label"><span class="spinner sm"></span> Waiting for the host's map…</span>`;
    for (const b of strip.querySelectorAll<HTMLElement>('.lm[data-mode]')) {
      b.addEventListener('click', () => {
        mode = modeOf(b.dataset.mode);
        store.set('mode', mode.id);
        sfx.play('select');
        paint();
      });
    }
  };
  paint();
  const poll = setInterval(paint, 700);

  cleanupLobby = () => {
    clearInterval(poll);
    lobby.destroy();
  };
}

// ── the run ─────────────────────────────────────────────────────────────────

function startSolo(): void {
  teardownRoom();
  const seed = newSeed();
  startRun(seed, mode, [{ id: 'solo', name: myName }], true);
}

function startRun(
  seed: number,
  m: Mode,
  players: { id: string; name: string }[],
  isHost: boolean,
): void {
  cleanupLobby?.();
  cleanupLobby = null;
  countdown?.cancel();

  const seats: Seat[] = players.map((p) => ({ name: p.name, bot: false }));
  const sseats: SessionSeat[] = players.map((p) => ({ id: p.id, bot: false }));

  const me = net ? players.findIndex((p) => p.id === net!.selfId) : 0;
  mySeat = me >= 0 ? me : 0;
  game = new Game({ seed, mode: m, seats });
  const g = game;

  session = createSession({
    game: g,
    me: mySeat,
    seats: sseats,
    net: net ?? undefined,
    host: isHost,
    seed,
    onEnd: () => showResults(),
    onHostChange: (h) => {
      if (h) flashHud("You're holding the line now");
    },
  });

  showGame(g, m);
}

let cleanupGame: (() => void) | null = null;

function showGame(g: Game, m: Mode): void {
  document.body.classList.add('playing');
  shell(`
    <div class="play">
      <div class="hud">
        <div class="hud-l">
          <div class="wavebox"><span class="wave-n" id="waven">Prep</span><span class="wave-sub" id="wavesub">${esc(m.name)}</span></div>
        </div>
        <div class="hud-mid">
          <div class="corebar"><span class="corebar-fill" id="corefill"></span><span class="corebar-txt" id="coretxt">Core</span></div>
        </div>
        <div class="hud-r">
          <div class="res"><span class="res-ic scrap">◆</span><span id="scrap">0</span></div>
          <div class="res"><span class="res-ic ammo">▮</span><span id="ammo">0</span></div>
          <button class="icon" id="pause" aria-label="Pause">II</button>
        </div>
      </div>

      <div class="board-wrap">
        <canvas id="cv" class="drag-surface"></canvas>
        <div class="big" id="big" hidden></div>
        <div class="flash" id="flash" role="status" aria-live="polite"></div>
      </div>

      <div class="toolbar" id="toolbar">
        ${TOOLS.map(
          (t) => `<button class="tool" data-tool="${t.id}" aria-pressed="${t.id === tool}">
            <span class="tool-lbl">${t.label}</span>
            <span class="tool-cost">${t.cost > 0 ? `◆${t.cost}` : '↺'}</span>
          </button>`,
        ).join('')}
        <button class="tool launch" id="launch"><span class="tool-lbl">Launch</span><span class="tool-cost" id="launchsub">wave</span></button>
      </div>

      <div class="overlay" id="pausebox" hidden>
        <div class="modal-card">
          <h2>Paused</h2>
          <button class="btn primary" id="resume">Resume</button>
          <button class="btn" id="restart">Restart</button>
          <button class="btn ghost" id="quit">Menu</button>
        </div>
      </div>
    </div>`);

  const canvas = app.querySelector<HTMLCanvasElement>('#cv')!;
  const renderer = createRenderer(canvas);
  const fx = createFx();

  const waveN = app.querySelector<HTMLElement>('#waven')!;
  const waveSub = app.querySelector<HTMLElement>('#wavesub')!;
  const coreFill = app.querySelector<HTMLElement>('#corefill')!;
  const coreTxt = app.querySelector<HTMLElement>('#coretxt')!;
  const scrapEl = app.querySelector<HTMLElement>('#scrap')!;
  const ammoEl = app.querySelector<HTMLElement>('#ammo')!;
  const bigEl = app.querySelector<HTMLElement>('#big')!;
  const launchBtn = app.querySelector<HTMLButtonElement>('#launch')!;
  const launchSub = app.querySelector<HTMLElement>('#launchsub')!;
  const pauseBox = app.querySelector<HTMLElement>('#pausebox')!;

  let paused = false;
  let running = true;
  let lastWave = -1;
  let lastPhase = '';

  // ── tool selection ──────────────────────────────────────────────────────
  function selectTool(id: ToolId): void {
    tool = id;
    for (const b of app.querySelectorAll<HTMLElement>('.tool[data-tool]')) {
      b.setAttribute('aria-pressed', String(b.dataset.tool === id));
    }
  }
  for (const b of app.querySelectorAll<HTMLElement>('.tool[data-tool]')) {
    b.addEventListener('click', () => {
      selectTool(b.dataset.tool as ToolId);
      sfx.play('select');
    });
  }
  selectTool(tool);

  launchBtn.addEventListener('click', () => {
    if (g.phase === 'prep') {
      session?.launch();
      sfx.unlock();
    }
  });

  app.querySelector('#pause')!.addEventListener('click', () => setPaused(true));
  app.querySelector('#resume')!.addEventListener('click', () => setPaused(false));
  app.querySelector('#restart')!.addEventListener('click', () => {
    if (net) {
      setPaused(false);
      return; // a shared run is not one player's to restart
    }
    cleanupGame?.();
    startSolo();
  });
  app.querySelector('#quit')!.addEventListener('click', () => {
    cleanupGame?.();
    showMenu();
  });

  function setPaused(p: boolean): void {
    paused = p && !net; // in a room the world does not stop for you
    pauseBox.hidden = !paused;
  }

  // ── canvas input: tap places, drag paints ───────────────────────────────
  let pointerId: number | null = null;
  const applied = new Set<number>();
  let lastCell = -1;

  function cellFromEvent(e: PointerEvent): number {
    const rect = canvas.getBoundingClientRect();
    return renderer.cellAt(e.clientX - rect.left, e.clientY - rect.top);
  }

  function applyToCell(i: number): void {
    if (i < 0 || !g || g.over) return;
    if (applied.has(i)) return;
    applied.add(i);
    sfx.unlock();
    if (g.salv[i] > 0) {
      session?.act('harvest', i);
      sfx.play('harvest');
      return;
    }
    const t = g.ct[i];
    if (tool === 'wall' || tool === 'turret' || tool === 'spikes') {
      if (g.buildable(i)) {
        const kind = tool as BuildKind;
        if (g.scrap >= STRUCTS[kind].cost) {
          session?.act('build', i, kind);
          sfx.play('place');
        } else {
          sfx.play('nope');
          flashHud('Not enough scrap — harvest some salvage');
        }
      }
    } else if (tool === 'fix') {
      if ((t === WALL || t === TURRET || t === SPIKES || t === CORE) && g.chp[i] < g.cmax[i]) {
        session?.act('repair', i);
      }
    } else if (tool === 'clear') {
      if (t === WALL || t === TURRET || t === SPIKES) {
        session?.act('clear', i);
        sfx.play('select');
      }
    }
  }

  const onDown = (e: PointerEvent): void => {
    if (pointerId !== null || paused) return;
    pointerId = e.pointerId;
    applied.clear();
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const i = cellFromEvent(e);
    lastCell = i;
    applyToCell(i);
  };
  const onMove = (e: PointerEvent): void => {
    if (e.pointerId !== pointerId) return;
    const i = cellFromEvent(e);
    if (i !== lastCell) {
      lastCell = i;
      // painting only makes sense for build / clear / fix / harvest across cells
      applyToCell(i);
    }
    e.preventDefault();
  };
  const onUp = (e: PointerEvent): void => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    lastCell = -1;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  const onCancel = (e: PointerEvent): void => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    lastCell = -1;
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);

  // ── keyboard ─────────────────────────────────────────────────────────────
  const onKey = (e: KeyboardEvent): void => {
    const t = TOOLS.find((x) => x.key === e.key);
    if (t) {
      selectTool(t.id);
      sfx.play('select');
    } else if (e.code === 'Space' || e.code === 'Enter') {
      if (g.phase === 'prep') session?.launch();
      e.preventDefault();
    } else if (e.code === 'KeyP' || e.code === 'Escape') {
      setPaused(pauseBox.hidden);
    } else if (e.code === 'KeyM') {
      sfx.setMuted(!sfx.muted());
      store.set('muted', sfx.muted());
    }
  };
  window.addEventListener('keydown', onKey);

  // ── resize ───────────────────────────────────────────────────────────────
  const resize = (): void => {
    const wrap = canvas.parentElement!;
    const r = wrap.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    renderer.resize(r.width, r.height, Math.min(2, window.devicePixelRatio || 1));
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas.parentElement!);
  resize();

  // ── HUD sync ─────────────────────────────────────────────────────────────
  function syncHud(): void {
    const frac = g.coreMax > 0 ? Math.max(0, g.coreHp / g.coreMax) : 0;
    coreFill.style.width = `${frac * 100}%`;
    coreFill.style.background = frac > 0.35 ? PALETTE.core : PALETTE.coreLow;
    coreTxt.textContent = `Core ${Math.ceil(g.coreHp)}`;
    scrapEl.textContent = String(Math.floor(g.scrap));
    ammoEl.textContent = String(Math.floor(g.ammo));

    if (g.phase === 'prep') {
      waveN.textContent = `Prep`;
      waveSub.textContent = `Wave ${g.wave + 1} in ${Math.ceil(g.prepLeft)}s`;
      launchBtn.hidden = false;
      launchBtn.classList.add('ready');
      launchSub.textContent = 'wave';
    } else if (g.phase === 'wave') {
      waveN.textContent = `Wave ${g.wave}`;
      const left = g.husks.length + queuedCount(g);
      waveSub.textContent = left > 0 ? `${left} husks left` : 'clearing…';
      launchBtn.classList.remove('ready');
      launchBtn.hidden = true;
    }

    // affordability tint on tools
    for (const b of app.querySelectorAll<HTMLElement>('.tool[data-tool]')) {
      const tdef = TOOLS.find((x) => x.id === b.dataset.tool)!;
      const afford = tdef.cost === 0 || g.scrap >= tdef.cost;
      b.classList.toggle('poor', !afford && (tdef.id === 'wall' || tdef.id === 'turret' || tdef.id === 'spikes'));
    }
  }

  // ── the frame loop ───────────────────────────────────────────────────────
  const keep = setInterval(() => {
    if (running && !paused) session?.pump(performance.now());
  }, 120);

  let lastFrame = performance.now();
  let rafId = 0;
  const frame = (): void => {
    rafId = requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;

    if (running && !paused) session?.pump(now);

    // drain events for juice
    const evs = session?.drainFx() ?? [];
    for (const e of evs) playFx(e, fx);

    fx.step(dt);
    syncHud();

    // pointer position ghost (desktop hover). Use lastCell during a drag.
    const ghost = pointerId !== null ? lastCell : hoverCell;
    const kind = tool as BuildKind;
    const affordable =
      tool === 'clear' ||
      tool === 'fix' ||
      (g.scrap >= (STRUCTS[kind]?.cost ?? 0));
    renderer.draw(g, fx, paused ? 0 : dt, {
      tool: tool === 'fix' || tool === 'clear' ? null : tool,
      ghost: ghost >= 0 && g.buildable(ghost) ? ghost : -1,
      affordable,
      seatColor: seatColor(mySeat),
    });

    // wave / phase transitions handled via events; also detect for countdown
    if (g.wave !== lastWave && g.phase === 'wave') {
      lastWave = g.wave;
    }
    lastPhase = g.phase;
    void lastPhase;
  };

  // desktop hover ghost
  let hoverCell = -1;
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse' && pointerId === null) hoverCell = cellFromEvent(e as PointerEvent);
  });
  canvas.addEventListener('pointerleave', () => {
    hoverCell = -1;
  });

  rafId = requestAnimationFrame(frame);

  // ── fx / countdown ─────────────────────────────────────────────────────────
  const soundAt: Partial<Record<SfxName, number>> = {};
  function throttleSound(name: SfxName, ms: number): void {
    const t = performance.now();
    if ((soundAt[name] ?? 0) + ms > t) return;
    soundAt[name] = t;
    sfx.play(name);
  }

  function playFx(e: GEvent, f: ReturnType<typeof createFx>): void {
    switch (e.k) {
      case 'fire':
        f.tracer(e.x, e.y, e.tx, e.ty);
        f.burst(e.x, e.y, 1, PALETTE.hot, 30, 2);
        throttleSound('fire', 55);
        break;
      case 'splat':
        f.burst(e.x, e.y, 8, huskColor(e.kind), 130, 3);
        f.ring(e.x, e.y, huskColor(e.kind), 0.7);
        throttleSound('splat', 45);
        break;
      case 'crack':
        f.burst(e.x, e.y, 3, PALETTE.steel, 60, 2);
        throttleSound('crack', 70);
        break;
      case 'break':
        f.burst(e.x, e.y, 14, PALETTE.steel, 160, 3);
        f.shake(6);
        sfx.play('break');
        flashHud('A wall broke!');
        break;
      case 'corehit':
        f.shake(7);
        f.coreFlash(0.45);
        f.burst(e.x, e.y, 6, PALETTE.coreLow, 120, 3);
        throttleSound('corehit', 120);
        break;
      case 'harvest':
        f.burst(e.x, e.y, 6, PALETTE.salvage, 80, 2);
        break;
      case 'place':
        f.burst(e.x, e.y, 6, PALETTE.amber, 60, 2);
        break;
      case 'repair':
        f.burst(e.x, e.y, 8, PALETTE.core, 70, 2);
        throttleSound('repair', 60);
        break;
      case 'wavestart':
        startWaveCountdown(e.wave);
        break;
      case 'waveclear':
        sfx.play('waveclear');
        flashHud(`Wave ${e.wave} held — rebuild!`);
        break;
      case 'lowammo':
        sfx.play('lowammo');
        flashHud('Out of ammo — harvest salvage!');
        break;
      case 'over':
        break;
    }
  }

  function startWaveCountdown(wave: number): void {
    countdown?.cancel();
    bigEl.hidden = false;
    sfx.play('wavestart');
    countdown = startCountdown({
      onBeat: (nn) => {
        bigEl.textContent = nn > 0 ? String(nn) : `WAVE ${wave}`;
        bigEl.className = 'big pop';
        void bigEl.offsetWidth;
        bigEl.className = 'big pop go';
        sfx.play(nn > 0 ? 'beat' : 'go');
      },
      onDone: () => {
        bigEl.hidden = true;
      },
    });
  }

  cleanupGame = () => {
    running = false;
    cancelAnimationFrame(rafId);
    clearInterval(keep);
    window.removeEventListener('keydown', onKey);
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onCancel);
    ro.disconnect();
    countdown?.cancel();
    countdown = null;
  };
}

function queuedCount(g: Game): number {
  // remaining scheduled spawns this wave (host only knows; clients approximate 0)
  return (g as unknown as { queue?: unknown[] }).queue?.length ?? 0;
}

function flashHud(msg: string): void {
  const f = document.querySelector<HTMLElement>('#flash');
  if (!f) return;
  f.textContent = msg;
  f.classList.add('show');
  setTimeout(() => f.classList.remove('show'), 2000);
}

// ── results ─────────────────────────────────────────────────────────────────

function showResults(): void {
  const g = game;
  cleanupGame?.();
  cleanupGame = null;
  document.body.classList.remove('playing');
  if (!g) return showMenu();

  sfx.play('over');
  const best = store.get<number>(`best:${g.mode.id}`, 0);
  const s = summarize(g, mySeat, best);
  if (s.isBest) {
    store.set(`best:${g.mode.id}`, s.waves);
    sfx.play('win');
  }
  const prevTally = tally;
  tally = tallyRun(tally, s);

  shell(`
    <div class="results">
      <h2 class="rs-title">The wall broke</h2>
      <div id="rsbody">${renderSummary(s, g.mode.name, prevTally)}</div>
      <div class="rs-wait" id="rswait" hidden></div>
      <div class="rs-actions">
        <button class="btn primary" id="again">Play again</button>
        <button class="btn" id="share">Share</button>
        ${net ? '<button class="btn ghost" id="tolobby">Back to lobby</button>' : ''}
        <button class="btn ghost" id="menu">Menu</button>
      </div>
    </div>`);

  app.querySelector('#share')!.addEventListener('click', () => void share(shareText(s, g.mode.name)));
  app.querySelector('#menu')!.addEventListener('click', showMenu);
  app.querySelector('#tolobby')?.addEventListener('click', () => {
    rounds?.finish();
    showLobby();
  });

  const again = app.querySelector<HTMLElement>('#again')!;
  const wait = app.querySelector<HTMLElement>('#rswait')!;

  if (!net) {
    again.addEventListener('click', () => startSolo());
    return;
  }

  rounds?.finish();
  again.addEventListener('click', () => {
    rounds?.vote();
    again.setAttribute('disabled', '');
    again.textContent = 'Waiting…';
    paintWait();
  });

  function paintWait(): void {
    if (!rounds || !net) return;
    const st = rounds.state();
    if (st.phase === 'playing') return;
    const votes = st.votes.map((v) => esc(v.name)).join(', ');
    const missing = st.present.length - st.votes.length;
    wait.hidden = st.votes.length === 0;
    wait.innerHTML = `
      <span class="spinner sm" aria-hidden="true"></span>
      <span>${votes || 'Nobody'} ready${missing > 0 ? ` · waiting on ${missing}` : ''}${
        st.startsInMs != null
          ? ` · starting in ${Math.ceil(st.startsInMs / 1000)}s`
          : st.votes.length >= 2
            ? ''
            : ' · need 2 to defend'
      }</span>
      ${st.isHost && st.canStart ? '<button class="btn sm" id="force">Start now</button>' : ''}`;
    wait.querySelector('#force')?.addEventListener('click', () => rounds?.go());
  }
  const poll = setInterval(paintWait, 400);
  cleanupGame = () => clearInterval(poll);
  paintWait();
}

async function share(text: string): Promise<void> {
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Scrapwall', text });
      return;
    }
  } catch {
    /* cancelled — fall through to copy */
  }
  try {
    await navigator.clipboard.writeText(text);
    flashHud('Copied!');
  } catch {
    flashHud('Copy failed — select and copy manually');
  }
}

// ── teardown ────────────────────────────────────────────────────────────────

function teardownRoom(): void {
  cleanupGame?.();
  cleanupGame = null;
  cleanupLobby?.();
  cleanupLobby = null;
  countdown?.cancel();
  countdown = null;
  session?.destroy();
  session = null;
  rounds?.destroy();
  rounds = null;
  if (net) {
    void net.leave();
    net = null;
  }
  game = null;
  tally = emptyTally();
}

window.addEventListener('beforeunload', () => {
  void net?.leave();
});

// ── boot ──────────────────────────────────────────────────────────────────

const url = new URL(location.href);
const deep = url.searchParams.get('room');
if (deep && !deepLinkUsed) {
  deepLinkUsed = true;
  const code = normalizeRoomCode(deep);
  if (code.length >= 3) enterRoom(code, false);
  else showMenu();
} else {
  showMenu();
}
