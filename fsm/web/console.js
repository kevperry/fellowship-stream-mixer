/*
 * Channel strips + the Channel settings panel.
 *
 * Shared by the Mac app's control panel (fsm/web) and the practice page (docs).
 * fsm/web/console.js and docs/console.js must stay identical (a test checks this).
 *
 * Strips hold only what you reach for during a service: name, meters, fader,
 * pan, Mute, Solo, Link and a Gate threshold slider. Linking a channel to the one on its left turns the
 * two into one stereo strip (one fader, hard left/right). Click a strip's name
 * to open everything else for that channel in the Channel settings panel.
 */
"use strict";

const FsmConsole = (() => {
  const $ = (s, el = document) => el.querySelector(s);
  const FLOOR = -60;
  const VOCAL = ["lead_vocal"];
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
  // One strip per *group*: a single channel, or channels linked into one stereo source
  // (each linked channel joins the one to its left). Selecting a strip selects the
  // group's first channel; settings changed there are shared by the whole group.

  function groups() {
    const out = [];
    cfg().channels.forEach((ch, i) => {
      if (i > 0 && ch.link && out.length) out[out.length - 1].push(i);
      else out.push([i]);
    });
    return out;
  }
  const groupOf = (i) => groups().find((g) => g.includes(i)) || [i];
  const signature = () => JSON.stringify(groups());

  /** "Keys L" + "Keys R" -> "Keys"; otherwise "A / B". */
  function groupName(g) {
    const names = g.map((k) => CH(k).name);
    if (g.length === 1) return names[0];
    const base = names.map((n) => n.replace(/[\s_-]*(l|r|left|right)$/i, "").trim());
    return base.every((b) => b && b === base[0]) ? base[0] : names.join(" / ");
  }

  function buildStrips() {
    const host = $("#strips");
    host.innerHTML = "";
    const gs = groups();
    strips = gs.map((g, gi) => {
      const lead = g[0], stereo = g.length > 1;
      const el = document.createElement("div");
      el.className = "strip card" + (stereo ? " stereo" : "");
      el.innerHTML = `
        <button class="strip-head" title="Show this channel's settings">
          <span class="num"></span><span class="led" title="Active"></span>
          <b class="sname"></b><span class="stype"></span>
        </button>
        <div class="strip-body">
          <div class="meters"><i class="gmark" title="Gate threshold"></i>${stereo
            // stereo: one meter per side (left, right), showing each side's output
            ? g.map((_, j) => `<div class="meter" title="${["Left", "Right"][j] || "Side " + (j + 1)}"><div class="fill out"></div></div>`).join("")
            // mono: input (faint) and output
            : `<div class="meter" title="Input"><div class="fill in"></div></div><div class="meter" title="Output"><div class="fill out"></div></div>`}
          </div>
          <div class="fader-wrap">
            <input type="range" class="fader" min="-40" max="10" step="0.5" aria-label="Fader">
            <output class="fader-v"></output>
          </div>
        </div>
        ${stereo ? `<div class="stereo-tag" title="Left side hard left, right side hard right">◂ stereo ▸</div>`
                 : `<label class="mini">Pan <input type="range" class="pan" min="-1" max="1" step="0.05"></label>`}
        <div class="row btns"><button class="mute">Mute</button><button class="solo">Solo</button></div>
        <button class="linkbtn"></button>
        <label class="mini gatebox" title="Soft gate: below this level the channel is eased down. Far left = automatic.">Gate <output class="gate-v"></output>
          <input type="range" class="gate" min="${GATE_AUTO}" max="-20" step="1"></label>`;
      const s = {
        el, g, lead, stereo, head: $(".strip-head", el), num: $(".num", el), led: $(".led", el), name: $(".sname", el),
        type: $(".stype", el), fader: $(".fader", el), faderV: $(".fader-v", el), pan: $(".pan", el),
        mute: $(".mute", el), solo: $(".solo", el), link: $(".linkbtn", el),
        mIn: [...el.querySelectorAll(".fill.in")], mOut: [...el.querySelectorAll(".fill.out")],
        gate: $(".gate", el), gateV: $(".gate-v", el), gmark: $(".gmark", el),
      };
      s.gate.addEventListener("input", () => {
        const v = Number(s.gate.value);
        o.setChannel(lead, { gate_threshold: v <= GATE_AUTO ? null : v });
      });
      s.gate.addEventListener("dblclick", () => o.setChannel(lead, { gate_threshold: null }));
      s.head.addEventListener("click", () => { select(lead); if (P && P.setCollapsed) P.setCollapsed(false); });
      s.fader.addEventListener("input", () => { s.faderV.textContent = fmt(s.fader.value); o.setChannel(lead, { fader_db: Number(s.fader.value) }); });
      s.fader.addEventListener("dblclick", () => o.setChannel(lead, { fader_db: 0 }));
      if (s.pan) {
        s.pan.addEventListener("input", () => o.setChannel(lead, { pan: Number(s.pan.value) }));
        s.pan.addEventListener("dblclick", () => o.setChannel(lead, { pan: 0 }));
      }
      s.mute.addEventListener("click", () => o.setChannel(lead, { mute: !CH(lead).mute }));
      s.solo.addEventListener("click", () => o.setChannel(lead, { solo: !CH(lead).solo }));
      // Link joins this channel to the strip on its left; a stereo strip offers Unlink instead.
      const leftGroup = gi > 0 ? gs[gi - 1] : null;
      if (stereo) {
        s.link.textContent = "Unlink";
        s.link.title = "Split back into separate channels";
        s.link.addEventListener("click", () => {
          for (const k of g.slice(1).reverse()) o.setChannel(k, { link: false });
          refresh();
        });
      } else if (!leftGroup) {
        s.link.textContent = "Link";
        s.link.disabled = true;
        s.link.style.visibility = "hidden";
      } else {
        const leftIn = leftGroup.map((k) => CH(k).input).join("/");
        s.link.textContent = `Link ◂ IN ${leftIn}`;
        if (leftGroup.length > 1) {
          s.link.disabled = true;
          s.link.title = `IN ${leftIn} is already part of a stereo pair`;
        } else {
          s.link.title = `Combine with IN ${leftIn} into one stereo channel`;
          s.link.addEventListener("click", () => {
            o.setChannel(lead, { link: true });
            selected = leftGroup[0];
            refresh();
          });
        }
      }
      host.appendChild(el);
      return s;
    });
    builtSig = signature();
  }

  function renderStrip(s) {
    const ch = CH(s.lead);
    if (!ch) return;
    s.num.textContent = "IN " + s.g.map((k) => CH(k).input).join("/");
    s.name.textContent = groupName(s.g);
    s.type.textContent = typeInfo(ch.type).label || ch.type;
    if (document.activeElement !== s.fader) s.fader.value = ch.fader_db;
    s.faderV.textContent = fmt(ch.fader_db);
    if (s.pan && document.activeElement !== s.pan) s.pan.value = ch.pan;
    s.mute.classList.toggle("active", !!ch.mute);
    s.solo.classList.toggle("active", !!ch.solo);
    s.el.classList.toggle("soloed", !!ch.solo);
    s.el.classList.toggle("off", ch.type === "off");
    s.el.classList.toggle("selected", s.g.includes(selected));
    const thr = ch.gate_threshold;
    if (document.activeElement !== s.gate) s.gate.value = thr == null ? GATE_AUTO : thr;
    s.gateV.textContent = thr == null ? "auto" : `${thr}`;
    s.el.classList.toggle("gate-manual", thr != null);
  }

  let builtSig = "";
  /** Rebuild the strips if channels were linked/unlinked, then redraw. */
  function refresh() {
    if (signature() !== builtSig) buildStrips();
    selected = groupOf(selected)[0];
    strips.forEach(renderStrip);
    renderPanel();
  }

  // ------------------------------------------------------------ settings panel
  const GATE_AUTO = -81;   // gate slider's far-left position = automatic threshold

  function buildPanel() {
    const host = $("#chpanel");
    host.innerHTML = `
      <div class="cp-head">
        <span class="cp-title">Channel settings</span>
        <span class="cp-num"></span>
        <input class="cp-name" maxlength="32" aria-label="Channel name">
        <select class="cp-type" aria-label="Source type"></select>
        <button class="cp-collapse" title="Hide or show the channel settings (clicking a channel's name opens them)">Hide ▴</button>
      </div>
      <section class="cp-eqbox">
        <div class="cp-eqbar">
          <b>Parametric EQ</b>
          <label class="cp-inline">Source curve <select class="cp-eq" aria-label="Suggested curve for this source"></select></label>
          <span class="cp-edited muted small"></span>
          <button class="cp-eqreset" title="Go back to the suggested curve for this source">Reset to suggested</button>
          <label class="check cp-inline" title="High-pass filter"><input type="checkbox" class="cp-hpf-on"> HPF</label>
          <label class="cp-inline" title="Adaptive EQ: small automatic corrections on top of your curve (faint line)">Auto EQ
            <input type="range" class="cp-eqa" min="0" max="100" step="5"><output class="cp-eqa-v"></output></label>
        </div>
        <svg class="cp-graph" aria-label="EQ curve: drag the numbered points; mouse wheel changes width; double-click resets a band"></svg>
        <div class="cp-bandlist muted small"></div>
      </section>
      <div class="cp-grid">
        <section class="cp-sec">
          <h4>Auto level</h4>
          <div class="cp-target"></div>
          <label class="check"><input type="checkbox" class="cp-al"> On</label>
          <label class="mini">Range <output class="cp-range-v"></output><input type="range" class="cp-range" min="0" max="24" step="1"></label>
          <label class="mini">Speed <output class="cp-speed-v"></output><input type="range" class="cp-speed" min="0.5" max="12" step="0.5"></label>
          <label class="check cp-dm" title="Music steps back while this mic is in use. Untick for a mic that picks up the band."><input type="checkbox" class="cp-dm-on"> Ducks music</label>
          <button class="cp-reset">Reset</button>
        </section>
        <section class="cp-sec">
          <h4>Gate <span class="cp-gstate muted small"></span></h4>
          <div class="cp-gthr"></div>
          <label class="mini" title="How far the gate turns the channel down when it closes">Depth <output class="cp-gd-v"></output><input type="range" class="cp-gd" min="-40" max="0" step="1"></label>
          <label class="mini" title="How long it stays open after the sound drops">Hold <output class="cp-gh-v"></output><input type="range" class="cp-gh" min="20" max="1000" step="10"></label>
          <label class="mini" title="How gently it closes">Release <output class="cp-gr2-v"></output><input type="range" class="cp-gr2" min="50" max="1500" step="10"></label>
          <button class="cp-greset">Auto gate</button>
        </section>
        <section class="cp-sec">
          <h4>Compressor</h4>
          <select class="cp-comp" aria-label="Compressor"></select>
          <div class="cp-gr"><div class="cp-gr-track"><div class="cp-gr-fill"></div></div><span class="cp-gr-v">0.0 dB</span></div>
          <h4>Reverb send</h4>
          <label class="mini">Send <output class="cp-rv-v"></output><input type="range" class="cp-rv" min="-40" max="0" step="1"></label>
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
      num: q(".cp-num"), name: q(".cp-name"), type: q(".cp-type"),
      target: q(".cp-target"), al: q(".cp-al"), range: q(".cp-range"), rangeV: q(".cp-range-v"),
      speed: q(".cp-speed"), speedV: q(".cp-speed-v"), dmRow: q(".cp-dm"), dm: q(".cp-dm-on"), reset: q(".cp-reset"),
      eq: q(".cp-eq"), edited: q(".cp-edited"), eqReset: q(".cp-eqreset"), hpfOn: q(".cp-hpf-on"),
      eqa: q(".cp-eqa"), eqaV: q(".cp-eqa-v"), graph: q(".cp-graph"), bandList: q(".cp-bandlist"),
      gstate: q(".cp-gstate"), gthr: q(".cp-gthr"), gd: q(".cp-gd"), gdV: q(".cp-gd-v"), gh: q(".cp-gh"), ghV: q(".cp-gh-v"),
      gr2: q(".cp-gr2"), gr2V: q(".cp-gr2-v"), greset: q(".cp-greset"),
      comp: q(".cp-comp"), grFill: q(".cp-gr-fill"), grV: q(".cp-gr-v"), rv: q(".cp-rv"), rvV: q(".cp-rv-v"),
      tune: q(".cp-tune"), tuneOn: q(".cp-tune-on"), note: q(".cp-note"), cents: q(".cp-cents"),
      ta: q(".cp-ta"), taV: q(".cp-ta-v"), ts: q(".cp-ts"), tsV: q(".cp-ts-v"),
    };
    P.collapse = q(".cp-collapse");
    const setCollapsed = (v) => {
      host.classList.toggle("collapsed", v);
      P.collapse.textContent = v ? "Show ▾" : "Hide ▴";
      try { localStorage.setItem("fsm:panelCollapsed", v ? "1" : ""); } catch { /* storage may be blocked */ }
      if (!v) drawGraph();
    };
    P.setCollapsed = setCollapsed;
    P.collapse.addEventListener("click", () => setCollapsed(!host.classList.contains("collapsed")));
    try { if (localStorage.getItem("fsm:panelCollapsed")) setCollapsed(true); } catch { /* ignore */ }
    for (const t of o.types) P.type.add(new Option(t.label, t.id));
    for (const e of o.eqPresets) P.eq.add(new Option(e.label, e.id));
    for (const c of o.compLevels) P.comp.add(new Option(c.label, c.id));
    const set = (changes) => o.setChannel(selected, changes);
    P.name.addEventListener("change", () => {
      const g = groupOf(selected), v = P.name.value.trim();
      // a channel's default EQ preset comes from its name: keep the current one so renaming never changes the sound
      const ch = CH(g[0]), live = lastMeters && lastMeters[g[0]];
      if (ch.eq_preset == null && live && live.eq_preset) o.setChannel(g[0], { eq_preset: live.eq_preset });
      if (g.length === 2) { o.setChannel(g[0], { name: `${v} L` }); o.setChannel(g[1], { name: `${v} R` }); }
      else set({ name: v });
    });
    P.type.addEventListener("change", () => set({ type: P.type.value, reverb_db: null, eq_preset: null, comp: null, peq: null }));
    P.al.addEventListener("change", () => set({ auto_level: P.al.checked }));
    P.range.addEventListener("input", () => set({ level_range: Number(P.range.value) }));
    P.speed.addEventListener("input", () => set({ level_speed: Number(P.speed.value) }));
    P.dm.addEventListener("change", () => set({ ducks_music: P.dm.checked }));
    P.reset.addEventListener("click", () => set({ auto_level: true, level_range: null, level_speed: null }));
    P.eq.addEventListener("change", () => { set({ eq_preset: P.eq.value, peq: null }); draft = null; });
    P.eqReset.addEventListener("click", () => { set({ peq: null }); draft = null; });
    P.hpfOn.addEventListener("change", () => {
      const c = editableCurve();
      c.hpf = P.hpfOn.checked ? (c.lastHpf || 80) : null;
      commitCurve(c, true);
    });
    P.eqa.addEventListener("input", () => set({ eq_amount: Number(P.eqa.value) }));
    P.gd.addEventListener("input", () => set({ gate_depth: Number(P.gd.value) }));
    P.gh.addEventListener("input", () => set({ gate_hold_ms: Number(P.gh.value) }));
    P.gr2.addEventListener("input", () => set({ gate_release_ms: Number(P.gr2.value) }));
    P.greset.addEventListener("click", () => set({ gate_threshold: null, gate_depth: null, gate_hold_ms: null, gate_release_ms: null }));
    P.comp.addEventListener("change", () => set({ comp: P.comp.value }));
    P.rv.addEventListener("input", () => { const v = Number(P.rv.value); set({ reverb_db: v <= -40 ? -60 : v }); });
    P.tuneOn.addEventListener("change", () => set({ tune: P.tuneOn.checked }));
    P.ta.addEventListener("input", () => set({ tune_amount: Number(P.ta.value) }));
    P.ts.addEventListener("input", () => set({ tune_speed_ms: Number(P.ts.value) }));
    setupGraph();
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => drawGraph()).observe(P.graph);
  }

  // ------------------------------------------------------------ EQ graph
  const GFS = 48000, FMIN = 20, FMAX = 20000, DBMAX = 15, GH = 140;
  let draft = null;        // the curve being dragged (shown immediately, sent to the engine a few times a second)
  let sendTimer = 0;

  function biquad(kind, f0, g, Q) {
    const A = Math.pow(10, g / 40), w0 = 2 * Math.PI * Math.min(f0, 0.45 * GFS) / GFS, c = Math.cos(w0), s = Math.sin(w0), al = s / (2 * Q);
    if (kind === "hp") return [(1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al];
    return [1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A];
  }
  function magDb(sec, f) {
    const w = 2 * Math.PI * f / GFS, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const [b0, b1, b2, a0, a1, a2] = sec;
    const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2), dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
    return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }
  function curveSections(c) {
    const secs = [];
    if (c.hpf) (c.hpf_order >= 4 ? [0.5412, 1.3066] : [0.7071]).forEach((Q) => secs.push(biquad("hp", c.hpf, 0, Q)));
    for (const [f, g, Q] of c.bands) if (Math.abs(g) > 1e-3) secs.push(biquad("peak", f, g, Q));
    return secs;
  }
  const liveCurve = () => (lastMeters && lastMeters[selected] && lastMeters[selected].curve) || null;
  function editableCurve() {
    const c = draft || liveCurve();
    if (!c) return null;
    return { hpf: c.hpf, hpf_order: c.hpf_order, lastHpf: c.hpf || c.lastHpf, bands: c.bands.map((b) => b.slice()) };
  }
  function commitCurve(c, now) {
    draft = c;
    drawGraph();
    const send = () => o.setChannel(selected, { peq: { hpf: c.hpf, bands: c.bands.map((b) => b.slice(0, 3)) } });
    clearTimeout(sendTimer);
    if (now) send(); else sendTimer = setTimeout(send, 40);
  }

  let gw = 600;
  const gx = (f) => Math.log10(f / FMIN) / Math.log10(FMAX / FMIN) * gw;
  const gf = (x) => FMIN * Math.pow(FMAX / FMIN, Math.max(0, Math.min(1, x / gw)));
  const gy = (db) => GH / 2 - (db / DBMAX) * (GH / 2 - 10);
  const gdb = (y) => Math.max(-DBMAX, Math.min(DBMAX, (GH / 2 - y) / (GH / 2 - 10) * DBMAX));
  const fLabel = (f) => (f >= 1000 ? `${+(f / 1000).toFixed(f >= 10000 ? 0 : 1)}k` : `${Math.round(f)}`);

  function drawGraph() {
    if (!P) return;
    const svg = P.graph, c = draft || liveCurve(), live = lastMeters && lastMeters[selected];
    gw = Math.max(200, svg.clientWidth || 600);
    svg.setAttribute("viewBox", `0 0 ${gw} ${GH}`);
    let h = "";
    for (const f of [30, 40, 50, 60, 70, 80, 90, 200, 300, 400, 600, 700, 800, 900, 3000, 4000, 6000, 7000, 8000, 9000])
      h += `<line class="g-minor" x1="${gx(f)}" x2="${gx(f)}" y1="0" y2="${GH}"/>`;
    for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000])
      h += `<line class="g-major" x1="${gx(f)}" x2="${gx(f)}" y1="0" y2="${GH}"/><text class="g-lab" x="${gx(f) + 3}" y="${GH - 4}">${fLabel(f)}</text>`;
    for (let d = -15; d <= 15; d += 5) {
      h += `<line class="${d === 0 ? "g-zero" : "g-major"}" x1="0" x2="${gw}" y1="${gy(d)}" y2="${gy(d)}"/>`;
      if (d && Math.abs(d) < 15) h += `<text class="g-lab" x="4" y="${gy(d) - 3}">${d > 0 ? "+" : ""}${d}</text>`;
    }
    if (c) {
      const secs = curveSections(c), pts = [], auto = [];
      const adaptive = live && live.eq_gains ? [125, 250, 500, 1000, 2000, 4000, 8000].map((f, k) => biquad("peak", f, live.eq_gains[k], 1.2)) : [];
      for (let i = 0; i <= 240; i++) {
        const f = FMIN * Math.pow(FMAX / FMIN, i / 240);
        let d = 0; for (const s of secs) d += magDb(s, f);
        let a = d; for (const s of adaptive) a += magDb(s, f);
        pts.push(`${gx(f).toFixed(1)},${gy(Math.max(-DBMAX - 5, d)).toFixed(1)}`);
        auto.push(`${gx(f).toFixed(1)},${gy(Math.max(-DBMAX - 5, a)).toFixed(1)}`);
      }
      if (adaptive.some((s, k) => Math.abs(live.eq_gains[k]) > 0.05))
        h += `<polyline class="g-auto" points="${auto.join(" ")}"><title>With the adaptive EQ's automatic corrections</title></polyline>`;
      h += `<polyline class="g-curve-glow" points="${pts.join(" ")}"/><polyline class="g-curve" points="${pts.join(" ")}"/>`;
      if (c.hpf) {
        const x = gx(c.hpf);
        h += `<line class="g-hpf" x1="${x}" x2="${x}" y1="0" y2="${GH}"/><text class="g-hpf-lab" x="${x + 5}" y="14">HPF ${Math.round(c.hpf)} Hz</text>` +
             `<rect class="g-hpf-hit" data-h="1" x="${x - 6}" y="0" width="12" height="${GH}"><title>Drag to move the high-pass filter</title></rect>`;
      }
      c.bands.forEach(([f, g, Q], k) => {
        h += `<g class="g-node" data-b="${k}"><circle cx="${gx(f)}" cy="${gy(g)}" r="9"/><text x="${gx(f)}" y="${gy(g) + 4}">${k + 1}</text>` +
             `<title>Band ${k + 1}: ${fLabel(f)} Hz, ${fmt(g)} dB, Q ${Q.toFixed(1)} — drag; wheel = width; double-click = flat</title></g>`;
      });
      P.bandList.innerHTML = (c.hpf ? `HPF ${Math.round(c.hpf)} Hz · ` : "HPF off · ") +
        c.bands.map(([f, g, Q], k) => `<span>${k + 1}: ${fLabel(f)} Hz ${fmt(g)} dB Q${Q.toFixed(1)}</span>`).join(" · ");
    }
    svg.innerHTML = h;
  }

  function setupGraph() {
    const svg = P.graph;
    let drag = null;
    const pos = (e) => { const r = svg.getBoundingClientRect(); return [(e.clientX - r.left) * gw / r.width, (e.clientY - r.top) * GH / r.height]; };
    svg.addEventListener("pointerdown", (e) => {
      const node = e.target.closest(".g-node"), hpf = e.target.closest("[data-h]");
      if (!node && !hpf) return;
      const c = editableCurve();
      if (!c) return;
      drag = { band: node ? Number(node.dataset.b) : null, hpf: !!hpf && !node, curve: c };
      svg.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    svg.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const [x, y] = pos(e), c = drag.curve;
      if (drag.hpf) c.hpf = Math.max(20, Math.min(400, gf(x)));
      else { const b = c.bands[drag.band]; b[0] = Math.round(gf(x)); b[1] = Math.round(gdb(y) * 10) / 10; }
      commitCurve(c, false);
    });
    const end = () => { if (drag) { commitCurve(drag.curve, true); drag = null; } };
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", end);
    svg.addEventListener("wheel", (e) => {
      const node = e.target.closest(".g-node");
      if (!node) return;
      e.preventDefault();
      const c = editableCurve(), b = c.bands[Number(node.dataset.b)];
      b[2] = Math.max(0.3, Math.min(8, b[2] * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      commitCurve(c, false);
    }, { passive: false });
    svg.addEventListener("dblclick", (e) => {
      const node = e.target.closest(".g-node");
      if (!node) return;
      const c = editableCurve();
      c.bands[Number(node.dataset.b)][1] = 0;
      commitCurve(c, true);
    });
  }

  const notFocused = (el) => document.activeElement !== el;

  function renderPanel() {
    const ch = CH(selected);
    if (!ch || !P) return;
    const t = typeInfo(ch.type), off = ch.type === "off";
    const g = groupOf(selected);
    P.num.textContent = "IN " + g.map((k) => CH(k).input).join("/") + (g.length > 1 ? " · stereo" : "");
    if (notFocused(P.name)) P.name.value = groupName(g);
    P.type.value = ch.type;

    // auto level: one line, details in the tooltip
    const lvlOn = ch.auto_level !== false;
    const range = ch.level_range ?? t.leveler_range ?? 0, speed = ch.level_speed ?? 3;
    P.target.title = off ? "" : `Aims for about ${t.target_db} dBFS average (${TARGET_WORDS[ch.type] || t.label}). ` +
      `It can move this channel up to ±${Math.round(range)} dB; your fader sits on top.`;
    P.al.checked = lvlOn;
    P.range.disabled = P.speed.disabled = !lvlOn || off;
    if (notFocused(P.range)) P.range.value = range;
    if (notFocused(P.speed)) P.speed.value = speed;
    P.rangeV.textContent = `±${Math.round(range)} dB`;
    P.speedV.textContent = `${speed} dB/s`;
    P.dmRow.hidden = ch.type !== "speech";
    P.dm.checked = ch.ducks_music !== false;

    // EQ
    if (ch.eq_preset != null && notFocused(P.eq)) P.eq.value = ch.eq_preset;
    P.edited.textContent = ch.peq ? "edited" : "suggested";
    P.eqReset.disabled = !ch.peq;
    if (notFocused(P.eqa)) P.eqa.value = ch.eq_amount ?? 50;
    P.eqaV.textContent = `${Math.round(ch.eq_amount ?? 50)}%`;
    if (!ch.peq) draft = null;
    const cur = draft || liveCurve();
    P.hpfOn.checked = !!(cur && cur.hpf);

    // gate
    const manual = ch.gate_threshold != null;
    const depth = ch.gate_depth ?? (manual && !t.gate_range ? -12 : t.gate_range ?? 0);
    if (notFocused(P.gd)) P.gd.value = depth;
    P.gdV.textContent = depth ? `${depth} dB` : "none";
    const hold = ch.gate_hold_ms ?? Math.round((t.gate_hold ?? 0.3) * 1000), rel = ch.gate_release_ms ?? 250;
    if (notFocused(P.gh)) P.gh.value = hold;
    if (notFocused(P.gr2)) P.gr2.value = rel;
    P.ghV.textContent = `${hold} ms`;
    P.gr2V.textContent = `${rel} ms`;
    P.greset.disabled = !manual && ch.gate_depth == null && ch.gate_hold_ms == null && ch.gate_release_ms == null;

    if (ch.comp != null && notFocused(P.comp)) P.comp.value = ch.comp;
    const rv = ch.reverb_db ?? t.reverb_db ?? null;
    if (notFocused(P.rv)) P.rv.value = rv === null || rv <= -40 ? -40 : rv;
    P.rvV.textContent = rv === null || rv <= -40 ? "off" : `${rv} dB`;

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
    drawGraph();
  }

  let graphTick = 0;
  function renderPanelMeters(c) {
    if (!c || !P) return;
    const ch = CH(selected), t = typeInfo(ch.type);
    const auto = c.leveler_db + c.comp_db + c.gate_db + c.share_db + c.duck_db;
    const range = ch.level_range ?? t.leveler_range ?? 0;
    P.target.innerHTML = ch.type === "off" ? "" :
      `Target <b>${String(t.target_db).replace("-", "−")} dBFS</b> · ±${Math.round(range)} dB · now <b>${fmt(auto)}</b>` +
      (c.auto_level === false ? " · <b>off</b>" : "");
    P.target.title += "";
    const manual = ch.gate_threshold != null;
    P.gthr.innerHTML = `Threshold <b>${manual ? `${ch.gate_threshold} dBFS` : `auto (${Math.round(c.gate_level)})`}</b>`;
    P.gthr.title = "Set the threshold with the Gate slider at the bottom of the channel strip (far left = auto).";
    P.gstate.textContent = c.gate_db < -0.5 ? `closed ${c.gate_db.toFixed(0)} dB` : "open";
    if (ch.eq_preset == null && notFocused(P.eq) && c.eq_preset) P.eq.value = c.eq_preset;
    if (ch.comp == null && notFocused(P.comp) && c.comp) P.comp.value = c.comp;
    P.grFill.style.width = `${Math.min(100, (-c.comp_db / 12) * 100)}%`;
    P.grV.textContent = c.comp === "off" ? "off" : `${c.comp_db.toFixed(1)} dB`;
    P.note.textContent = ch.tune && c.tune_note ? ` · ${c.tune_note}` : "";
    P.cents.textContent = ch.tune && c.tune_note && Math.abs(c.tune_cents) >= 1 ? ` ${fmt(c.tune_cents, 0)}¢` : "";
    if (!P.hpfOn.matches(":focus")) P.hpfOn.checked = !!((draft || c.curve || {}).hpf);
    if (++graphTick % 6 === 0 && !draft) drawGraph();   // the adaptive EQ line moves slowly
  }

  function select(i) {
    selected = groupOf(Math.max(0, Math.min(cfg().channels.length - 1, i)))[0];
    strips.forEach(renderStrip);
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
      refresh();
    },
    /** Re-draw after settings changed for channel i (rebuilds strips if links changed). */
    render() { refresh(); },
    renderAll() { refresh(); },
    /** Meter values from the engine: one entry per channel. */
    meters(channels) {
      lastMeters = channels;
      for (const s of strips) {
        s.g.forEach((k, j) => {
          const c = channels[k];
          if (!c) return;
          if (s.mIn[j]) meter(s.mIn[j], c.in_peak);
          if (s.mOut[j]) meter(s.mOut[j], c.out_peak);
        });
        s.led.classList.toggle("on", s.g.some((k) => channels[k] && channels[k].active));
        const c0 = channels[s.lead], ch = CH(s.lead);
        if (c0 && ch) {
          const thr = ch.gate_threshold ?? c0.gate_level;
          s.gmark.style.bottom = `${pct(thr)}%`;
          s.gmark.classList.toggle("closed", c0.gate_db < -0.5);
        }
      }
      renderPanelMeters(channels[selected]);
    },
    select,
    get selected() { return selected; },
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = { FsmConsole };
