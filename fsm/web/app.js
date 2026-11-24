"use strict";

const $ = (s, el = document) => el.querySelector(s);
const FLOOR = -60;
const pct = (db) => Math.max(0, Math.min(100, ((db - FLOOR) / -FLOOR) * 100));
const fmt = (v, d = 1) => (v > 0 ? "+" : "") + Number(v).toFixed(d);

let cfg = null;
let types = [];
let keys = ["chromatic"];
let EQ_PRESET_LIST = [], COMP_LIST = [];
const held = new Map(); // meter element -> displayed dB (for smooth fall-off)

async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

function setChannel(i, changes) {
  api("/api/channel", { index: i, changes })
    .then((r) => { for (const u of r.updated) { cfg.channels[u.index] = u.channel; FsmConsole.render(u.index); } })
    .catch((e) => flash(e.message));
}
function setMaster(changes) {
  api("/api/master", changes).then((m) => { cfg.master = m; renderMaster(); }).catch((e) => flash(e.message));
}

const CFG = () => cfg;
function flash(msg) { $("#status").textContent = msg; }

// ---------------------------------------------------------------- channels (shared console.js)
function build() {
  FsmConsole.init({
    getCfg: () => cfg,
    setChannel,
    types,
    eqPresets: EQ_PRESET_LIST,
    compLevels: COMP_LIST,
  });
  FsmConsole.build();
  renderMaster();
}

function renderMaster() {
  const m = cfg.master;
  const ks = $("#key");
  if (ks.options.length !== keys.length) { ks.innerHTML = ""; for (const k of keys) ks.add(new Option(k === "chromatic" ? "Chromatic (any note)" : k === "auto" ? "Auto-detect" : k, k)); }
  ks.value = m.tune_key || "chromatic";
  $("#polish").value = m.polish === false ? "off" : "on";
  $("#target").value = String(Math.round(m.target_lufs));
  if (![...$("#target").options].some((o) => o.value === $("#target").value)) {
    $("#target").add(new Option(`${m.target_lufs} LUFS`, String(Math.round(m.target_lufs))));
    $("#target").value = String(Math.round(m.target_lufs));
  }
  $("#lufs-sub").textContent = `target ${String(m.target_lufs).replace("-", "–")}`;
  $("#rv").value = m.reverb_return_db; $("#rvv").textContent = `${fmt(m.reverb_return_db, 0)} dB`;
  const b = $("#bypass");
  b.textContent = m.bypass ? "Auto mix: OFF (plain faders)" : "Auto mix: ON";
  b.className = "toggle " + (m.bypass ? "off" : "on");
}

$("#target").addEventListener("change", (e) => setMaster({ target_lufs: Number(e.target.value) }));
$("#rv").addEventListener("input", (e) => setMaster({ reverb_return_db: Number(e.target.value) }));
$("#key").addEventListener("change", (e) => setMaster({ tune_key: e.target.value }));
$("#polish").addEventListener("change", (e) => setMaster({ polish: e.target.value === "on" }));
$("#solo-alert").addEventListener("click", () =>
  api("/api/clear_solo", {}).then(() => { cfg.channels.forEach((c) => { c.solo = false; }); FsmConsole.renderAll(); })
    .catch((e) => flash(e.message)));
// ---- recorder
let recording = false;
const fmtSize = (b) => b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`;
const fmtClock = (s) => { s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  return `${h ? h + ":" + String(m).padStart(2, "0") : m}:${String(s % 60).padStart(2, "0")}`; };
function renderRecording(r) {
  recording = r.active;
  const btn = $("#record"), st = $("#rec-status");
  btn.classList.toggle("on", r.active);
  btn.textContent = r.active ? "■ Stop recording" : "● Record";
  if (r.active) {
    st.hidden = false;
    st.textContent = `REC ${fmtClock(r.seconds)} · ${fmtSize(r.bytes)}` +
      (r.free_bytes != null ? ` · ${fmtSize(r.free_bytes)} free` : "") + (r.dropped ? ` · ${r.dropped} gaps` : "");
  } else if (r.error) {
    st.hidden = false; st.textContent = r.error;
  } else if (r.folder && r.seconds > 0) {
    st.hidden = false; st.textContent = `Saved ${fmtClock(r.seconds)} to ${r.folder.split("/").pop()}`;
  } else st.hidden = true;
}
$("#record").addEventListener("click", () => {
  if (recording && !confirm("Stop recording?")) return;
  api("/api/record", { on: !recording }).then((r) => renderRecording(r.recording)).catch((e) => flash(e.message));
});

$("#bypass").addEventListener("click", () => setMaster({ bypass: !cfg.master.bypass }));
$("#save").addEventListener("click", () =>
  api("/api/save", {}).then((r) => flash(`Saved to ${r.saved}`)).catch((e) => flash(e.message)));

// ---------------------------------------------------------------- meters
function meter(el, db) {
  const prev = held.has(el) ? held.get(el) : FLOOR;
  const shown = Math.max(db ?? FLOOR, prev - 1.2); // ~15 dB/s fall-off at 12 fps
  held.set(el, shown);
  el.style.height = pct(shown) + "%";
  el.style.setProperty("--h", el.parentElement.clientHeight + "px");
}

function renderMeters(m) {
  const ms = m.master;
  $("#lufs").textContent = ms.short_term < -70 ? "–" : ms.short_term.toFixed(1).replace("-", "–");
  meter($("#mL"), ms.peak_l);
  meter($("#mR"), ms.peak_r);
  $("#agc").textContent = `${fmt(ms.loudness_gain_db)} dB`;
  $("#lim").textContent = `${ms.limiter_db.toFixed(1)} dB`;
  $("#pol").textContent = ms.polish === false ? "off" : `${(ms.polish_db || 0).toFixed(1)} dB`;
  $("#load").textContent = `${ms.dsp_load.toFixed(0)}%` + (ms.xruns ? ` · ${ms.xruns} dropouts` : "");
  $("#solo-alert").hidden = !ms.solo_active;
  $("#key-now").textContent = ms.key_detected || "listening…";
  const kd = $("#key-detected"), auto = (CFG().master.tune_key || "chromatic") === "auto";
  kd.hidden = !auto;
  if (auto) kd.textContent = ms.key_detected ? `Detected: ${ms.key_detected}` : "Listening for the key… (Tune uses any note until then)";
  const sp = $("#speech");
  const ducking = ms.duck_db < -0.5;
  sp.textContent = ducking ? `Speech — music ${ms.duck_db.toFixed(0)} dB` : ms.speech_active ? "Speech detected" : "Music level normal";
  sp.classList.toggle("live", ducking);
  const rv = $("#reverb-state");
  rv.textContent = ms.reverb_resting ? "Reverb resting — no music" : "Reverb on";
  rv.classList.toggle("rest", !!ms.reverb_resting);
  flash(`Running · ${Math.round(ms.sample_rate / 1000)} kHz · ${(1000 * ms.block / ms.sample_rate).toFixed(0)} ms blocks` +
        (ms.bypass ? " · automation bypassed" : ""));

  FsmConsole.meters(m.channels);
}

// ---------------------------------------------------------------- loop
async function start() {
  for (;;) {
    try {
      const data = await api("/api/config");
      cfg = data.config; types = data.types; keys = data.keys || keys;
      EQ_PRESET_LIST = data.eq_presets || []; COMP_LIST = data.comp_levels || [];
      $("#save").hidden = !data.can_save;
      build();
      break;
    } catch (e) {
      flash("Waiting for the audio engine…");
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  const tick = async () => {
    try {
      const st = await api("/api/state");
      if (st.meters && st.meters.channels) renderMeters(st.meters);
      if (st.recording) renderRecording(st.recording);
    } catch (e) {
      flash("Lost connection to the mixer — is it still running?");
    }
    setTimeout(tick, 80);
  };
  tick();
}
start();
