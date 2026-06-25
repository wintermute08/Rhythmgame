(() => {
  'use strict';

  // ---------- config ----------
  const LANES = 4;
  const KEYS = ['KeyD', 'KeyF', 'KeyJ', 'KeyK'];
  const KEY_LABEL = ['D', 'F', 'J', 'K'];
  const LANE_COLORS = ['#4d9fff', '#3bd1ff', '#b06bff', '#ff5fa8'];

  // difficulty affects approach speed + note density (BPM comes from user input)
  const DIFF = {
    easy:   { approach: 1500, density: 0.50, chordChance: 0.04 },
    normal: { approach: 1150, density: 0.72, chordChance: 0.14 },
    hard:   { approach: 880,  density: 0.95, chordChance: 0.30 },
  };

  // timing windows (ms)
  const W_PERFECT = 45, W_GREAT = 90, W_GOOD = 140, W_MISS = 200;
  const SCORE = { perfect: 300, great: 200, good: 100, miss: 0 };

  // perspective tuning
  const VP_Y_RATIO = 0.16;   // vanishing point height (fraction of canvas)
  const HITLINE_RATIO = 0.86; // hit line height (fraction of canvas)
  const PERSP = 3.2;         // higher = more bunching near the top

  // ---------- dom ----------
  const $ = (id) => document.getElementById(id);
  const screens = { menu: $('menu'), game: $('game'), result: $('result') };
  const pauseOverlay = $('pause');
  const canvas = $('board');
  const ctx = canvas.getContext('2d');

  let chosenDiff = 'normal';
  let bgImage = null;       // HTMLImageElement for background
  let audioEl = null;       // HTMLAudioElement for user song
  let audioURL = null;      // object URL to revoke
  let audioCtx = null;      // WebAudio for synth fallback / hit sfx
  let songBuffer = null;    // ArrayBuffer of the loaded song (for analysis)
  let analysis = null;      // cached { notes, bpm } from analyzeSong

  const now = () => performance.now();

  function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.remove('active'));
    screens[name].classList.add('active');
  }

  // ---------- background persistence ----------
  function setBackground(dataUrl, persist) {
    const img = new Image();
    img.onload = () => { bgImage = img; };
    img.src = dataUrl;
    if (persist) { try { localStorage.setItem('rf_bg', dataUrl); } catch (e) {} }
  }
  function loadStoredBackground() {
    try {
      const d = localStorage.getItem('rf_bg');
      if (d) setBackground(d, false);
    } catch (e) {}
  }

  // ---------- canvas sizing ----------
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);

  // ---------- geometry helpers ----------
  function geom() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const vpY = h * VP_Y_RATIO;
    const hitY = h * HITLINE_RATIO;
    const vpX = w / 2;
    return { w, h, vpY, hitY, vpX };
  }
  // perspective factor: t in [0,1] where 1 = far (at VP), 0 = near (hit line)
  function perspF(t) {
    const p = 1 - t;                       // 0 far -> 1 near
    return p / (1 + (1 - p) * (PERSP - 1)); // bunch near the top
  }
  function laneBottomX(lane, w) {
    // lanes fan out across the central portion of the screen at the hit line
    const spread = Math.min(w * 0.9, 620);
    const left = (w - spread) / 2;
    return left + (lane + 0.5) / LANES * spread;
  }

  // ---------- chart generation (from BPM) ----------
  function makeChart(cfg, bpm, durationMs) {
    const notes = [];
    const beat = 60000 / bpm;
    const startBeat = 4; // lead-in beats
    const lastMs = durationMs && durationMs > 0 ? durationMs - 1000 : 180000;
    let lastLane = -1;
    for (let b = startBeat; b * beat < lastMs; b++) {
      const subs = cfg.density > 0.85 ? [0, 0.5] : [0];
      for (const s of subs) {
        if (s === 0.5 && Math.random() > cfg.density - 0.3) continue;
        if (s === 0 && Math.random() > cfg.density) continue;
        const t = b * beat + s * beat;
        let lane = (Math.random() * LANES) | 0;
        if (lane === lastLane && Math.random() < 0.6) lane = (lane + 1) % LANES;
        lastLane = lane;
        notes.push({ t, lane });
        if (Math.random() < cfg.chordChance) {
          const l2 = (lane + 1 + ((Math.random() * 2) | 0)) % LANES;
          if (l2 !== lane) notes.push({ t, lane: l2 });
        }
      }
    }
    notes.sort((a, b) => a.t - b.t);
    notes.forEach((n) => { n.hit = false; });
    return notes;
  }

  // ---------- onset / beat detection (match notes to the actual song) ----------
  // Render the decoded audio through a band filter offline, then peak-pick the
  // energy envelope to find percussive onsets in that band.
  async function detectBand(buffer, type, freq, q, minGapSec, sensitivity) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const oac = new OAC(1, buffer.length, buffer.sampleRate);
    const src = oac.createBufferSource();
    src.buffer = buffer;
    const filt = oac.createBiquadFilter();
    filt.type = type;
    filt.frequency.value = freq;
    if (q) filt.Q.value = q;
    src.connect(filt).connect(oac.destination);
    src.start(0);
    const rendered = await oac.startRendering();
    const data = rendered.getChannelData(0);
    const sr = rendered.sampleRate;

    // energy envelope (hop ~11ms)
    const hop = Math.floor(sr * 0.011);
    const env = [];
    for (let i = 0; i < data.length; i += hop) {
      let sum = 0;
      const end = Math.min(i + hop, data.length);
      for (let j = i; j < end; j++) sum += data[j] * data[j];
      env.push(Math.sqrt(sum / (end - i)));
    }

    // adaptive peak picking
    const onsets = [];
    const win = 18; // ~200ms local average window
    const minGapFrames = Math.max(1, Math.floor(minGapSec / 0.011));
    let lastIdx = -minGapFrames;
    for (let i = 1; i < env.length - 1; i++) {
      let avg = 0, n = 0;
      for (let k = Math.max(0, i - win); k <= Math.min(env.length - 1, i + win); k++) { avg += env[k]; n++; }
      avg /= n;
      const thresh = avg * sensitivity;
      if (env[i] > thresh && env[i] >= env[i - 1] && env[i] >= env[i + 1] && i - lastIdx >= minGapFrames) {
        onsets.push((i * hop) / sr * 1000); // ms
        lastIdx = i;
      }
    }
    return onsets;
  }

  // Estimate BPM from the median spacing between kick onsets.
  function estimateBPM(kicks) {
    if (kicks.length < 4) return null;
    const gaps = [];
    for (let i = 1; i < kicks.length; i++) gaps.push(kicks[i] - kicks[i - 1]);
    gaps.sort((a, b) => a - b);
    let med = gaps[Math.floor(gaps.length / 2)];
    // fold into a musical range (90-180 BPM)
    while (med > 0 && 60000 / med < 90) med /= 2;
    while (med > 0 && 60000 / med > 200) med *= 2;
    const bpm = Math.round(60000 / med);
    return bpm >= 40 && bpm <= 300 ? bpm : null;
  }

  // Build a chart from detected onsets across bands. Lane is biased by band so
  // low hits feel different from highs, with anti-repeat for playability.
  function makeChartFromOnsets(bands, cfg) {
    const tagged = [];
    bands.kick.forEach((t) => tagged.push({ t, band: 0 }));
    bands.snare.forEach((t) => tagged.push({ t, band: 1 }));
    bands.hat.forEach((t) => tagged.push({ t, band: 2 }));
    tagged.sort((a, b) => a.t - b.t);

    // enforce minimum spacing by difficulty (dedupe near-simultaneous cross-band)
    const minGap = cfg.density > 0.85 ? 95 : cfg.density > 0.6 ? 150 : 260;
    const notes = [];
    let lastT = -1e9, lastLane = -1;
    for (const o of tagged) {
      if (o.t - lastT < minGap) continue;
      // higher difficulty keeps more onsets; lower drops some non-kick hits
      if (o.band !== 0 && Math.random() > cfg.density) continue;
      // lane: kick -> outer, snare -> inner, hat -> spread; avoid repeat
      let lane;
      if (o.band === 0) lane = Math.random() < 0.5 ? 0 : 3;
      else if (o.band === 1) lane = Math.random() < 0.5 ? 1 : 2;
      else lane = (Math.random() * LANES) | 0;
      if (lane === lastLane) lane = (lane + 1) % LANES;
      notes.push({ t: o.t, lane, hit: false });
      lastT = o.t; lastLane = lane;
    }
    return notes;
  }

  // Decode + analyze the loaded song file into a chart. Returns {notes, bpm}.
  async function analyzeSong(arrayBuffer, cfg) {
    ensureAudioCtx();
    const buf = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    const [kick, snare, hat] = await Promise.all([
      detectBand(buf, 'lowpass', 150, 1, 0.16, 1.5),    // kick drum
      detectBand(buf, 'bandpass', 2200, 1.2, 0.16, 1.7), // snare / clap
      detectBand(buf, 'highpass', 7000, 1, 0.10, 1.9),   // hats / cymbals
    ]);
    const bpm = estimateBPM(kick) || estimateBPM(snare);
    const notes = makeChartFromOnsets({ kick, snare, hat }, cfg);
    return { notes, bpm };
  }

  // ---------- audio ----------
  function ensureAudioCtx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }

  // Layered hit sound: noise transient + pitched click + body thump
  function blip(lane, judge) {
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    const master = audioCtx.createGain();
    master.gain.setValueAtTime(judge === 'perfect' ? 1.0 : judge === 'great' ? 0.82 : 0.65, t);
    master.connect(audioCtx.destination);

    // 1) Noise transient (attack crack)
    const bufLen = audioCtx.sampleRate * 0.06;
    const buf = audioCtx.createBuffer(1, bufLen, audioCtx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufLen, 4);
    const noise = audioCtx.createBufferSource();
    noise.buffer = buf;
    const nfilt = audioCtx.createBiquadFilter();
    nfilt.type = 'bandpass';
    nfilt.frequency.value = 3200 + lane * 400;
    nfilt.Q.value = 1.4;
    const ng = audioCtx.createGain();
    ng.gain.setValueAtTime(0.55, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.055);
    noise.connect(nfilt).connect(ng).connect(master);
    noise.start(t); noise.stop(t + 0.06);

    // 2) Pitched click (tone body) — lane-tuned
    const freqs = [280, 340, 400, 480];
    const osc = audioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freqs[lane] * 1.5, t);
    osc.frequency.exponentialRampToValueAtTime(freqs[lane], t + 0.04);
    const og = audioCtx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.30, t + 0.005);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.connect(og).connect(master);
    osc.start(t); osc.stop(t + 0.2);

    // 3) Sub thump (punch feel)
    const sub = audioCtx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(90, t);
    sub.frequency.exponentialRampToValueAtTime(38, t + 0.1);
    const sg = audioCtx.createGain();
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime(0.28, t + 0.006);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    sub.connect(sg).connect(master);
    sub.start(t); sub.stop(t + 0.13);
  }

  function kick() {
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(50, t + 0.12);
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(t); osc.stop(t + 0.2);
  }

  // ---------- fx pools ----------
  let particles = [];   // { x, y, vx, vy, life, maxLife, r, color }
  let shockwaves = [];  // { x, y, lane, born, dur }
  let cores = [];       // { x, y, born, dur, r, color } bright hit-core flash
  let shake = { dx: 0, dy: 0, until: 0 };

  function spawnHitFX(lane, judge) {
    const { w, h, vpY, hitY } = geom();
    const x = laneBottomX(lane, w);
    const y = hitY;
    const col = LANE_COLORS[lane];
    const count = judge === 'perfect' ? 26 : judge === 'great' ? 16 : 9;

    for (let i = 0; i < count; i++) {
      const angle = (Math.random() * Math.PI * 2);
      const speed = 2.8 + Math.random() * (judge === 'perfect' ? 8 : 5);
      particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - (judge === 'perfect' ? 3.4 : 1.7),
        life: 1, maxLife: 0.55 + Math.random() * 0.35,
        r: 3 + Math.random() * (judge === 'perfect' ? 5 : 3),
        color: col,
      });
    }

    shockwaves.push({ x, y, lane, born: now(), dur: judge === 'perfect' ? 330 : 230 });
    // bright additive core flash — reads as the "punch" of the hit
    cores.push({ x, y, born: now(), dur: judge === 'perfect' ? 140 : 100,
      r: laneHalfW(w) * (judge === 'perfect' ? 1.5 : 1.1), color: col });

    if (judge === 'perfect') {
      shake.dx = (Math.random() - 0.5) * 8.5;
      shake.dy = (Math.random() - 0.5) * 8.5;
      shake.until = now() + 90;
    } else if (judge === 'great') {
      shake.dx = (Math.random() - 0.5) * 4;
      shake.dy = (Math.random() - 0.5) * 4;
      shake.until = now() + 55;
    }
  }

  function updateFX() {
    const dt = 1 / 60;
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.22; // gravity
      p.life -= dt / p.maxLife;
    }
    particles = particles.filter((p) => p.life > 0);
    shockwaves = shockwaves.filter((s) => now() - s.born < s.dur);
    cores = cores.filter((c) => now() - c.born < c.dur);
  }

  function drawFX() {
    const { w, h, hitY } = geom();
    const t = now();

    // bright core flash (additive)
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const c of cores) {
      const prog = (t - c.born) / c.dur;
      const a = (1 - prog);
      const r = c.r * (0.6 + prog * 0.8);
      const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
      g.addColorStop(0, `rgba(255,255,255,${0.9 * a})`);
      g.addColorStop(0.4, hexA(c.color, 0.55 * a));
      g.addColorStop(1, hexA(c.color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // shockwaves
    for (const s of shockwaves) {
      const prog = (t - s.born) / s.dur;
      const radius = laneHalfW(w) * (0.5 + prog * 2.2);
      const alpha = (1 - prog) * 0.85;
      const col = LANE_COLORS[s.lane];
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = col;
      ctx.lineWidth = 3 * (1 - prog) + 1;
      ctx.shadowColor = col;
      ctx.shadowBlur = 18 * (1 - prog);
      ctx.beginPath();
      ctx.ellipse(s.x, s.y, radius, radius * 0.28, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // particles
    for (const p of particles) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.life) * 0.92;
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = p.r * 2.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * Math.max(0, p.life), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // ---------- state ----------
  let state = null;
  let rafId = null;

  function startGame(diff) {
    ensureAudioCtx();
    const cfg = DIFF[diff];
    const bpm = clampInt($('bpmInput').value, 40, 300, 130);
    const offset = parseInt($('offsetInput').value, 10) || 0;

    const useSong = !!audioEl;
    const durationMs = useSong && isFinite(audioEl.duration) ? audioEl.duration * 1000 : 180000;

    // Prefer the analyzed chart (notes on real beats); else BPM-grid fallback.
    let notes;
    if (analysis && analysis.notes && analysis.notes.length > 8) {
      notes = analysis.notes.map((n) => ({ t: n.t, lane: n.lane, hit: false }));
    } else {
      notes = makeChart(cfg, bpm, durationMs);
    }

    state = {
      diff, cfg, bpm, offset, useSong, durationMs,
      notes,
      startTime: now() + 2500,
      score: 0, combo: 0, maxCombo: 0,
      counts: { perfect: 0, great: 0, good: 0, miss: 0 },
      judged: 0, paused: false, ended: false, pausedAt: 0, beatTimer: null,
    };

    particles = []; shockwaves = []; cores = []; shake = { dx: 0, dy: 0, until: 0 };
    $('bpmShow').textContent = bpm;
    resetHud();
    // show screen FIRST so canvas has layout dimensions, then resize
    showScreen('game');
    requestAnimationFrame(() => { resize(); });

    if (useSong) {
      audioEl.currentTime = 0;
      // small lead-in before the song actually starts
      setTimeout(() => { if (state && !state.ended) audioEl.play().catch(() => {}); }, 2500);
    } else {
      scheduleBeat();
    }
    loop();
  }

  // master song time in ms (note timeline is independent of offset; offset shifts notes)
  function songTime() {
    if (state.useSong && !audioEl.paused) {
      return audioEl.currentTime * 1000 - state.offset;
    }
    if (state.useSong) {
      // before play() kicks in, count down via the lead-in clock
      return (now() - state.startTime) - state.offset;
    }
    return now() - state.startTime;
  }

  function scheduleBeat() {
    if (!state || state.paused || state.ended || state.useSong) return;
    const beat = 60000 / state.bpm;
    const elapsed = now() - state.startTime;
    const nextIdx = Math.ceil(elapsed / beat);
    const delay = Math.max(0, nextIdx * beat - elapsed);
    state.beatTimer = setTimeout(() => { kick(); scheduleBeat(); }, delay);
  }

  function loop() {
    rafId = requestAnimationFrame(loop);
    if (!state || state.paused) return;
    update();
    updateFX();
    draw();
  }

  function update() {
    const t = songTime();
    for (const n of state.notes) {
      if (n.hit) continue;
      if (t - n.t > W_MISS) { n.hit = true; registerJudge('miss'); }
    }
    // progress + end
    const total = state.durationMs;
    const cur = Math.max(0, t);
    $('progFill').style.width = Math.min(100, (cur / total) * 100) + '%';
    $('timeShow').textContent = fmt(cur) + ' / ' + fmt(total);

    const songOver = state.useSong ? (audioEl.ended || t > total) : (t > lastNoteT() + 1500);
    if (songOver && !state.ended) endGame();
  }

  function lastNoteT() {
    const last = state.notes[state.notes.length - 1];
    return last ? last.t : 0;
  }

  // ---------- rendering ----------
  function draw() {
    const { w, h, vpY, hitY, vpX } = geom();
    ctx.clearRect(0, 0, w, h);

    // screen shake
    const isShaking = shake.until > now();
    if (isShaking) {
      ctx.save();
      ctx.translate(shake.dx, shake.dy);
    }

    // background image (cover)
    if (bgImage) {
      drawCover(bgImage, w, h);
      ctx.fillStyle = 'rgba(233,227,211,0.06)';
      ctx.fillRect(0, 0, w, h);
    } else {
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#e9e3d3'); grad.addColorStop(1, '#cfc6b0');
      ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
    }

    // lane wedges
    for (let i = 0; i < LANES; i++) {
      const bx0 = laneBottomX(i, w) - laneHalfW(w);
      const bx1 = laneBottomX(i, w) + laneHalfW(w);
      ctx.beginPath();
      ctx.moveTo(vpX, vpY);
      ctx.lineTo(bx0, hitY);
      ctx.lineTo(bx1, hitY);
      ctx.closePath();
      const col = LANE_COLORS[i];
      ctx.fillStyle = hexA(col, i % 2 ? 0.10 : 0.16);
      ctx.fill();
      // lane edges
      ctx.strokeStyle = hexA(col, 0.55);
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(vpX, vpY); ctx.lineTo(bx0, hitY); ctx.stroke();
    }
    // right-most edge
    {
      const last = LANES - 1;
      ctx.strokeStyle = hexA(LANE_COLORS[last], 0.55);
      ctx.beginPath(); ctx.moveTo(vpX, vpY); ctx.lineTo(laneBottomX(last, w) + laneHalfW(w), hitY); ctx.stroke();
    }

    // hit line
    const hl = ctx.createLinearGradient(0, hitY, w, hitY);
    hl.addColorStop(0, 'rgba(255,255,255,0)');
    hl.addColorStop(0.5, 'rgba(255,255,255,0.9)');
    hl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hl;
    ctx.fillRect(0, hitY - 1.5, w, 3);

    // key labels at the bottom of each lane
    ctx.font = '700 16px -apple-system, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = 0; i < LANES; i++) {
      const x = laneBottomX(i, w);
      ctx.fillStyle = 'rgba(20,20,35,0.75)';
      ctx.beginPath(); ctx.roundRect(x - 16, hitY + 14, 32, 26, 6); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(KEY_LABEL[i], x, hitY + 28);
    }

    // notes (far first)
    const t = songTime();
    const cfg = state.cfg;
    for (let k = state.notes.length - 1; k >= 0; k--) {
      const n = state.notes[k];
      if (n.hit) continue;
      const dt = n.t - t;
      if (dt > cfg.approach || dt < -W_MISS) continue;
      const tt = dt / cfg.approach;         // 1 far -> 0 near
      const f = perspF(tt);                 // 0 far -> 1 near (perspective)
      const x = lerp(vpX, laneBottomX(n.lane, w), f);
      const y = lerp(vpY, hitY, f);
      const scale = lerp(0.12, 1, f);
      const noteW = laneHalfW(w) * 2 * 0.82 * scale;
      const noteH = 26 * scale + 6;
      const col = LANE_COLORS[n.lane];
      ctx.save();
      ctx.shadowColor = col;
      ctx.shadowBlur = 18 * scale;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.roundRect(x - noteW / 2, y - noteH / 2, noteW, noteH, Math.min(10, noteH / 2));
      ctx.fill();
      // glossy top
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.roundRect(x - noteW / 2 + 3, y - noteH / 2 + 2, noteW - 6, noteH * 0.32, 4);
      ctx.fill();
      ctx.restore();
    }

    // lane hit flashes
    if (state.flash) {
      for (let i = 0; i < LANES; i++) {
        if (!state.flash[i] || state.flash[i] < now()) continue;
        const bx0 = laneBottomX(i, w) - laneHalfW(w);
        const bx1 = laneBottomX(i, w) + laneHalfW(w);
        const a = (state.flash[i] - now()) / 160;
        // wider, brighter flash
        ctx.beginPath();
        ctx.moveTo(vpX, vpY); ctx.lineTo(bx0, hitY); ctx.lineTo(bx1, hitY); ctx.closePath();
        ctx.fillStyle = hexA(LANE_COLORS[i], 0.38 * a);
        ctx.fill();
        // hit-line burst glow
        ctx.save();
        ctx.shadowColor = LANE_COLORS[i];
        ctx.shadowBlur = 28 * a;
        ctx.fillStyle = hexA(LANE_COLORS[i], 0.7 * a);
        ctx.fillRect(bx0, hitY - 5, bx1 - bx0, 10);
        ctx.restore();
      }
    }

    // FX (particles + shockwaves) on top
    drawFX();

    if (isShaking) ctx.restore();
  }

  function laneHalfW(w) {
    const spread = Math.min(w * 0.9, 620);
    return (spread / LANES) / 2 * 0.92;
  }

  function drawCover(img, w, h) {
    const ir = img.width / img.height, cr = w / h;
    let dw, dh, dx, dy;
    if (ir > cr) { dh = h; dw = h * ir; dx = (w - dw) / 2; dy = 0; }
    else { dw = w; dh = w / ir; dx = 0; dy = (h - dh) / 2; }
    ctx.drawImage(img, dx, dy, dw, dh);
  }

  // ---------- input / judging ----------
  function hitLane(lane) {
    if (!state || state.paused || state.ended) return;
    if (!state.flash) state.flash = [];
    state.flash[lane] = now() + 160;
    const t = songTime();
    let best = null, bestAbs = Infinity;
    for (const n of state.notes) {
      if (n.hit || n.lane !== lane) continue;
      const d = Math.abs(n.t - t);
      if (d < bestAbs && d <= W_MISS) { best = n; bestAbs = d; }
    }
    if (!best) return;
    best.hit = true;
    let judge;
    if (bestAbs <= W_PERFECT) judge = 'perfect';
    else if (bestAbs <= W_GREAT) judge = 'great';
    else if (bestAbs <= W_GOOD) judge = 'good';
    else judge = 'miss';
    spawnHitFX(lane, judge);
    registerJudge(judge);
  }

  function registerJudge(judge) {
    state.counts[judge]++;
    state.judged++;
    if (judge === 'miss') {
      state.combo = 0;
    } else {
      state.combo++;
      state.maxCombo = Math.max(state.maxCombo, state.combo);
      state.score += Math.round(SCORE[judge] * (1 + Math.min(state.combo, 100) * 0.01));
      bumpCombo();
    }
    showJudge(judge);
    updateHud();
  }

  const JUDGE_TEXT = { perfect: 'PERFECT', great: 'GREAT', good: 'GOOD', miss: 'MISS' };
  const JUDGE_VAR = { perfect: '--perfect', great: '--great', good: '--good', miss: '--miss' };
  function showJudge(j) {
    const el = $('judge');
    el.textContent = JUDGE_TEXT[j];
    el.style.color = getComputedStyle(document.documentElement).getPropertyValue(JUDGE_VAR[j]);
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  }
  function bumpCombo() {
    const el = $('comboNum');
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
  }

  function resetHud() {
    $('score').textContent = '0';
    $('accuracy').textContent = '100%';
    $('comboNum').textContent = '0';
    ['Perfect','Great','Good','Miss'].forEach((k) => $('cnt' + k).textContent = '0');
    $('maxComboShow').textContent = '0';
  }
  function updateHud() {
    $('score').textContent = state.score.toLocaleString();
    $('accuracy').textContent = (state.judged ? accuracy() : 100).toFixed(2) + '%';
    $('comboNum').textContent = state.combo;
    $('cntPerfect').textContent = state.counts.perfect;
    $('cntGreat').textContent = state.counts.great;
    $('cntGood').textContent = state.counts.good;
    $('cntMiss').textContent = state.counts.miss;
    $('maxComboShow').textContent = state.maxCombo;
  }
  function accuracy() {
    const c = state.counts;
    const got = c.perfect + c.great * 0.66 + c.good * 0.33;
    return (got / state.judged) * 100;
  }

  // ---------- end ----------
  function endGame() {
    state.ended = true;
    cancelAnimationFrame(rafId);
    clearTimeout(state.beatTimer);
    if (state.useSong && audioEl) { audioEl.pause(); }
    const acc = state.judged ? accuracy() : 0;
    $('finalScore').textContent = state.score.toLocaleString();
    $('rank').textContent = rankFor(acc);
    $('maxCombo').textContent = state.maxCombo;
    $('finalAcc').textContent = acc.toFixed(2) + '%';
    $('rPerfect').textContent = state.counts.perfect;
    $('rGreat').textContent = state.counts.great;
    $('rGood').textContent = state.counts.good;
    $('rMiss').textContent = state.counts.miss;
    saveBest(state.score);
    showScreen('result');
  }
  function rankFor(a) {
    if (a >= 98) return 'S'; if (a >= 90) return 'A';
    if (a >= 80) return 'B'; if (a >= 65) return 'C'; return 'D';
  }
  function saveBest(s) {
    try { if (s > (+localStorage.getItem('rf_best') || 0)) localStorage.setItem('rf_best', s); } catch (e) {}
  }
  function loadBest() { try { return +localStorage.getItem('rf_best') || 0; } catch (e) { return 0; } }

  // ---------- pause ----------
  function togglePause(force) {
    if (!state || state.ended) return;
    const willPause = force !== undefined ? force : !state.paused;
    if (willPause === state.paused) return;
    state.paused = willPause;
    if (willPause) {
      state.pausedAt = now();
      clearTimeout(state.beatTimer);
      if (state.useSong && audioEl) audioEl.pause();
      pauseOverlay.classList.add('active');
    } else {
      if (!state.useSong) state.startTime += now() - state.pausedAt;
      pauseOverlay.classList.remove('active');
      if (state.useSong && audioEl) audioEl.play().catch(() => {});
      else scheduleBeat();
    }
  }

  // ---------- utils ----------
  function lerp(a, b, t) { return a + (b - a) * t; }
  function clampInt(v, lo, hi, def) { const n = parseInt(v, 10); return isNaN(n) ? def : Math.max(lo, Math.min(hi, n)); }
  function fmt(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
      r = Math.min(r, w / 2, h / 2);
      this.beginPath();
      this.moveTo(x + r, y);
      this.arcTo(x + w, y, x + w, y + h, r);
      this.arcTo(x + w, y + h, x, y + h, r);
      this.arcTo(x, y + h, x, y, r);
      this.arcTo(x, y, x + w, y, r);
      this.closePath();
      return this;
    };
  }

  // ---------- events ----------
  $('diffPicker').addEventListener('click', (e) => {
    const btn = e.target.closest('.diff'); if (!btn) return;
    document.querySelectorAll('.diff').forEach((d) => d.classList.remove('selected'));
    btn.classList.add('selected');
    if (chosenDiff !== btn.dataset.diff) analysis = null; // density differs per difficulty
    chosenDiff = btn.dataset.diff;
  });

  $('bgInput').addEventListener('change', (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setBackground(reader.result, true);
    reader.readAsDataURL(file);
  });

  $('audioInput').addEventListener('change', (e) => {
    const file = e.target.files[0]; if (!file) return;
    if (audioURL) URL.revokeObjectURL(audioURL);
    audioURL = URL.createObjectURL(file);
    audioEl = new Audio(audioURL);
    audioEl.preload = 'auto';
    analysis = null;            // invalidate previous analysis
    songBuffer = null;
    file.arrayBuffer().then((ab) => { songBuffer = ab; });
  });

  async function beginGame(diff) {
    // If a song is loaded, analyze it once to match notes to the actual beats.
    if (audioEl && songBuffer && !analysis) {
      const btn = $('startBtn');
      const prev = btn.textContent;
      btn.textContent = '♪ 분석 중...';
      btn.disabled = true;
      try {
        analysis = await analyzeSong(songBuffer, DIFF[diff]);
        if (analysis.bpm) $('bpmInput').value = analysis.bpm;
      } catch (err) {
        analysis = null; // fall back to BPM grid
      }
      btn.textContent = prev;
      btn.disabled = false;
    }
    startGame(diff);
  }

  $('startBtn').addEventListener('click', () => beginGame(chosenDiff));
  $('retryBtn').addEventListener('click', () => startGame(state ? state.diff : chosenDiff));
  $('menuBtn').addEventListener('click', () => { showScreen('menu'); $('bestScore').textContent = loadBest().toLocaleString(); });
  $('pauseBtn').addEventListener('click', () => togglePause(true));
  $('resumeBtn').addEventListener('click', () => togglePause(false));
  $('quitBtn').addEventListener('click', () => {
    if (state) { state.ended = true; cancelAnimationFrame(rafId); clearTimeout(state.beatTimer); if (state.useSong && audioEl) audioEl.pause(); }
    pauseOverlay.classList.remove('active');
    showScreen('menu');
    $('bestScore').textContent = loadBest().toLocaleString();
  });

  // keyboard (physical codes for layout independence)
  const pressed = new Set();
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') { togglePause(); return; }
    const lane = KEYS.indexOf(e.code);
    if (lane === -1 || pressed.has(e.code)) return;
    pressed.add(e.code);
    hitLane(lane);
  });
  window.addEventListener('keyup', (e) => pressed.delete(e.code));

  // touch / click: map x position to lane
  canvas.addEventListener('pointerdown', (e) => {
    if (!state || state.paused || state.ended) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const w = rect.width;
    const spread = Math.min(w * 0.9, 620);
    const left = (w - spread) / 2;
    let lane = Math.floor((x - left) / (spread / LANES));
    lane = Math.max(0, Math.min(LANES - 1, lane));
    hitLane(lane);
  });

  document.addEventListener('visibilitychange', () => { if (document.hidden) togglePause(true); });

  // ---------- init ----------
  loadStoredBackground();
  $('bestScore').textContent = loadBest().toLocaleString();
  showScreen('menu');
})();
