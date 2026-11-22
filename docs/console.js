/*
 * Channel strips + the Channel settings panel.
 *
 * Shared by the Mac app's control panel (fsm/web) and the practice page (docs).
 * fsm/web/console.js and docs/console.js must stay identical (a test checks this).
 *
 * Strips hold only what you reach for during a service: name, meters, fader,
 * pan, Mute and Solo. Click a strip's name to open everything else for that
 * channel in the Channel settings panel.
 */
"use strict";

const FsmConsole = (() => {
  const $ = (s, el = document) => el.querySelector(s);
  const FLOOR = -60;
  const VOCAL = ["lead_vocal"];
  const BANDS = ["125", "250", "500", "1k", "2k", "4k", "8k"];
  const pct = (db) => Math.max(0, Math.min(100, ((db - FLOOR) / -FLOOR) * 100));
  const fmt = (v, d = 1) => (v > 0 ? "+" : "") + Number(v).toFixed(d);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const held = new Map();
  // What each source type's automatic level is aiming for, in plain words.
  const TARGET_WORDS = {
    speech: "a clear speaking voice", lead_vocal: "a lead vocal over the band", instrument: "a supporting instrument",
    drums: "drums sitting under the vocals", playback: "a video or backing track", off: "",
  };

  let o = null;            // options from the page
  let strips = [];
  let selected = 0;
  let P = null;            // panel elements
  let lastMeters = null;

  const cfg = () => o.getCfg();
  const CH = (i) => cfg().channels[i];
  const typeInfo = (id) => o.types.find((t) => t.id === id) || {};

  function meter(el, db) {
    const prev = held.has(el) ? held.get(el) : FLOOR;
    const shown = Math.max(db ?? FLOOR, prev - 1.2);
    held.set(el, shown);
    el.style.height = pct(shown) + "%";
    el.style.setProperty("--h", el.parentElement.clientHeight + "px");
  }

  // ------------------------------------------------------------ strips
  function buildStrips() {
    const host = $("#strips");
    host.innerHTML = "";
    strips = cfg().channels.map((ch, i) => {
      const el = document.createElement("div");
      el.className = "strip card";
      el.innerHTML = `
        <button class="strip-head" title="Show this channel's settings">
          <span class="num"></span><span class="led" title="Active"></span>
          <b class="sname"></b><span class="stype"></span>
        </button>
        <div class="strip-body">
          <div class="meters">
            <div class="meter"><div class="fill in"></div></div>
            <div class="meter"><div class="fill out"></div></div>
          </div>
          <div class="fader-wrap">
            <input type="range" class="fader" min="-40" max="10" step="0.5" aria-label="Fader">
            <output class="fader-v"></output>
          </div>
        </div>
        <label class="mini">Pan <input type="range" class="pan" min="-1" max="1" step="0.05"></label>
        <div class="row btns"><button class="mute">Mute</button><button class="solo">Solo</button></div>`;
      const s = {
        el, head: $(".strip-head", el), num: $(".num", el), led: $(".led", el), name: $(".sname", el), type: $(".stype", el),
        fader: $(".fader", el), faderV: $(".fader-v", el), pan: $(".pan", el), mute: $(".mute", el), solo: $(".solo", el),
        mIn: $(".fill.in", el), mOut: $(".fill.out", el),
      };
      s.head.addEventListener("click", () => select(i));
      s.fader.addEventListener("input", () => { s.faderV.textContent = fmt(s.fader.value); o.setChannel(i, { fader_db: Number(s.fader.value) }); });
      s.fader.addEventListener("dblclick", () => o.setChannel(i, { fader_db: 0 }));
      s.pan.addEventListener("input", () => o.setChannel(i, { pan: Number(s.pan.value) }));
      s.pan.addEventListener("dblclick", () => o.setChannel(i, { pan: 0 }));
      s.mute.addEventListener("click", () => o.setChannel(i, { mute: !CH(i).mute }));
      s.solo.addEventListener("click", () => o.setChannel(i, { solo: !CH(i).solo }));
      host.appendChild(el);
      return s;
    });
  }

  function renderStrip(i) {
    const ch = CH(i), s = strips[i];
    if (!ch || !s) return;
    s.num.textContent = `IN ${ch.input}`;
    s.name.textContent = ch.name;
    s.type.textContent = typeInfo(ch.type).label || ch.type;
    if (document.activeElement !== s.fader) s.fader.value = ch.fader_db;
    s.faderV.textContent = fmt(ch.fader_db);
    if (document.activeElement !== s.pan) s.pan.value = ch.pan;
    s.mute.classList.toggle("active", !!ch.mute);
    s.solo.classList.toggle("active", !!ch.solo);
    s.el.classList.toggle("soloed", !!ch.solo);
    s.el.classList.toggle("off", ch.type === "off");
    s.el.classList.toggle("selected", i === selected);
    s.el.classList.toggle("linked", !!ch.link);
  }

  // ------------------------------------------------------------ settings panel
  function buildPanel() {
    const host = $("#chpanel");
    host.innerHTML = `
      <div class="cp-head">
        <span class="cp-title">Channel settings</span>
        <span class="cp-num"></span>
        <input class="cp-name" maxlength="32" aria-label="Channel name">
        <select class="cp-type" aria-label="Source type"></select>
        <label class="check cp-link" title="Stereo-link with the channel to the left: faders, mute and all settings move together (pan stays separate)"><input type="checkbox"> Link with left</label>
      </div>
      <div class="cp-grid">
        <section class="cp-sec">
          <h4>Auto level</h4>
          <p class="cp-target"></p>
          <p class="cp-now muted"></p>
          <label class="check"><input type="checkbox" class="cp-al"> Auto level on</label>
          <label class="mini">Range <output class="cp-range-v"></output><input type="range" class="cp-range" min="0" max="24" step="1"></label>
          <label class="mini">Speed <output class="cp-speed-v"></output><input type="range" class="cp-speed" min="0.5" max="12" step="0.5"></label>
          <label class="check cp-dm" title="Music steps back while this mic is in use. Untick for a mic that picks up the band."><input type="checkbox" class="cp-dm-on"> Ducks music</label>
          <button class="cp-reset">Reset auto level</button>
        </section>
        <section class="cp-sec">
          <h4>EQ <span class="muted small">adaptive</span></h4>
          <select class="cp-eq" aria-label="EQ preset"></select>
          <label class="mini">Amount <output class="cp-eqa-v"></output><input type="range" class="cp-eqa" min="0" max="100" step="5"></label>
          <div class="cp-bands">${BANDS.map((b) => `<div class="cp-band"><div class="cp-bar"><i></i></div><span class="v">0</span><span class="f">${b}</span></div>`).join("")}</div>
        </section>
        <section class="cp-sec">
          <h4>Compressor</h4>
          <select class="cp-comp" aria-label="Compressor"></select>
          <div class="cp-gr"><div class="cp-gr-track"><div class="cp-gr-fill"></div></div><span class="cp-gr-v">0.0 dB</span></div>
          <h4>Reverb send</h4>
          <label class="mini"><output class="cp-rv-v"></output><input type="range" class="cp-rv" min="-40" max="0" step="1"></label>
          <div class="cp-tune">
            <h4>Tune <span class="muted small">pitch correction</span></h4>
            <label class="check"><input type="checkbox" class="cp-tune-on"> On <b class="cp-note"></b><span class="cp-cents"></span></label>
            <label class="mini">Amount <output class="cp-ta-v"></output><input type="range" class="cp-ta" min="0" max="100" step="5"></label>
            <label class="mini">Speed <output class="cp-ts-v"></output><input type="range" class="cp-ts" min="20" max="500" step="10"></label>
          </div>
        </section>
      </div>`;
    const q = (c) => $(c, host);
    P = {
      num: q(".cp-num"), name: q(".cp-name"), type: q(".cp-type"), link: q(".cp-link input"), linkRow: q(".cp-link"),
      target: q(".cp-target"), now: q(".cp-now"), al: q(".cp-al"), range: q(".cp-range"), rangeV: q(".cp-range-v"),
      speed: q(".cp-speed"), speedV: q(".cp-speed-v"), dmRow: q(".cp-dm"), dm: q(".cp-dm-on"), reset: q(".cp-reset"),
      eq: q(".cp-eq"), eqa: q(".cp-eqa"), eqaV: q(".cp-eqa-v"), bands: [...host.querySelectorAll(".cp-band")],
      comp: q(".cp-comp"), grFill: q(".cp-gr-fill"), grV: q(".cp-gr-v"), rv: q(".cp-rv"), rvV: q(".cp-rv-v"),
      tune: q(".cp-tune"), tuneOn: q(".cp-tune-on"), note: q(".cp-note"), cents: q(".cp-cents"),
      ta: q(".cp-ta"), taV: q(".cp-ta-v"), ts: q(".cp-ts"), tsV: q(".cp-ts-v"),
    };
    for (const t of o.types) P.type.add(new Option(t.label, t.id));
    for (const e of o.eqPresets) P.eq.add(new Option(e.label, e.id));
    for (const c of o.compLevels) P.comp.add(new Option(c.label, c.id));
    const set = (changes) => o.setChannel(selected, changes);
    P.name.addEventListener("change", () => set({ name: P.name.value }));
    P.type.addEventListener("change", () => set({ type: P.type.value, reverb_db: null, eq_preset: null, comp: null }));
    P.link.addEventListener("change", () => set({ link: P.link.checked }));
    P.al.addEventListener("change", () => set({ auto_level: P.al.checked }));
    P.range.addEventListener("input", () => set({ level_range: Number(P.range.value) }));
    P.speed.addEventListener("input", () => set({ level_speed: Number(P.speed.value) }));
    P.dm.addEventListener("change", () => set({ ducks_music: P.dm.checked }));
    P.reset.addEventListener("click", () => set({ auto_level: true, level_range: null, level_speed: null }));
    P.eq.addEventListener("change", () => set({ eq_preset: P.eq.value }));
    P.eqa.addEventListener("input", () => set({ eq_amount: Number(P.eqa.value) }));
    P.comp.addEventListener("change", () => set({ comp: P.comp.value }));
    P.rv.addEventListener("input", () => { const v = Number(P.rv.value); set({ reverb_db: v <= -40 ? -60 : v }); });
    P.tuneOn.addEventListener("change", () => set({ tune: P.tuneOn.checked }));
    P.ta.addEventListener("input", () => set({ tune_amount: Number(P.ta.value) }));
    P.ts.addEventListener("input", () => set({ tune_speed_ms: Number(P.ts.value) }));
  }

  const notFocused = (el) => document.activeElement !== el;

  function renderPanel() {
    const ch = CH(selected);
    if (!ch || !P) return;
    const t = typeInfo(ch.type), off = ch.type === "off";
    P.num.textContent = `IN ${ch.input}`;
    if (notFocused(P.name)) P.name.value = ch.name;
    P.type.value = ch.type;
    P.linkRow.hidden = selected === 0;
    P.link.checked = !!ch.link;

    const lvlOn = ch.auto_level !== false;
    const range = ch.level_range ?? t.leveler_range ?? 0, speed = ch.level_speed ?? 3;
    P.target.innerHTML = off ? "This channel is off." : t.target_db == null ? "" :
      `Aims for about <b>${String(t.target_db).replace("-", "−")} dBFS</b> average — ${esc(TARGET_WORDS[ch.type] || t.label)}.` +
      ` It can move this channel up to <b>±${Math.round(range)} dB</b>; your fader sits on top.`;
    P.al.checked = lvlOn;
    P.range.disabled = P.speed.disabled = !lvlOn || off;
    if (notFocused(P.range)) P.range.value = range;
    if (notFocused(P.speed)) P.speed.value = speed;
    P.rangeV.textContent = `±${Math.round(range)} dB` + (ch.level_range == null ? " (default)" : "");
    P.speedV.textContent = `${speed} dB/s` + (speed <= 1.5 ? " · slow" : speed >= 6 ? " · fast" : "");
    P.dmRow.hidden = ch.type !== "speech";
    P.dm.checked = ch.ducks_music !== false;

    if (ch.eq_preset != null && notFocused(P.eq)) P.eq.value = ch.eq_preset;
    if (notFocused(P.eqa)) P.eqa.value = ch.eq_amount ?? 50;
    P.eqaV.textContent = `${Math.round(ch.eq_amount ?? 50)}%`;
    if (ch.comp != null && notFocused(P.comp)) P.comp.value = ch.comp;

    const rv = ch.reverb_db ?? t.reverb_db ?? null;
    if (notFocused(P.rv)) P.rv.value = rv === null || rv <= -40 ? -40 : rv;
    P.rvV.textContent = rv === null || rv <= -40 ? "off" : `${rv} dB` + (ch.reverb_db == null ? " (default)" : "");

    const vocal = VOCAL.includes(ch.type);
    P.tune.hidden = !vocal;
    P.tuneOn.checked = !!ch.tune;
    P.ta.disabled = P.ts.disabled = !ch.tune;
    if (notFocused(P.ta)) P.ta.value = ch.tune_amount ?? 50;
    if (notFocused(P.ts)) P.ts.value = ch.tune_speed_ms ?? 150;
    P.taV.textContent = `${Math.round(ch.tune_amount ?? 50)}%`;
    P.tsV.textContent = `${Math.round(ch.tune_speed_ms ?? 150)} ms`;
    $("#chpanel").classList.toggle("off", off);
    if (lastMeters) renderPanelMeters(lastMeters[selected]);
  }

  function renderPanelMeters(c) {
    if (!c || !P) return;
    const ch = CH(selected);
    const auto = c.leveler_db + c.comp_db + c.gate_db + c.share_db + c.duck_db;
    P.now.innerHTML = ch && ch.type !== "off"
      ? `Now: level <b>${c.level} dBFS</b> → auto <b>${fmt(auto)} dB</b>` +
        `<br><span class="small">leveler ${fmt(c.leveler_db)} · comp ${fmt(c.comp_db)} · gate ${fmt(c.gate_db)}` +
        (c.share_db ? ` · share ${fmt(c.share_db)}` : "") + (c.duck_db ? ` · duck ${fmt(c.duck_db)}` : "") +
        (c.auto_level === false ? " · <b>auto level off</b>" : "") + "</span>"
      : "";
    (c.eq_gains || []).forEach((g, k) => {
      const b = P.bands[k], bar = $("i", b);
      bar.style.height = `${Math.min(50, Math.abs(g) / 6 * 50)}%`;
      bar.style.bottom = g >= 0 ? "50%" : "auto";
      bar.style.top = g >= 0 ? "auto" : "50%";
      bar.className = g > 0.2 ? "up" : g < -0.2 ? "down" : "";
      $(".v", b).textContent = Math.abs(g) < 0.05 ? "0" : fmt(g);
    });
    if (ch && ch.eq_preset == null && notFocused(P.eq) && c.eq_preset) P.eq.value = c.eq_preset;
    if (ch && ch.comp == null && notFocused(P.comp) && c.comp) P.comp.value = c.comp;
    P.grFill.style.width = `${Math.min(100, (-c.comp_db / 12) * 100)}%`;
    P.grV.textContent = c.comp === "off" ? "off" : `${c.comp_db.toFixed(1)} dB`;
    P.note.textContent = ch && ch.tune && c.tune_note ? ` · ${c.tune_note}` : "";
    P.cents.textContent = ch && ch.tune && c.tune_note && Math.abs(c.tune_cents) >= 1 ? ` ${fmt(c.tune_cents, 0)}¢` : "";
  }

  function select(i) {
    selected = Math.max(0, Math.min(cfg().channels.length - 1, i));
    strips.forEach((_, k) => renderStrip(k));
    renderPanel();
  }

  // ------------------------------------------------------------ public
  return {
    /** opts: { getCfg, setChannel(i, changes), types: [{id,label,reverb_db,leveler_range,target_db}], eqPresets, compLevels } */
    init(opts) { o = opts; },
    build() {
      selected = Math.min(selected, Math.max(0, cfg().channels.length - 1));
      buildStrips();
      buildPanel();
      strips.forEach((_, i) => renderStrip(i));
      renderPanel();
    },
    /** Re-draw after settings changed for channel i. */
    render(i) { renderStrip(i); if (i === selected) renderPanel(); },
    renderAll() { strips.forEach((_, i) => renderStrip(i)); renderPanel(); },
    /** Meter values from the engine: one entry per channel. */
    meters(channels) {
      lastMeters = channels;
      channels.forEach((c, i) => {
        const s = strips[i];
        if (!s) return;
        meter(s.mIn, c.in_peak);
        meter(s.mOut, c.out_peak);
        s.led.classList.toggle("on", c.active);
      });
      renderPanelMeters(channels[selected]);
    },
    select,
    get selected() { return selected; },
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = { FsmConsole };
