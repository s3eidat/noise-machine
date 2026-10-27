/* Noise Machine — every sound is generated in JS and looped through WebAudio filters. No audio files. */
(function () {
  "use strict";
  var $ = S3.$, $$ = S3.$$;
  var LOOP_SECONDS = 12, XFADE = 0.5;

  var SOUNDS = [
    { id: "white", name: "White noise", desc: "Bright hiss, masks voices", ico: '<path d="M2 12l2-5 2 9 2-8 2 10 2-11 2 8 2-6 2 7 2-4 2 3"/>', gen: "white", gain: 0.22 },
    { id: "pink", name: "Pink noise", desc: "Balanced and soft", ico: '<path d="M2 12c1.5-4 3-4 4 0s2.5 4 4 0 2.5-5 4 0 2.5 3 4 0 2-2 4 0"/>', gen: "pink", gain: 0.5 },
    { id: "brown", name: "Brown noise", desc: "Deep rumble for focus", ico: '<path d="M2 12C6 4 9 4 12 12s6 8 10 0"/>', gen: "brown", gain: 0.6 },
    { id: "rain", name: "Rain", desc: "Steady rain with drops", ico: '<path d="M6 3v5M12 6v5M18 3v5M9 13v5M15 15v5M5 17v3M19 14v4"/>', gen: "rain", gain: 0.6, filters: [{ type: "highpass", f: 450 }, { type: "lowpass", f: 7000 }] },
    { id: "fan", name: "Fan", desc: "Low, even whoosh", ico: '<circle cx="12" cy="12" r="2"/><path d="M12 10c0-5 5-6 5-3s-3 3-5 3M14 12c5 0 6 5 3 5s-3-3-3-5M12 14c0 5-5 6-5 3s3-3 5-3M10 12c-5 0-6-5-3-5s3 3 3 5"/>', gen: "brown", gain: 0.75, filters: [{ type: "lowpass", f: 650 }, { type: "peaking", f: 150, g: 5 }], lfo: { rate: 3.1, depth: 0.08 } },
    { id: "ocean", name: "Ocean", desc: "Slow swelling waves", ico: '<path d="M2 9c2.5-2 5-2 7.5 0s5 2 7.5 0 3.5-1.5 5 0M2 15c2.5-2 5-2 7.5 0s5 2 7.5 0 3.5-1.5 5 0"/>', gen: "pink", gain: 0.6, filters: [{ type: "lowpass", f: 1100 }], lfo: { rate: 0.085, depth: 0.8 } }
  ];
  var BUILTIN = [
    { name: "Deep focus", mix: { brown: 70, pink: 15 } },
    { name: "Rainy night", mix: { rain: 75, brown: 30 } },
    { name: "Ocean sleep", mix: { ocean: 80, pink: 15 } },
    { name: "Bedroom fan", mix: { fan: 85 } },
    { name: "Pure white", mix: { white: 55 } }
  ];

  // ---------- pure generators (tested in S3_SELFTEST) ----------
  function rng(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function white(n, r) { var a = new Float32Array(n); for (var i = 0; i < n; i++) a[i] = r() * 2 - 1; return a; }
  function pink(n, r) { // Paul Kellet's refined filter
    var a = new Float32Array(n), b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (var i = 0; i < n; i++) {
      var w = r() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      a[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926;
    }
    return a;
  }
  function brown(n, r) { // leaky integrator of white noise, DC removed
    var a = new Float32Array(n), last = 0, mean = 0, i;
    for (i = 0; i < n; i++) { last = (last + 0.02 * (r() * 2 - 1)) / 1.02; a[i] = last; mean += last; }
    mean /= n; for (i = 0; i < n; i++) a[i] -= mean;
    return a;
  }
  function rain(n, r, rate) {
    var a = pink(n, r), i;
    for (i = 0; i < n; i++) a[i] *= 0.08;
    var drops = Math.floor(n / rate * 28);
    for (var k = 0; k < drops; k++) {
      var at = Math.floor(r() * n), len = Math.floor(rate * (0.002 + r() * 0.008)), amp = 0.15 + r() * r() * 0.6;
      for (i = 0; i < len && at + i < n; i++) a[at + i] += amp * Math.exp(-6 * i / len) * (r() * 2 - 1);
    }
    return a;
  }
  function normalize(a, peak) { var m = 0, i; for (i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i])); if (m) for (i = 0; i < a.length; i++) a[i] *= peak / m; return a; }
  // Generate len+fade samples, then cross-fade the tail into the head so the loop has no seam.
  function makeLoop(full, fade) {
    var len = full.length - fade, out = full.slice(0, len);
    for (var i = 0; i < fade; i++) { var t = i / fade; out[i] = full[i] * Math.sqrt(t) + full[len + i] * Math.sqrt(1 - t); }
    return out;
  }
  function generate(kind, n, seed, rate) {
    var r = rng(seed), a = kind === "white" ? white(n, r) : kind === "pink" ? pink(n, r) : kind === "brown" ? brown(n, r) : rain(n, r, rate);
    return normalize(a, 0.9);
  }
  function hfRatio(a) { var e = 0, d = 0; for (var i = 1; i < a.length; i++) { e += a[i] * a[i]; var x = a[i] - a[i - 1]; d += x * x; } return d / e; }
  function timerGain(t, total, fade) { return t <= total - fade ? 1 : t >= total ? 0 : (total - t) / fade; }
  function fadeFor(total) { return Math.min(60, total / 4); }
  function fmtLeft(s) { s = Math.max(0, Math.ceil(s)); var h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0"); }

  // ---------- audio graph ----------
  function makeBuffer(ctx, kind) {
    var rate = ctx.sampleRate, n = Math.floor(rate * LOOP_SECONDS), f = Math.floor(rate * XFADE), b = ctx.createBuffer(2, n, rate);
    for (var c = 0; c < 2; c++) b.copyToChannel(makeLoop(generate(kind, n + f, 1234 + c * 777 + kind.length * 31, rate), f), c);
    return b;
  }
  function buildVoice(ctx, def, buffer, dest, vol, when) {
    var src = ctx.createBufferSource(); src.buffer = buffer; src.loop = true;
    var node = src;
    (def.filters || []).forEach(function (f) {
      var bq = ctx.createBiquadFilter(); bq.type = f.type; bq.frequency.value = f.f; if (f.g) bq.gain.value = f.g; if (f.q) bq.Q.value = f.q;
      node.connect(bq); node = bq;
    });
    var mod = ctx.createGain(), lfo = null;
    if (def.lfo) {
      mod.gain.value = 1 - def.lfo.depth / 2;
      lfo = ctx.createOscillator(); lfo.frequency.value = def.lfo.rate;
      var depth = ctx.createGain(); depth.gain.value = def.lfo.depth / 2;
      lfo.connect(depth); depth.connect(mod.gain); lfo.start(when || 0);
    }
    var g = ctx.createGain(); g.gain.value = vol * def.gain;
    node.connect(mod); mod.connect(g); g.connect(dest);
    src.start(when || 0, Math.random() * LOOP_SECONDS);
    return { src: src, gain: g, lfo: lfo };
  }
  function buildMaster(ctx) {
    var vol = ctx.createGain(), timer = ctx.createGain(), comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10; comp.knee.value = 6; comp.ratio.value = 12; comp.attack.value = 0.003; comp.release.value = 0.25;
    vol.connect(timer); timer.connect(comp); comp.connect(ctx.destination);
    return { vol: vol, timer: timer };
  }

  // ---------- state ----------
  var mix = {};
  SOUNDS.forEach(function (s) { mix[s.id] = { on: false, vol: 60 }; });
  Object.assign(mix, S3.store("noise.mix") || {});
  var master = S3.store("noise.master"); master = master == null ? 70 : master;
  var userPresets = S3.store("noise.presets") || [];
  var ctx = null, M = null, buffers = {}, voices = {}, playing = false, timerMin = 0, timerEnd = 0, timerTotal = 0, tick = null;

  function save() { S3.store("noise.mix", mix); S3.store("noise.master", master); }
  function bufFor(kind) { return buffers[kind] || (buffers[kind] = makeBuffer(ctx, kind)); }
  function startVoice(def) {
    if (voices[def.id]) return;
    var v = buildVoice(ctx, def, bufFor(def.gen), M.vol, 0, ctx.currentTime);
    v.gain.gain.setValueAtTime(0, ctx.currentTime); v.gain.gain.linearRampToValueAtTime(mix[def.id].vol / 100 * def.gain, ctx.currentTime + 1.2);
    voices[def.id] = v;
  }
  function stopVoice(id) {
    var v = voices[id]; if (!v) return; delete voices[id];
    var t = ctx.currentTime; v.gain.gain.cancelScheduledValues(t); v.gain.gain.setValueAtTime(v.gain.gain.value, t); v.gain.gain.linearRampToValueAtTime(0, t + 0.6);
    v.src.stop(t + 0.65); if (v.lfo) v.lfo.stop(t + 0.65);
  }
  function setVoiceVol(def) { var v = voices[def.id]; if (v) v.gain.gain.setTargetAtTime(mix[def.id].vol / 100 * def.gain, ctx.currentTime, 0.05); }
  function anyOn() { return SOUNDS.some(function (s) { return mix[s.id].on; }); }

  async function play() {
    if (!anyOn()) { mix.brown.on = true; renderSounds(); }
    if (!ctx) { ctx = new (window.AudioContext || window.webkitAudioContext)(); M = buildMaster(ctx); }
    await ctx.resume();
    M.vol.gain.setValueAtTime(master / 100, ctx.currentTime);
    SOUNDS.forEach(function (s) { if (mix[s.id].on) startVoice(s); });
    playing = true; armTimer(); ui(); S3.done();
  }
  function pause() {
    if (!ctx) return;
    SOUNDS.forEach(function (s) { stopVoice(s.id); });
    playing = false; disarmTimer(); ui();
  }

  // ---------- sleep timer ----------
  function armTimer() {
    disarmTimer();
    if (!timerMin || !playing) return;
    timerTotal = timerMin * 60; timerEnd = Date.now() + timerTotal * 1000;
    var fade = fadeFor(timerTotal), t = ctx.currentTime;
    M.timer.gain.cancelScheduledValues(t); M.timer.gain.setValueAtTime(1, t);
    M.timer.gain.setValueAtTime(1, t + timerTotal - fade); M.timer.gain.linearRampToValueAtTime(0, t + timerTotal);
    tick = setInterval(timerTick, 1000); timerTick();
  }
  function disarmTimer() {
    clearInterval(tick); tick = null;
    if (M) { M.timer.gain.cancelScheduledValues(ctx.currentTime); M.timer.gain.setValueAtTime(1, ctx.currentTime); }
    $("#timerChip").hidden = !timerMin; $("#timerChip").textContent = timerMin ? "Timer: " + (timerMin >= 60 ? timerMin / 60 + " h" : timerMin + " min") : "";
  }
  function timerTick() {
    var left = (timerEnd - Date.now()) / 1000;
    $("#timerChip").hidden = false; $("#timerChip").className = "chip accent";
    $("#timerChip").textContent = left > fadeFor(timerTotal) ? "Stops in " + fmtLeft(left) : "Fading out… " + fmtLeft(left);
    if (left <= 0) { pause(); setTimer(0); S3.toast("Sleep timer finished"); }
  }
  function setTimer(min) {
    timerMin = min;
    $$("#timer button").forEach(function (b) { b.setAttribute("aria-pressed", String(+b.dataset.v === min)); });
    $("#timerChip").className = "chip";
    if (playing) armTimer(); else disarmTimer();
  }
  $$("#timer button").forEach(function (b) { b.addEventListener("click", function () { setTimer(+b.dataset.v); }); });

  // ---------- UI ----------
  function ui() {
    document.body.classList.toggle("playing", playing);
    $("#play").innerHTML = S3.icon(playing ? "pause" : "play"); $("#play").setAttribute("aria-label", playing ? "Pause" : "Play");
    var on = SOUNDS.filter(function (s) { return mix[s.id].on; }).map(function (s) { return s.name; });
    $("#nowPlaying").textContent = on.length ? (playing ? "Playing: " : "Ready: ") + on.join(" + ") : "Pick a sound below, then press play";
  }
  function renderSounds() {
    var box = $("#sounds"); box.innerHTML = "";
    SOUNDS.forEach(function (s) {
      var st = mix[s.id];
      var range = S3.h("input", { type: "range", min: "0", max: "100", value: st.vol, "aria-label": s.name + " volume" });
      var head = S3.h("button", { "class": "snd-head", "aria-pressed": String(st.on), title: st.on ? "Turn off" : "Turn on" }, [
        S3.h("span", { "class": "snd-ico", "aria-hidden": "true", html: '<svg class="i" viewBox="0 0 24 24">' + s.ico + "</svg>" }),
        S3.h("span", { "class": "snd-txt" }, [S3.h("b", { text: s.name }), S3.h("span", { "class": "snd-desc", text: s.desc })]),
        S3.h("span", { "class": "snd-state", "aria-hidden": "true" })
      ]);
      var card = S3.h("div", { "class": "snd" + (st.on ? " on" : "") }, [head, range]);
      head.addEventListener("click", function () { toggle(s, !st.on); });
      range.addEventListener("input", function () { st.vol = +range.value; setVoiceVol(s); save(); });
      range.addEventListener("change", function () { if (!st.on && st.vol > 0) toggle(s, true); });
      box.appendChild(card);
    });
    ui();
  }
  function toggle(s, on) {
    mix[s.id].on = on; save();
    if (on && !playing) { renderSounds(); play(); return; }
    if (playing) { if (on) startVoice(s); else { stopVoice(s.id); if (!anyOn()) pause(); } }
    renderSounds();
  }
  function applyMix(m) {
    SOUNDS.forEach(function (s) { mix[s.id].on = m[s.id] != null; if (m[s.id] != null) mix[s.id].vol = m[s.id]; });
    save(); renderSounds();
    if (playing) SOUNDS.forEach(function (s) { if (mix[s.id].on) { startVoice(s); setVoiceVol(s); } else stopVoice(s.id); });
    else play();
  }
  function renderPresets() {
    var box = $("#presets"); box.innerHTML = "";
    BUILTIN.concat(userPresets).forEach(function (p) {
      var user = userPresets.indexOf(p) >= 0;
      var el = S3.h("span", { "class": "preset" }, [S3.h("button", { "class": "pick", text: p.name, onclick: function () { applyMix(p.mix); } })]);
      if (user) el.appendChild(S3.h("button", { "class": "del", "aria-label": "Delete preset " + p.name, html: S3.icon("x"), onclick: function () {
        userPresets.splice(userPresets.indexOf(p), 1); S3.store("noise.presets", userPresets); renderPresets();
      } }));
      box.appendChild(el);
    });
  }
  $("#savePreset").addEventListener("click", function () {
    var name = $("#presetName").value.trim(), m = {};
    SOUNDS.forEach(function (s) { if (mix[s.id].on) m[s.id] = mix[s.id].vol; });
    if (!Object.keys(m).length) return S3.toast("Turn on at least one sound first", "error");
    if (!name) name = "My mix " + (userPresets.length + 1);
    userPresets = userPresets.filter(function (p) { return p.name !== name; }).concat([{ name: name, mix: m }]);
    S3.store("noise.presets", userPresets); $("#presetName").value = ""; renderPresets(); S3.toast("Preset saved"); S3.done();
  });
  $("#presetName").addEventListener("keydown", function (e) { if (e.key === "Enter") $("#savePreset").click(); });
  $("#play").addEventListener("click", function () { if (playing) pause(); else play(); });
  $("#master").value = master; $("#masterV").textContent = master + "%";
  $("#master").addEventListener("input", function () { master = +this.value; $("#masterV").textContent = master + "%"; if (M) M.vol.gain.setTargetAtTime(master / 100, ctx.currentTime, 0.05); save(); });
  document.addEventListener("keydown", function (e) {
    if (e.key === " " && !/INPUT|TEXTAREA|SELECT|BUTTON/.test(e.target.tagName)) { e.preventDefault(); $("#play").click(); }
  });
  renderSounds(); renderPresets(); setTimer(0);

  // ---------- demo + self-test ----------
  window.S3_DEMO = function () {
    mix.rain = { on: true, vol: 75 }; mix.brown = { on: true, vol: 35 }; mix.ocean = { on: false, vol: 50 };
    userPresets = [{ name: "Late night study", mix: { brown: 60, rain: 40 } }]; renderPresets();
    renderSounds(); playing = true; ui();
    timerMin = 30; $$("#timer button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.v === "30")); });
    $("#timerChip").hidden = false; $("#timerChip").className = "chip accent"; $("#timerChip").textContent = "Stops in 27:42";
  };

  window.S3_SELFTEST = async function () {
    var n = 48000, w = generate("white", n, 1, 48000), p = generate("pink", n, 2, 48000), b = generate("brown", n, 3, 48000), r = generate("rain", n, 4, 48000);
    function stats(a) { var mx = 0, s = 0, s2 = 0; for (var i = 0; i < a.length; i++) { mx = Math.max(mx, Math.abs(a[i])); s += a[i]; s2 += a[i] * a[i]; } return { peak: mx, mean: s / a.length, rms: Math.sqrt(s2 / a.length), finite: isFinite(s2) }; }
    var ok = [w, p, b, r].every(function (a) { var s = stats(a); return s.finite && s.peak <= 0.9 + 1e-6 && s.peak > 0.89 && Math.abs(s.mean) < 0.05 && s.rms > 0.05; });
    var raw = white(100000, rng(9)), rs = stats(raw);
    ok = ok && rs.peak <= 1 && Math.abs(rs.mean) < 0.01 && Math.abs(rs.rms - 1 / Math.sqrt(3)) < 0.01; // uniform [-1,1]
    // spectral tilt: white ≈ 2, pink lower, brown far lower
    var hw = hfRatio(w), hp = hfRatio(p), hb = hfRatio(b);
    ok = ok && Math.abs(hw - 2) < 0.05 && hp < hw * 0.8 && hb < 0.06 && hb < hp * 0.2;
    // same seed → same noise; loop seam is continuous
    ok = ok && generate("pink", 50, 7, 48000)[49] === generate("pink", 50, 7, 48000)[49];
    var lp = makeLoop(brown(4800 + 480, rng(5)), 480), steps = 0;
    for (var i = 1; i < lp.length; i++) steps = Math.max(steps, Math.abs(lp[i] - lp[i - 1]));
    ok = ok && lp.length === 4800 && Math.abs(lp[0] - lp[lp.length - 1]) <= steps * 1.5;
    ok = ok && timerGain(0, 1800, 60) === 1 && timerGain(1740, 1800, 60) === 1 && timerGain(1770, 1800, 60) === 0.5 && timerGain(1800, 1800, 60) === 0 && fadeFor(120) === 30 && fmtLeft(3725) === "1:02:05";
    // every sound at full volume through the real graph never clips
    var off = new OfflineAudioContext(2, 22050 * 0.6, 22050), mOff = buildMaster(off);
    mOff.vol.gain.value = 1;
    SOUNDS.forEach(function (s) { buildVoice(off, s, makeBufferFor(off, s.gen), mOff.vol, 1, 0); });
    var out = await off.startRendering(), pk = 0, e = 0, ch = out.getChannelData(0);
    for (i = 0; i < ch.length; i++) { pk = Math.max(pk, Math.abs(ch[i])); e += ch[i] * ch[i]; }
    ok = ok && pk <= 1 && Math.sqrt(e / ch.length) > 0.05;
    return ok;
  };
  function makeBufferFor(c, kind) { var n = Math.floor(c.sampleRate * 2), f = Math.floor(c.sampleRate * 0.1), bb = c.createBuffer(1, n, c.sampleRate); bb.copyToChannel(makeLoop(generate(kind, n + f, 1, c.sampleRate), f), 0); return bb; }
})();
