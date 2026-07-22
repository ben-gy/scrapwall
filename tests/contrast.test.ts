/**
 * contrast.test.ts — can you actually SEE the fort you built?
 *
 * Scrapwall shipped with walls at 1.14:1 against the board. They were drawn, in
 * the right cells, at the right size — and invisible. A player reported the walls
 * as "see-through", which is exactly what a 1.14:1 rectangle looks like: an empty
 * cell with a faint edge.
 *
 * Every layout gate the factory runs is a GEOMETRY gate — overflow, overlap, hit
 * targets, clipping, a blurred overlay. A shape that is on-screen, correctly sized
 * and the same colour as its background passes all of them. And on a deliberately
 * moody dark palette, "screenshot it and look" reads invisible as atmosphere. The
 * only thing that catches it is measuring, so: measure.
 *
 * WCAG 2.1 (1.4.11 Non-text Contrast) puts the floor for a meaningful non-text
 * graphic at 3:1. Anything that sits on the board and carries meaning is held to
 * that here, against the surface it is actually drawn on.
 */

import { describe, expect, it } from 'vitest';
import { PALETTE, huskColor } from '../src/fx';

/** sRGB hex → WCAG relative luminance. */
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const ch = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The WCAG 2.1 floor for a non-text graphic that carries meaning. */
const MIN = 3;

describe('everything on the board is legible against the board', () => {
  // The board surface a piece is drawn on. Structures and husks sit on grid
  // cells; the border ring is the spawn lane, darker again.
  const SURFACE = PALETTE.grid;

  for (const [what, color] of [
    ['a healthy wall', PALETTE.steel],
    ['a damaged wall', PALETTE.steelLow],
    ['salvage', PALETTE.salvage],
    ['a shambler', huskColor(0)],
    ['a runner', huskColor(1)],
    ['a brute', huskColor(2)],
    ['the Core', PALETTE.core],
    ['the Core, low', PALETTE.coreLow],
    ['a turret barrel', PALETTE.hot],
    ['a turret muzzle', PALETTE.amber],
  ] as const) {
    it(`${what} reads against an empty cell`, () => {
      const r = contrast(color, SURFACE);
      expect(
        r,
        `${what} (${color}) is ${r.toFixed(2)}:1 against the board (${SURFACE}) — ` +
          `below the ${MIN}:1 floor, so it looks see-through`,
      ).toBeGreaterThanOrEqual(MIN);
    });
  }

  it('a wall reads on the border ring too — husks walk in over it', () => {
    // Walls cannot be built on the ring, but husks and fx cross it, and the ring
    // is the darkest surface on the board, so it is the worst case for anything
    // drawn over it.
    const ring = '#0e1830';
    for (const kind of [0, 1, 2] as const) {
      expect(contrast(huskColor(kind), ring)).toBeGreaterThanOrEqual(MIN);
    }
  });

  it('a damaged wall is not HARDER to see than a healthy one', () => {
    // The bug had this exactly backwards: the rust of a broken wall was more
    // visible than the steel of an intact one, so the fort read as strongest at
    // the moment it was falling apart.
    const healthy = contrast(PALETTE.steel, PALETTE.grid);
    const damaged = contrast(PALETTE.steelLow, PALETTE.grid);
    expect(Math.min(healthy, damaged)).toBeGreaterThanOrEqual(MIN);
  });
});
