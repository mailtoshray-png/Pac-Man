const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

const scoreEl = document.getElementById("score");
const livesEl = document.getElementById("lives");
const stateEl = document.getElementById("state");
const overlayEl = document.getElementById("overlay");
const overlayTitle = document.getElementById("overlay-title");
const overlaySubtitle = document.getElementById("overlay-subtitle");
const overlayHint = document.getElementById("overlay-hint");
const audioStatusEl = document.getElementById("audio-status");
const audioBtn = document.getElementById("audio-btn");
const gameWrap = document.querySelector(".game-wrap");

const TILE = 20;
const OPEN_ROW = ".".repeat(21);
let MAP = Array.from({ length: 23 }, () => OPEN_ROW);

function setChar(row, col, ch) {
  return `${row.slice(0, col)}${ch}${row.slice(col + 1)}`;
}

MAP[11] = setChar(MAP[11], 10, "P");
MAP[13] = setChar(MAP[13], 9, "G");
MAP[13] = setChar(MAP[13], 11, "G");
MAP[13] = setChar(MAP[13], 13, "G");

const ROWS = MAP.length;
const COLS = MAP[0].length;
const BASE_WIDTH = COLS * TILE;
const BASE_HEIGHT = ROWS * TILE;
canvas.width = BASE_WIDTH;
canvas.height = BASE_HEIGHT;

const DIRS = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
};

const reverseDir = (dir) => ({ x: -dir.x, y: -dir.y });
const PELLET_SCORE = 50;
const POWER_DURATION = 8;
const PELLET_PICKUP_RADIUS = TILE * 0.6;
const PELLET_SAFETY_RADIUS = TILE * 0.8;
const PELLET_SHIELD_DURATION = 0.4;

const CHOMP_VOLUME = 0.35;
const CHOMP_SRC = "assets/pacman-chomp.mp3";
const CHOMP_SLICE_OFFSET = 0.12;
const CHOMP_SLICE_DURATION = 0.32;
const CHOMP_MIN_GAP = 0.04;
const CHOMP_POOL_SIZE = 6;
let audioUnlocked = false;
let audioCtx = null;
let chompBuffer = null;
let chompSlice = null;
let chompIndex = 0;
let lastChompTime = 0;
const chompFallbackPool = Array.from({ length: CHOMP_POOL_SIZE }, () => {
  const audio = new Audio(CHOMP_SRC);
  audio.preload = "auto";
  audio.volume = CHOMP_VOLUME;
  audio.playsInline = true;
  return audio;
});

const isTouchDevice =
  "ontouchstart" in window || navigator.maxTouchPoints > 0;

function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  audioStatusEl.textContent = "Sound: unlocking...";
  audioBtn.style.display = "none";
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
  if (audioCtx) {
    const silentBuffer = audioCtx.createBuffer(1, 1, audioCtx.sampleRate);
    const silentSource = audioCtx.createBufferSource();
    silentSource.buffer = silentBuffer;
    silentSource.connect(audioCtx.destination);
    silentSource.start(0);
  }
  if (!chompBuffer) {
    fetch(CHOMP_SRC)
      .then((res) => res.arrayBuffer())
      .then((buf) => audioCtx.decodeAudioData(buf))
      .then((decoded) => {
        chompBuffer = decoded;
        chompSlice = buildChompSlice(decoded);
        audioStatusEl.textContent = "Sound: ready";
      })
      .catch(() => {
        audioStatusEl.textContent = "Sound: fallback";
      });
  }
  chompFallbackPool.forEach((audio) => {
    audio.muted = true;
    audio.volume = CHOMP_VOLUME;
    const fallbackPromise = audio.play();
    if (fallbackPromise && typeof fallbackPromise.then === "function") {
      fallbackPromise
        .then(() => {
          audio.pause();
          audio.currentTime = 0;
          audio.muted = false;
          if (!chompBuffer) {
            audioStatusEl.textContent = "Sound: fallback ready";
          }
        })
        .catch(() => {
          audio.muted = false;
          if (!chompBuffer) {
            audioStatusEl.textContent = "Sound: blocked";
            audioBtn.style.display = "inline-flex";
          }
        });
    } else {
      audio.muted = false;
      if (!chompBuffer) {
        audioStatusEl.textContent = "Sound: fallback ready";
      }
    }
  });
}

function buildChompSlice(buffer) {
  if (!audioCtx) return null;
  const sampleRate = buffer.sampleRate;
  const start = Math.floor(CHOMP_SLICE_OFFSET * sampleRate);
  const end = Math.min(
    buffer.length,
    start + Math.floor(CHOMP_SLICE_DURATION * sampleRate)
  );
  const length = Math.max(1, end - start);
  const slice = audioCtx.createBuffer(
    buffer.numberOfChannels,
    length,
    sampleRate
  );
  for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
    const channel = buffer.getChannelData(ch).subarray(start, end);
    slice.getChannelData(ch).set(channel);
  }
  return slice;
}

function playChomp() {
  if (!audioUnlocked) return;
  const now = performance.now();
  if (now - lastChompTime < CHOMP_MIN_GAP * 1000) return;
  lastChompTime = now;
  if (chompSlice && audioCtx) {
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }
    const source = audioCtx.createBufferSource();
    const gain = audioCtx.createGain();
    gain.gain.value = CHOMP_VOLUME;
    source.buffer = chompSlice;
    source.connect(gain).connect(audioCtx.destination);
    source.start(0);
  } else {
    const audio = chompFallbackPool[chompIndex];
    chompIndex = (chompIndex + 1) % CHOMP_POOL_SIZE;
    audio.pause();
    audio.currentTime = CHOMP_SLICE_OFFSET;
    audio.volume = CHOMP_VOLUME;
    audio.play().catch(() => {});
    if (audio._chompTimer) {
      clearTimeout(audio._chompTimer);
    }
    audio._chompTimer = setTimeout(() => {
      audio.pause();
      audio.currentTime = 0;
      audio._chompTimer = null;
    }, CHOMP_SLICE_DURATION * 1000);
  }
}

const state = {
  score: 0,
  lives: 3,
  mode: "ready",
  lastTime: 0,
  pellets: new Set(),
  powerTimer: 0,
  countdown: 0,
  pelletShield: 0,
  winReason: "pellets",
};

const startPositions = {
  pacman: null,
  ghosts: [],
};

function keyForTile(r, c) {
  return `${r},${c}`;
}

function isWall(r, c) {
  if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return true;
  return MAP[r][c] === "#";
}

function parseMap() {
  state.pellets.clear();
  startPositions.ghosts = [];

  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      const ch = MAP[r][c];
      if (
        (ch === "." || ch === "o") &&
        c !== 0 &&
        c !== COLS - 1 &&
        r !== 0 &&
        r !== ROWS - 1
      ) {
        state.pellets.add(keyForTile(r, c));
      }
      if (ch === "P") {
        startPositions.pacman = { r, c };
      }
      if (ch === "G") {
        startPositions.ghosts.push({ r, c });
      }
    }
  }
}

function tileCenter(r, c) {
  return {
    x: (c + 0.5) * TILE,
    y: (r + 0.5) * TILE,
  };
}

function getTileFromPos(x, y) {
  return {
    r: Math.floor(y / TILE),
    c: Math.floor(x / TILE),
  };
}

function isNearCenter(entity) {
  const tile = getTileFromPos(entity.x, entity.y);
  const center = tileCenter(tile.r, tile.c);
  return Math.abs(entity.x - center.x) < 1.5 && Math.abs(entity.y - center.y) < 1.5;
}

function canMove(tile, dir) {
  const r = tile.r + dir.y;
  const c = tile.c + dir.x;
  if (dir.x !== 0) {
    if (c < 0 || c >= COLS) return true;
    if (c === 0 || c === COLS - 1) return true;
  }
  if (dir.y !== 0) {
    if (r < 0 || r >= ROWS) return true;
    if (r === 0 || r === ROWS - 1) return true;
  }
  return !isWall(r, c);
}

function alignToCenter(entity) {
  const tile = getTileFromPos(entity.x, entity.y);
  const center = tileCenter(tile.r, tile.c);
  if (Math.abs(entity.x - center.x) < 0.6) entity.x = center.x;
  if (Math.abs(entity.y - center.y) < 0.6) entity.y = center.y;
}

function applyPowerPellet() {
  state.score += PELLET_SCORE;
  state.powerTimer = POWER_DURATION;
  state.pelletShield = PELLET_SHIELD_DURATION;
  ghosts.forEach((ghost) => {
    ghost.frightened = POWER_DURATION;
  });
  scoreEl.textContent = state.score;
  playChomp();
}

function tryConsumePellet(entity, radius) {
  const tile = getTileFromPos(entity.x, entity.y);
  for (let dr = -1; dr <= 1; dr += 1) {
    for (let dc = -1; dc <= 1; dc += 1) {
      const r = tile.r + dr;
      const c = tile.c + dc;
      const key = keyForTile(r, c);
      if (!state.pellets.has(key)) continue;
      const center = tileCenter(r, c);
      const dist = Math.hypot(entity.x - center.x, entity.y - center.y);
      if (dist <= radius) {
        state.pellets.delete(key);
        applyPowerPellet();
        return true;
      }
    }
  }
  return false;
}

function handleTunnel(entity) {
  const leftBound = -TILE * 0.25;
  const rightBound = BASE_WIDTH + TILE * 0.25;
  const topBound = -TILE * 0.25;
  const bottomBound = BASE_HEIGHT + TILE * 0.25;
  if (entity.x < leftBound) {
    entity.x = BASE_WIDTH - TILE * 0.5;
  } else if (entity.x > rightBound) {
    entity.x = TILE * 0.5;
  }
  if (entity.y < topBound) {
    entity.y = BASE_HEIGHT - TILE * 0.5;
  } else if (entity.y > bottomBound) {
    entity.y = TILE * 0.5;
  }
}

const pacman = {
  x: 0,
  y: 0,
  dir: { x: 0, y: 0 },
  nextDir: { x: 0, y: 0 },
  speed: 90,
};

const ghosts = [];

function resetEntities() {
  const pacStart = tileCenter(startPositions.pacman.r, startPositions.pacman.c);
  pacman.x = pacStart.x;
  pacman.y = pacStart.y;
  pacman.dir = { x: 0, y: 0 };
  pacman.nextDir = { x: 0, y: 0 };

  ghosts.length = 0;
  startPositions.ghosts.forEach((ghostStart, idx) => {
    const center = tileCenter(ghostStart.r, ghostStart.c);
    ghosts.push({
      x: center.x,
      y: center.y,
      home: { x: center.x, y: center.y },
      dir: idx % 2 === 0 ? DIRS.left : DIRS.right,
      speed: 80,
      color: ["#ff4b4b", "#49d6ff", "#ff8bd1"][idx % 3],
      frightened: 0,
      alive: true,
    });
  });
}

function setMode(mode) {
  state.mode = mode;
  stateEl.textContent = mode[0].toUpperCase() + mode.slice(1);
  overlayEl.classList.toggle("active", mode !== "playing");
  if (mode === "over") {
    overlayTitle.textContent = "YOU LOST";
    overlaySubtitle.textContent = "Game Over";
    overlayHint.textContent = isTouchDevice ? "Tap to Restart" : "Press Space to Restart";
  } else if (mode === "win") {
    overlayTitle.textContent = "YOU WIN";
    overlaySubtitle.textContent =
      state.winReason === "ghosts" ? "All ghosts eliminated" : "All pellets cleared";
    overlayHint.textContent = isTouchDevice ? "Tap to Restart" : "Press Space to Restart";
  } else if (mode === "ready") {
    overlayTitle.textContent = "PAC-MAN";
    overlaySubtitle.textContent = isTouchDevice ? "Tap to Start" : "Press Space to Start";
    overlayHint.textContent = isTouchDevice ? "Swipe to move" : "Arrow keys to move";
  } else if (mode === "paused") {
    overlayTitle.textContent = "You Died";
    overlaySubtitle.textContent = isTouchDevice ? "Tap to Continue" : "Press Space to Continue";
    overlayHint.textContent = isTouchDevice ? "Swipe to move" : "Get ready for a countdown";
  } else if (mode === "countdown") {
    overlayTitle.textContent = "Get Ready";
    overlaySubtitle.textContent = "Starting in 3";
    overlayHint.textContent = isTouchDevice ? "Swipe to move" : "Arrow keys to move";
  }
}

function setWin(reason) {
  state.winReason = reason;
  setMode("win");
}

function startGame() {
  if (state.mode === "over" || state.mode === "win") {
    state.score = 0;
    state.lives = 3;
    parseMap();
  }
  scoreEl.textContent = state.score;
  livesEl.textContent = state.lives;
  if (state.mode !== "paused") {
    resetEntities();
    state.powerTimer = 0;
  }
  beginCountdown();
}

function beginCountdown() {
  state.countdown = 3;
  setMode("countdown");
}

function loseLife() {
  state.lives -= 1;
  livesEl.textContent = state.lives;
  if (state.lives <= 0) {
    setMode("over");
    return;
  }
  resetEntities();
  setMode("paused");
}

function updatePacman(dt) {
  const tile = getTileFromPos(pacman.x, pacman.y);

  if (isNearCenter(pacman)) {
    if (canMove(tile, pacman.nextDir)) {
      pacman.dir = { ...pacman.nextDir };
    } else if (!canMove(tile, pacman.dir)) {
      pacman.dir = { x: 0, y: 0 };
    }
  }

  pacman.x += pacman.dir.x * pacman.speed * dt;
  pacman.y += pacman.dir.y * pacman.speed * dt;
  handleTunnel(pacman);
  alignToCenter(pacman);

  tryConsumePellet(pacman, PELLET_PICKUP_RADIUS);

  if (state.pellets.size === 0) {
    setWin("pellets");
  }

  if (ghosts.length > 0 && ghosts.every((ghost) => !ghost.alive)) {
    setWin("ghosts");
  }
}

function validDirections(tile, currentDir) {
  const options = [];
  Object.values(DIRS).forEach((dir) => {
    if (canMove(tile, dir)) {
      options.push(dir);
    }
  });

  if (options.length <= 1) return options;
  return options.filter(
    (dir) => !(dir.x === -currentDir.x && dir.y === -currentDir.y)
  );
}

function chooseGhostDir(ghost) {
  const tile = getTileFromPos(ghost.x, ghost.y);
  const options = validDirections(tile, ghost.dir);
  if (options.length === 0) return ghost.dir;

  if (ghost.frightened > 0) {
    return options[Math.floor(Math.random() * options.length)];
  }

  let best = options[0];
  let bestScore = Infinity;
  options.forEach((dir) => {
    const nextTile = { r: tile.r + dir.y, c: tile.c + dir.x };
    const center = tileCenter(nextTile.r, nextTile.c);
    const dx = center.x - pacman.x;
    const dy = center.y - pacman.y;
    const score = dx * dx + dy * dy;
    if (score < bestScore) {
      bestScore = score;
      best = dir;
    }
  });

  return best;
}

function updateGhosts(dt) {
  ghosts.forEach((ghost) => {
    if (!ghost.alive) return;
    if (ghost.frightened > 0) {
      ghost.frightened = Math.max(0, ghost.frightened - dt);
    }

    const tile = getTileFromPos(ghost.x, ghost.y);
    if (isNearCenter(ghost)) {
      ghost.dir = chooseGhostDir(ghost);
      if (!canMove(tile, ghost.dir)) {
        ghost.dir = reverseDir(ghost.dir);
      }
    }

    const speed = ghost.frightened > 0 ? 60 : ghost.speed;
    ghost.x += ghost.dir.x * speed * dt;
    ghost.y += ghost.dir.y * speed * dt;
    handleTunnel(ghost);
    alignToCenter(ghost);
  });
}

function checkCollisions() {
  const pelletShield =
    state.pelletShield > 0 || tryConsumePellet(pacman, PELLET_SAFETY_RADIUS);
  ghosts.forEach((ghost) => {
    if (!ghost.alive) return;
    const dx = ghost.x - pacman.x;
    const dy = ghost.y - pacman.y;
    const dist = Math.hypot(dx, dy);
    if (dist < TILE * 0.5) {
      if (ghost.frightened > 0 || pelletShield) {
        state.score += 200;
        scoreEl.textContent = state.score;
        ghost.alive = false;
        if (ghosts.every((g) => !g.alive)) {
          setWin("ghosts");
        }
      } else {
        loseLife();
        if (state.mode !== "playing") return;
      }
    }
  });
}

function drawMaze() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      const ch = MAP[r][c];
      if (ch === "#" && c !== 0 && c !== COLS - 1 && r !== 0 && r !== ROWS - 1) {
        ctx.fillStyle = "#3654ff";
        ctx.fillRect(c * TILE, r * TILE, TILE, TILE);
      }
    }
  }

  state.pellets.forEach((key) => {
    const [r, c] = key.split(",").map(Number);
    ctx.fillStyle = "#ff8fcf";
    ctx.beginPath();
    ctx.arc((c + 0.5) * TILE, (r + 0.5) * TILE, 5, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawPacman() {
  ctx.fillStyle = "#f6d743";
  ctx.beginPath();
  const angle = Math.abs(Math.sin(Date.now() / 120)) * 0.35;
  const dirAngle = pacman.dir.x === 1 ? 0 : pacman.dir.x === -1 ? Math.PI : pacman.dir.y === -1 ? -Math.PI / 2 : Math.PI / 2;
  ctx.moveTo(pacman.x, pacman.y);
  ctx.arc(pacman.x, pacman.y, TILE * 0.45, dirAngle + angle, dirAngle + Math.PI * 2 - angle);
  ctx.fill();
}

function drawGhosts() {
  ghosts.forEach((ghost) => {
    if (!ghost.alive) return;
    ctx.fillStyle = ghost.frightened > 0 ? "#6bd6ff" : ghost.color;
    ctx.beginPath();
    ctx.arc(ghost.x, ghost.y, TILE * 0.45, Math.PI, 0);
    ctx.lineTo(ghost.x + TILE * 0.45, ghost.y + TILE * 0.45);
    ctx.lineTo(ghost.x + TILE * 0.25, ghost.y + TILE * 0.2);
    ctx.lineTo(ghost.x, ghost.y + TILE * 0.45);
    ctx.lineTo(ghost.x - TILE * 0.25, ghost.y + TILE * 0.2);
    ctx.lineTo(ghost.x - TILE * 0.45, ghost.y + TILE * 0.45);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(ghost.x - 4, ghost.y - 2, 3, 0, Math.PI * 2);
    ctx.arc(ghost.x + 4, ghost.y - 2, 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#1b1b1b";
    ctx.beginPath();
    ctx.arc(ghost.x - 4, ghost.y - 2, 1.5, 0, Math.PI * 2);
    ctx.arc(ghost.x + 4, ghost.y - 2, 1.5, 0, Math.PI * 2);
    ctx.fill();
  });
}

function draw() {
  drawMaze();
  drawPacman();
  drawGhosts();
}

function update(timestamp) {
  const dt = Math.min(0.016, (timestamp - state.lastTime) / 1000 || 0);
  state.lastTime = timestamp;

  if (state.mode === "countdown") {
    state.countdown = Math.max(0, state.countdown - dt);
    overlaySubtitle.textContent = `Starting in ${Math.ceil(state.countdown)}`;
    if (state.countdown <= 0) {
      setMode("playing");
    }
  } else if (state.mode === "playing") {
    state.pelletShield = Math.max(0, state.pelletShield - dt);
    updatePacman(dt);
    updateGhosts(dt);
    checkCollisions();
  }

  draw();
  requestAnimationFrame(update);
}

function handleKey(e) {
  unlockAudio();
  if (e.key === " ") {
    if (state.mode === "playing") {
      setMode("paused");
    } else if (state.mode !== "countdown") {
      startGame();
    }
    return;
  }

  if (e.key === "ArrowLeft") pacman.nextDir = DIRS.left;
  if (e.key === "ArrowRight") pacman.nextDir = DIRS.right;
  if (e.key === "ArrowUp") pacman.nextDir = DIRS.up;
  if (e.key === "ArrowDown") pacman.nextDir = DIRS.down;
}

function handleStartAction() {
  unlockAudio();
  if (state.mode === "playing" || state.mode === "countdown") return;
  startGame();
}

let touchStart = null;

function onTouchStart(e) {
  if (!e.touches || e.touches.length === 0) return;
  const touch = e.touches[0];
  touchStart = { x: touch.clientX, y: touch.clientY };
}

function onTouchEnd(e) {
  if (!touchStart || !e.changedTouches || e.changedTouches.length === 0) return;
  const touch = e.changedTouches[0];
  const dx = touch.clientX - touchStart.x;
  const dy = touch.clientY - touchStart.y;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  const threshold = 20;

  if (absX < threshold && absY < threshold) {
    handleStartAction();
  } else if (absX > absY) {
    pacman.nextDir = dx > 0 ? DIRS.right : DIRS.left;
  } else {
    pacman.nextDir = dy > 0 ? DIRS.down : DIRS.up;
  }

  touchStart = null;
}

document.addEventListener("keydown", handleKey);
document.addEventListener("pointerdown", unlockAudio, { once: true });
document.addEventListener("touchstart", unlockAudio, { once: true });
audioBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  unlockAudio();
});
if (gameWrap) {
  gameWrap.addEventListener("click", () => {
    if (isTouchDevice) handleStartAction();
  });
  gameWrap.addEventListener("touchstart", onTouchStart, { passive: false });
  gameWrap.addEventListener("touchend", onTouchEnd, { passive: false });
  gameWrap.addEventListener(
    "touchmove",
    (e) => {
      e.preventDefault();
    },
    { passive: false }
  );
}

parseMap();
resetEntities();
scoreEl.textContent = state.score;
livesEl.textContent = state.lives;
setMode("ready");
requestAnimationFrame(update);

function resizeCanvas() {
  const hudHeight = document.querySelector(".hud")?.offsetHeight || 0;
  const padding = 32;
  const availableWidth = Math.max(200, window.innerWidth - padding);
  const availableHeight = Math.max(200, window.innerHeight - hudHeight - padding);
  const scale = Math.min(availableWidth / BASE_WIDTH, availableHeight / BASE_HEIGHT);
  const displayWidth = Math.floor(BASE_WIDTH * scale);
  const displayHeight = Math.floor(BASE_HEIGHT * scale);
  canvas.style.width = `${displayWidth}px`;
  canvas.style.height = `${displayHeight}px`;
}

window.addEventListener("resize", resizeCanvas);
resizeCanvas();
