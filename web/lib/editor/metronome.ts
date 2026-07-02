/**
 * Metronome: schedules click sounds on the editor's AudioContext, aligned to
 * absolute song time so it stays in sync with playback (and any tempo detected
 * from the track). Uses a lookahead scheduler (short oscillator blips).
 */

export class Metronome {
  private ctx: AudioContext;
  private out: AudioNode;
  bpm = 120;
  beatsPerBar = 4;
  enabled = false;

  private running = false;
  private rate = 1;
  private nextNoteTime = 0;
  private beat = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly lookahead = 0.1; // seconds scheduled ahead
  private readonly interval = 25; // scheduler tick, ms

  constructor(ctx: AudioContext, out: AudioNode) {
    this.ctx = ctx;
    this.out = out;
  }

  private secPerBeat(): number {
    return 60 / this.bpm;
  }

  private click(time: number, accent: boolean) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.frequency.value = accent ? 1600 : 1000;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.3, time + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    osc.connect(gain);
    gain.connect(this.out);
    osc.start(time);
    osc.stop(time + 0.06);
  }

  private schedule = () => {
    const spb = this.secPerBeat() / this.rate; // real seconds per beat at current speed
    while (this.nextNoteTime < this.ctx.currentTime + this.lookahead) {
      this.click(this.nextNoteTime, this.beat % this.beatsPerBar === 0);
      this.nextNoteTime += spb;
      this.beat += 1;
    }
  };

  /** Start clicking, aligned so beats land on absolute song time `fromSec`. */
  start(fromSec: number, rate = 1) {
    if (!this.enabled || this.running) return;
    this.rate = rate || 1;
    const spb = this.secPerBeat();
    const firstBeatIndex = Math.ceil(fromSec / spb - 1e-6);
    this.beat = firstBeatIndex;
    this.nextNoteTime = this.ctx.currentTime + (firstBeatIndex * spb - fromSec) / this.rate;
    this.running = true;
    this.timer = setInterval(this.schedule, this.interval);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get isRunning() {
    return this.running;
  }
}
