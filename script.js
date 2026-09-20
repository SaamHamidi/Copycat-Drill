const $ = id => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Sound files, relative to index.html. sounds.js holds embedded copies of the
// same files, used automatically when the files can't be fetched (file://).
const SOUND_URLS = { click: "click.wav", hit: "don.wav", accent: "ka.wav" };
const SOUND_UI = {
  click:  { file: "clickFile",  name: "clickName",  preview: "previewClick" },
  hit:    { file: "hitFile",    name: "hitName",    preview: "previewHit" },
  accent: { file: "accentFile", name: "accentName", preview: "previewAccent" }
};

let audioCtx = null;
let limiter = null;                     // soft limiter shared by everything
let master = null;                      // replaced on Stop to cut off scheduled sounds
const buffers = { click: null, hit: null, accent: null };

let pattern = [];                       // the rhythm currently shown on screen
let previousPattern = null;             // the rhythm this one replaced, for the Previous button
let stepEls = [];                       // its cells, for highlighting
let lit = -1;                           // index of the highlighted cell
let layoutSub = 4;                      // subdivision used to lay out the current pattern's rows
let running = false;
let starting = false;
let generation = 0;                     // bumped on every start/stop so old loops exit
const timers = new Set();               // UI timers (highlighting, status text)

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

// Read a numeric control, kept inside its min/max.
function num(id) {
  const el = $(id);
  const lo = Number(el.getAttribute("min") ?? 1);
  const hi = Number(el.getAttribute("max") ?? 999);
  const v = Number(el.value);
  return clamp(Number.isFinite(v) ? v : lo, lo, hi);
}

function settings() {
  return {
    bpm: num("bpm"),
    measures: num("measures"),
    beats: num("beats"),
    subdivision: num("subdivision"),
    density: num("density"),
    syncopation: num("syncopation"),
    accentChance: num("accentChance"),
    repeats: num("repeats"),
    metro: $("metro").value,
    swing: $("swing").checked,
    loop: $("loop").checked
  };
}

// Tempo and metronome mode can change while playing; everything else is
// fixed for the length of one rhythm.
function live(s) {
  return { ...s, bpm: num("bpm"), metro: $("metro").value };
}

const stepSeconds = s => 60 / s.bpm / s.subdivision;

/* ------------------------------------------------------------------ */
/* Sliders                                                             */
/* ------------------------------------------------------------------ */

function paintSlider(el) {
  const pct = (el.value - el.min) / (el.max - el.min) * 100;
  el.style.setProperty("--fill", pct + "%");
}

function updateLabels() {
  $("bpmValue").textContent = $("bpm").value;
  $("densityValue").textContent = Number($("density").value).toFixed(2);
  $("syncValue").textContent = Number($("syncopation").value).toFixed(2);
  $("accentValue").textContent = Number($("accentChance").value).toFixed(2);
  document.querySelectorAll('input[type="range"]').forEach(paintSlider);
}
["bpm", "density", "syncopation", "accentChance"].forEach(id =>
  $(id).addEventListener("input", updateLabels)
);

/* ------------------------------------------------------------------ */
/* Steppers (− / + buttons) with press-and-hold repeat                 */
/* ------------------------------------------------------------------ */

const SUBDIVISION_NAMES = {
  1: "Quarter notes", 2: "8th notes", 3: "Triplets", 4: "16th notes",
  5: "Quintuplets", 6: "Sextuplets", 7: "Septuplets", 8: "32nd notes"
};

function holdRepeat(button, action) {
  let delay = null, interval = null;
  const halt = () => { clearTimeout(delay); clearInterval(interval); };
  button.addEventListener("pointerdown", event => {
    if (button.disabled) return;
    event.preventDefault();
    action();
    delay = setTimeout(() => { interval = setInterval(action, 90); }, 420);
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach(type => button.addEventListener(type, halt));
  button.addEventListener("keydown", event => {   // keyboard: Enter / Space
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); action(); }
  });
  button.addEventListener("contextmenu", event => event.preventDefault());
}

function stepperValues(input) {
  return input.dataset.values ? input.dataset.values.split(",").map(Number) : null;
}

const REPEATS_HINT_DEFAULT = "Repeats per rhythm";

function refreshSteppers() {
  const swing = $("swing").checked;
  const loop = $("loop").checked;
  document.querySelectorAll(".stepper").forEach(stepper => {
    const input = stepper.querySelector("input");
    const [down, up] = stepper.querySelectorAll("button");
    const locked = (swing && input.id === "subdivision") || (loop && input.id === "repeats");
    stepper.classList.toggle("locked", locked);
    if (locked) { down.disabled = true; up.disabled = true; return; }

    const values = stepperValues(input);
    const v = Number(input.value);
    if (values) {
      down.disabled = v <= values[0];
      up.disabled = v >= values[values.length - 1];
    } else {
      down.disabled = v <= Number(input.min);
      up.disabled = v >= Number(input.max);
    }
  });
  $("subdivisionHint").textContent = swing
    ? "Fixed in swing mode."
    : (SUBDIVISION_NAMES[num("subdivision")] || "");
  $("repeatsHint").textContent = loop ? "Not used in loop mode." : REPEATS_HINT_DEFAULT;
}

function setStepper(input, value) {
  if (String(value) === input.value) return;
  input.value = value;
  refreshSteppers();
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

document.querySelectorAll(".stepper").forEach(stepper => {
  const input = stepper.querySelector("input");
  const values = stepperValues(input);

  stepper.querySelectorAll("button").forEach(button => {
    const dir = Number(button.dataset.dir);
    holdRepeat(button, () => {
      const current = Number(input.value);
      if (values) {
        let i = values.indexOf(current);
        if (i < 0) i = values.findIndex(v => v >= current);
        setStepper(input, values[clamp(i + dir, 0, values.length - 1)]);
      } else {
        setStepper(input, clamp(current + dir, Number(input.min), Number(input.max)));
      }
    });
  });

  // Typing a number directly: keep it a whole number inside the range.
  if (!input.readOnly) {
    input.addEventListener("change", () => {
      const lo = Number(input.min), hi = Number(input.max);
      const v = Math.round(Number(input.value));
      input.value = clamp(Number.isFinite(v) ? v : lo, lo, hi);
      refreshSteppers();
    });
  }
});

// Tempo − / + buttons
document.querySelectorAll(".nudge").forEach(button => {
  const slider = $(button.dataset.target);
  const dir = Number(button.dataset.nudge);
  holdRepeat(button, () => {
    const v = clamp(Number(slider.value) + dir, Number(slider.min), Number(slider.max));
    if (String(v) === slider.value) return;
    slider.value = v;
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  });
});

/* ------------------------------------------------------------------ */
/* Rhythm generation                                                    */
/*                                                                     */
/* Normal mode matches copycatSync2.py. Swing mode matches              */
/* copycatSwing.py: hits only land on the 1st and 3rd triplet of a      */
/* beat (the middle triplet is always a rest), and syncopation isn't    */
/* used.                                                                */
/* ------------------------------------------------------------------ */

function generateRhythm(s = settings()) {
  const total = s.beats * s.subdivision * s.measures;

  if (s.swing) {
    const swung = [];
    for (let i = 0; i < total; i++) {
      if (i % 3 === 0 || i % 3 === 2) {
        swung.push(Math.random() < s.density
          ? (Math.random() < s.accentChance ? 2 : 1)
          : 0);
      } else {
        swung.push(0);
      }
    }
    return swung;
  }

  const evenChance = s.density - s.syncopation * (1 - s.density);
  const oddChance = s.density + s.syncopation * (1 - s.density);
  const result = [];

  for (let i = 0; i < total; i++) {
    if (Math.random() > s.density) {
      result.push(0);
    } else if (i % 2 === 0) {
      result.push(Math.random() < evenChance
        ? (Math.random() < s.accentChance ? 2 : 1)
        : 0);
    } else {
      result.push(Math.random() < oddChance
        ? (Math.random() < s.accentChance ? 2 : 1)
        : 0);
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Pattern display                                                     */
/*                                                                     */
/* Every box is a fixed size. Boxes are simply added on in rows; JS     */
/* picks how many fit per row and, wherever a whole beat fits, keeps    */
/* rows ending on a beat boundary so a beat is never split across two   */
/* lines.                                                               */
/* ------------------------------------------------------------------ */

// Paints a cell's value (rest / hit / accent) without touching its beat or
// highlight classes.
function paintCell(cell, value) {
  cell.classList.remove("hit", "accent", "rest");
  if (value === 1) {
    cell.classList.add("hit");
    cell.textContent = "DON";
    cell.setAttribute("aria-pressed", "true");
    cell.setAttribute("aria-label", "Hit. Tap to change to accent.");
  } else if (value === 2) {
    cell.classList.add("accent");
    cell.textContent = "KA";
    cell.setAttribute("aria-pressed", "true");
    cell.setAttribute("aria-label", "Accent. Tap to clear.");
  } else {
    cell.classList.add("rest");
    cell.textContent = "·";
    cell.setAttribute("aria-pressed", "false");
    cell.setAttribute("aria-label", "Rest. Tap to add a hit.");
  }
}

// Tapping a box cycles it rest -> hit -> accent -> rest, so you can build a
// rhythm by hand instead of only generating one.
function cycleStep(i) {
  pattern[i] = (pattern[i] + 1) % 3;
  paintCell(stepEls[i], pattern[i]);
}

function drawPattern(p = pattern, subdivision = num("subdivision"), beats = num("beats")) {
  const el = $("pattern");
  el.innerHTML = "";
  stepEls = [];
  lit = -1;
  layoutSub = subdivision;

  p.forEach((value, i) => {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "step";

    if (i % subdivision === 0) {                       // first step of a beat
      const beatNumber = Math.floor(i / subdivision) % beats + 1;
      cell.classList.add("beat");
      if (beatNumber === 1) cell.classList.add("down");
      cell.dataset.beat = beatNumber;
    }

    paintCell(cell, value);
    cell.addEventListener("click", () => cycleStep(i));
    el.appendChild(cell);
    stepEls.push(cell);
  });

  layoutPattern();
}

function layoutPattern() {
  const el = $("pattern");
  const style = getComputedStyle(el);
  const cell = parseFloat(style.getPropertyValue("--cell")) || 32;
  const gap = parseFloat(style.columnGap) || 4;
  const fit = Math.max(1, Math.floor((el.clientWidth + gap) / (cell + gap)));
  const perRow = fit >= layoutSub ? Math.floor(fit / layoutSub) * layoutSub : fit;
  el.style.setProperty("--per-row", perRow);
}
window.addEventListener("resize", layoutPattern);
if ("ResizeObserver" in window) new ResizeObserver(layoutPattern).observe($("pattern"));

// The rhythm grid is inside a collapsible <details>; re-measure when it's
// opened in case the browser didn't fire the ResizeObserver while hidden.
const patternFold = $("patternFold");
if (patternFold) patternFold.addEventListener("toggle", () => { if (patternFold.open) layoutPattern(); });

function highlight(index) {
  if (stepEls[lit]) stepEls[lit].classList.remove("current");
  if (stepEls[index]) stepEls[index].classList.add("current");
  lit = index;
}

function setStatus(text, phase = "idle") {
  $("status").textContent = text;
  $("dock").dataset.phase = phase;
}
const setCount = text => { $("count").textContent = text; };

function showNotice(text) { $("notice").textContent = text; $("notice").hidden = false; }
function hideNotice() { $("notice").hidden = true; }

/* ------------------------------------------------------------------ */
/* Previous rhythm                                                     */
/*                                                                     */
/* A single undo slot. Remembering only happens when a rhythm is        */
/* replaced by another of the exact same shape (New Rhythm, or the      */
/* automatic new rhythm each cycle) so the stored pattern always still  */
/* matches the current measures/beats/subdivision/swing settings.       */
/* Changing any of those invalidates the slot instead.                  */
/* ------------------------------------------------------------------ */

function updatePreviousButton() {
  $("previous").disabled = !previousPattern;
}

function rememberPrevious(oldPattern) {
  if (!oldPattern || !oldPattern.length) return;
  previousPattern = oldPattern.slice();
  updatePreviousButton();
}

function forgetPrevious() {
  previousPattern = null;
  updatePreviousButton();
}

/* ------------------------------------------------------------------ */
/* Audio output                                                        */
/*                                                                     */
/* Hits can overlap (don is half a second long) and don + click peak   */
/* above full scale together, which causes crackle. All sound goes     */
/* through a soft limiter instead of hard-clipping.                    */
/* ------------------------------------------------------------------ */

const LIMITER_KNEE = 0.6;               // levels below this pass through untouched
const LIMITER_RANGE = 2;                // sums up to 2.0 are handled smoothly

function makeLimiterCurve(n = 4097) {
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;                  // -1..1 into the shaper
    const u = Math.abs(x) * LIMITER_RANGE;            // level before the input gain
    const y = u <= LIMITER_KNEE
      ? u
      : LIMITER_KNEE + (1 - LIMITER_KNEE) * Math.tanh((u - LIMITER_KNEE) / (1 - LIMITER_KNEE));
    curve[i] = x < 0 ? -y : y;
  }
  return curve;
}

function newMaster() {
  master = audioCtx.createGain();
  master.gain.value = 1 / LIMITER_RANGE;
  master.connect(limiter);
}

function buildOutput() {
  limiter = audioCtx.createWaveShaper();
  limiter.curve = makeLimiterCurve();
  limiter.oversample = "2x";
  limiter.connect(audioCtx.destination);
  newMaster();
}

function getCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    buildOutput();
  }
  return audioCtx;
}

async function initAudio() {
  // iPhone: keep playing even when the ring/silent switch is on silent.
  if (navigator.audioSession) navigator.audioSession.type = "playback";
  getCtx();
  if (audioCtx.state === "suspended") await audioCtx.resume();
}

// Fade out and drop everything that was scheduled but hasn't played yet.
function silenceScheduledAudio() {
  const old = master;
  const now = audioCtx.currentTime;
  old.gain.cancelScheduledValues(now);
  old.gain.setValueAtTime(old.gain.value, now);
  old.gain.linearRampToValueAtTime(0, now + 0.02);
  setTimeout(() => old.disconnect(), 150);
  newMaster();
}

function playBuffer(buffer, when) {
  if (!buffer) return;
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(master);
  source.start(when);
  return source;
}

const playClick = when => playBuffer(buffers.click, when);

// Whatever the don/ka sound files are, one is never allowed to ring into the
// next: this tracks the currently-sounding hit/accent voice and, if it would
// still be playing when the next one starts, fades it out and cuts it off
// a hair before that next hit begins.
let hitVoice = null;                    // { gainNode, source, startedAt, naturalEnd }
const HIT_CHOKE_FADE = 0.006;           // seconds; short enough to be inaudible, long enough to avoid a click

function chokeHitVoice(beforeTime) {
  if (!hitVoice) return;
  if (hitVoice.naturalEnd <= beforeTime) { hitVoice = null; return; } // already finished on its own

  const gain = hitVoice.gainNode.gain;
  const fadeStart = Math.max(hitVoice.startedAt, beforeTime - HIT_CHOKE_FADE);
  gain.cancelScheduledValues(fadeStart);
  gain.setValueAtTime(1, fadeStart);
  gain.linearRampToValueAtTime(0, beforeTime);
  try { hitVoice.source.stop(beforeTime + 0.001); } catch (err) { /* already stopped/ended */ }
  hitVoice = null;
}

function playStep(value, when) {
  if (value !== 1 && value !== 2) return;
  const buffer = value === 1 ? buffers.hit : buffers.accent;
  if (!buffer) return;

  chokeHitVoice(when);                  // cut off whatever's still ringing from the last hit

  const source = audioCtx.createBufferSource();
  const gainNode = audioCtx.createGain();
  source.buffer = buffer;
  source.connect(gainNode);
  gainNode.connect(master);
  source.start(when);
  hitVoice = { source, gainNode, startedAt: when, naturalEnd: when + buffer.duration };
}

function metroAtStep(i, s) {
  // Swing mode: the on-beat click is half-time, every 2 beats.
  if (s.metro === "onbeat") return i % (s.swing ? s.subdivision * 2 : s.subdivision) === 0;
  if (s.metro === "offbeat")
    return s.subdivision > 1 && i % s.subdivision === Math.floor(s.subdivision / 2);
  return false;
}

/* ------------------------------------------------------------------ */
/* Sound loading                                                       */
/* ------------------------------------------------------------------ */

// Smooth the very start and end of a sound if the file begins or ends on a
// non-zero sample (that step is an audible tick). Files that already start and
// end at zero are left alone.
function polish(buffer) {
  const rate = buffer.sampleRate;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    const n = d.length;
    if (n < 64) continue;

    if (Math.abs(d[0]) > 0.002) {
      const len = Math.min(Math.round(rate * 0.0004), n >> 1);
      for (let i = 0; i < len; i++) d[i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / len);
    }
    if (Math.abs(d[n - 1]) > 0.002) {
      const len = Math.min(Math.round(rate * 0.010), n >> 2);
      for (let i = 0; i < len; i++) d[n - 1 - i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / len);
    }
  }
  return buffer;
}

// Fallback decoder for plain PCM / float WAV files, used only if the browser's
// own decoder rejects a file.
function parseWav(bytes) {
  const v = new DataView(bytes);
  const tag = o => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (v.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Not a WAV file");

  let pos = 12, fmt = null, dataStart = -1, dataLen = 0;
  while (pos + 8 <= v.byteLength) {
    const id = tag(pos);
    const size = v.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === "fmt ") {
      fmt = {
        format: v.getUint16(body, true),
        channels: v.getUint16(body + 2, true),
        rate: v.getUint32(body + 4, true),
        bits: v.getUint16(body + 14, true)
      };
      if (fmt.format === 0xFFFE && size >= 26) fmt.format = v.getUint16(body + 24, true);
    } else if (id === "data") {
      dataStart = body;
      dataLen = Math.min(size, v.byteLength - body);
      break;
    }
    pos = body + size + (size & 1);
  }
  if (!fmt || dataStart < 0) throw new Error("WAV file is missing its fmt or data chunk");

  const bytesPer = fmt.bits / 8;
  const frames = Math.floor(dataLen / (bytesPer * fmt.channels));
  const out = audioCtx.createBuffer(fmt.channels, frames, fmt.rate);

  for (let c = 0; c < fmt.channels; c++) {
    const ch = out.getChannelData(c);
    for (let f = 0; f < frames; f++) {
      const o = dataStart + (f * fmt.channels + c) * bytesPer;
      let s;
      if (fmt.format === 3 && fmt.bits === 32) s = v.getFloat32(o, true);
      else if (fmt.bits === 16) s = v.getInt16(o, true) / 32768;
      else if (fmt.bits === 8) s = (v.getUint8(o) - 128) / 128;
      else if (fmt.bits === 24) s = ((v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getInt8(o + 2) << 16))) / 8388608;
      else if (fmt.bits === 32) s = v.getInt32(o, true) / 2147483648;
      else throw new Error(`Unsupported WAV format (${fmt.bits}-bit)`);
      ch[f] = s;
    }
  }
  return out;
}

async function decodeBytes(bytes) {
  try {
    return await audioCtx.decodeAudioData(bytes.slice(0));
  } catch (err) {
    console.warn("Browser decoder rejected the file; trying the built-in WAV parser.", err);
    return parseWav(bytes);
  }
}

function dataUrlToBytes(dataUrl) {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.arrayBuffer();
}

// Try the .wav file next to index.html first, then the copy in sounds.js.
async function loadSound(key) {
  const url = SOUND_URLS[key];
  const embedded = (window.BUILTIN_SOUNDS || {})[key];
  const sources = [];
  if (location.protocol !== "file:") sources.push(() => fetchBytes(url));
  if (embedded) sources.push(async () => dataUrlToBytes(embedded));

  for (const getBytes of sources) {
    try {
      const buffer = polish(await decodeBytes(await getBytes()));
      if (!buffers[key]) buffers[key] = buffer;   // don't overwrite a file the user already picked
      return true;
    } catch (err) {
      console.warn(`Could not load ${url} from one source:`, err);
    }
  }
  return false;
}

// Loads whatever isn't loaded yet. Returns the file names that failed.
async function loadBuiltInSounds() {
  getCtx();
  const failed = [];
  await Promise.all(Object.keys(buffers).filter(key => !buffers[key]).map(async key => {
    if (!(await loadSound(key))) failed.push(SOUND_URLS[key]);
  }));
  return failed;
}

function showLoadError(failed) {
  showNotice(`Couldn't load ${failed.join(", ")}. Keep the .wav files (and sounds.js) next to index.html, or choose your own files under Sounds.`);
  setStatus("Sounds missing", "error");
}

async function ensureSounds() {
  if (Object.values(buffers).every(Boolean)) return true;
  setStatus("Loading sounds…");
  const failed = await loadBuiltInSounds();
  if (failed.length) {
    showLoadError(failed);
    return false;
  }
  hideNotice();
  setStatus("Ready");
  setCount("—");
  return true;
}

// Optional replacement sounds and previews.
Object.entries(SOUND_UI).forEach(([key, ui]) => {
  $(ui.file).addEventListener("change", async event => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      getCtx();
      buffers[key] = polish(await decodeBytes(await file.arrayBuffer()));
      $(ui.name).textContent = file.name;
      hideNotice();
    } catch (err) {
      console.error(err);
      showNotice(`Couldn't read "${file.name}" as audio.`);
    }
  });

  $(ui.preview).addEventListener("click", async () => {
    await initAudio();
    if (!buffers[key]) await loadBuiltInSounds();
    playBuffer(buffers[key], audioCtx.currentTime);
  });
});

/* ------------------------------------------------------------------ */
/* Timing helpers                                                      */
/* ------------------------------------------------------------------ */

// Run a UI update when the audio clock reaches `audioTime`.
function at(audioTime, fn, gen) {
  const latency = audioCtx.outputLatency || 0;
  const delay = Math.max(0, (audioTime + latency - audioCtx.currentTime) * 1000);
  const id = setTimeout(() => {
    timers.delete(id);
    if (running && gen === generation) fn();
  }, delay);
  timers.add(id);
}

// Resolve once the audio clock reaches `audioTime` (or playback was stopped).
function waitUntil(audioTime, gen) {
  return new Promise(resolve => {
    const tick = () => {
      if (!running || gen !== generation) return resolve();
      const remaining = audioTime - audioCtx.currentTime;
      if (remaining <= 0) return resolve();
      setTimeout(tick, Math.max(5, Math.min(remaining * 1000 - 10, 250)));
    };
    tick();
  });
}

/* ------------------------------------------------------------------ */
/* Session: same order as copycatSync2.py / copycatSwing.py            */
/*                                                                     */
/*   4-count intro (once)                                              */
/*   loop forever:                                                     */
/*     new rhythm                                                      */
/*     repeat N times:  Listen  ->  Your Turn                          */
/*                                                                     */
/* Every click, don and ka is scheduled on the audio clock, and each   */
/* phase is queued while the previous one is still playing, so nothing */
/* drifts and there are no gaps between phases.                        */
/* ------------------------------------------------------------------ */

async function runSession(gen) {
  const alive = () => running && gen === generation;
  let t = audioCtx.currentTime + 0.15;

  // Decided once per Start: toggling loop stops playback (see the swing/loop
  // change handlers), so it can't change out from under a running session.
  const loopMode = settings().loop;

  // Schedule one phase starting at `t`, then wait until it begins playing
  // so the following phase is always queued one phase ahead.
  //
  // Without the alive() check here, a phase whose "wait for the previous one
  // to begin" resolved right as Stop (or New Rhythm, which stops then
  // restarts) was pressed would go on to schedule its sounds anyway — onto
  // whatever the *next* session's audio graph happened to be by then. That's
  // what caused clicks to double up or keep playing after Stop.
  async function queue(schedule) {
    if (!alive()) return;
    if (t < audioCtx.currentTime + 0.02) t = audioCtx.currentTime + 0.05; // fell behind; resync
    const start = t;
    t = schedule(start);
    await waitUntil(start, gen);
  }

  const beatText = (i, s, measures) => {
    const beat = Math.floor(i / s.subdivision) % s.beats + 1;
    const measure = Math.floor(i / (s.beats * s.subdivision)) + 1;
    return measures > 1
      ? `Measure ${measure} · Beat ${beat} of ${s.beats}`
      : `Beat ${beat} of ${s.beats}`;
  };

  // 4-count intro, once per Start (like eight_count_intro() in the Python).
  // Swing mode: 8-beat intro with a half-time click, still 4 clicks total.
  // Loop mode skips it entirely — Start just starts looping right away.
  if (!loopMode) {
    await queue(start => {
      const s = live(settings());
      const step = stepSeconds(s);
      const clickEvery = (s.swing ? 2 : 1) * s.subdivision;
      at(start, () => { setStatus("Count-in", "count"); highlight(-1); }, gen);
      for (let n = 0; n < 4; n++) {
        const when = start + n * clickEvery * step;
        playClick(when);
        at(when, () => setCount(`Count ${n + 1} of 4`), gen);
      }
      return start + 4 * clickEvery * step;
    });
  }

  // `t` is already sitting right after the intro's last scheduled click (queue()
  // only waits for a phase to *begin*, not finish, so the intro's 4 clicks are
  // still playing out when we get here) — or, in loop mode, right at the start
  // since there's no intro. Loop mode has to pick up from `t`, not from "now" —
  // starting from "now" (when there was still an intro) scheduled the loop's
  // first click while the intro's tail was still sounding, causing a double
  // click right after Start.
  if (loopMode) {
    await runLoopMode(gen, alive, beatText, t);
    return;
  }

  let firstCycle = true;

  // One "cycle" is one rhythm's worth of practice: the normal Listen/Your-Turn
  // back-and-forth for cycle.repeats rounds, then a new rhythm.
  while (alive()) {
    const cycle = settings();
    const total = cycle.beats * cycle.subdivision * cycle.measures;

    // A fresh rhythm every cycle. The very first one reuses the rhythm the
    // user is already looking at.
    const cyclePattern = firstCycle && pattern.length === total ? pattern : generateRhythm(cycle);
    firstCycle = false;

    let repeat = 1;
    while (alive()) {
      if (repeat > cycle.repeats) break;   // done with this rhythm's repeats; start a new one

      // --- Listen: rhythm + metronome ---
      await queue(start => {
        const s = live(cycle);
        const step = stepSeconds(s);
        at(start, () => {
          setStatus(`Listen ${repeat} of ${cycle.repeats}`, "listen");
          if (pattern !== cyclePattern) {
            rememberPrevious(pattern);
            pattern = cyclePattern;
            drawPattern(pattern, cycle.subdivision, cycle.beats);
          }
        }, gen);

        cyclePattern.forEach((value, i) => {
          const when = start + i * step;
          if (metroAtStep(i, s)) playClick(when);
          playStep(value, when);
          at(when, () => {
            highlight(i);
            if (i % cycle.subdivision === 0) setCount(beatText(i, cycle, cycle.measures));
          }, gen);
        });
        return start + cyclePattern.length * step;
      });

      // --- Your Turn: metronome only, after EVERY listen. Always the same
      // length as the rhythm you just heard (measures). ---
      await queue(start => {
        const s = live(cycle);
        const step = stepSeconds(s);
        const steps = cycle.beats * cycle.subdivision * cycle.measures;
        at(start, () => { setStatus("Your Turn", "turn"); highlight(-1); }, gen);

        for (let i = 0; i < steps; i++) {
          const when = start + i * step;
          if (metroAtStep(i, s)) playClick(when);
          if (i % cycle.subdivision === 0) {
            at(when, () => setCount(beatText(i, cycle, cycle.measures)), gen);
          }
        }
        return start + steps * step;
      });

      repeat++;
    }
  }
}

// Loop mode: the current rhythm repeats forever (with the metronome), no
// Your Turn, until Stop is pressed. Unlike the Listen/Your-Turn path above —
// which schedules a whole phase's worth of sounds as soon as the previous
// one starts, so there's never a gap between phases — loop mode uses a
// short-lookahead scheduler that only ever commits the next ~150ms of steps
// to the audio graph. That's what lets a tap on the diagram change what's
// heard within a step or two, instead of waiting one or two full repetitions
// for the next batch (which had already been scheduled) to catch up.
async function runLoopMode(gen, alive, beatText, startTime) {
  const s0 = settings();
  const total = s0.beats * s0.subdivision * s0.measures;
  if (pattern.length !== total) {
    rememberPrevious(pattern);
    pattern = generateRhythm(s0);
  }
  drawPattern(pattern, s0.subdivision, s0.beats);
  setStatus("Looping", "listen");

  const LOOKAHEAD = 0.15; // seconds of audio to keep scheduled ahead
  const TICK_MS = 25;     // how often to top that up

  // Start exactly where the intro left off, not "now" — the intro's clicks
  // are still playing out when this runs (see the caller for why), and
  // starting from "now" would schedule the loop's first click on top of them.
  let nextTime = Math.max(startTime, audioCtx.currentTime + 0.05);
  let i = 0;

  while (alive()) {
    const s = live(s0);
    const step = stepSeconds(s);
    while (alive() && nextTime < audioCtx.currentTime + LOOKAHEAD) {
      const len = pattern.length || 1;
      const idx = i % len;
      const when = nextTime;
      if (metroAtStep(idx, s)) playClick(when);
      playStep(pattern[idx], when);
      at(when, () => {
        highlight(idx);
        if (idx % s0.subdivision === 0) setCount(beatText(idx, s0, s0.measures));
      }, gen);
      nextTime += step;
      i++;
    }
    await new Promise(resolve => setTimeout(resolve, TICK_MS));
  }
}

/* ------------------------------------------------------------------ */
/* Swing toggle                                                        */
/* ------------------------------------------------------------------ */

let subdivisionBeforeSwing = null;
const syncSlider = $("syncopationField");
const syncHint = $("syncHint");
const syncHintDefault = syncHint.textContent;

function applySwingUI() {
  const on = $("swing").checked;
  const sub = $("subdivision");
  if (on) {
    if (subdivisionBeforeSwing === null) subdivisionBeforeSwing = sub.value;
    sub.value = 3;
  } else if (subdivisionBeforeSwing !== null) {
    sub.value = subdivisionBeforeSwing;
    subdivisionBeforeSwing = null;
  }
  $("syncopation").disabled = on;
  syncSlider.classList.toggle("is-off", on);
  syncHint.textContent = on ? "Not used in swing mode." : syncHintDefault;
  $("metro").options[0].textContent = on ? "Half-time" : "On beat";
  refreshSteppers();
}

$("swing").addEventListener("change", () => {
  if (running) stop();   // grid/timing changed — needs a manual restart
  applySwingUI();
  forgetPrevious();
  pattern = generateRhythm();
  drawPattern();
});

$("loop").addEventListener("change", () => {
  if (running) stop();   // needs a manual restart in the new mode
  refreshSteppers();
});

/* ------------------------------------------------------------------ */
/* Start / stop                                                        */
/* ------------------------------------------------------------------ */

// Keep the screen on while practising (phones dim and suspend audio otherwise).
let wakeLock = null;
async function keepAwake() {
  try {
    if ("wakeLock" in navigator && running && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch (err) { /* not available or denied; harmless */ }
}
function releaseAwake() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") keepAwake();
});

async function start() {
  if (running || starting) return;
  starting = true;
  try {
    await initAudio();
    if (!(await ensureSounds())) return;

    const s = settings();
    if (pattern.length !== s.beats * s.subdivision * s.measures) {
      pattern = generateRhythm(s);
      drawPattern();
    }

    running = true;
    generation++;
    $("start").disabled = true;
    $("stop").disabled = false;
    keepAwake();
    runSession(generation).catch(err => {
      console.error(err);
      stop();
      showNotice("Something went wrong during playback. See the browser console for details.");
    });
  } finally {
    starting = false;
  }
}

function stop() {
  running = false;
  generation++;
  timers.forEach(clearTimeout);
  timers.clear();
  if (audioCtx) silenceScheduledAudio();
  hitVoice = null;
  releaseAwake();
  setStatus("Stopped");
  setCount("—");
  $("start").disabled = false;
  $("stop").disabled = true;
  highlight(-1);
}

$("start").addEventListener("click", start);
$("stop").addEventListener("click", stop);

// Spacebar always starts/stops, full stop — it never reaches whatever else
// happens to be focused (a button, a checkbox switch, a slider, a collapsible
// section's header), so it can't toggle a switch or flip a fold open/closed
// by accident.
document.addEventListener("keydown", event => {
  if (event.code !== "Space" && event.key !== " ") return;
  event.preventDefault();
  event.stopPropagation();
  if (running) stop(); else start();
}, true);   // capture phase: intercept before it reaches the focused control

$("generate").addEventListener("click", async () => {
  const wasRunning = running;
  if (wasRunning) stop();
  rememberPrevious(pattern);
  pattern = generateRhythm();
  drawPattern();
  if (wasRunning) await start();        // restart with the new rhythm
});

$("previous").addEventListener("click", async () => {
  if (!previousPattern) return;
  const wasRunning = running;
  if (wasRunning) stop();
  const swappedOut = pattern.slice();
  pattern = previousPattern;
  previousPattern = swappedOut;         // toggle: pressing again returns to where you were
  drawPattern();
  updatePreviousButton();
  if (wasRunning) await start();
});

// Changing the grid while stopped shows a matching new rhythm right away.
// This also changes what "Previous rhythm" would mean, so it's cleared.
["measures", "beats", "subdivision"].forEach(id =>
  $(id).addEventListener("change", () => {
    forgetPrevious();
    if (running) return;                // takes effect at the next new rhythm
    pattern = generateRhythm();
    drawPattern();
  })
);

/* ------------------------------------------------------------------ */
/* Page load                                                           */
/* ------------------------------------------------------------------ */

updateLabels();
applySwingUI();
refreshSteppers();
updatePreviousButton();
pattern = generateRhythm();
drawPattern();
loadBuiltInSounds().then(failed => {
  if (failed.length) showLoadError(failed);
});
