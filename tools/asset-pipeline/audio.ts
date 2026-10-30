/**
 * audio.ts — the free set's sound: a synthesized stand-in for every sound, speech and music file the
 * INI corpus refers to.
 *
 * The engine builds file names from the INIs (AudioEventRTS::generateFilename):
 *   AudioEvent  Sounds / Attack / Decay = name …  ->  Data\Audio\Sounds\<name>.wav
 *   DialogEvent Filename = x.wav                  ->  Data\Audio\Speech\x.wav      (streamed)
 *   MusicTrack  Filename = x.mp3                  ->  Data\Audio\Tracks\x.mp3      (streamed)
 * Each file gets one of a few dozen archetypes, picked from the event's name, file name, Type and
 * Control (a voice line chirps, a gun cracks, an explosion rumbles, a looping engine hums …). The
 * archive stores each archetype once: every entry of the same archetype points at the same bytes
 * (buildBig shares identical Buffer objects), so ~7 800 names cost a few hundred KB of data.
 *
 * All sound is generated here (no recordings, nothing third-party): 22 050 Hz, 16-bit mono PCM WAV.
 * Music tracks are WAV data under their .mp3 names — the web audio bridge sniffs the container.
 *
 * Usage (from build-free-assets.ts): const a = buildFreeAudio(patchDataDir);
 *   buildBig(a.sounds) -> AudioZH.big (sounds + speech), buildBig(a.music) -> MusicZH.big
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const RATE = 22050;

// ---------------------------------------------------------------------------------------------
// INI scan
// ---------------------------------------------------------------------------------------------
export interface AudioRef { kind: "sound" | "speech" | "music"; file: string; event: string; type: string; loop: boolean }

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.ini$/i.test(e)) out.push(p);
  }
  return out;
}

/** Every audio file the INIs name, once per file name (the first event naming it describes it). */
export function collectAudioRefs(patchDataDir: string): AudioRef[] {
  const seen = new Map<string, AudioRef>();
  for (const f of walk(join(patchDataDir, "INI"))) {
    let block: { kind: string; name: string; type: string; loop: boolean; sounds: string[]; filename: string } | null = null;
    const flush = () => {
      if (!block) return;
      const add = (kind: AudioRef["kind"], file: string) => {
        const key = `${kind}:${file.toLowerCase()}`;
        if (!seen.has(key)) seen.set(key, { kind, file, event: block!.name, type: block!.type, loop: block!.loop });
      };
      if (block.kind === "AudioEvent") for (const s of block.sounds) add("sound", s);
      else if (block.kind === "DialogEvent" && block.filename) add("speech", block.filename);
      else if (block.kind === "MusicTrack" && block.filename && !/^nofilename$/i.test(block.filename)) add("music", block.filename);
      block = null;
    };
    for (const raw of readFileSync(f, "latin1").split(/\r?\n/)) {
      const line = raw.replace(/;.*$/, "").trim();
      if (!line) continue;
      let m: RegExpExecArray | null;
      if ((m = /^(AudioEvent|DialogEvent|MusicTrack)\s+(\S+)/.exec(line))) {
        flush();
        block = { kind: m[1], name: m[2], type: "", loop: false, sounds: [], filename: "" };
        continue;
      }
      if (!block) continue;
      if (/^End$/i.test(line)) { flush(); continue; }
      if ((m = /^(Sounds|Attack|Decay)\s*=\s*(.*)$/i.exec(line))) block.sounds.push(...m[2].split(/\s+/).filter(Boolean));
      else if ((m = /^Filename\s*=\s*(\S+)/i.exec(line))) block.filename = m[1];
      else if ((m = /^Type\s*=\s*(.*)$/i.exec(line))) block.type = m[1].toLowerCase();
      else if ((m = /^Control\s*=\s*(.*)$/i.exec(line))) block.loop = /\bloop\b/i.test(m[1]);
    }
    flush();
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------------------------
// synthesis
// ---------------------------------------------------------------------------------------------
type Signal = Float32Array;

/** Deterministic noise (each archetype has its own seed: builds are reproducible). */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 2 ** 31 - 1; };
}
const secs = (n: number) => new Float32Array(Math.max(1, Math.round(n * RATE)));

/** One-pole low-pass over a signal, cutoff in Hz (constant or per-sample function of t). */
function lowpass(x: Signal, cutoff: number | ((t: number) => number)): Signal {
  const y = new Float32Array(x.length);
  let v = 0;
  for (let i = 0; i < x.length; i++) {
    const fc = typeof cutoff === "number" ? cutoff : cutoff(i / RATE);
    const a = 1 - Math.exp((-2 * Math.PI * fc) / RATE);
    v += a * (x[i] - v);
    y[i] = v;
  }
  return y;
}
function noise(len: number, seed: number): Signal {
  const r = rng(seed), x = secs(len);
  for (let i = 0; i < x.length; i++) x[i] = r();
  return x;
}
/** Exponential decay envelope with a short attack. */
function env(x: Signal, attack: number, decay: number): Signal {
  for (let i = 0; i < x.length; i++) {
    const t = i / RATE;
    x[i] *= Math.min(1, t / Math.max(attack, 1e-4)) * Math.exp(-t / decay);
  }
  return x;
}
/** A tone sweeping from f0 to f1 (Hz) with the given waveform. */
function tone(len: number, f0: number, f1: number, wave: "sine" | "square" | "saw" | "tri" = "sine"): Signal {
  const x = secs(len);
  let ph = 0;
  for (let i = 0; i < x.length; i++) {
    const f = f0 + (f1 - f0) * (i / x.length);
    ph += f / RATE;
    const p = ph - Math.floor(ph);
    x[i] = wave === "sine" ? Math.sin(2 * Math.PI * p) : wave === "square" ? (p < 0.5 ? 1 : -1)
      : wave === "saw" ? 2 * p - 1 : 1 - 4 * Math.abs(p - 0.5);
  }
  return x;
}
function mix(...parts: [Signal, number][]): Signal {
  const len = Math.max(...parts.map(([s]) => s.length));
  const y = new Float32Array(len);
  for (const [s, g] of parts) for (let i = 0; i < s.length; i++) y[i] += s[i] * g;
  return y;
}
function concat(...parts: Signal[]): Signal {
  const y = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { y.set(p, o); o += p.length; }
  return y;
}
/** Scale to a peak level; fade the last few ms so nothing clicks. */
function finish(x: Signal, peak = 0.5, fade = 0.008): Signal {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  const g = m > 0 ? peak / m : 0;
  const n = Math.min(x.length, Math.round(fade * RATE));
  for (let i = 0; i < x.length; i++) x[i] *= g * (i >= x.length - n ? (x.length - i) / n : 1);
  return x;
}

export function wav(x: Signal): Buffer {
  const data = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "latin1"); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8, "latin1");
  h.write("fmt ", 12, "latin1"); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36, "latin1"); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// ---- archetypes ------------------------------------------------------------------------------
const VOICE_PITCH = [520, 600, 680, 760, 440, 840];

const ARCHETYPES: Record<string, () => Signal> = {
  click: () => finish(env(mix([tone(0.04, 2200, 1800, "square"), 0.3], [noise(0.04, 7), 0.2]), 0.001, 0.008), 0.45),
  uiBlip: () => finish(env(tone(0.12, 880, 1320, "tri"), 0.004, 0.05), 0.4),
  uiAlert: () => finish(concat(env(tone(0.11, 988, 988, "tri"), 0.004, 0.06), env(tone(0.16, 740, 740, "tri"), 0.004, 0.08)), 0.45),
  // unit acknowledgements: a two-note radio chirp under a band-limited hiss, six pitches
  ...Object.fromEntries(VOICE_PITCH.map((f, i) => [`voice${i}`, () => {
    const a = env(tone(0.09, f, f * 1.12, "square"), 0.004, 0.07);
    const b = env(tone(0.12, f * 1.26, f * 1.18, "square"), 0.004, 0.08);
    const body = lowpass(concat(a, secs(0.02), b), 2600);
    return finish(mix([body, 1], [env(lowpass(noise(0.25, 30 + i), 3000), 0.002, 0.2), 0.08]), 0.42);
  }])),
  speech0: () => speech(1.2, 11),
  speech1: () => speech(0.9, 12),
  speech2: () => speech(1.5, 13),
  gun: () => finish(env(lowpass(noise(0.16, 21), (t) => 6000 * Math.exp(-t * 30) + 400), 0.001, 0.04), 0.55),
  autogun: () => finish(concat(...[0, 1, 2, 3].map((k) => concat(env(lowpass(noise(0.07, 22 + k), 4500), 0.001, 0.02), secs(0.02)))), 0.5),
  cannon: () => finish(mix(
    [env(lowpass(noise(0.7, 23), (t) => 1800 * Math.exp(-t * 8) + 120), 0.002, 0.18), 1],
    [env(tone(0.5, 90, 45), 0.002, 0.15), 0.6]), 0.6),
  missile: () => finish(mix(
    [env(lowpass(noise(0.9, 24), (t) => 900 + 3000 * t), 0.08, 0.5), 1],
    [env(tone(0.9, 300, 700, "saw"), 0.1, 0.4), 0.08]), 0.5),
  laser: () => finish(env(tone(0.35, 2400, 300, "saw"), 0.002, 0.12), 0.35),
  flame: () => finish(env(lowpass(noise(0.8, 25), 1400), 0.06, 0.4), 0.5),
  explosionSmall: () => finish(mix(
    [env(lowpass(noise(1.0, 26), (t) => 2500 * Math.exp(-t * 6) + 150), 0.002, 0.3), 1],
    [env(tone(0.6, 70, 35), 0.002, 0.25), 0.7]), 0.65),
  explosionLarge: () => finish(mix(
    [env(lowpass(noise(2.2, 27), (t) => 1500 * Math.exp(-t * 3) + 80), 0.004, 0.7), 1],
    [env(tone(1.6, 55, 25), 0.004, 0.6), 0.9]), 0.7),
  impact: () => finish(env(lowpass(noise(0.25, 28), 1200), 0.001, 0.06), 0.5),
  clank: () => finish(mix(
    [env(tone(0.3, 420, 400, "tri"), 0.001, 0.08), 0.6], [env(tone(0.3, 1130, 1100, "sine"), 0.001, 0.05), 0.5],
    [env(lowpass(noise(0.3, 29), 3500), 0.001, 0.03), 0.4]), 0.45),
  money: () => finish(concat(env(tone(0.07, 1568, 1568, "tri"), 0.002, 0.05), env(tone(0.12, 2093, 2093, "tri"), 0.002, 0.07)), 0.35),
  thud: () => finish(env(mix([lowpass(noise(0.3, 31), 600), 1], [tone(0.3, 120, 80), 0.5]), 0.002, 0.08), 0.45),
  // loops: whole cycles of every partial in exactly one second, so they repeat without a seam
  engineLoop: () => loop((t) => 0.5 * Math.sin(2 * Math.PI * 55 * t) + 0.3 * Math.sin(2 * Math.PI * 110 * t) * (0.8 + 0.2 * Math.sin(2 * Math.PI * 6 * t)), 0.35, 1400),
  rotorLoop: () => loop((t) => Math.sin(2 * Math.PI * 80 * t) * (0.4 + 0.6 * Math.pow(Math.abs(Math.sin(2 * Math.PI * 8 * t)), 4)), 0.4, 1800),
  ambientLoop: () => loop((t) => 0.3 * Math.sin(2 * Math.PI * 40 * t) + 0.2 * Math.sin(2 * Math.PI * 61 * t), 0.2, 900, 0.18),
  jetLoop: () => loop((t) => 0.2 * Math.sin(2 * Math.PI * 220 * t) + 0.1 * Math.sin(2 * Math.PI * 331 * t), 0.6, 2500),
  // a firing weapon held down: 12 shots a second, whole loop one second
  weaponLoop: () => {
    const x = new Float32Array(RATE), shot = env(lowpass(noise(0.06, 42), 4000), 0.001, 0.015);
    for (let k = 0; k < 12; k++) x.set(shot, Math.round((k * RATE) / 12));
    return finish(x, 0.45, 0);
  },
  // an infantry death: a falling cry
  dieCry: () => finish(env(lowpass(tone(0.45, 520, 180, "saw"), 1600), 0.01, 0.2), 0.4),
};

/** A one-second seamless loop: f(t) plus noise that is itself periodic (filtered on a doubled copy). */
function loop(f: (t: number) => number, noiseGain: number, cutoff: number, peak = 0.35): Signal {
  const n = RATE;
  const raw = noise(2, 41);
  for (let i = 0; i < n; i++) raw[n + i] = raw[i];       // period of one second
  const filtered = lowpass(raw, cutoff).subarray(n, 2 * n);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = f(i / RATE) + noiseGain * filtered[i] * 3;
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  for (let i = 0; i < n; i++) x[i] *= peak / m;
  return x;
}

/** "Speech": syllable-like formant chirps over radio hiss, framed by squelch clicks. */
function speech(len: number, seed: number): Signal {
  const r = rng(seed);
  const parts: Signal[] = [env(lowpass(noise(0.05, seed), 5000), 0.001, 0.015)];
  let t = 0;
  while (t < len) {
    const d = 0.08 + 0.1 * Math.abs(r());
    const f = 150 + 60 * r();
    const syl = env(mix([tone(d, f, f * (1 + 0.15 * r()), "saw"), 1]), 0.01, d * 0.6);
    parts.push(lowpass(syl, 1800 + 700 * r()), secs(0.02 + 0.05 * Math.abs(r())));
    t += d + 0.05;
  }
  parts.push(env(lowpass(noise(0.06, seed + 1), 5000), 0.001, 0.02));
  const body = concat(...parts);
  return finish(mix([body, 1], [lowpass(noise(body.length / RATE, seed + 2), 3200), 0.06]), 0.45);
}

// ---- music -----------------------------------------------------------------------------------
/** A seamless loop: four bars per chord, minor progression, bass + pad + drums (+ lead when driving). */
export function musicTrack(style: "calm" | "drive"): Signal {
  const bpm = style === "calm" ? 84 : 120;
  const beat = 60 / bpm;
  const chords = style === "calm" ? [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]   // Am F C G
    : [[52, 55, 59], [48, 52, 55], [50, 53, 57], [47, 50, 54]];                                 // Em C Dm Bm(b5)
  const beatsPerChord = 8;
  const total = Math.round(chords.length * beatsPerChord * beat * RATE);
  const x = new Float32Array(total);
  const hz = (m: number) => 440 * 2 ** ((m - 69) / 12);
  const r = rng(style === "calm" ? 51 : 52);
  const drumNoise = noise(0.3, 53);
  const add = (start: number, s: Signal, g: number) => {
    const o = Math.round(start * RATE);
    for (let i = 0; i < s.length && o + i < total; i++) x[o + i] += s[i] * g;
  };
  chords.forEach((chord, ci) => {
    const t0 = ci * beatsPerChord * beat;
    // pad: the chord, slow attack, held for the bar
    for (const n of chord) add(t0, env(lowpass(tone(beatsPerChord * beat, hz(n), hz(n), "saw"), style === "calm" ? 900 : 1300), 0.6, 4), 0.07);
    for (let b = 0; b < beatsPerChord; b++) {
      const tb = t0 + b * beat;
      // bass: root on every beat (calm: every other), an octave jump on the off-beat when driving
      if (style === "drive" || b % 2 === 0) add(tb, env(lowpass(tone(beat * 0.9, hz(chord[0] - 24), hz(chord[0] - 24), "square"), 500), 0.005, beat * 0.5), 0.22);
      if (style === "drive") add(tb + beat / 2, env(lowpass(tone(beat * 0.4, hz(chord[0] - 12), hz(chord[0] - 12), "square"), 700), 0.005, beat * 0.2), 0.12);
      // drums: kick on 1 and 3, snare on 2 and 4, hats on eighths when driving
      if (b % 2 === 0) add(tb, env(tone(0.25, 120, 40), 0.001, 0.08), 0.5);
      if (b % 2 === 1) add(tb, env(lowpass(drumNoise, 3500), 0.001, style === "calm" ? 0.05 : 0.08), style === "calm" ? 0.12 : 0.25);
      if (style === "drive") for (const h of [0, 0.5]) add(tb + h * beat, env(noise(0.05, 54 + b), 0.001, 0.012), 0.05);
      // lead: chord tones, a note per beat with a rest now and then
      if (style === "drive" && r() > -0.3) {
        const n = chord[Math.floor(Math.abs(r()) * 3) % 3] + 12;
        add(tb, env(lowpass(tone(beat * 0.8, hz(n), hz(n), "tri"), 2400), 0.01, beat * 0.4), 0.1);
      }
    }
  });
  // notes still sounding at the end are cut there; the pad's slow attack hides the restart
  return finish(x, 0.6, 0.02);
}

// ---------------------------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------------------------
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

export function archetypeFor(ref: AudioRef): string {
  if (ref.kind === "speech") return `speech${hash(ref.file) % 3}`;
  if (ref.kind === "music") return /shell|score|load|menu|credit|silen/i.test(`${ref.event} ${ref.file}`) ? "musicCalm" : "musicDrive";
  const name = `${ref.event} ${ref.file}`.toLowerCase();
  if (/\bvoice\b/.test(ref.type) || /voice/.test(name)) return `voice${hash(ref.event) % VOICE_PITCH.length}`;
  if (ref.loop) {
    if (/heli|rotor|chinook|comanche|helix/.test(name)) return "rotorLoop";
    if (/jet|aircraft|fighter|raptor|\bmig|bomber|squadron|aurora|plane/.test(name)) return "jetLoop";
    if (/weapon|gattling|gatling|firing|gun/.test(name)) return "weaponLoop";
    if (/ambient|^amb_|wind|water|bird|insect|walla|crowd|thunder/.test(name)) return "ambientLoop";
    return "engineLoop";
  }
  if (/^die|death|scream/.test(name) && !/vehicle|tank|building|structure/.test(name)) return "dieCry";
  if (/panic|crowd|mob|walla|cheer|\bciv/.test(name)) return `speech${hash(ref.event) % 3}`;
  if (/click|button|menu/.test(name)) return "click";
  if (/money|cash|deposit|withdraw|bounty/.test(name)) return "money";
  if (/nuke|superweapon|scud|particlecannon|structure.*(die|destroy|explo)|building.*(die|destroy|explo|collapse)|large/.test(name)) return "explosionLarge";
  if (/explo|boom|blast|die\b|death|destroy|crash|collapse|detonat/.test(name)) return "explosionSmall";
  if (/missile|rocket|patriot|tomahawk|stinger|scud/.test(name)) return "missile";
  if (/laser|beam|microwave|ecm|emp/.test(name)) return "laser";
  if (/flame|napalm|fire|inferno|dragon/.test(name)) return "flame";
  if (/cannon|artillery|tank|howitzer|crusader|battlemaster|overlord|paladin|tomahawk|gattling|gatling|weapon.*heavy/.test(name)) return "cannon";
  if (/minigun|gatling|gattling|quad|machine|mg\b|autogun|avenger/.test(name)) return "autogun";
  if (/gun|rifle|shot|fire|weapon|sniper|pistol|bullet/.test(name)) return "gun";
  if (/build|construct|repair|place|upgrade|scaffold|dozer|worker|salvage/.test(name)) return "clank";
  if (/impact|hit|ricochet|land/.test(name)) return "impact";
  if (/\bui\b/.test(ref.type)) return /radar|alert|notify|warning|attack|eva|lowpower|power/.test(name) ? "uiAlert" : "uiBlip";
  return "thud";
}

export interface FreeAudio {
  sounds: { path: string; data: Buffer }[];
  music: { path: string; data: Buffer }[];
  archetypes: Map<string, number>;   // archetype -> files using it
  bytes: number;                     // distinct data
}

export function buildFreeAudio(patchDataDir: string): FreeAudio {
  const refs = collectAudioRefs(patchDataDir);
  const made = new Map<string, Buffer>();
  const data = (a: string): Buffer => {
    let b = made.get(a);
    if (!b) {
      b = wav(a === "musicCalm" ? musicTrack("calm") : a === "musicDrive" ? musicTrack("drive") : ARCHETYPES[a]());
      made.set(a, b);
    }
    return b;
  };
  const out: FreeAudio = { sounds: [], music: [], archetypes: new Map(), bytes: 0 };
  for (const ref of refs) {
    const a = archetypeFor(ref);
    out.archetypes.set(a, (out.archetypes.get(a) ?? 0) + 1);
    const file = ref.kind === "sound" && !/\.wav$/i.test(ref.file) ? `${ref.file}.wav` : ref.file;
    const dir = ref.kind === "sound" ? "Sounds" : ref.kind === "speech" ? "Speech" : "Tracks";
    (ref.kind === "music" ? out.music : out.sounds).push({ path: `Data\\Audio\\${dir}\\${file}`, data: data(a) });
  }
  for (const b of made.values()) out.bytes += b.length;
  return out;
}
