export const durationFor = (bib) =>
  bib === "001" ? 30000 : 31000 + Number(bib) * 1300;

export function formatTimingEvent(event, format = "vola") {
  if (format === "jsonl") return JSON.stringify(event) + "\n";
  const micros = String(Math.round(event.timestampMs * 1000)).padStart(7, "0");
  return `NR;${event.type === "start" ? 0 : 1};;${event.bib};;;${micros}\r\n`;
}

export class SimulatorRace {
  constructor(roster, emit = () => {}) {
    this.roster = roster;
    this.emit = emit;
    this.speed = 1;
    this.reset();
  }
  reset() {
    this.running = false;
    this.pauseAfterFinish = false;
    this.current = null;
    this.nextIndex = 0;
    this.clockMs = 36000000;
    this.results = new Map();
  }
  startRacer() {
    const racer = this.roster[this.nextIndex++ % this.roster.length];
    this.current = {
      ...racer,
      elapsedMs: 0,
      durationMs: durationFor(racer.bib),
      startedAtMs: this.clockMs,
    };
    this.emit({
      type: "start",
      bib: racer.bib,
      timeMs: 0,
      timestampMs: this.clockMs,
    });
  }
  finishRacer() {
    const racer = this.current;
    if (!racer) return;
    this.clockMs = racer.startedAtMs + racer.durationMs;
    this.emit({
      type: "finish",
      bib: racer.bib,
      timeMs: racer.durationMs,
      timestampMs: this.clockMs,
    });
    this.results.set(racer.bib, {
      bib: racer.bib,
      name: racer.name,
      category: racer.category,
      timeMs: racer.durationMs,
    });
    this.current = null;
    if (this.pauseAfterFinish) {
      this.running = false;
      this.pauseAfterFinish = false;
    }
  }
  tick(milliseconds) {
    if (!this.running) return;
    if (!this.current) this.startRacer();
    const advance = milliseconds * this.speed;
    this.clockMs += advance;
    this.current.elapsedMs += advance;
    if (this.current.elapsedMs >= this.current.durationMs) this.finishRacer();
  }
  control(action, speed) {
    if (speed !== undefined) {
      speed = Number(speed);
      if (!Number.isFinite(speed) || speed < 1 || speed > 100)
        throw new Error("Speed must be between 1 and 100.");
    }
    if (!["start", "pause", "next", "reset", "speed"].includes(action))
      throw new Error("Unknown control action.");
    if (speed !== undefined) this.speed = speed;
    if (action === "start") {
      this.running = true;
      this.pauseAfterFinish = false;
      if (!this.current) this.startRacer();
    }
    if (action === "pause") {
      if (this.current) this.pauseAfterFinish = true;
      else this.running = false;
    }
    if (action === "next") {
      if (this.current) this.finishRacer();
      else this.startRacer();
    }
    if (action === "reset") this.reset();
  }
  state() {
    return {
      test: true,
      running: this.running,
      pauseAfterFinish: this.pauseAfterFinish,
      speed: this.speed,
      current: this.current,
      results: [...this.results.values()].sort((a, b) => a.timeMs - b.timeMs),
      nextBib: this.roster[this.nextIndex % this.roster.length].bib,
    };
  }
}
