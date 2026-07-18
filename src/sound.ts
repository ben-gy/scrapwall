/**
 * sound.ts — procedural sound effects via the Web Audio API. Zero asset files.
 *
 * Generating SFX from oscillators keeps the bundle tiny and the site offline. Call
 * sfx.unlock() from the first user gesture (browsers block audio until then), then
 * sfx.play('fire'). Extended from patterns/sound.ts with Scrapwall's own patches.
 */

export type SfxName =
  | 'select'
  | 'place'
  | 'nope'
  | 'harvest'
  | 'fire'
  | 'splat'
  | 'crack'
  | 'break'
  | 'corehit'
  | 'repair'
  | 'wavestart'
  | 'waveclear'
  | 'lowammo'
  | 'beat'
  | 'go'
  | 'over'
  | 'win';

interface Patch {
  type: OscillatorType;
  /** [startFreq, endFreq] Hz — glides between them over `dur`. */
  freq: [number, number];
  dur: number;
  /** Peak gain 0..1. */
  gain?: number;
  /** Add a short noise burst (explosions/hits). */
  noise?: boolean;
}

const PATCHES: Record<SfxName, Patch> = {
  select: { type: 'triangle', freq: [520, 760], dur: 0.07, gain: 0.18 },
  place: { type: 'square', freq: [200, 120], dur: 0.09, gain: 0.22, noise: true },
  nope: { type: 'sawtooth', freq: [180, 100], dur: 0.12, gain: 0.18 },
  harvest: { type: 'square', freq: [740, 1180], dur: 0.1, gain: 0.16 },
  fire: { type: 'square', freq: [420, 180], dur: 0.05, gain: 0.12, noise: true },
  splat: { type: 'sawtooth', freq: [260, 70], dur: 0.14, gain: 0.2, noise: true },
  crack: { type: 'sawtooth', freq: [320, 160], dur: 0.06, gain: 0.16, noise: true },
  break: { type: 'sawtooth', freq: [200, 40], dur: 0.34, gain: 0.3, noise: true },
  corehit: { type: 'sawtooth', freq: [150, 50], dur: 0.28, gain: 0.34, noise: true },
  repair: { type: 'triangle', freq: [360, 620], dur: 0.12, gain: 0.16 },
  wavestart: { type: 'sawtooth', freq: [120, 300], dur: 0.5, gain: 0.28 },
  waveclear: { type: 'triangle', freq: [520, 1040], dur: 0.42, gain: 0.24 },
  lowammo: { type: 'square', freq: [660, 440], dur: 0.16, gain: 0.16 },
  beat: { type: 'square', freq: [440, 520], dur: 0.09, gain: 0.2 },
  go: { type: 'triangle', freq: [620, 1240], dur: 0.32, gain: 0.26 },
  over: { type: 'sawtooth', freq: [300, 80], dur: 0.6, gain: 0.32, noise: true },
  win: { type: 'triangle', freq: [520, 1180], dur: 0.5, gain: 0.26 },
};

export interface Sfx {
  unlock(): void;
  play(name: SfxName): void;
  muted(): boolean;
  setMuted(m: boolean): void;
}

export function createSfx(initialMuted = false): Sfx {
  let ctx: AudioContext | null = null;
  let muted = initialMuted;

  const ensure = (): AudioContext | null => {
    if (!ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  };

  const noiseBuffer = (ac: AudioContext, dur: number): AudioBuffer => {
    const len = Math.floor(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  };

  return {
    unlock() {
      ensure();
    },
    play(name) {
      if (muted) return;
      const ac = ensure();
      if (!ac) return;
      const p = PATCHES[name];
      const t0 = ac.currentTime;
      const g = ac.createGain();
      g.gain.setValueAtTime(p.gain ?? 0.25, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + p.dur);
      g.connect(ac.destination);

      const osc = ac.createOscillator();
      osc.type = p.type;
      osc.frequency.setValueAtTime(p.freq[0], t0);
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, p.freq[1]), t0 + p.dur);
      osc.connect(g);
      osc.start(t0);
      osc.stop(t0 + p.dur);

      if (p.noise) {
        const n = ac.createBufferSource();
        n.buffer = noiseBuffer(ac, p.dur);
        const ng = ac.createGain();
        ng.gain.setValueAtTime((p.gain ?? 0.25) * 0.6, t0);
        ng.gain.exponentialRampToValueAtTime(0.0001, t0 + p.dur);
        n.connect(ng);
        ng.connect(ac.destination);
        n.start(t0);
        n.stop(t0 + p.dur);
      }
    },
    muted: () => muted,
    setMuted(m) {
      muted = m;
    },
  };
}
