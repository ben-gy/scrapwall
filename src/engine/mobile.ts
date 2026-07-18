/**
 * mobile.ts — the parts of "never zoom, never feel like a web page" that CSS
 * cannot express on its own.
 *
 * Pair with mobile.css. Call `hardenViewport()` once at boot, before the first
 * screen renders.
 *
 *   import { hardenViewport } from './engine/mobile';
 *   hardenViewport();
 *
 * Why any of this is needed: `<meta name="viewport" content="user-scalable=no">`
 * is ignored by iOS Safari (deliberately, since iOS 10). mobile.css's
 * `touch-action: manipulation` kills double-tap zoom, but PINCH zoom on iOS only
 * stops if you cancel the proprietary `gesture*` events — and a zoomed-in game
 * with no way back out is unplayable.
 *
 * COPY THIS FILE into src/engine/.
 */

export interface HardenOptions {
  pinch?: boolean;
  doubleTap?: boolean;
  vhUnit?: boolean;
}

/** Undo everything hardenViewport() installed. Mostly for tests. */
export type Unharden = () => void;

export function hardenViewport(opts: HardenOptions = {}): Unharden {
  const { pinch = true, doubleTap = true, vhUnit = true } = opts;
  const offs: (() => void)[] = [];

  const on = <K extends string>(
    target: EventTarget,
    type: K,
    fn: (e: Event) => void,
    options?: AddEventListenerOptions,
  ): void => {
    target.addEventListener(type, fn, options);
    offs.push(() => target.removeEventListener(type, fn, options));
  };

  if (pinch) {
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      on(document, type, (e) => e.preventDefault(), { passive: false });
    }
    on(
      document,
      'touchmove',
      (e) => {
        if ((e as TouchEvent).touches.length > 1) e.preventDefault();
      },
      { passive: false },
    );
  }

  if (doubleTap) {
    let lastTap = 0;
    on(
      document,
      'touchend',
      (e) => {
        const t = Date.now();
        if (t - lastTap < 320) e.preventDefault();
        lastTap = t;
      },
      { passive: false },
    );
    on(document, 'dblclick', (e) => e.preventDefault(), { passive: false });
  }

  if (vhUnit) {
    const setVh = (): void => {
      const h = window.innerHeight;
      if (h > 0) document.documentElement.style.setProperty('--vh', `${h * 0.01}px`);
    };
    setVh();
    on(window, 'resize', setVh);
    on(window, 'orientationchange', setVh);
    on(document, 'visibilitychange', setVh);
  }

  return () => {
    for (const off of offs) off();
  };
}
