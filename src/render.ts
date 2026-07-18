/**
 * render.ts — draw the fort and the horde on a Canvas 2D. Reads Game + Fx; owns
 * no state beyond the viewport transform. Everything is laid out in WORLD (cell)
 * units and mapped through one transform, so a tap maps back to a cell cleanly.
 */

import { Game, EMPTY, CORE, WALL, TURRET, SPIKES, HUSKS } from './game';
import { PALETTE, huskColor, type Fx } from './fx';

export interface View {
  tool: string | null;
  ghost: number; // cell idx under the pointer, or -1
  affordable: boolean;
  seatColor: string;
}

export interface Renderer {
  resize(cssW: number, cssH: number, dpr: number): void;
  draw(g: Game, fx: Fx, dt: number, view: View): void;
  cellAt(px: number, py: number): number;
  layout(): { cell: number; ox: number; oy: number };
}

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const ctx = canvas.getContext('2d')!;
  let cssW = 300;
  let cssH = 300;
  let cell = 20;
  let ox = 0;
  let oy = 0;
  let cols = 9;
  let rows = 9;

  function relayout(g: Game): void {
    cols = g.cols;
    rows = g.rows;
    const pad = 10;
    cell = Math.floor(Math.min((cssW - pad * 2) / cols, (cssH - pad * 2) / rows));
    if (cell < 1) cell = 1;
    ox = Math.round((cssW - cell * cols) / 2);
    oy = Math.round((cssH - cell * rows) / 2);
  }

  const sx = (wx: number): number => ox + wx * cell;
  const sy = (wy: number): number => oy + wy * cell;

  function roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function hpBar(cx: number, topY: number, w: number, frac: number, color: string): void {
    const bw = w * 0.78;
    const bh = Math.max(2, cell * 0.08);
    const x = cx - bw / 2;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x - 1, topY - 1, bw + 2, bh + 2);
    ctx.fillStyle = color;
    ctx.fillRect(x, topY, bw * Math.max(0, Math.min(1, frac)), bh);
  }

  return {
    resize(w, h, dpr) {
      cssW = w;
      cssH = h;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    },

    layout: () => ({ cell, ox, oy }),

    cellAt(px, py) {
      const c = Math.floor((px - ox) / cell);
      const r = Math.floor((py - oy) / cell);
      if (c < 0 || r < 0 || c >= cols || r >= rows) return -1;
      return r * cols + c;
    },

    draw(g, fx, dt, view) {
      relayout(g);
      const shx = fx.shakeX();
      const shy = fx.shakeY();

      ctx.save();
      ctx.setTransform(
        (canvas.width / cssW),
        0,
        0,
        (canvas.height / cssH),
        0,
        0,
      );

      // background
      ctx.fillStyle = PALETTE.night;
      ctx.fillRect(0, 0, cssW, cssH);

      ctx.translate(shx, shy);

      // board panel
      ctx.fillStyle = PALETTE.panel;
      roundRect(ox - 6, oy - 6, cell * cols + 12, cell * rows + 12, 10);
      ctx.fill();

      // grid + salvage
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = ox + c * cell;
          const y = oy + r * cell;
          const border = c === 0 || r === 0 || c === cols - 1 || r === rows - 1;
          ctx.fillStyle = border ? '#0e1830' : PALETTE.grid;
          ctx.fillRect(x + 0.5, y + 0.5, cell - 1, cell - 1);
        }
      }

      const n = cols * rows;
      // salvage nodes
      for (let i = 0; i < n; i++) {
        if (g.salv[i] <= 0) continue;
        const c = i % cols;
        const r = (i / cols) | 0;
        const cx = sx(c + 0.5);
        const cy = sy(r + 0.5);
        const frac = Math.min(1, g.salv[i] / g.mode.salvagePer);
        const s = cell * (0.16 + 0.2 * frac);
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = PALETTE.salvage;
        ctx.globalAlpha = 0.85;
        ctx.fillRect(-s, -s, s * 2, s * 2);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        ctx.strokeRect(-s, -s, s * 2, s * 2);
        ctx.restore();
      }

      // structures
      for (let i = 0; i < n; i++) {
        const t = g.ct[i];
        if (t === EMPTY || t === CORE) continue;
        const c = i % cols;
        const r = (i / cols) | 0;
        const x = ox + c * cell;
        const y = oy + r * cell;
        const cx = x + cell / 2;
        const cy = y + cell / 2;
        const frac = g.cmax[i] > 0 ? g.chp[i] / g.cmax[i] : 1;
        if (t === WALL) {
          ctx.fillStyle = frac > 0.4 ? PALETTE.steel : '#3a2b2b';
          roundRect(x + cell * 0.1, y + cell * 0.1, cell * 0.8, cell * 0.8, cell * 0.14);
          ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.06)';
          ctx.fillRect(x + cell * 0.14, y + cell * 0.14, cell * 0.72, cell * 0.14);
        } else if (t === TURRET) {
          ctx.fillStyle = '#2c3c52';
          ctx.beginPath();
          ctx.arc(cx, cy, cell * 0.36, 0, Math.PI * 2);
          ctx.fill();
          // barrel toward nearest husk
          let ang = -Math.PI / 2;
          let bd = Infinity;
          for (const h of g.husks) {
            const d = (h.x - (c + 0.5)) ** 2 + (h.y - (r + 0.5)) ** 2;
            if (d < bd) {
              bd = d;
              ang = Math.atan2(h.y - (r + 0.5), h.x - (c + 0.5));
            }
          }
          ctx.strokeStyle = PALETTE.hot;
          ctx.lineWidth = Math.max(2, cell * 0.16);
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.cos(ang) * cell * 0.42, cy + Math.sin(ang) * cell * 0.42);
          ctx.stroke();
          ctx.fillStyle = PALETTE.amber;
          ctx.beginPath();
          ctx.arc(cx, cy, cell * 0.12, 0, Math.PI * 2);
          ctx.fill();
        } else if (t === SPIKES) {
          ctx.fillStyle = '#8a94a6';
          const s = cell * 0.16;
          for (let k = 0; k < 4; k++) {
            const px = x + cell * (0.24 + (k % 2) * 0.4);
            const py = y + cell * (0.28 + Math.floor(k / 2) * 0.4);
            ctx.beginPath();
            ctx.moveTo(px, py + s);
            ctx.lineTo(px + s, py + s);
            ctx.lineTo(px + s / 2, py - s);
            ctx.closePath();
            ctx.fill();
          }
        }
        if (frac < 0.99 && t !== SPIKES) hpBar(cx, y + cell * 0.02, cell, frac, frac > 0.4 ? PALETTE.amber : PALETTE.breach);
      }

      // core
      {
        const c = g.colOf(g.coreIdx);
        const r = g.rowOf(g.coreIdx);
        const x = ox + c * cell;
        const y = oy + r * cell;
        const cx = x + cell / 2;
        const cy = y + cell / 2;
        const frac = g.coreMax > 0 ? g.coreHp / g.coreMax : 0;
        const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 380);
        ctx.save();
        ctx.shadowColor = frac > 0.35 ? PALETTE.core : PALETTE.coreLow;
        ctx.shadowBlur = cell * (0.3 + 0.3 * pulse);
        ctx.fillStyle = frac > 0.35 ? PALETTE.core : PALETTE.coreLow;
        roundRect(x + cell * 0.14, y + cell * 0.14, cell * 0.72, cell * 0.72, cell * 0.16);
        ctx.fill();
        ctx.restore();
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.14, 0, Math.PI * 2);
        ctx.fill();
        hpBar(cx, y - cell * 0.06, cell * 1.1, frac, frac > 0.35 ? PALETTE.core : PALETTE.coreLow);
      }

      // husks (smoothed toward snapshot positions)
      const ease = Math.min(1, dt * 12);
      for (const h of g.husks) {
        h.rx += (h.x - h.rx) * ease;
        h.ry += (h.y - h.ry) * ease;
        const cx = sx(h.rx);
        const cy = sy(h.ry);
        const def = HUSKS[h.kind];
        const rad = cell * def.r;
        ctx.fillStyle = huskColor(h.kind);
        if (h.kind === 2) {
          // brute — a big square
          roundRect(cx - rad, cy - rad, rad * 2, rad * 2, rad * 0.3);
          ctx.fill();
        } else if (h.kind === 1) {
          // runner — a diamond
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(Math.PI / 4);
          ctx.fillRect(-rad, -rad, rad * 2, rad * 2);
          ctx.restore();
        } else {
          // shambler — a circle
          ctx.beginPath();
          ctx.arc(cx, cy, rad, 0, Math.PI * 2);
          ctx.fill();
        }
        const frac = h.maxHp > 0 ? h.hp / h.maxHp : 1;
        if (frac < 0.99) hpBar(cx, cy - rad - cell * 0.14, cell * 0.6, frac, PALETTE.breach);
      }

      // tracers
      ctx.lineCap = 'round';
      for (const tr of fx.tracers) {
        const a = tr.life / tr.max;
        ctx.strokeStyle = `rgba(255,200,120,${0.85 * a})`;
        ctx.lineWidth = Math.max(1.5, cell * 0.08);
        ctx.beginPath();
        ctx.moveTo(sx(tr.x0), sy(tr.y0));
        ctx.lineTo(sx(tr.x1), sy(tr.y1));
        ctx.stroke();
      }

      // rings
      for (const rg of fx.rings) {
        const a = rg.life / rg.max;
        ctx.strokeStyle = rg.color;
        ctx.globalAlpha = a * 0.7;
        ctx.lineWidth = Math.max(1.5, cell * 0.06);
        ctx.beginPath();
        ctx.arc(sx(rg.x), sy(rg.y), rg.r * cell, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // particles
      for (const p of fx.particles) {
        const a = Math.min(1, p.life / 0.4);
        ctx.globalAlpha = a;
        ctx.fillStyle = p.color;
        ctx.fillRect(sx(p.x) - p.size / 2, sy(p.y) - p.size / 2, p.size, p.size);
      }
      ctx.globalAlpha = 1;

      // build ghost
      if (view.ghost >= 0 && view.tool) {
        const c = view.ghost % cols;
        const r = (view.ghost / cols) | 0;
        const x = ox + c * cell;
        const y = oy + r * cell;
        const ok = view.affordable;
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = ok ? view.seatColor : PALETTE.breach;
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1, cell - 2, cell - 2);
        ctx.fillStyle = ok ? view.seatColor : PALETTE.breach;
        ctx.globalAlpha = 0.18;
        ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
        ctx.globalAlpha = 1;
      }

      ctx.restore();

      // Core-breach vignette (screen space, not shaken)
      const glow = fx.coreGlow();
      if (glow > 0.01) {
        const grad = ctx.createRadialGradient(
          cssW / 2,
          cssH / 2,
          Math.min(cssW, cssH) * 0.3,
          cssW / 2,
          cssH / 2,
          Math.max(cssW, cssH) * 0.7,
        );
        grad.addColorStop(0, 'rgba(255,80,80,0)');
        grad.addColorStop(1, `rgba(255,60,60,${0.5 * glow})`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, cssW, cssH);
      }
    },
  };
}
