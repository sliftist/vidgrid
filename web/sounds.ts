// UI sound effects, synthesized in real time with the Web Audio API — no
// sample files. Each sound is rendered once into an AudioBuffer via an
// OfflineAudioContext and cached by name; replaying just spins up a cheap
// BufferSource from the cached buffer. Rendering is fast enough that we
// render lazily on first play rather than preloading.
//
// Everything is lazy: the AudioContext is created on the first playSound
// (which always happens inside a user gesture, so resume() succeeds), and
// nothing touches the audio API at import time.

export type SoundName =
    | "modalOpen"
    | "modalClose"
    | "toggle"
    | "scanStart"
    | "videoOpen"
    | "play"
    | "pause"
    | "heyGoogle"
    | "heyGoogleBack"
    | "navMove"
    | "majorAction";

interface SoundDef {
    duration: number;
    build(ctx: BaseAudioContext, dest: AudioNode): void;
}

const SILENCE = 0.0001;

// One-shot amplitude envelope: linear attack from silence to peak, then an
// exponential decay back to silence. Exponential ramps can't originate from
// 0, hence the linear attack and the SILENCE floor on the decay target.
function ampEnv(g: AudioParam, peak: number, attack: number, end: number) {
    g.setValueAtTime(0, 0);
    g.linearRampToValueAtTime(peak, attack);
    g.exponentialRampToValueAtTime(SILENCE, end);
}

function noiseSource(ctx: BaseAudioContext, dur: number): AudioBufferSourceNode {
    const len = Math.max(1, Math.ceil(dur * ctx.sampleRate));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    return src;
}

// Noise swept through a bandpass — the shared body of the modal open/close
// and video-open whooshes. The center frequency glides f0→f1 over the
// duration; the gain swells in over `attackFrac` then decays out.
function noiseSweep(ctx: BaseAudioContext, dest: AudioNode, opts: {
    dur: number; f0: number; f1: number; q: number; gain: number; attackFrac: number;
}) {
    const { dur, f0, f1, q, gain, attackFrac } = opts;
    const noise = noiseSource(ctx, dur);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = q;
    bp.frequency.setValueAtTime(f0, 0);
    bp.frequency.linearRampToValueAtTime(f1, dur);
    const g = ctx.createGain();
    ampEnv(g.gain, gain, dur * attackFrac, dur);
    noise.connect(bp).connect(g).connect(dest);
    noise.start(0);
    noise.stop(dur);
}

// Shepard tone: `voices` sine oscillators evenly spread across `rangeOct`
// octaves above `base`, each gliding upward at `speed` oct/s and wrapping to
// the bottom at the top. A Gaussian over each voice's position fades it in at
// the bottom and out at the top, so the wrap discontinuity lands where the
// voice is silent and stays inaudible — producing the endless-rise illusion.
function buildShepard(ctx: BaseAudioContext, dest: AudioNode, opts: {
    base: number; rangeOct: number; voices: number; speed: number;
    lowpassHz: number; fadeIn: number; hold: number; trail: number; outGain: number;
}): number {
    const { base, rangeOct, voices, speed, lowpassHz, fadeIn, hold, trail, outGain } = opts;
    const dur = fadeIn + hold + trail;

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = lowpassHz;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;

    const master = ctx.createGain();
    master.gain.setValueAtTime(0, 0);
    master.gain.linearRampToValueAtTime(outGain, fadeIn);
    master.gain.setValueAtTime(outGain, fadeIn + hold);
    master.gain.linearRampToValueAtTime(0, dur);

    lp.connect(limiter);
    limiter.connect(master);
    master.connect(dest);

    const steps = Math.max(2, Math.ceil(dur * 60));
    const sigma = rangeOct / 5;
    const norm = 1 / Math.sqrt(voices);
    for (let v = 0; v < voices; v++) {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        const g = ctx.createGain();
        const freqCurve = new Float32Array(steps);
        const gainCurve = new Float32Array(steps);
        const startPos = (v / voices) * rangeOct;
        for (let s = 0; s < steps; s++) {
            const t = (s / (steps - 1)) * dur;
            const pos = (startPos + speed * t) % rangeOct;
            freqCurve[s] = base * Math.pow(2, pos);
            const d = pos - rangeOct / 2;
            gainCurve[s] = Math.exp(-(d * d) / (2 * sigma * sigma)) * norm;
        }
        osc.frequency.setValueCurveAtTime(freqCurve, 0, dur);
        g.gain.setValueCurveAtTime(gainCurve, 0, dur);
        osc.connect(g);
        g.connect(lp);
        osc.start(0);
        osc.stop(dur);
    }
    return dur;
}

// Staggered arpeggio of triangle notes (each lowpassed, plucked envelope).
// Pass freqs ascending for a rising figure, descending for a falling one.
function buildArpeggio(ctx: BaseAudioContext, dest: AudioNode, freqs: number[]) {
    const spread = 0.1;
    const decay = 0.32;
    const master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(dest);
    freqs.forEach((freq, i) => {
        const t0 = i * spread;
        const osc = ctx.createOscillator();
        osc.type = "triangle";
        osc.frequency.value = freq;
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 4200;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(1, t0 + 0.008);
        g.gain.exponentialRampToValueAtTime(SILENCE, t0 + decay);
        osc.connect(lp).connect(g).connect(master);
        osc.start(t0);
        osc.stop(t0 + decay + 0.02);
    });
}

const SOUNDS: Record<SoundName, SoundDef> = {
    modalOpen: {
        duration: 0.32,
        build: (ctx, dest) => noiseSweep(ctx, dest, {
            dur: 0.32, f0: 318, f1: 1680, q: 6, gain: 0.25, attackFrac: 0.3,
        }),
    },
    modalClose: {
        duration: 0.16,
        build: (ctx, dest) => noiseSweep(ctx, dest, {
            dur: 0.16, f0: 780, f1: 6300, q: 6, gain: 0.35, attackFrac: 0.3,
        }),
    },
    videoOpen: {
        duration: 0.3,
        build: (ctx, dest) => noiseSweep(ctx, dest, {
            dur: 0.3, f0: 300, f1: 5350, q: 5.2, gain: 0.5, attackFrac: 0.6,
        }),
    },
    majorAction: {
        duration: 3.0,
        build: (ctx, dest) => buildShepard(ctx, dest, {
            base: 33, rangeOct: 6, voices: 6, speed: 0.2, lowpassHz: 4000,
            fadeIn: 0.5, hold: 0.5, trail: 2.0, outGain: 0.5,
        }),
    },
    toggle: {
        duration: 0.09,
        build: (ctx, dest) => {
            const dur = 0.09;
            const osc = ctx.createOscillator();
            osc.type = "sine";
            osc.frequency.setValueAtTime(373, 0);
            osc.frequency.exponentialRampToValueAtTime(200, 0.076);
            const g = ctx.createGain();
            ampEnv(g.gain, 0.55, 0.004, dur);
            osc.connect(g).connect(dest);
            osc.start(0);
            osc.stop(dur);
        },
    },
    play: {
        duration: 0.12,
        build: (ctx, dest) => {
            const dur = 0.12;
            const osc = ctx.createOscillator();
            osc.type = "sine";
            osc.frequency.setValueAtTime(1800, 0);
            osc.frequency.exponentialRampToValueAtTime(2403, dur * 0.6);
            const g = ctx.createGain();
            ampEnv(g.gain, 0.5, 0.005, dur);
            osc.connect(g).connect(dest);
            osc.start(0);
            osc.stop(dur);
        },
    },
    pause: {
        duration: 0.5,
        build: (ctx, dest) => {
            // Bell: three consonant (harmonic) sine partials; upper partials
            // are quieter and decay faster, so it rings sweet, not metallic.
            const partials = [
                { freq: 1320, amp: 1.0, decay: 0.5 },
                { freq: 2640, amp: 0.25, decay: 0.3 },
                { freq: 3960, amp: 0.13, decay: 0.3 },
            ];
            const master = ctx.createGain();
            master.gain.value = 0.45;
            master.connect(dest);
            for (const p of partials) {
                const osc = ctx.createOscillator();
                osc.type = "sine";
                osc.frequency.value = p.freq;
                const g = ctx.createGain();
                ampEnv(g.gain, p.amp, 0.005, p.decay);
                osc.connect(g).connect(master);
                osc.start(0);
                osc.stop(p.decay);
            }
        },
    },
    heyGoogle: {
        // Rising arpeggio: root, +4, +7, +12 semitones, staggered.
        duration: 0.62,
        build: (ctx, dest) => buildArpeggio(ctx, dest, [520, 655, 779, 1040]),
    },
    heyGoogleBack: {
        // The heyGoogle arpeggio in reverse — a descending counterpart for
        // leaving the page.
        duration: 0.62,
        build: (ctx, dest) => buildArpeggio(ctx, dest, [1040, 779, 655, 520]),
    },
    scanStart: {
        duration: 1.5,
        build: (ctx, dest) => {
            const dur = 1.5;
            const lp = ctx.createBiquadFilter();
            lp.type = "lowpass";
            lp.frequency.value = 3000;
            // Slow LFO gently sweeps the cutoff for movement.
            const lfo = ctx.createOscillator();
            lfo.type = "sine";
            lfo.frequency.value = 0.1;
            const lfoGain = ctx.createGain();
            lfoGain.gain.value = 1000;
            lfo.connect(lfoGain).connect(lp.frequency);
            lfo.start(0);
            lfo.stop(dur);

            const master = ctx.createGain();
            master.gain.setValueAtTime(0, 0);
            master.gain.linearRampToValueAtTime(0.4, 0.5);
            master.gain.setValueAtTime(0.4, 0.7);
            master.gain.linearRampToValueAtTime(0, dur);
            lp.connect(master).connect(dest);

            for (const cents of [-8, 0, 8]) {
                const osc = ctx.createOscillator();
                osc.type = "sawtooth";
                osc.frequency.value = 140;
                osc.detune.value = cents;
                osc.connect(lp);
                osc.start(0);
                osc.stop(dur);
            }
        },
    },
    navMove: {
        duration: 0.025,
        build: (ctx, dest) => {
            const dur = 0.025;
            const master = ctx.createGain();
            master.gain.value = 0.6;
            master.connect(dest);

            const osc = ctx.createOscillator();
            osc.type = "triangle";
            osc.frequency.value = 1000;
            const og = ctx.createGain();
            ampEnv(og.gain, 1, 0.001, dur);
            osc.connect(og).connect(master);
            osc.start(0);
            osc.stop(dur);

            const noise = noiseSource(ctx, dur);
            const hp = ctx.createBiquadFilter();
            hp.type = "highpass";
            hp.frequency.value = 600;
            const ng = ctx.createGain();
            ampEnv(ng.gain, 0.09, 0.001, dur);
            noise.connect(hp).connect(ng).connect(master);
            noise.start(0);
            noise.stop(dur);
        },
    },
};

let audioCtx: AudioContext | undefined;
function getCtx(): AudioContext | undefined {
    const Ctor: typeof AudioContext | undefined =
        (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext;
    if (!Ctor) return undefined;
    if (!audioCtx) audioCtx = new Ctor();
    return audioCtx;
}

const bufferCache = new Map<SoundName, Promise<AudioBuffer>>();

function renderSound(name: SoundName, sampleRate: number): Promise<AudioBuffer> {
    let p = bufferCache.get(name);
    if (!p) {
        const def = SOUNDS[name];
        const Ctor: typeof OfflineAudioContext | undefined =
            (globalThis as any).OfflineAudioContext ?? (globalThis as any).webkitOfflineAudioContext;
        const frames = Math.ceil(def.duration * sampleRate) + 64;
        const octx = new Ctor!(2, frames, sampleRate);
        def.build(octx, octx.destination);
        p = octx.startRendering();
        bufferCache.set(name, p);
    }
    return p;
}

export function playSound(name: SoundName): void {
    const ctx = getCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume();
    void renderSound(name, ctx.sampleRate).then(buffer => {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.start();
    });
}
