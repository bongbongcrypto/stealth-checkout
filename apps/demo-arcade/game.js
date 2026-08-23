// SHADOW RUN: 60-second score-attack for the Stealth Checkout demo arcade.
// Plain canvas, no engine. You are a shadow: collect encrypted notes, dodge seekers.

export function createGame(canvas, { onGameOver }) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;

  const state = {
    running: false,
    mode: "practice", // "practice" | "paid"
    t: 0,
    timeLeft: 60,
    score: 0,
    combo: 1,
    comboT: 0,
    hp: 3,
    invulnT: 0,
    player: { x: W / 2, y: H / 2, vx: 0, vy: 0, r: 9 },
    notes: [],
    seekers: [],
    sweeps: [],
    particles: [],
    shake: 0,
    keys: new Set(),
    last: 0,
  };

  const rand = (a, b) => a + Math.random() * (b - a);

  function reset(mode) {
    Object.assign(state, {
      running: true,
      mode,
      t: 0,
      timeLeft: 60,
      score: 0,
      combo: 1,
      comboT: 0,
      hp: 3,
      invulnT: 1,
      notes: [],
      seekers: [],
      sweeps: [],
      particles: [],
      shake: 0,
    });
    state.player.x = W / 2;
    state.player.y = H / 2;
    for (let i = 0; i < 5; i++) spawnNote();
    for (let i = 0; i < 2; i++) spawnSeeker();
  }

  function spawnNote() {
    state.notes.push({ x: rand(30, W - 30), y: rand(30, H - 30), r: 7, pulse: rand(0, 6) });
  }

  function spawnSeeker() {
    const edge = Math.floor(rand(0, 4));
    const pos =
      edge === 0 ? { x: rand(0, W), y: -20 } :
      edge === 1 ? { x: rand(0, W), y: H + 20 } :
      edge === 2 ? { x: -20, y: rand(0, H) } : { x: W + 20, y: rand(0, H) };
    state.seekers.push({ ...pos, r: 11, speed: rand(52, 78) });
  }

  function spawnSweep() {
    const vertical = Math.random() < 0.5;
    state.sweeps.push({
      vertical,
      pos: vertical ? -40 : -40,
      speed: rand(120, 170),
      width: 34,
      warnT: 1.1,
    });
  }

  function burst(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2);
      const s = rand(30, 130);
      state.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.25, 0.6), color });
    }
  }

  function hit() {
    if (state.invulnT > 0) return;
    state.hp -= 1;
    state.combo = 1;
    state.invulnT = 1.2;
    state.shake = 0.35;
    burst(state.player.x, state.player.y, "#ff7b72", 26);
    if (state.hp <= 0) end();
  }

  function end() {
    state.running = false;
    onGameOver({ score: state.score, mode: state.mode });
  }

  function update(dt) {
    state.t += dt;
    state.timeLeft -= dt;
    if (state.timeLeft <= 0) return end();

    // difficulty ramp
    if (state.seekers.length < 2 + Math.floor(state.t / 9)) spawnSeeker();
    if (state.t > 8 && state.sweeps.length < 1 + Math.floor(state.t / 20) && Math.random() < 0.01) spawnSweep();

    // input
    const k = state.keys;
    const ax = (k.has("ArrowRight") || k.has("d") ? 1 : 0) - (k.has("ArrowLeft") || k.has("a") ? 1 : 0);
    const ay = (k.has("ArrowDown") || k.has("s") ? 1 : 0) - (k.has("ArrowUp") || k.has("w") ? 1 : 0);
    const ACC = 900, FRICTION = 6.5, MAX = 240;
    const p = state.player;
    p.vx += ax * ACC * dt;
    p.vy += ay * ACC * dt;
    p.vx -= p.vx * FRICTION * dt;
    p.vy -= p.vy * FRICTION * dt;
    const sp = Math.hypot(p.vx, p.vy);
    if (sp > MAX) { p.vx = (p.vx / sp) * MAX; p.vy = (p.vy / sp) * MAX; }
    p.x = Math.max(p.r, Math.min(W - p.r, p.x + p.vx * dt));
    p.y = Math.max(p.r, Math.min(H - p.r, p.y + p.vy * dt));

    // combo decay
    state.comboT -= dt;
    if (state.comboT <= 0 && state.combo > 1) state.combo = Math.max(1, state.combo - 1);
    state.invulnT = Math.max(0, state.invulnT - dt);
    state.shake = Math.max(0, state.shake - dt);

    // notes
    for (let i = state.notes.length - 1; i >= 0; i--) {
      const n = state.notes[i];
      n.pulse += dt * 4;
      if (Math.hypot(n.x - p.x, n.y - p.y) < n.r + p.r + 2) {
        state.notes.splice(i, 1);
        state.score += 10 * state.combo;
        state.combo = Math.min(8, state.combo + 1);
        state.comboT = 2.2;
        burst(n.x, n.y, "#7ee787", 12);
        spawnNote();
      }
    }

    // seekers
    for (const s of state.seekers) {
      const d = Math.hypot(p.x - s.x, p.y - s.y) || 1;
      s.x += ((p.x - s.x) / d) * s.speed * dt;
      s.y += ((p.y - s.y) / d) * s.speed * dt;
      if (d < s.r + p.r) hit();
    }

    // spotlight sweeps
    for (let i = state.sweeps.length - 1; i >= 0; i--) {
      const sw = state.sweeps[i];
      if (sw.warnT > 0) { sw.warnT -= dt; continue; }
      sw.pos += sw.speed * dt;
      const limit = sw.vertical ? H : W;
      if (sw.pos > limit + 60) { state.sweeps.splice(i, 1); continue; }
      const dist = sw.vertical ? Math.abs(p.y - sw.pos) : Math.abs(p.x - sw.pos);
      if (dist < sw.width / 2 + p.r) hit();
    }

    // particles
    for (let i = state.particles.length - 1; i >= 0; i--) {
      const q = state.particles[i];
      q.life -= dt;
      if (q.life <= 0) { state.particles.splice(i, 1); continue; }
      q.x += q.vx * dt;
      q.y += q.vy * dt;
    }
  }

  function draw() {
    ctx.save();
    if (state.shake > 0) ctx.translate(rand(-4, 4) * state.shake * 3, rand(-4, 4) * state.shake * 3);

    ctx.fillStyle = "#0a0c10";
    ctx.fillRect(-10, -10, W + 20, H + 20);

    // grid
    ctx.strokeStyle = "rgba(126,231,135,0.05)";
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

    // sweeps
    for (const sw of state.sweeps) {
      const warning = sw.warnT > 0;
      ctx.fillStyle = warning
        ? `rgba(255,123,114,${0.10 + 0.10 * Math.sin(state.t * 20)})`
        : "rgba(255,220,120,0.16)";
      const pos = warning ? (sw.vertical ? 0 : 0) : sw.pos - sw.width / 2;
      if (sw.vertical) ctx.fillRect(0, warning ? sw.pos : pos, W, warning ? 2 : sw.width);
      else ctx.fillRect(warning ? sw.pos : pos, 0, warning ? 2 : sw.width, H);
    }

    // notes
    for (const n of state.notes) {
      const r = n.r + Math.sin(n.pulse) * 1.5;
      ctx.save();
      ctx.translate(n.x, n.y);
      ctx.rotate(Math.PI / 4);
      ctx.shadowColor = "#7ee787";
      ctx.shadowBlur = 14;
      ctx.fillStyle = "#7ee787";
      ctx.fillRect(-r / 1.4, -r / 1.4, r * 1.45, r * 1.45);
      ctx.restore();
    }

    // seekers
    for (const s of state.seekers) {
      ctx.save();
      ctx.shadowColor = "#ff7b72";
      ctx.shadowBlur = 16;
      ctx.strokeStyle = "#ff7b72";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(s.x, s.y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = "#ff7b72";
      ctx.fill();
      ctx.restore();
    }

    // player
    const p = state.player;
    ctx.save();
    if (state.invulnT > 0 && Math.floor(state.t * 12) % 2 === 0) ctx.globalAlpha = 0.35;
    ctx.shadowColor = "#b28dff";
    ctx.shadowBlur = 22;
    ctx.fillStyle = "#b28dff";
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // particles
    for (const q of state.particles) {
      ctx.globalAlpha = Math.max(0, q.life * 2);
      ctx.fillStyle = q.color;
      ctx.fillRect(q.x - 1.5, q.y - 1.5, 3, 3);
      ctx.globalAlpha = 1;
    }

    // HUD
    ctx.fillStyle = "#e8eaf0";
    ctx.font = "700 16px monospace";
    ctx.fillText(String(state.score).padStart(6, "0"), 12, 24);
    ctx.fillStyle = state.combo > 1 ? "#7ee787" : "#9aa1ad";
    ctx.font = "700 12px monospace";
    ctx.fillText(`x${state.combo}`, 12, 42);
    ctx.fillStyle = state.timeLeft < 10 ? "#ff7b72" : "#9aa1ad";
    ctx.font = "700 16px monospace";
    ctx.fillText(`${Math.ceil(state.timeLeft)}s`, W - 48, 24);
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = i < state.hp ? "#ff7b72" : "#2a2e37";
      ctx.fillRect(W - 60 + i * 16, 34, 10, 10);
    }
    if (state.mode === "paid") {
      ctx.fillStyle = "#7ee787";
      ctx.font = "700 10px monospace";
      ctx.fillText("PAID RUN", 12, H - 12);
    }

    // scanlines
    ctx.fillStyle = "rgba(0,0,0,0.10)";
    for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 1);
    ctx.restore();
  }

  function frame(now) {
    if (!state.running) return;
    const dt = Math.min(0.05, (now - state.last) / 1000);
    state.last = now;
    update(dt);
    draw();
    requestAnimationFrame(frame);
  }

  // Swallow arrows and space only while the game owns the input. Doing it
  // unconditionally stopped Space from activating a focused button and stopped
  // the arrow keys from scrolling the page, which broke the checkout beside it.
  const TYPING = new Set(["BUTTON", "INPUT", "TEXTAREA", "SELECT", "A", "SUMMARY"]);
  window.addEventListener("keydown", (e) => {
    const target = e.target;
    const typing = target instanceof HTMLElement && (TYPING.has(target.tagName) || target.isContentEditable);
    if (state.running && !typing && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(e.key)) {
      e.preventDefault();
    }
    state.keys.add(e.key.length === 1 ? e.key.toLowerCase() : e.key);
  });

  // Held keys must not survive a tab switch: coming back mid-run with a stuck
  // arrow key sent the runner into a wall.
  window.addEventListener("blur", () => state.keys.clear());
  window.addEventListener("keyup", (e) => state.keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key));

  function drawIdle() {
    ctx.fillStyle = "#0a0c10";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#b28dff";
    ctx.shadowColor = "#b28dff";
    ctx.shadowBlur = 20;
    ctx.font = "700 26px monospace";
    ctx.textAlign = "center";
    ctx.fillText("SHADOW RUN", W / 2, H / 2 - 26);
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#9aa1ad";
    ctx.font = "13px monospace";
    ctx.fillText("collect notes · dodge seekers · 60s", W / 2, H / 2 + 2);
    ctx.fillStyle = "#7ee787";
    ctx.fillText("insert coin or press practice", W / 2, H / 2 + 26);
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(0,0,0,0.10)";
    for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 1);
  }

  drawIdle();

  return {
    start(mode) {
      reset(mode);
      state.last = performance.now();
      requestAnimationFrame(frame);
    },
    idle: drawIdle,
    isRunning: () => state.running,
  };
}
