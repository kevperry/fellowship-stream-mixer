/* Practice page: load tracks, stream them to the mixer worklet, show the console. */
/* global WavReader, naturalCompare, makeDemoTracks, fsmNormalize, fsmValidateChannel, fsmValidateMaster,
   fsmGuessType, fsmGang, FsmConsole, FSM_TONE, FSM_PRESETS, FSM_TYPE_ORDER, FSM_DEFAULT_AUDIO, FSM_KEYS, RemoteFile, openAudio, AUDIO_EXT, COMPRESSED_EXT */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const FLOOR = -60;
const pct = (db) => Math.max(0, Math.min(100, ((db - FLOOR) / -FLOOR) * 100));
const fmt = (v, d = 1) => (v > 0 ? "+" : "") + Number(v).toFixed(d);
const fmtTime = (s) => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s % 60).padStart(2, "0"); };

const types = FSM_TYPE_ORDER.map((id) => ({ id, label: FSM_PRESETS[id].label, reverb_db: FSM_PRESETS[id].reverb_db,
  leveler_range: FSM_PRESETS[id].leveler_range, target_db: FSM_PRESETS[id].target_db,
  gate_range: FSM_PRESETS[id].gate_range, gate_hold: FSM_PRESETS[id].gate_hold }));
const state = {
  readers: [], rate: 0, frames: 0, channels: 0, names: [], remote: false,
  cfg: null, ctx: null, node: null, playing: false,
  readPos: 0, generation: 0, reading: false, seeking: false, key: "",
};
const EQ_PRESET_LIST = Object.entries(FSM_TONE.eq_presets).map(([id, p]) => ({ id, label: p.label }));
const COMP_LIST = Object.entries(FSM_TONE.comp_levels).map(([id, c]) => ({ id, label: c.label }));
const held = new Map();

const CFG = () => state.cfg;
function flash(msg) { $("#status").textContent = msg; }

// ------------------------------------------------------------------ storage (best effort)
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode etc. */ } },
};
let saveTimer = 0;
function remember() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const snap = JSON.parse(JSON.stringify(state.cfg));
    snap.master.bypass = false;
    store.set(state.key, snap);
  }, 400);
}

// ------------------------------------------------------------------ loading
async function loadFiles(fileList, opts = {}) {
  const err = $("#load-error");
  err.hidden = true;
  // A folder saved by the Mac app's recorder holds config.json (that day's settings) and
  // "_stream mix.wav"; names starting with "_" are not tracks.
  const cfgFile = [...fileList].find((f) => f.name === "config.json" && typeof f.text === "function");
  if (cfgFile && !opts.config) {
    try { opts = Object.assign({}, opts, { config: JSON.parse(await cfgFile.text()), title: "the recording's settings" }); }
    catch { /* ignore a bad settings file */ }
  }
  const files = [...fileList].filter((f) => AUDIO_EXT.test(f.name) && !f.name.startsWith("_"))
    .sort((a, b) => naturalCompare(a.name, b.name));
  if (!files.length) { err.textContent = "No audio files found. Use WAV or MP3 tracks and try again."; err.hidden = false; return; }
  try {
    const compressed = files.filter((f) => COMPRESSED_EXT.test(f.name)).length;
    let done = 0;
    flash(compressed ? `Decoding tracks… 0 of ${files.length}` : "Reading track headers…");
    const readers = await Promise.all(files.map(async (f) => {
      const r = await openAudio(f);
      if (compressed) flash(`Decoding tracks… ${++done} of ${files.length}`);
      return r;
    }));
    const rates = [...new Set(readers.map((r) => r.rate))];
    if (rates.length > 1) throw new Error(`All tracks must share one sample rate (found ${rates.join(", ")} Hz). ` +
      "MP3s are played at 48 kHz, so mix them only with 48 kHz WAVs.");
    await stopAudio();
    state.readers = readers;
    state.rate = rates[0];
    state.frames = Math.min(...readers.map((r) => r.frames));
    state.channels = readers.reduce((a, r) => a + r.channels, 0);
    state.names = [];
    for (const r of readers) {
      const base = r.name.replace(AUDIO_EXT, "").replace(/^(track|trk|ch|channel)?\s*\d+\s*[-_. ]*\s*/i, "").trim();
      for (let c = 0; c < r.channels; c++) {
        const nm = base || r.name.replace(AUDIO_EXT, "");
        state.names.push(r.channels > 1 ? `${nm} ${c + 1}` : nm);
      }
    }
    if (state.channels > 64) throw new Error(`That's ${state.channels} channels; the mixer handles up to 64.`);
    state.key = "fsm:" + readers.map((r) => `${r.name}/${r.channels}`).join("|");
    const saved = store.get(state.key);
    state.cfg = saved && saved.channels && saved.channels.length === state.channels ? fsmNormalize(saved) : defaultConfig();
    if (!saved && opts.config) applyConfig(opts.config);
    state.remote = !!opts.remote;
    state.readPos = 0;
    $("#loader").hidden = true;
    $("#transport").hidden = false;
    $("#mixer").hidden = false;
    $("#bypass").disabled = false;
    $("#duration").textContent = fmtTime(state.frames / state.rate);
    $("#info").textContent = `${state.channels} tracks · ${state.rate / 1000} kHz`;
    setTime(0);
    build();
    flash(saved ? "Loaded — your settings for these tracks were restored. Press play."
      : opts.config ? (opts.title === "the recording's settings" ? "Loaded with the recording's settings. Press play."
        : `Loaded “${opts.title}”. Press play.`) : "Loaded. Check each channel's type, then press play.");
  } catch (e) {
    err.textContent = e.message; err.hidden = false; flash("Couldn't load those files.");
  }
}

function defaultConfig() {
  const channels = state.names.map((name, i) => {
    const type = fsmGuessType(name);
    let pan = 0;
    if (/\b(l|left)\b/i.test(name)) pan = -0.7;
    if (/\b(r|right)\b/i.test(name)) pan = 0.7;
    const link = i > 0 && pan > 0 && /\b(r|right)\b/i.test(name);
    return { input: i + 1, name: name.slice(0, 32), type, pan, link };
  });
  return fsmNormalize({ channels });
}

// ------------------------------------------------------------------ audio
async function startAudio() {
  if (state.ctx) return;
  let ctx;
  try { ctx = new AudioContext({ sampleRate: state.rate, latencyHint: "playback" }); }
  catch (e) { throw new Error(`This browser can't play ${state.rate / 1000} kHz audio. Try Chrome or Edge.`); }
  await ctx.audioWorklet.addModule("engine.js");
  await ctx.audioWorklet.addModule("worklet.js");
  const node = new AudioWorkletNode(ctx, "fsm-mixer", {
    numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
    processorOptions: { config: state.cfg, channels: state.channels },
  });
  node.connect(ctx.destination);
  node.port.onmessage = (e) => onWorklet(e.data);
  node.onprocessorerror = () => { flash("The mixer stopped because of an internal error. Reload the page to try again."); setPlaying(false); };
  state.ctx = ctx; state.node = node;
  seekTo(state.readPos);
}

async function stopAudio() {
  state.playing = false;
  if (state.ctx) { try { await state.ctx.close(); } catch { /* already closed */ } }
  state.ctx = null; state.node = null;
  $("#play").textContent = "▶";
}

function onWorklet(msg) {
  if (msg.type === "need") feed();
  else if (msg.type === "meters") {
    renderMeters(msg.meters);
    if (!state.seeking) setTime(msg.position);
  } else if (msg.type === "ended") {
    setPlaying(false);
    seekTo(0);
  } else if (msg.type === "error") flash(msg.message);
}

async function feed() {
  if (state.reading || !state.node) return;
  state.reading = true;
  const gen = state.generation;
  try {
    const frames = Math.round(state.rate * (state.remote ? 1.0 : 0.5));
    const start = state.readPos;
    const parts = await Promise.all(state.readers.map((r) => r.read(start, frames)));
    if (gen !== state.generation || !state.node) return;
    const data = parts.flat();
    state.readPos = start + frames;
    let eof = state.readPos >= state.frames;
    if (eof && $("#loop").checked) { state.readPos = 0; eof = false; }
    state.node.port.postMessage({ type: "chunk", data, frames, eof, generation: gen }, data.map((a) => a.buffer));
  } catch (e) {
    flash("Couldn't read the tracks: " + e.message);
  } finally {
    state.reading = false;
  }
}

function seekTo(frame) {
  state.generation++;
  state.readPos = Math.max(0, Math.min(state.frames - 1, Math.round(frame)));
  if (state.node) state.node.port.postMessage({ type: "seek", frame: state.readPos, generation: state.generation });
  setTime(state.readPos);
}

function setTime(pos) {
  const p = state.frames ? pos % state.frames : 0;
  $("#time").textContent = fmtTime(p / (state.rate || 1));
  if (!state.seeking) $("#seek").value = state.frames ? Math.round((p / state.frames) * 1000) : 0;
}

async function setPlaying(on) {
  if (on) {
    try { await startAudio(); } catch (e) { flash(e.message); return; }
    await state.ctx.resume();
    state.node.port.postMessage({ type: "play" });
  } else if (state.node) {
    state.node.port.postMessage({ type: "pause" });
  }
  state.playing = on;
  $("#play").textContent = on ? "❚❚" : "▶";
  $("#play").setAttribute("aria-label", on ? "Pause" : "Play");
}

// ------------------------------------------------------------------ settings
function setChannel(i, changes) {
  try {
    const updated = fsmGang(state.cfg.channels, i, fsmValidateChannel(changes));
    if (state.node) state.node.port.postMessage({ type: "channel", index: i, changes });
    for (const k of updated) FsmConsole.render(k);
    remember();
  } catch (e) { flash(e.message); }
}
function setMaster(changes) {
  try {
    Object.assign(state.cfg.master, fsmValidateMaster(changes));
    if (state.node) state.node.port.postMessage({ type: "master", changes });
    renderMaster();
    if (!("bypass" in changes)) remember();
  } catch (e) { flash(e.message); }
}

function exportConfig() {
  if (!state.cfg) { flash("Load some tracks first."); return; }
  const out = JSON.parse(JSON.stringify(state.cfg));
  out.master.bypass = false;
  out.channels.forEach((c) => { c.solo = false; });
  out.audio = Object.assign({}, FSM_DEFAULT_AUDIO, out.audio || {});
  const blob = new Blob([JSON.stringify(out, null, 2) + "\n"], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "config.json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  flash("Downloaded config.json — put it in the Fellowship Stream Mixer folder on the Mac.");
}

async function importConfig(file) {
  try {
    const cfg = fsmNormalize(JSON.parse(await file.text()));
    if (!state.cfg) { flash("Load your tracks first, then load settings."); return; }
    const byInput = new Map(cfg.channels.map((c) => [c.input, c]));
    state.cfg.channels.forEach((ch, i) => {
      const src = byInput.get(ch.input);
      if (!src) return;
      const { input, link, ...rest } = src;
      if (link !== undefined) setChannel(i, { link });
      setChannel(i, rest);
    });
    const { bypass, ...m } = cfg.master;
    setMaster(m);
    state.cfg.audio = cfg.audio;
    flash(`Loaded settings from ${file.name}.`);
  } catch (e) { flash("Couldn't read that settings file: " + e.message); }
}

// ------------------------------------------------------------------ console UI
function build() {
  FsmConsole.init({
    getCfg: () => state.cfg,
    setChannel,
    types,
    eqPresets: EQ_PRESET_LIST,
    compLevels: COMP_LIST,
  });
  FsmConsole.build();
  renderMaster();
}

function renderMaster() {
  const m = state.cfg.master, sel = $("#target");
  const ks = $("#key");
  if (!ks.options.length) for (const k of FSM_KEYS) ks.add(new Option(k === "chromatic" ? "Chromatic (any note)" : k === "auto" ? "Auto-detect" : k, k));
  ks.value = m.tune_key || "chromatic";
  $("#polish").value = m.polish === false ? "off" : "on";
  const tv = String(Math.round(m.target_lufs));
  if (![...sel.options].some((o) => o.value === tv)) sel.add(new Option(`${m.target_lufs} LUFS`, tv));
  sel.value = tv;
  $("#lufs-sub").textContent = `target ${String(m.target_lufs).replace("-", "–")}`;
  $("#rv").value = m.reverb_return_db; $("#rvv").textContent = `${fmt(m.reverb_return_db, 0)} dB`;
  const b = $("#bypass");
  b.textContent = m.bypass ? "Auto mix: OFF (plain faders)" : "Auto mix: ON";
  b.className = "toggle " + (m.bypass ? "off" : "on");
}

function meter(el, db) {
  const prev = held.has(el) ? held.get(el) : FLOOR;
  const shown = Math.max(db ?? FLOOR, prev - 1.2);
  held.set(el, shown);
  el.style.height = pct(shown) + "%";
  el.style.setProperty("--h", el.parentElement.clientHeight + "px");
}

function renderMeters(m) {
  const ms = m.master;
  $("#lufs").textContent = ms.short_term < -70 ? "–" : ms.short_term.toFixed(1).replace("-", "–");
  meter($("#mL"), ms.peak_l); meter($("#mR"), ms.peak_r);
  $("#agc").textContent = `${fmt(ms.loudness_gain_db)} dB`;
  $("#lim").textContent = `${ms.limiter_db.toFixed(1)} dB`;
  $("#pol").textContent = ms.polish === false ? "off" : `${(ms.polish_db || 0).toFixed(1)} dB`;
  $("#load").textContent = `${ms.dsp_load.toFixed(0)}%` + (ms.xruns ? ` · ${ms.xruns} gaps` : "");
  $("#solo-alert").hidden = !ms.solo_active;
  $("#key-now").textContent = ms.key_detected || "listening…";
  const kd = $("#key-detected"), auto = (CFG().master.tune_key || "chromatic") === "auto";
  kd.hidden = !auto;
  if (auto) kd.textContent = ms.key_detected ? `Detected: ${ms.key_detected}` : "Listening for the key… (Tune uses any note until then)";
  const sp = $("#speech"), ducking = ms.duck_db < -0.5;
  sp.textContent = ducking ? `Speech — music ${ms.duck_db.toFixed(0)} dB` : ms.speech_active ? "Speech detected" : "Music level normal";
  sp.classList.toggle("live", ducking);
  const rv = $("#reverb-state");
  rv.textContent = ms.reverb_resting ? "Reverb resting — no music" : "Reverb on";
  rv.classList.toggle("rest", !!ms.reverb_resting);
  if (state.playing) flash(`Playing · ${state.rate / 1000} kHz` + (ms.bypass ? " · automation bypassed" : ""));
  FsmConsole.meters(m.channels);
}

// ------------------------------------------------------------------ wiring
$("#pick-files").addEventListener("click", () => $("#files").click());
$("#pick-folder").addEventListener("click", () => $("#folder").click());
$("#files").addEventListener("change", (e) => loadFiles(e.target.files));
$("#folder").addEventListener("change", (e) => loadFiles(e.target.files));
// ---- demo recordings published on the website (docs/demos/index.json)
function applyConfig(cfg) {
  const c = fsmNormalize(cfg);
  const byInput = new Map(c.channels.map((ch) => [ch.input, ch]));
  state.cfg.channels = state.cfg.channels.map((ch) => {
    const src = byInput.get(ch.input);
    return src ? Object.assign({}, ch, src, { input: ch.input, solo: false }) : ch;
  });
  state.cfg.master = Object.assign({}, state.cfg.master, c.master, { bypass: false });
}

async function loadDemo(d, button) {
  const err = $("#load-error");
  err.hidden = true;
  button.disabled = true;
  try {
    flash(`Opening “${d.title}”…`);
    const rel = d.path || `demos/${d.folder}`;
    const base = rel.split("/").map(encodeURIComponent).join("/") + "/";
    let config = null;
    if (d.config) {
      try { config = await (await fetch(base + encodeURIComponent(d.config))).json(); }
      catch { /* the demo still works without its settings */ }
    }
    // WAVs stream with range requests; compressed tracks are fetched whole and decoded
    const files = await Promise.all(d.tracks.map((t) => COMPRESSED_EXT.test(t)
      ? { name: t, url: base + encodeURIComponent(t) }
      : RemoteFile.open(base + encodeURIComponent(t), t)));
    await loadFiles(files, { config, remote: true, title: d.title });
  } catch (e) {
    err.textContent = `Couldn't open that demo: ${e.message}`; err.hidden = false; flash("Couldn't open the demo.");
  } finally {
    button.disabled = false;
  }
}

let publishedDemos = [];

async function listDemos() {
  let index;
  try {
    const res = await fetch("demos/index.json", { cache: "no-cache" });
    if (!res.ok) return;
    index = await res.json();
  } catch { return; }
  const demos = (index && index.demos) || [];
  publishedDemos = demos;
  if (!demos.length) return;
  // the first published recording becomes "Try the demo"; any others are listed below
  $("#demo").title = `Opens “${demos[0].title}”`;
  if (demos.length < 2) return;
  const host = $("#demo-cards");
  host.innerHTML = "";
  for (const d of demos) {
    const b = document.createElement("button");
    b.className = "demo-card";
    const mins = Math.floor(d.seconds / 60), secs = String(Math.round(d.seconds % 60)).padStart(2, "0");
    b.innerHTML = "<b></b><span class=\"muted small\"></span><span class=\"desc\"></span>";
    b.querySelector("b").textContent = d.title;
    b.querySelector(".muted").textContent = `${d.tracks.length} tracks · ${mins}:${secs} · ${Math.round(d.rate / 1000)} kHz`;
    b.querySelector(".desc").textContent = d.description || "";
    b.addEventListener("click", () => loadDemo(d, b));
    host.appendChild(b);
  }
  $("#demo-list").hidden = false;
}
listDemos();

$("#demo").addEventListener("click", (e) => {
  if (publishedDemos.length) { loadDemo(publishedDemos[0], e.currentTarget); return; }
  flash("Building the demo…");
  setTimeout(() => loadFiles(makeDemoTracks()), 20);
});

const drop = $("#drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", async (e) => {
  e.preventDefault(); drop.classList.remove("over");
  const files = [];
  const walk = async (entry) => {
    if (!entry) return;
    if (entry.isFile) files.push(await new Promise((res, rej) => entry.file(res, rej)));
    else if (entry.isDirectory) {
      const rd = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => rd.readEntries(res, rej));
        if (!batch.length) break;
        for (const b of batch) await walk(b);
      }
    }
  };
  const items = [...(e.dataTransfer.items || [])];
  if (items.length && items[0].webkitGetAsEntry) for (const it of items) await walk(it.webkitGetAsEntry());
  else files.push(...e.dataTransfer.files);
  loadFiles(files);
});

$("#play").addEventListener("click", () => setPlaying(!state.playing));
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && state.cfg && !/INPUT|SELECT|BUTTON|TEXTAREA/.test(document.activeElement.tagName)) {
    e.preventDefault(); setPlaying(!state.playing);
  }
});
const seek = $("#seek");
seek.addEventListener("input", () => {
  state.seeking = true;
  $("#time").textContent = fmtTime((seek.value / 1000) * state.frames / state.rate);
});
seek.addEventListener("change", () => { seekTo((seek.value / 1000) * state.frames); state.seeking = false; });

$("#target").addEventListener("change", (e) => setMaster({ target_lufs: Number(e.target.value) }));
$("#rv").addEventListener("input", (e) => setMaster({ reverb_return_db: Number(e.target.value) }));
$("#key").addEventListener("change", (e) => setMaster({ tune_key: e.target.value }));
$("#polish").addEventListener("change", (e) => setMaster({ polish: e.target.value === "on" }));
$("#solo-alert").addEventListener("click", () => {
  state.cfg.channels.forEach((c, i) => { if (c.solo) setChannel(i, { solo: false }); });
});
$("#bypass").addEventListener("click", () => setMaster({ bypass: !state.cfg.master.bypass }));

const menu = $("#menu"), menuBtn = $("#menu-btn");
menuBtn.addEventListener("click", (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; menuBtn.setAttribute("aria-expanded", String(!menu.hidden)); });
document.addEventListener("click", (e) => { if (!menu.contains(e.target)) { menu.hidden = true; menuBtn.setAttribute("aria-expanded", "false"); } });
$("#export").addEventListener("click", () => { menu.hidden = true; exportConfig(); });
$("#import").addEventListener("click", () => { menu.hidden = true; $("#import-file").click(); });
$("#import-file").addEventListener("change", (e) => { if (e.target.files[0]) importConfig(e.target.files[0]); e.target.value = ""; });
$("#change").addEventListener("click", async () => {
  menu.hidden = true;
  await stopAudio();
  $("#loader").hidden = false; $("#transport").hidden = true; $("#mixer").hidden = true; $("#bypass").disabled = true;
  flash("Load a multitrack recording to begin.");
});

if (!("audioWorklet" in (window.AudioContext ? AudioContext.prototype : {}))) {
  flash("This browser can't run the mixer. Please use a recent Chrome, Edge, Safari or Firefox.");
}
