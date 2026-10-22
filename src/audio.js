import { clamp, mulberry32 } from "./utils.js";

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

/** Dmaj9 — Bm9 — Gmaj9 — A6/9, a slow, warm waltz in the last light. */
const CHORDS = [
  [62, 66, 69, 73, 76], // Dmaj9
  [59, 62, 66, 69, 73], // Bm9
  [55, 59, 62, 66, 69], // Gmaj9
  [57, 61, 64, 66, 71], // A6/9
];

const PENTATONIC = [74, 76, 78, 81, 83, 86, 88, 90];

export class Soundscape {
  constructor() {
    this.ctx = null;
    this.started = false;
    this.muted = localStorage.getItem("sky-muted") === "1";
    this.nextChordTime = 0;
    this.nextPluckTime = 0;
    this.chordIndex = 0;
    this.pluckIndex = 0;
    this.scheduler = null;
    this.rng = mulberry32(741);
    this.active = false;
    this.paused = false;
  }

  async start() {
    if (this.started) {
      if (this.ctx?.state === "suspended") await this.ctx.resume();
      return;
    }
    this.started = true;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = (this.ctx = new Ctx());

    const master = (this.master = ctx.createGain());
    master.gain.value = this.muted ? 0 : 0.82;

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 20;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.02;
    compressor.release.value = 0.35;
    master.connect(compressor).connect(ctx.destination);

    // A long, soft hall.
    const convolver = ctx.createConvolver();
    convolver.buffer = this.makeImpulse(ctx, 4.6, 2.1);
    const wet = ctx.createGain();
    wet.gain.value = 0.36;
    convolver.connect(wet).connect(master);
    this.reverb = convolver;

    // Wind: filtered loopable noise with two slow gusts.
    const noise = ctx.createBuffer(1, ctx.sampleRate * 5, ctx.sampleRate);
    const data = noise.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      brown = (brown + white * 0.018) / 1.018;
      data[i] = brown * 2.4;
    }
    this.noiseBuffer = noise;
    const wind = ctx.createBufferSource();
    wind.buffer = noise;
    wind.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = "lowpass";
    windFilter.frequency.value = 380;
    windFilter.Q.value = 0.5;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.14;
    wind.connect(windFilter).connect(windGain).connect(master);
    wind.start();

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.075;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.06;
    lfo.connect(lfoGain).connect(windGain.gain);
    lfo.start();
    this.windGain = windGain;

    // Music busses.
    this.padBus = ctx.createGain();
    this.padBus.gain.value = 0.13;
    this.padBus.connect(master);
    this.padBus.connect(convolver);

    this.pluckBus = ctx.createGain();
    this.pluckBus.gain.value = 0.16;
    this.pluckBus.connect(master);
    this.pluckBus.connect(convolver);

    // A short echo for the little falling stars.
    const delay = ctx.createDelay(1.2);
    delay.delayTime.value = 0.39;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.27;
    const delayGain = ctx.createGain();
    delayGain.gain.value = 0.16;
    this.pluckBus.connect(delay);
    delay.connect(feedback).connect(delay);
    delay.connect(delayGain).connect(master);

    this.nextChordTime = ctx.currentTime + 0.25;
    this.nextPluckTime = ctx.currentTime + 1.2;
    this.chordIndex = 0;
    this.pluckIndex = 0;
    this.scheduler = window.setInterval(() => this.schedule(), 220);
    this.schedule();
  }

  makeImpulse(ctx, seconds, decay) {
    const length = Math.floor(ctx.sampleRate * seconds);
    const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const channel = impulse.getChannelData(c);
      for (let i = 0; i < length; i++) {
        channel[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return impulse;
  }

  schedule() {
    if (!this.ctx || this.paused) return;
    const ctx = this.ctx;
    const beat = 60 / 62;
    const chordLength = beat * 4;
    while (this.nextChordTime < ctx.currentTime + 1.6) {
      this.playPad(CHORDS[this.chordIndex], this.nextChordTime, chordLength);
      if (this.chordIndex % 2 === 0) this.playBellAccent(this.nextChordTime + beat * 2);
      this.chordIndex = (this.chordIndex + 1) % CHORDS.length;
      this.nextChordTime += chordLength;
    }

    while (this.nextPluckTime < ctx.currentTime + 1.4) {
      const chord = CHORDS[this.chordIndex];
      const note = chord[2 + (this.pluckIndex % 3)] + 12;
      const pan = Math.sin(this.pluckIndex * 1.7) * 0.65;
      this.playPluck(midi(note), this.nextPluckTime, 0.065, pan, 1.1);
      if (this.pluckIndex % 4 === 2) {
        const sparkle = PENTATONIC[(this.pluckIndex * 3) % PENTATONIC.length];
        this.playPluck(midi(sparkle), this.nextPluckTime + beat * 0.5, 0.028, -pan, 0.7);
      }
      this.nextPluckTime += beat * 0.5;
      this.pluckIndex++;
    }
  }

  playPad(notes, when, duration) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(520, when);
    filter.frequency.linearRampToValueAtTime(1150, when + duration * 0.45);
    filter.frequency.linearRampToValueAtTime(700, when + duration);
    filter.Q.value = 0.55;
    filter.connect(this.padBus);

    notes.forEach((note, index) => {
      const freq = midi(note);
      const gain = ctx.createGain();
      const peak = 0.09 / Math.sqrt(index + 1.2);
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.linearRampToValueAtTime(peak, when + 1.35);
      gain.gain.setValueAtTime(peak, when + duration * 0.65);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + duration + 1.2);

      for (let d = 0; d < 2; d++) {
        const osc = ctx.createOscillator();
        osc.type = d === 0 ? "triangle" : "sine";
        osc.frequency.value = freq;
        osc.detune.value = d === 0 ? -5 : 6;
        osc.connect(gain);
        osc.start(when);
        osc.stop(when + duration + 1.3);
      }
      gain.connect(filter);
    });
  }

  playPluck(freq, when, volume = 0.08, pan = 0, length = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(volume, when + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 1.2 * length);

    const panner = ctx.createStereoPanner();
    panner.pan.value = clamp(pan, -1, 1);

    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    osc.connect(gain);

    const shimmer = ctx.createOscillator();
    shimmer.type = "triangle";
    shimmer.frequency.value = freq * 2.003;
    const shimmerGain = ctx.createGain();
    shimmerGain.gain.value = 0.18;
    shimmer.connect(shimmerGain).connect(gain);

    gain.connect(panner).connect(this.pluckBus);
    osc.start(when);
    shimmer.start(when);
    osc.stop(when + 1.3 * length);
    shimmer.stop(when + 1.3 * length);
  }

  playBellAccent(when) {
    if (!this.ctx) return;
    this.playPluck(midi(86), when, 0.018, 0.3, 1.7);
    this.playPluck(midi(93), when + 0.32, 0.011, -0.2, 2);
  }

  /** Reward chime, stepping up with the combo. */
  ringChime(combo = 1) {
    if (!this.ctx || this.muted) return;
    const now = this.ctx.currentTime + 0.01;
    const notes = [74, 78, 81, 83, 86, 88, 90, 93];
    const n = notes[(combo - 1) % notes.length];
    this.playPluck(midi(n), now, 0.14, -0.25, 1.5);
    this.playPluck(midi(n + 7), now + 0.085, 0.08, 0.3, 1.9);
    this.playPluck(midi(n + 12), now + 0.17, 0.045, -0.1, 2.2);
  }

  miss() {
    if (!this.ctx || this.muted) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(310, now);
    osc.frequency.exponentialRampToValueAtTime(235, now + 0.4);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.035, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
    osc.connect(gain).connect(this.master);
    osc.start(now);
    osc.stop(now + 0.6);
  }

  boost() {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.playbackRate.value = 1.35;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(350, now);
    filter.frequency.exponentialRampToValueAtTime(1700, now + 0.6);
    filter.Q.value = 0.7;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.11, now + 0.12);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.85);
    source.connect(filter).connect(gain).connect(this.master);
    source.start(now, Math.random() * 2);
    source.stop(now + 0.9);
  }

  bump() {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(115, now);
    osc.frequency.exponentialRampToValueAtTime(48, now + 0.28);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
    osc.connect(gain).connect(this.master);
    osc.start(now);
    osc.stop(now + 0.52);
    this.playPluck(midi(50), now, 0.07, 0, 0.8);
  }

  softClick() {
    if (!this.ctx || this.muted) return;
    const now = this.ctx.currentTime;
    this.playPluck(midi(81), now, 0.035, 0.2, 0.4);
  }

  setMuted(muted) {
    this.muted = muted;
    localStorage.setItem("sky-muted", muted ? "1" : "0");
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(muted ? 0 : 0.82, t, 0.18);
  }

  setPaused(paused) {
    this.paused = paused;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (paused) {
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(0.16, t, 0.4);
    } else {
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(this.muted ? 0 : 0.82, t, 0.4);
      this.nextChordTime = Math.max(this.nextChordTime, t + 0.2);
      this.nextPluckTime = Math.max(this.nextPluckTime, t + 0.4);
    }
  }

  suspend() {
    if (this.ctx?.state === "running") this.ctx.suspend();
  }

  resume() {
    if (this.ctx?.state === "suspended") this.ctx.resume();
  }
}
