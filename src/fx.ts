/**
 * fx.ts — particles, screen shake, hit-stop and the palette. Juice, and the
 * single source of the colours so the game reads as one system.
 *
 * Particles and rings live in WORLD (cell) units so they line up with the grid;
 * render.ts maps them to pixels with the same transform it uses for everything
 * else. Shake and the Core-breach vignette are scalar. Everything degrades under
 * `prefers-reduced-motion`.
 */

/**
 * Anything that sits ON the board must clear 3:1 contrast against `grid` — the
 * WCAG 2.1 floor for a meaningful non-text graphic, and the difference between a
 * wall you can see and one you cannot. `steel` used to be #243244, which is 1.14:1
 * against the grid: the walls rendered, and were invisible. They read as empty
 * cells, so the fort looked see-through. contrast.test.ts pins every one of these.
 */
export const PALETTE = {
  night: '#0b1220',
  panel: '#111c2e',
  steel: '#677892',
  /** A wall/turret below 40% hp — rust, and still legible rather than near-black. */
  steelLow: '#b06a55',
  grid: '#1b2740',
  amber: '#f0b429',
  hot: '#ff8c42',
  core: '#56b4e9',
  coreLow: '#ff6b6b',
  ichor: '#6ee7b7',
  runner: '#e9d16e',
  brute: '#c98bff',
  salvage: '#7ee0c0',
  breach: '#ff6b6b',
  text: '#e7ecf5',
  dim: '#8ea0bd',
};

/** Distinct hue AND shape per husk kind (colour-blind safety). */
export function huskColor(kind: number): string {
  return kind === 1 ? PALETTE.runner : kind === 2 ? PALETTE.brute : PALETTE.ichor;
}

/** Per-seat accent, for the ghost cursor and the results rows. */
const SEAT_COLORS = ['#f0b429', '#56b4e9', '#6ee7b7', '#ff8c42'];
export function seatColor(i: number): string {
  return SEAT_COLORS[((i % SEAT_COLORS.length) + SEAT_COLORS.length) % SEAT_COLORS.length];
}

const reduce =
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
  size: number;
}
export interface Ring {
  x: number;
  y: number;
  r: number;
  maxR: number;
  life: number;
  max: number;
  color: string;
}
export interface Tracer {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  life: number;
  max: number;
}

export interface Fx {
  particles: Particle[];
  rings: Ring[];
  tracers: Tracer[];
  burst(x: number, y: number, n: number, color: string, spread: number, size: number): void;
  ring(x: number, y: number, color: string, maxR: number): void;
  tracer(x0: number, y0: number, x1: number, y1: number): void;
  shake(mag: number): void;
  coreFlash(mag: number): void;
  stop(secs: number): void;
  step(dt: number): void;
  shakeX(): number;
  shakeY(): number;
  stopped(): number;
  coreGlow(): number;
}

export function createFx(): Fx {
  const particles: Particle[] = [];
  const rings: Ring[] = [];
  const tracers: Tracer[] = [];
  let shakeMag = 0;
  let hitstop = 0;
  let coreG = 0;
  let seed = 1234;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  return {
    particles,
    rings,
    tracers,
    burst(x, y, n, color, spread, size) {
      if (reduce) n = Math.min(n, 3);
      for (let i = 0; i < n; i++) {
        const a = rnd() * Math.PI * 2;
        const s = spread * (0.3 + rnd() * 0.7) * 0.02; // world units/sec
        particles.push({
          x,
          y,
          vx: Math.cos(a) * s,
          vy: Math.sin(a) * s,
          life: 0.4 + rnd() * 0.4,
          max: 0.8,
          color,
          size: size * (0.6 + rnd() * 0.8),
        });
      }
      if (particles.length > 500) particles.splice(0, particles.length - 500);
    },
    ring(x, y, color, maxR) {
      if (reduce) return;
      rings.push({ x, y, r: 0.1, maxR, life: 0.5, max: 0.5, color });
    },
    tracer(x0, y0, x1, y1) {
      tracers.push({ x0, y0, x1, y1, life: 0.09, max: 0.09 });
      if (tracers.length > 120) tracers.splice(0, tracers.length - 120);
    },
    shake(mag) {
      if (reduce) return;
      shakeMag = Math.min(18, shakeMag + mag);
    },
    coreFlash(mag) {
      coreG = Math.min(1, coreG + mag);
    },
    stop(secs) {
      if (reduce) return;
      hitstop = Math.max(hitstop, secs);
    },
    step(dt) {
      if (hitstop > 0) hitstop -= dt;
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life -= dt;
        if (p.life <= 0) {
          particles.splice(i, 1);
          continue;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= 0.9;
        p.vy *= 0.9;
      }
      for (let i = rings.length - 1; i >= 0; i--) {
        const r = rings[i];
        r.life -= dt;
        if (r.life <= 0) {
          rings.splice(i, 1);
          continue;
        }
        r.r += (r.maxR - r.r) * Math.min(1, dt * 6);
      }
      for (let i = tracers.length - 1; i >= 0; i--) {
        tracers[i].life -= dt;
        if (tracers[i].life <= 0) tracers.splice(i, 1);
      }
      shakeMag *= Math.max(0, 1 - dt * 9);
      if (shakeMag < 0.1) shakeMag = 0;
      coreG *= Math.max(0, 1 - dt * 2.5);
    },
    shakeX() {
      return shakeMag ? (rnd() - 0.5) * shakeMag * 2 : 0;
    },
    shakeY() {
      return shakeMag ? (rnd() - 0.5) * shakeMag * 2 : 0;
    },
    stopped() {
      return hitstop;
    },
    coreGlow() {
      return coreG;
    },
  };
}
