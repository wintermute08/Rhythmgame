(() => {
  'use strict';

  // ---------- config ----------
  const LANES = 4;
  const KEYS = ['KeyD', 'KeyF', 'KeyJ', 'KeyK'];
  const LANE_COLORS = ['#ff3b78', '#ffb13b', '#3bd1ff', '#9b6bff'];
  const HIT_LINE_FROM_BOTTOM = 120; // matches .lanes height in CSS

  const DIFF = {
    easy:   { bpm: 100, approach: 1500, density: 0.55, chordChance: 0.05 },
    normal: { bpm: 130, approach: 1150, density: 0.75, chordChance: 0.15 },
    hard:   { bpm: 160, approach: 900,  density: 0.95, chordChance: 0.30 },
  };

  // timing windows (ms)
  const W_PERFECT = 45, W_GREAT = 90, W_GOOD = 140, W_MISS = 200;
  const SCORE = { perfect: 300, great: 200, good: 100, miss: 0 };

  // ---------- dom ----------
  const $ = (id) => document.getElementById(id);
  const screens = {
    menu: $('menu'), game: $('game'), result: $('result'),
  };
  const pauseOverlay = $('pause');
  const canvas = $('board');
  const ctx = canvas.getContext('2d');
  const laneEls = Array.from(document.querySelectorAll('.lane'));

  let chosenDiff = 'normal';

  // ---------- state ----------
  let state = null;
  let rafId = null;
  let audio = null; // AudioContext

  function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.remove('active'));
    screens[name].classList.add('active');
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

  // ---------- chart generation ----------
  // Deterministic-ish but varied note chart driven by BPM.
  function makeChart(cfg) {
    const notes = [];
    const beat = 60000 / cfg.bpm; // ms per beat
    const totalBeats = 180; // ~ length of the song
    let lastLane = -1;
    for (let b = 4; b < totalBeats; b++) {
      // subdivisions: place on beats and some offbeats based on density
      const subs = cfg.density > 0.85 ? [0, 0.5] : [0];
      for (const s of subs) {
        if (s === 0.5 && Math.random() > cfg.density - 0.3) continue;
        if (s === 0 && Math.random() > cfg.density) continue;
        const t = b * beat + s * beat;
        let lane = (Math.random() * LANES) | 0;
        if (lane === lastLane && Math.random() < 0.6) lane = (lane + 1) % LANES;
        lastLane = lane;
        notes.push({ t, lane });
        // occasional chord (two lanes at once)
        if (Math.random() < cfg.chordChance) {
          let l2 = (lane + 1 + ((Math.random() * 2) | 0)) % LANES;
          if (l2 !== lane) notes.push({ t, lane: l2 });
        }
      }
    }
    notes.sort((a, b) => a.t - b.t);
    notes.forEach((n, i) => { n.id = i; n.hit = false; });
    return notes;
  }

  // ---------- audio (synth beat, no external assets) ----------
  function initAudio() {
    if (!audio) {
      const AC = window.AudioContext || window.webkitAudioContext;
      audio = new AC();
    }
    if (audio.state === 'suspended') audio.resume();
  }

  function blip(lane) {
    if (!audio) return;
    const now = audio.currentTime;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    const base = [220, 277, 330, 415][lane];
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(base, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    osc.connect(gain).connect(audio.destination);
    osc.start(now);
    osc.stop(now + 0.2);
  }

  // metronome-ish kick to give a beat
  function scheduleBeat() {
    if (!state || state.paused || state.ended) return;
    const cfg = DIFF[state.diff];
    const beat = 60000 / cfg.bpm;
    const elapsed = now() - state.startTime;
    const nextBeatIdx = Math.ceil(elapsed / beat);
    const targetMs = nextBeatIdx * beat;
    const delay = Math.max(0, targetMs - elapsed);
    state.beatTimer = setTimeout(() => {
      kick();
      scheduleBeat();
    }, delay);
  }

  function kick() {
    if (!audio) return;
    const now = audio.currentTime;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.setValueAtTime(150, now);
    osc.frequency.exponentialRampToValueAtTime(50, now + 0.12);
    gain.gain.setValueAtTime(0.25, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    osc.connect(gain).connect(audio.destination);
    osc.start(now);
    osc.stop(now + 0.2);
  }

  const now = () => performance.now();

  // ---------- game lifecycle ----------
  function startGame(diff) {
    initAudio();
    resize();
    const cfg = DIFF[diff];
    state = {
      diff,
      cfg,
      notes: makeChart(cfg),
      startTime: now() + 2500, // lead-in
      score: 0,
      combo: 0,
      maxCombo: 0,
      counts: { perfect: 0, great: 0, good: 0, miss: 0 },
      judged: 0,
      paused: false,
      ended: false,
      pauseOffset: 0,
      beatTimer: null,
    };
    updateHud();
    showScreen('game');
    scheduleBeat();
    loop();
  }

  function songTime() {
    return now() - state.startTime;
  }

  function loop() {
    rafId = requestAnimationFrame(loop);
    if (!state || state.paused) return;
    update();
    draw();
  }

  function update() {
    const t = songTime();
    // auto-miss notes that passed the window
    for (const n of state.notes) {
      if (n.hit) continue;
      if (t - n.t > W_MISS) {
        n.hit = true;
        registerJudge('miss');
      }
    }
    // end condition
    const last = state.notes[state.notes.length - 1];
    if (last && t > last.t + 1500 && !state.ended) {
      endGame();
    }
  }

  function draw() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    const laneW = w / LANES;
    const hitY = h - HIT_LINE_FROM_BOTTOM;
    const cfg = state.cfg;
    const t = songTime();

    // hit line glow
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(0, hitY - 2, w, 4);

    for (const n of state.notes) {
      if (n.hit) continue;
      const dt = n.t - t; // ms until hit
      if (dt > cfg.approach || dt < -W_MISS) continue;
      const prog = 1 - dt / cfg.approach; // 0 (top) -> 1 (hit line)
      const y = prog * hitY;
      const x = n.lane * laneW;
      const noteH = 22;
      const r = 12;
      ctx.fillStyle = LANE_COLORS[n.lane];
      ctx.shadowColor = LANE_COLORS[n.lane];
      ctx.shadowBlur = 16;
      roundRect(ctx, x + 6, y - noteH / 2, laneW - 12, noteH, r);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  function roundRect(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  // ---------- input / judging ----------
  function hitLane(lane) {
    if (!state || state.paused || state.ended) return;
    flashLane(lane);
    blip(lane);
    const t = songTime();
    // find nearest unhit note in this lane within miss window
    let best = null, bestAbs = Infinity;
    for (const n of state.notes) {
      if (n.hit || n.lane !== lane) continue;
      const d = Math.abs(n.t - t);
      if (d < bestAbs && d <= W_MISS) { best = n; bestAbs = d; }
    }
    if (!best) return; // empty tap, no penalty
    best.hit = true;
    let judge;
    if (bestAbs <= W_PERFECT) judge = 'perfect';
    else if (bestAbs <= W_GREAT) judge = 'great';
    else if (bestAbs <= W_GOOD) judge = 'good';
    else judge = 'miss';
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
      const comboBonus = 1 + Math.min(state.combo, 100) * 0.01;
      state.score += Math.round(SCORE[judge] * comboBonus);
    }
    showJudge(judge);
    updateHud();
  }

  const JUDGE_TEXT = { perfect: 'PERFECT', great: 'GREAT', good: 'GOOD', miss: 'MISS' };
  const JUDGE_COLOR = { perfect: 'var(--perfect)', great: 'var(--great)', good: 'var(--good)', miss: 'var(--miss)' };
  function showJudge(judge) {
    const el = $('judge');
    el.textContent = JUDGE_TEXT[judge];
    el.style.color = JUDGE_COLOR[judge];
    el.classList.remove('show');
    void el.offsetWidth; // reflow to restart animation
    el.classList.add('show');
  }

  function flashLane(lane) {
    const el = laneEls[lane];
    el.classList.add('hit');
    setTimeout(() => el.classList.remove('hit'), 90);
  }

  function updateHud() {
    $('score').textContent = state.score.toLocaleString();
    $('combo').textContent = state.combo;
    const acc = state.judged ? accuracy() : 100;
    $('accuracy').textContent = acc.toFixed(1) + '%';
  }

  function accuracy() {
    const c = state.counts;
    const got = c.perfect * 1 + c.great * 0.66 + c.good * 0.33;
    return (got / state.judged) * 100;
  }

  // ---------- end / result ----------
  function endGame() {
    state.ended = true;
    cancelAnimationFrame(rafId);
    clearTimeout(state.beatTimer);
    const acc = state.judged ? accuracy() : 0;
    $('finalScore').textContent = state.score.toLocaleString();
    $('maxCombo').textContent = state.maxCombo;
    $('finalAcc').textContent = acc.toFixed(1) + '%';
    $('cntPerfect').textContent = state.counts.perfect;
    $('cntGreat').textContent = state.counts.great;
    $('cntGood').textContent = state.counts.good;
    $('cntMiss').textContent = state.counts.miss;
    $('rank').textContent = rankFor(acc);
    saveBest(state.score);
    showScreen('result');
  }

  function rankFor(acc) {
    if (acc >= 98) return 'S';
    if (acc >= 90) return 'A';
    if (acc >= 80) return 'B';
    if (acc >= 65) return 'C';
    return 'D';
  }

  function saveBest(score) {
    try {
      const best = +(localStorage.getItem('rt_best') || 0);
      if (score > best) localStorage.setItem('rt_best', score);
    } catch (e) {}
  }
  function loadBest() {
    try { return +(localStorage.getItem('rt_best') || 0); } catch (e) { return 0; }
  }

  // ---------- pause ----------
  function togglePause(force) {
    if (!state || state.ended) return;
    const willPause = force !== undefined ? force : !state.paused;
    if (willPause === state.paused) return;
    state.paused = willPause;
    if (willPause) {
      state.pausedAt = now();
      clearTimeout(state.beatTimer);
      pauseOverlay.classList.add('active');
    } else {
      // shift timeline by the paused duration
      const delta = now() - state.pausedAt;
      state.startTime += delta;
      pauseOverlay.classList.remove('active');
      scheduleBeat();
    }
  }

  // ---------- events ----------
  $('diffPicker').addEventListener('click', (e) => {
    const btn = e.target.closest('.diff');
    if (!btn) return;
    document.querySelectorAll('.diff').forEach((d) => d.classList.remove('selected'));
    btn.classList.add('selected');
    chosenDiff = btn.dataset.diff;
  });

  $('startBtn').addEventListener('click', () => startGame(chosenDiff));
  $('retryBtn').addEventListener('click', () => startGame(state ? state.diff : chosenDiff));
  $('menuBtn').addEventListener('click', () => { showScreen('menu'); $('bestScore').textContent = loadBest().toLocaleString(); });
  $('pauseBtn').addEventListener('click', () => togglePause(true));
  $('resumeBtn').addEventListener('click', () => togglePause(false));
  $('quitBtn').addEventListener('click', () => {
    togglePause(false);
    if (state) { state.ended = true; cancelAnimationFrame(rafId); clearTimeout(state.beatTimer); }
    pauseOverlay.classList.remove('active');
    showScreen('menu');
    $('bestScore').textContent = loadBest().toLocaleString();
  });

  // keyboard (desktop) — physical key codes for layout independence
  const pressed = new Set();
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') { togglePause(); return; }
    const lane = KEYS.indexOf(e.code);
    if (lane === -1 || pressed.has(e.code)) return;
    pressed.add(e.code);
    hitLane(lane);
  });
  window.addEventListener('keyup', (e) => pressed.delete(e.code));

  // touch / pointer (mobile + desktop click)
  laneEls.forEach((el, lane) => {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      hitLane(lane);
    });
  });
  // also allow tapping anywhere on the board, mapped to lane by x
  canvas.addEventListener('pointerdown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const lane = Math.min(LANES - 1, Math.max(0, ((e.clientX - rect.left) / rect.width * LANES) | 0));
    hitLane(lane);
  });

  // pause when tab hidden
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) togglePause(true);
  });

  // ---------- init ----------
  $('bestScore').textContent = loadBest().toLocaleString();
  showScreen('menu');
})();
