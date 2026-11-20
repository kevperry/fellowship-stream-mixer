/* Practice page: load tracks, stream them to the mixer worklet, show the console. */
/* global WavReader, naturalCompare, makeDemoTracks, fsmNormalize, fsmValidateChannel, fsmValidateMaster,
   fsmGuessType, FSM_PRESETS, FSM_TYPE_ORDER, FSM_DEFAULT_AUDIO */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const FLOOR = -60;
const pct = (db) => Math.max(0, Math.min(100, ((db - FLOOR) / -FLOOR) * 100));
const fmt = (v, d = 1) => (v > 0 ? "+" : "") + Number(v).toFixed(d);
const fmtTime = (s) => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s % 60).padStart(2, "0"); };

const types = FSM_TYPE_ORDER.map((id) => ({ id, label: FSM_PRESETS[id].label, reverb_db: FSM_PRESETS[id].reverb_db }));
const state = {
  readers: [], rate: 0, frames: 0, channels: 0, names: [],
  cfg: null, ctx: null, node: null, playing: false,
  readPos: 0, generation: 0, reading: false, seeking: false, key: "",
};
const strips = [];
const held = new Map();

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
async function loadFiles(fileList) {
  const err = $("#load-error");
  err.hidden = true;
  const files = [...fileList].filter((f) => /\.wav$/i.test(f.name)).sort((a, b) => naturalCompare(a.name, b.name));
  if (!files.length) { err.textContent = "No .wav files found. Export your tracks as WAV and try again."; err.hidden = false; return; }
  try {
    flash("Reading track headers…");
    const readers = await Promise.all(files.map((f) => WavReader.open(f)));
    const rates = [...new Set(readers.map((r) => r.rate))];
    if (rates.length > 1) throw new Error(`All tracks must share one sample rate (found ${rates.join(", ")} Hz).`);
    await stopAudio();
    state.readers = readers;
    state.rate = rates[0];
    state.frames = Math.min(...readers.map((r) => r.frames));
    state.channels = readers.reduce((a, r) => a + r.channels, 0);
    state.names = [];
    for (const r of readers) {
      const base = r.name.replace(/\.wav$/i, "").replace(/^(track|trk|ch|channel)?\s*\d+\s*[-_. ]*\s*/i, "").trim();
      for (let c = 0; c < r.channels; c++) {
        const nm = base || r.name.replace(/\.wav$/i, "");
        state.names.push(r.channels > 1 ? `${nm} ${c + 1}` : nm);
      }
    }
    if (state.channels > 64) throw new Error(`That's ${state.channels} channels; the mixer handles up to 64.`);
    state.key = "fsm:" + readers.map((r) => `${r.name}/${r.channels}`).join("|");
    const saved = store.get(state.key);
    state.cfg = saved && saved.channels && saved.channels.length === state.channels ? fsmNormalize(saved) : defaultConfig();
    state.readPos = 0;
    $("#loader").hidden = true;
    $("#transport").hidden = false;
    $("#mixer").hidden = false;
    $("#bypass").disabled = false;
    $("#duration").textContent = fmtTime(state.frames / state.rate);
    $("#info").textContent = `${state.channels} tracks · ${state.rate / 1000} kHz`;
    setTime(0);
    build();
    flash(saved ? "Loaded — your settings for these tracks were restored. Press play." : "Loaded. Check each channel's type, then press play.");
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
    const frames = Math.round(state.rate * 0.5);
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
    const ch = Object.assign({}, state.cfg.channels[i], fsmValidateChannel(changes));
    if (ch.link && i === 0) ch.link = false;
    state.cfg.channels[i] = ch;
    if (state.node) state.node.port.postMessage({ type: "channel", index: i, changes });
    renderStripStatic(i);
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
      const { input, ...rest } = src;
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
  const host = $("#strips");
  host.innerHTML = "";
  strips.length = 0;
  const tpl = $("#strip-tpl");
  state.cfg.channels.forEach((ch, i) => {
    const el = tpl.content.firstElementChild.cloneNode(true);
    const sel = $(".type", el);
    for (const t of types) sel.add(new Option(t.label, t.id));
    const s = {
      el, sel, name: $(".name", el), num: $(".num", el), led: $(".led", el),
      fader: $(".fader", el), faderV: $(".fader-v", el), pan: $(".pan", el), reverb: $(".reverb", el),
      mute: $(".mute", el), link: $(".linkbox", el), auto: $(".auto", el), autoV: $(".auto b", el),
      mIn: $(".fill.in", el), mOut: $(".fill.out", el),
    };
    s.name.addEventListener("change", () => setChannel(i, { name: s.name.value }));
    sel.addEventListener("change", () => setChannel(i, { type: sel.value, reverb_db: null }));
    s.fader.addEventListener("input", () => setChannel(i, { fader_db: Number(s.fader.value) }));
    s.fader.addEventListener("dblclick", () => setChannel(i, { fader_db: 0 }));
    s.pan.addEventListener("input", () => setChannel(i, { pan: Number(s.pan.value) }));
    s.pan.addEventListener("dblclick", () => setChannel(i, { pan: 0 }));
    s.reverb.addEventListener("input", () => {
      const v = Number(s.reverb.value);
      setChannel(i, { reverb_db: v <= -40 ? -60 : v });
    });
    s.mute.addEventListener("click", () => setChannel(i, { mute: !state.cfg.channels[i].mute }));
    s.link.addEventListener("change", () => setChannel(i, { link: s.link.checked }));
    if (i === 0) $(".link", el).style.visibility = "hidden";
    host.appendChild(el);
    strips.push(s);
    renderStripStatic(i);
  });
  renderMaster();
}

function renderStripStatic(i) {
  const ch = state.cfg.channels[i], s = strips[i];
  if (!s) return;
  const t = types.find((x) => x.id === ch.type);
  s.num.textContent = `IN ${ch.input}`;
  if (document.activeElement !== s.name) s.name.value = ch.name;
  s.sel.value = ch.type;
  if (document.activeElement !== s.fader) s.fader.value = ch.fader_db;
  s.faderV.textContent = fmt(ch.fader_db);
  if (document.activeElement !== s.pan) s.pan.value = ch.pan;
  const rv = ch.reverb_db ?? t?.reverb_db ?? null;
  if (document.activeElement !== s.reverb) s.reverb.value = rv === null || rv <= -40 ? -40 : rv;
  s.mute.classList.toggle("active", !!ch.mute);
  s.link.checked = !!ch.link;
  s.el.classList.toggle("off", ch.type === "off");
}

function renderMaster() {
  const m = state.cfg.master, sel = $("#target");
  const tv = String(Math.round(m.target_lufs));
  if (![...sel.options].some((o) => o.value === tv)) sel.add(new Option(`${m.target_lufs} LUFS`, tv));
  sel.value = tv;
  $("#lufs-sub").textContent = `target ${String(m.target_lufs).replace("-", "–")}`;
  $("#ducking").value = m.ducking;
  $("#duck").value = m.duck_depth_db; $("#duckv").textContent = `${m.duck_depth_db} dB`;
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
  $("#load").textContent = `${ms.dsp_load.toFixed(0)}%` + (ms.xruns ? ` · ${ms.xruns} gaps` : "");
  const sp = $("#speech"), ducking = ms.duck_db < -0.5;
  sp.textContent = ducking ? `Speech — music ${ms.duck_db.toFixed(0)} dB` : ms.speech_active ? "Speech detected" : "Music level normal";
  sp.classList.toggle("live", ducking);
  if (state.playing) flash(`Playing · ${state.rate / 1000} kHz` + (ms.bypass ? " · automation bypassed" : ""));
  m.channels.forEach((c, i) => {
    const s = strips[i];
    if (!s) return;
    meter(s.mIn, c.in_peak); meter(s.mOut, c.out_peak);
    s.led.classList.toggle("on", c.active);
    s.autoV.textContent = fmt(c.leveler_db + c.comp_db + c.gate_db + c.share_db + c.duck_db);
    s.auto.title = `leveler ${fmt(c.leveler_db)} · compressor ${fmt(c.comp_db)} · gate ${fmt(c.gate_db)}\n` +
      `gain share ${fmt(c.share_db)} · ducking ${fmt(c.duck_db)}\nlevel ${c.level} dBFS · noise floor ${c.noise_floor} dBFS`;
  });
}

// ------------------------------------------------------------------ wiring
$("#pick-files").addEventListener("click", () => $("#files").click());
$("#pick-folder").addEventListener("click", () => $("#folder").click());
$("#files").addEventListener("change", (e) => loadFiles(e.target.files));
$("#folder").addEventListener("change", (e) => loadFiles(e.target.files));
$("#demo").addEventListener("click", () => { flash("Building the demo…"); setTimeout(() => loadFiles(makeDemoTracks()), 20); });

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
$("#ducking").addEventListener("change", (e) => setMaster({ ducking: e.target.value }));
$("#duck").addEventListener("input", (e) => setMaster({ duck_depth_db: Number(e.target.value) }));
$("#rv").addEventListener("input", (e) => setMaster({ reverb_return_db: Number(e.target.value) }));
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
