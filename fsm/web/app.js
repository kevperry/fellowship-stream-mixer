"use strict";

const $ = (s, el = document) => el.querySelector(s);
const FLOOR = -60;
const pct = (db) => Math.max(0, Math.min(100, ((db - FLOOR) / -FLOOR) * 100));
const fmt = (v, d = 1) => (v > 0 ? "+" : "") + Number(v).toFixed(d);

let cfg = null;
let types = [];
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
    .then((ch) => { cfg.channels[i] = ch; renderStripStatic(i); })
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
  s.el.classList.toggle("off", ch.type === "off");
}

function renderMaster() {
  const m = cfg.master;
  $("#target").value = String(Math.round(m.target_lufs));
  if (![...$("#target").options].some((o) => o.value === $("#target").value)) {
    $("#target").add(new Option(`${m.target_lufs} LUFS`, String(Math.round(m.target_lufs))));
    $("#target").value = String(Math.round(m.target_lufs));
  }
  $("#lufs-sub").textContent = `target ${String(m.target_lufs).replace("-", "–")}`;
  $("#ducking").value = m.ducking;
  $("#duck").value = m.duck_depth_db; $("#duckv").textContent = `${m.duck_depth_db} dB`;
  $("#rv").value = m.reverb_return_db; $("#rvv").textContent = `${fmt(m.reverb_return_db, 0)} dB`;
  const b = $("#bypass");
  b.textContent = m.bypass ? "Auto mix: OFF (plain faders)" : "Auto mix: ON";
  b.className = "toggle " + (m.bypass ? "off" : "on");
}

$("#target").addEventListener("change", (e) => setMaster({ target_lufs: Number(e.target.value) }));
$("#ducking").addEventListener("change", (e) => setMaster({ ducking: e.target.value }));
$("#duck").addEventListener("input", (e) => setMaster({ duck_depth_db: Number(e.target.value) }));
$("#rv").addEventListener("input", (e) => setMaster({ reverb_return_db: Number(e.target.value) }));
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
  $("#load").textContent = `${ms.dsp_load.toFixed(0)}%` + (ms.xruns ? ` · ${ms.xruns} dropouts` : "");
  const sp = $("#speech");
  const ducking = ms.duck_db < -0.5;
  sp.textContent = ducking ? `Speech — music ${ms.duck_db.toFixed(0)} dB` : ms.speech_active ? "Speech detected" : "Music level normal";
  sp.classList.toggle("live", ducking);
  flash(`Running · ${Math.round(ms.sample_rate / 1000)} kHz · ${(1000 * ms.block / ms.sample_rate).toFixed(0)} ms blocks` +
        (ms.bypass ? " · automation bypassed" : ""));

  m.channels.forEach((c, i) => {
    const s = strips[i];
    if (!s) return;
    meter(s.mIn, c.in_peak);
    meter(s.mOut, c.out_peak);
    s.led.classList.toggle("on", c.active);
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
      cfg = data.config; types = data.types;
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
    } catch (e) {
      flash("Lost connection to the mixer — is it still running?");
    }
    setTimeout(tick, 80);
  };
  tick();
}
start();
