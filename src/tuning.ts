/**
 * tuning.ts — a tiny override hook so the balance sim can prove which constants
 * are load-bearing (principle #18). In the game these are just their defaults;
 * in a test, `withTuning({ ... }, fn)` runs `fn` with the constant changed so the
 * sim can show what breaks when it moves.
 *
 * Only constants a test actually pins live here — everything else stays inline.
 */

export interface Tuning {
  /**
   * Geometric husk-HP growth per wave. This is what GUARANTEES a run ends: a
   * well-built fort's turret DPS is roughly constant per prep-budget, so without a
   * husk term that grows geometrically the horde never out-scales the guns and the
   * Core never falls — the run would go forever. Flatten it toward 1.0 and the
   * deep tail explodes; balance.test.ts asserts exactly that.
   */
  RAMP_EXP: number;
}

const DEFAULT: Tuning = { RAMP_EXP: 1.1 };

let current: Tuning = { ...DEFAULT };

export function tuning(): Tuning {
  return current;
}

export function withTuning<T>(patch: Partial<Tuning>, fn: () => T): T {
  const prev = current;
  current = { ...current, ...patch };
  try {
    return fn();
  } finally {
    current = prev;
  }
}
