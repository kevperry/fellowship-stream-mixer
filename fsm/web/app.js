"use strict";

const $ = (s, el = document) => el.querySelector(s);
const FLOOR = -60;
const VOCAL_TYPES = ["lead_vocal"];
const pct = (db) => Math.max(0, Math.min(100, ((db - FLOOR) / -FLOOR) * 100));
const fmt = (v, d = 1) => (v > 0 ? "+" : "") + Number(v).toFixed(d);

let cfg = null;
let types = [];
let keys = ["chromatic"];
let EQ_PRESET_LIST = [], COMP_LIST = [];
const CH = (i) => cfg.channels[i];
const strips = [];
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
    .then((r) => { for (const u of r.updated) { cfg.channels[u.index] = u.channel; renderStripStatic(u.index); } })
    .catch((e) => flash(e.message));
}
function setMaster(changes) {
  api("/api/master", changes).then((m) => { cfg.master = m; renderMaster(); }).catch((e) => flash(e.message));
}

function flash(msg) { $("#status").textContent = msg; }

// ---------------------------------------------------------------- build
function build() {
  const host = $("#strips");
  host.innerHTML = "";
  strips.length = 0;
  const tpl = $("#strip-tpl");
  cfg.channels.forEach((ch, i) => {
    const el = tpl.content.firstElementChild.cloneNode(true);
    const sel = $(".type", el);
    for (const t of types) sel.add(new Option(t.label, t.id));
    const s = {
      el, sel,
      name: $(".name", el), num: $(".num", el), led: $(".led", el),
      fader: $(".fader", el), faderV: $(".fader-v", el),
      pan: $(".pan", el), reverb: $(".reverb", el), mute: $(".mute", el),
      link: $(".linkbox", el), auto: $(".auto", el), autoV: $(".auto b", el),
      autoPanel: $(".auto-panel", el), alOn: $(".al-on", el), alRange: $(".al-range", el), arV: $(".ar-v", el),
      dmOn: $(".dm-on", el), dmRow: $(".dm", el),
      tone: $(".tone", el), tonePanel: $(".tone-panel", el), eqBars: [...el.querySelectorAll(".eqbars i")],
      gr: $(".tone .gr", el), eqSel: $(".eq-preset", el), eqAmt: $(".eq-amount", el), eaV: $(".ea-v", el),
      compSel: $(".comp-sel", el),
      alSpeed: $(".al-speed", el), asV: $(".as-v", el), alReset: $(".al-reset", el), lvlOff: $(".lvl-off", el),
      solo: $(".solo", el), tuneBtn: $(".tune-btn", el), tunePanel: $(".tune-panel", el),
      tuneNote: $(".tune-note", el), tuneCents: $(".tune-cents", el),
      tAmt: $(".tune-amount", el), tAmtV: $(".ta-v", el), tSpd: $(".tune-speed", el), tSpdV: $(".ts-v", el),
      mIn: $(".fill.in", el), mOut: $(".fill.out", el),
    };
    s.name.addEventListener("change", () => setChannel(i, { name: s.name.value }));
    sel.addEventListener("change", () => setChannel(i, { type: sel.value, reverb_db: null }));
    s.fader.addEventListener("input", () => {
      s.faderV.textContent = fmt(s.fader.value);
      setChannel(i, { fader_db: Number(s.fader.value) });
    });
    s.fader.addEventListener("dblclick", () => setChannel(i, { fader_db: 0 }));
    s.pan.addEventListener("input", () => setChannel(i, { pan: Number(s.pan.value) }));
    s.pan.addEventListener("dblclick", () => setChannel(i, { pan: 0 }));
    s.reverb.addEventListener("input", () => {
      const v = Number(s.reverb.value);
      setChannel(i, { reverb_db: v <= -40 ? -60 : v });
    });
    s.mute.addEventListener("click", () => setChannel(i, { mute: !cfg.channels[i].mute }));
    s.link.addEventListener("change", () => setChannel(i, { link: s.link.checked }));
    s.solo.addEventListener("click", () => setChannel(i, { solo: !CH(i).solo }));
    s.auto.addEventListener("click", () => { s.autoOpen = !s.autoOpen; renderStripStatic(i); });
    s.alOn.addEventListener("change", () => setChannel(i, { auto_level: s.alOn.checked }));
    s.dmOn.addEventListener("change", () => setChannel(i, { ducks_music: s.dmOn.checked }));
    for (const e of EQ_PRESET_LIST) s.eqSel.add(new Option(e.label, e.id));
    for (const c of COMP_LIST) s.compSel.add(new Option(c.label, c.id));
    s.tone.addEventListener("click", () => { s.toneOpen = !s.toneOpen; renderStripStatic(i); });
    s.eqSel.addEventListener("change", () => setChannel(i, { eq_preset: s.eqSel.value }));
    s.eqAmt.addEventListener("input", () => setChannel(i, { eq_amount: Number(s.eqAmt.value) }));
    s.compSel.addEventListener("change", () => setChannel(i, { comp: s.compSel.value }));
    s.alRange.addEventListener("input", () => setChannel(i, { level_range: Number(s.alRange.value) }));
    s.alSpeed.addEventListener("input", () => setChannel(i, { level_speed: Number(s.alSpeed.value) }));
    s.alReset.addEventListener("click", () => setChannel(i, { auto_level: true, level_range: null, level_speed: null }));
    s.tuneBtn.addEventListener("click", () => setChannel(i, { tune: !CH(i).tune }));
    s.tAmt.addEventListener("input", () => setChannel(i, { tune_amount: Number(s.tAmt.value) }));
    s.tSpd.addEventListener("input", () => setChannel(i, { tune_speed_ms: Number(s.tSpd.value) }));
    if (i === 0) $(".link", el).style.visibility = "hidden";
    host.appendChild(el);
    strips.push(s);
    renderStripStatic(i);
  });
  renderMaster();
}

function renderStripStatic(i) {
  const ch = cfg.channels[i], s = strips[i];
  const t = types.find((x) => x.id === ch.type);
  s.num.textContent = `IN ${ch.input}`;
  if (document.activeElement !== s.name) s.name.value = ch.name;
  s.sel.value = ch.type;
  if (document.activeElement !== s.fader) s.fader.value = ch.fader_db;
  s.faderV.textContent = fmt(ch.fader_db);
  s.pan.value = ch.pan;
  const rv = ch.reverb_db ?? t?.reverb_db ?? null;
  if (document.activeElement !== s.reverb) s.reverb.value = rv === null || rv <= -40 ? -40 : rv;
  s.mute.classList.toggle("active", !!ch.mute);
  s.link.checked = !!ch.link;
  s.solo.classList.toggle("active", !!ch.solo);
  const typeRange = (types.find((x) => x.id === ch.type) || {}).leveler_range ?? 0;
  const lvlOn = ch.auto_level !== false;
  const range = ch.level_range ?? typeRange, speed = ch.level_speed ?? 3;
  s.autoPanel.hidden = !s.autoOpen || ch.type === "off";
  s.auto.classList.toggle("open", !!s.autoOpen);
  s.auto.classList.toggle("dim", !lvlOn);
  s.lvlOff.hidden = lvlOn;
  s.alOn.checked = lvlOn;
  s.dmRow.hidden = ch.type !== "speech";
  s.tone.hidden = ch.type === "off";
  s.tonePanel.hidden = !s.toneOpen || ch.type === "off";
  s.tone.classList.toggle("open", !!s.toneOpen);
  if (ch.eq_preset != null && document.activeElement !== s.eqSel) s.eqSel.value = ch.eq_preset;
  if (ch.comp != null && document.activeElement !== s.compSel) s.compSel.value = ch.comp;
  if (document.activeElement !== s.eqAmt) s.eqAmt.value = ch.eq_amount ?? 50;
  s.eaV.textContent = `${Math.round(ch.eq_amount ?? 50)}%`;
  s.dmOn.checked = ch.ducks_music !== false;
  s.alRange.disabled = s.alSpeed.disabled = !lvlOn;
  if (document.activeElement !== s.alRange) s.alRange.value = range;
  if (document.activeElement !== s.alSpeed) s.alSpeed.value = speed;
  s.arV.textContent = `±${Math.round(range)} dB` + (ch.level_range == null ? " (default)" : "");
  s.asV.textContent = `${speed} dB/s` + (speed <= 1.5 ? " slow" : speed >= 6 ? " fast" : "");
  s.el.classList.toggle("soloed", !!ch.solo);
  const vocal = VOCAL_TYPES.includes(ch.type);
  s.tuneBtn.hidden = !vocal;
  s.tuneBtn.classList.toggle("active", vocal && !!ch.tune);
  s.tunePanel.hidden = !(vocal && ch.tune);
  if (document.activeElement !== s.tAmt) s.tAmt.value = ch.tune_amount ?? 50;
  if (document.activeElement !== s.tSpd) s.tSpd.value = ch.tune_speed_ms ?? 150;
  s.tAmtV.textContent = `${Math.round(ch.tune_amount ?? 50)}%`;
  s.tSpdV.textContent = `${Math.round(ch.tune_speed_ms ?? 150)} ms`;
  s.el.classList.toggle("off", ch.type === "off");
}

function renderMaster() {
  const m = cfg.master;
  const ks = $("#key");
  if (ks.options.length !== keys.length) { ks.innerHTML = ""; for (const k of keys) ks.add(new Option(k === "chromatic" ? "Chromatic (any note)" : k, k)); }
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
  api("/api/clear_solo", {}).then(() => { cfg.channels.forEach((c, i) => { c.solo = false; renderStripStatic(i); }); })
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
  const sp = $("#speech");
  const ducking = ms.duck_db < -0.5;
  sp.textContent = ducking ? `Speech — music ${ms.duck_db.toFixed(0)} dB` : ms.speech_active ? "Speech detected" : "Music level normal";
  sp.classList.toggle("live", ducking);
  const rv = $("#reverb-state");
  rv.textContent = ms.reverb_resting ? "Reverb resting — no music" : "Reverb on";
  rv.classList.toggle("rest", !!ms.reverb_resting);
  flash(`Running · ${Math.round(ms.sample_rate / 1000)} kHz · ${(1000 * ms.block / ms.sample_rate).toFixed(0)} ms blocks` +
        (ms.bypass ? " · automation bypassed" : ""));

  m.channels.forEach((c, i) => {
    const s = strips[i];
    if (!s) return;
    meter(s.mIn, c.in_peak);
    meter(s.mOut, c.out_peak);
    s.led.classList.toggle("on", c.active);
    if (c.eq_gains) c.eq_gains.forEach((g, k) => {
      const b = s.eqBars[k];
      b.style.height = `${Math.min(9, Math.abs(g) * 1.5)}px`;
      b.style.left = `${k * 6}px`;
      if (g >= 0) { b.style.bottom = "50%"; b.style.top = "auto"; } else { b.style.top = "50%"; b.style.bottom = "auto"; }
      b.className = g > 0.2 ? "up" : g < -0.2 ? "down" : "";
    });
    s.gr.textContent = c.comp === "off" ? "comp off" : `comp ${Math.abs(c.comp_db) < 0.05 ? "0" : c.comp_db.toFixed(1)}`;
    s.tone.title = `Tone — EQ: ${c.eq_gains ? c.eq_gains.map((g, k) => `${["125", "250", "500", "1k", "2k", "4k", "8k"][k]} ${fmt(g)}`).join(", ") : ""}\nClick to adjust`;
    const ch = CH(i);
    if (ch && ch.eq_preset == null && document.activeElement !== s.eqSel) s.eqSel.value = c.eq_preset;
    if (ch && ch.comp == null && document.activeElement !== s.compSel) s.compSel.value = c.comp;
    if (!s.tunePanel.hidden) {
      s.tuneNote.textContent = c.tune_note || "–";
      s.tuneCents.textContent = c.tune_note && Math.abs(c.tune_cents) >= 1 ? `${fmt(c.tune_cents, 0)}¢` : "";
    }
    const auto = c.leveler_db + c.comp_db + c.gate_db + c.share_db + c.duck_db;
    s.autoV.textContent = fmt(auto);
    s.auto.title =
      `leveler ${fmt(c.leveler_db)} · compressor ${fmt(c.comp_db)} · gate ${fmt(c.gate_db)}\n` +
      `gain share ${fmt(c.share_db)} · ducking ${fmt(c.duck_db)}\n` +
      `level ${c.level} dBFS · noise floor ${c.noise_floor} dBFS`;
  });
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
