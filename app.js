const HISTORY_KEY = 'cs2-sensitivity-history-v1';
const MAX_RAW_POINTER_DELTA = 160;
const RESOLUTION_PROFILES = {
  '1024x768': { width: 1024, height: 768, aspect: '4 / 3', family: '4:3' },
  '1280x960': { width: 1280, height: 960, aspect: '4 / 3', family: '4:3' },
  '1440x1080': { width: 1440, height: 1080, aspect: '4 / 3', family: '4:3' },
  '1280x1024': { width: 1280, height: 1024, aspect: '5 / 4', family: '5:4' },
  '1280x720': { width: 1280, height: 720, aspect: '16 / 9', family: '16:9' },
  '1600x900': { width: 1600, height: 900, aspect: '16 / 9', family: '16:9' },
  '1920x1080': { width: 1920, height: 1080, aspect: '16 / 9', family: '16:9' },
  '2560x1440': { width: 2560, height: 1440, aspect: '16 / 9', family: '16:9' },
  '1280x800': { width: 1280, height: 800, aspect: '16 / 10', family: '16:10' },
  '1440x900': { width: 1440, height: 900, aspect: '16 / 10', family: '16:10' },
  '1680x1050': { width: 1680, height: 1050, aspect: '16 / 10', family: '16:10' },
  '1728x1080': { width: 1728, height: 1080, aspect: '16 / 10', family: '16:10' },
};
const TEST_TYPES = [
  { id: 'flick', name: '小目标定位', description: '快速击中出现的小目标', goal: 10 },
  { id: 'tracking', name: '移动目标跟枪', description: '保持准星贴住移动目标', goal: 8 },
  { id: 'reaction', name: '反应点击', description: '目标出现后尽快点击', goal: 10 },
];

export function isPositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0.1;
}

export function buildCandidates(baseSensitivity) {
  const base = Number(baseSensitivity);
  return [-0.24, -0.12, 0, 0.12, 0.24].map((offset) => Number((base * (1 + offset)).toFixed(2)));
}

export function getResolutionProfile(resolution) {
  return RESOLUTION_PROFILES[resolution] ?? null;
}

export function getGameFrame(profile, viewportWidth, viewportHeight, displayMode) {
  if (displayMode === 'stretch') {
    return { scaleX: viewportWidth / profile.width, scaleY: viewportHeight / profile.height, offsetX: 0, offsetY: 0 };
  }
  const scale = Math.min(viewportWidth / profile.width, viewportHeight / profile.height);
  return {
    scaleX: scale,
    scaleY: scale,
    offsetX: (viewportWidth - profile.width * scale) / 2,
    offsetY: (viewportHeight - profile.height * scale) / 2,
  };
}

export function applyMouseDelta(cursor, movementX, movementY, scale) {
  if (Math.abs(movementX) > MAX_RAW_POINTER_DELTA || Math.abs(movementY) > MAX_RAW_POINTER_DELTA) {
    return { ...cursor };
  }
  return {
    x: Math.max(2, Math.min(98, cursor.x + movementX * 0.08 * scale)),
    y: Math.max(2, Math.min(98, cursor.y + movementY * 0.1 * scale)),
  };
}

function normalize(value, min, max, invert = false) {
  if (max === min) return 1;
  const result = Math.max(0, Math.min(1, (value - min) / (max - min)));
  return invert ? 1 - result : result;
}

export function calculateRecommendation(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const speeds = rows.map((row) => row.elapsedMs / Math.max(row.hits, 1));
  const deviations = rows.map((row) => row.deviation);
  const stabilities = rows.map((row) => row.stability);
  const minSpeed = Math.min(...speeds);
  const maxSpeed = Math.max(...speeds);
  const minDeviation = Math.min(...deviations);
  const maxDeviation = Math.max(...deviations);
  const minStability = Math.min(...stabilities);
  const maxStability = Math.max(...stabilities);

  const scored = rows.map((row, index) => {
    const accuracy = Math.min(1, row.hits / Math.max(row.shots, 1));
    const speed = normalize(speeds[index], minSpeed, maxSpeed, true);
    const precision = normalize(row.deviation, minDeviation, maxDeviation, true);
    const consistency = normalize(row.stability, minStability, maxStability, true);
    const score = (accuracy * 45) + (speed * 20) + (precision * 20) + (consistency * 15);
    return { ...row, accuracy, score: Number(score.toFixed(1)) };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  const runnerUp = scored[1] ?? best;
  const spread = best.score - runnerUp.score;
  const sensitivityOrder = scored.map((row) => row.sensitivity).sort((a, b) => a - b);
  const bestIndex = sensitivityOrder.indexOf(best.sensitivity);
  const lower = sensitivityOrder[Math.max(0, bestIndex - 1)];
  const upper = sensitivityOrder[Math.min(sensitivityOrder.length - 1, bestIndex + 1)];
  return {
    scored,
    recommendedSensitivity: best.sensitivity,
    range: [lower, upper],
    confidence: spread >= 8 ? 'high' : spread >= 3 ? 'medium' : 'low',
  };
}

export function sanitizeHistory(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item.id === 'string' && typeof item.createdAt === 'string'
      && isPositiveNumber(item.recommendedSensitivity) && Number.isFinite(item.score))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .slice(-10);
}

export function shouldAcceptShot(type, hasVisibleTarget) {
  if (type === 'tracking') return false;
  return type !== 'reaction' || hasVisibleTarget;
}

const state = {
  baseSensitivity: 0,
  dpi: '',
  resolution: null,
  displayMode: 'letterbox',
  candidates: [],
  schedule: [],
  index: 0,
  results: new Map(),
  pointerLocked: false,
  paused: false,
  round: null,
  cursor: { x: 50, y: 50 },
  animationId: 0,
  lockTimer: 0,
  ignoreNextMouseEvent: true,
};

const elements = {};

function getHistory() {
  try {
    return sanitizeHistory(JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'));
  } catch {
    return [];
  }
}

function setScreen(name) {
  document.querySelectorAll('[data-screen]').forEach((screen) => {
    screen.hidden = screen.dataset.screen !== name;
  });
}

function updateGameFrame() {
  if (!state.resolution) return;
  const frame = getGameFrame(state.resolution, window.innerWidth, window.innerHeight, state.displayMode);
  elements.arena.style.setProperty('--game-width', `${state.resolution.width}px`);
  elements.arena.style.setProperty('--game-height', `${state.resolution.height}px`);
  elements.arena.style.setProperty('--game-scale-x', String(frame.scaleX));
  elements.arena.style.setProperty('--game-scale-y', String(frame.scaleY));
}

function requestPointerLock() {
  Promise.resolve(elements.arena.requestPointerLock()).catch(() => {});
  window.clearTimeout(state.lockTimer);
  state.lockTimer = window.setTimeout(() => {
    if (!state.pointerLocked && !state.round) showPause('浏览器没有授予鼠标锁定。请点击继续并允许当前页面捕获鼠标。');
  }, 500);
}

function applyGameEnvironment() {
  document.documentElement.classList.add('game-mode');
  updateGameFrame();
  const fullscreen = document.documentElement.requestFullscreen?.();
  Promise.resolve(fullscreen).then(() => {
    updateGameFrame();
    requestPointerLock();
  }).catch(() => {
    displayToast('浏览器未进入全屏；可按 F11 后重新开始测试。', true);
    requestPointerLock();
  });
}

function shuffle(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[randomIndex]] = [copy[randomIndex], copy[index]];
  }
  return copy;
}

function displayToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.dataset.error = String(isError);
  elements.toast.hidden = false;
  window.clearTimeout(displayToast.timeout);
  displayToast.timeout = window.setTimeout(() => { elements.toast.hidden = true; }, 4000);
}

function screenPosition(point) {
  return {
    x: point.x / 100 * elements.arena.clientWidth,
    y: point.y / 100 * elements.arena.clientHeight,
  };
}

function setCursor() {
  elements.crosshair.style.left = `${state.cursor.x}%`;
  elements.crosshair.style.top = `${state.cursor.y}%`;
}

function updateProgress() {
  const total = state.schedule.length;
  const current = Math.min(state.index + 1, total);
  elements.progress.textContent = `进度 ${current} / ${total}`;
  elements.progressBar.style.width = `${Math.min(100, state.index / total * 100)}%`;
}

function showPause(message) {
  state.paused = true;
  cancelAnimationFrame(state.animationId);
  if (state.round) {
    window.clearTimeout(state.round.reactionTimer);
    state.round.restartRequired = true;
  }
  elements.pauseMessage.textContent = message;
  elements.pauseOverlay.hidden = false;
}

function hidePause() {
  state.paused = false;
  elements.pauseOverlay.hidden = true;
}

function registerShot(hit, distance = 1) {
  const round = state.round;
  round.shots += 1;
  round.deviationTotal += distance;
  if (hit) round.hits += 1;
  elements.statHits.textContent = `${round.hits} / ${round.goal}`;
  const completed = round.type.id !== 'tracking' && round.hits >= round.goal;
  if (completed) finishRound();
  return completed;
}

function createTarget({ x, y, size = 5, moving = false }) {
  elements.target.hidden = false;
  elements.target.style.width = `${size}%`;
  elements.target.style.height = `${size}%`;
  elements.target.style.left = `${x}%`;
  elements.target.style.top = `${y}%`;
  state.round.target = { x, y, size, moving, startedAt: performance.now(), vx: moving ? (Math.random() > 0.5 ? 16 : -16) : 0, vy: moving ? (Math.random() > 0.5 ? 11 : -11) : 0 };
}

function hideTarget() {
  elements.target.hidden = true;
  if (state.round) state.round.target = null;
}

function distanceToTarget() {
  const target = state.round.target;
  return Math.hypot(state.cursor.x - target.x, state.cursor.y - target.y) / Math.max(target.size, 1);
}

function pointInsideTarget() {
  const target = state.round.target;
  return Math.abs(state.cursor.x - target.x) <= target.size / 2 && Math.abs(state.cursor.y - target.y) <= target.size / 2;
}

function nextStaticTarget() {
  createTarget({ x: 12 + Math.random() * 76, y: 14 + Math.random() * 72, size: 3.6 });
}

function beginReactionTarget() {
  hideTarget();
  const delay = 450 + Math.random() * 1100;
  state.round.reactionTimer = window.setTimeout(() => {
    state.round.reactionStart = performance.now();
    createTarget({ x: 12 + Math.random() * 76, y: 14 + Math.random() * 72, size: 4.3 });
  }, delay);
}

function animateTracking(time) {
  if (state.paused || !state.round || state.round.type.id !== 'tracking') return;
  const last = state.round.lastTick || time;
  const delta = Math.min(50, time - last) / 1000;
  state.round.lastTick = time;
  const target = state.round.target;
  target.x += target.vx * delta;
  target.y += target.vy * delta;
  if (target.x < 7 || target.x > 93) target.vx *= -1;
  if (target.y < 8 || target.y > 92) target.vy *= -1;
  elements.target.style.left = `${target.x}%`;
  elements.target.style.top = `${target.y}%`;
  const distance = distanceToTarget();
  state.round.trackingSamples.push(distance);
  if (pointInsideTarget()) state.round.followMs += delta * 1000;
  if (time - state.round.startedAt >= state.round.durationMs) finishRound();
  else state.animationId = requestAnimationFrame(animateTracking);
}

function onArenaClick(event) {
  event.preventDefault();
  if (!state.pointerLocked || state.paused || !state.round) return;
  const round = state.round;
  if (!shouldAcceptShot(round.type.id, Boolean(round.target))) return;
  const hit = pointInsideTarget();
  if (hit) {
    const elapsed = performance.now() - (round.reactionStart || round.target.startedAt || round.startedAt);
    round.timings.push(elapsed);
  }
  const completed = registerShot(hit, distanceToTarget());
  if (!hit || completed) return;
  if (round.type.id === 'flick') nextStaticTarget();
  if (round.type.id === 'reaction') beginReactionTarget();
}

function beginRound() {
  const scheduled = state.schedule[state.index];
  state.round = {
    sensitivity: scheduled.sensitivity,
    type: scheduled.type,
    startedAt: performance.now(),
    goal: scheduled.type.goal,
    shots: 0,
    hits: 0,
    deviationTotal: 0,
    timings: [],
    trackingSamples: [],
    followMs: 0,
    durationMs: 15000,
    target: null,
  };
  state.cursor = { x: 50, y: 50 };
  setCursor();
  elements.taskName.textContent = scheduled.type.name;
  elements.taskDescription.textContent = scheduled.type.description;
  elements.statHits.textContent = `0 / ${scheduled.type.goal}`;
  elements.statTime.textContent = scheduled.type.id === 'tracking' ? '15.0 秒' : '计时中';
  updateProgress();
  if (scheduled.type.id === 'flick') nextStaticTarget();
  else if (scheduled.type.id === 'reaction') beginReactionTarget();
  else {
    createTarget({ x: 30, y: 38, size: 6, moving: true });
    state.animationId = requestAnimationFrame(animateTracking);
  }
}

function summarizeRound(round) {
  const samples = round.trackingSamples;
  const averageSample = samples.length ? samples.reduce((total, item) => total + item, 0) / samples.length : 0;
  const sampleVariance = samples.length ? samples.reduce((total, item) => total + (item - averageSample) ** 2, 0) / samples.length : 0;
  const elapsedMs = round.type.id === 'tracking'
    ? round.durationMs
    : round.timings.reduce((total, item) => total + item, 0) || performance.now() - round.startedAt;
  return {
    shots: round.type.id === 'tracking' ? 100 : round.shots || 1,
    hits: round.type.id === 'tracking' ? Math.round(round.followMs / round.durationMs * 100) : round.hits,
    elapsedMs,
    deviation: round.type.id === 'tracking' ? averageSample : round.deviationTotal / Math.max(round.shots, 1),
    stability: round.type.id === 'tracking' ? Math.sqrt(sampleVariance) : round.timings.length > 1
      ? Math.sqrt(round.timings.reduce((total, item) => total + (item - elapsedMs / round.timings.length) ** 2, 0) / round.timings.length) / 1000
      : 0.5,
  };
}

function finishRound() {
  cancelAnimationFrame(state.animationId);
  window.clearTimeout(state.round.reactionTimer);
  hideTarget();
  const summary = summarizeRound(state.round);
  const existing = state.results.get(state.round.sensitivity) || { sensitivity: state.round.sensitivity, shots: 0, hits: 0, elapsedMs: 0, deviation: 0, stability: 0, entries: 0 };
  existing.shots += summary.shots;
  existing.hits += summary.hits;
  existing.elapsedMs += summary.elapsedMs;
  existing.deviation += summary.deviation;
  existing.stability += summary.stability;
  existing.entries += 1;
  state.results.set(state.round.sensitivity, existing);
  state.index += 1;
  if (state.index >= state.schedule.length) completeSession();
  else window.setTimeout(beginRound, 450);
}

function completeSession() {
  document.exitPointerLock?.();
  document.exitFullscreen?.();
  document.documentElement.classList.remove('game-mode');
  const rows = [...state.results.values()].map((row) => ({
    ...row,
    deviation: row.deviation / row.entries,
    stability: row.stability / row.entries,
  }));
  const recommendation = calculateRecommendation(rows);
  const session = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    baseSensitivity: state.baseSensitivity,
    dpi: state.dpi || null,
    recommendedSensitivity: recommendation.recommendedSensitivity,
    range: recommendation.range,
    confidence: recommendation.confidence,
    score: recommendation.scored[0].score,
    results: recommendation.scored,
  };
  const history = sanitizeHistory([...getHistory(), session]);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  renderResults(session);
  setScreen('results');
}

function renderResults(session) {
  elements.recommended.textContent = session.recommendedSensitivity.toFixed(2);
  elements.range.textContent = `${session.range[0].toFixed(2)} - ${session.range[1].toFixed(2)}`;
  const confidenceText = { high: '高', medium: '中', low: '低' }[session.confidence];
  elements.confidence.textContent = `${confidenceText}置信度`;
  elements.retest.hidden = session.confidence !== 'low';
  elements.resultsBody.replaceChildren(...session.results.map((row, index) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${index === 0 ? '首选' : `候选 ${index + 1}`}</td><td>${row.sensitivity.toFixed(2)}</td><td>${Math.round(row.accuracy * 100)}%</td><td>${row.score}</td>`;
    return tr;
  }));
  renderHistory();
}

function renderHistory() {
  const history = getHistory();
  if (!history.length) {
    elements.historyList.innerHTML = '<p class="empty-state">完成测试后会显示最近 10 次记录。</p>';
    elements.historyChart.replaceChildren();
    return;
  }
  elements.historyList.innerHTML = history.slice().reverse().map((item) => `<div class="history-row"><span>${new Date(item.createdAt).toLocaleDateString('zh-CN')}</span><strong>${item.recommendedSensitivity.toFixed(2)}</strong><span>${item.score.toFixed(1)} 分</span></div>`).join('');
  const max = Math.max(...history.map((item) => item.recommendedSensitivity));
  const min = Math.min(...history.map((item) => item.recommendedSensitivity));
  const span = Math.max(0.05, max - min);
  elements.historyChart.innerHTML = history.map((item, index) => {
    const height = 28 + ((item.recommendedSensitivity - min) / span) * 62;
    return `<div class="chart-bar" title="${item.recommendedSensitivity.toFixed(2)}" style="height:${height}%"><span>${index + 1}</span></div>`;
  }).join('');
}

function startSession(event) {
  event.preventDefault();
  const sensitivity = elements.sensitivity.value.trim();
  const dpi = elements.dpi.value.trim();
  if (!isPositiveNumber(sensitivity) || (dpi && !isPositiveNumber(dpi))) {
    displayToast('请输入有效的正数灵敏度；DPI 可以留空。', true);
    return;
  }
  state.baseSensitivity = Number(sensitivity);
  state.dpi = dpi;
  state.resolution = getResolutionProfile(elements.resolution.value);
  state.displayMode = elements.displayMode.value;
  state.candidates = buildCandidates(state.baseSensitivity);
  state.schedule = shuffle(state.candidates.flatMap((candidate) => TEST_TYPES.map((type) => ({ sensitivity: candidate, type }))));
  state.index = 0;
  state.results = new Map();
  setScreen('test');
  elements.arena.focus();
  applyGameEnvironment();
}

function handlePointerLockChange() {
  state.pointerLocked = document.pointerLockElement === elements.arena;
  window.clearTimeout(state.lockTimer);
  if (state.pointerLocked) {
    state.ignoreNextMouseEvent = true;
    hidePause();
    if (!state.round || state.round.restartRequired) beginRound();
    return;
  }
  if (state.round && state.index < state.schedule.length) showPause('鼠标未锁定。点击继续回到测试。');
}

function handleMouseMove(event) {
  if (!state.pointerLocked || state.paused || !state.round) return;
  if (state.ignoreNextMouseEvent) {
    state.ignoreNextMouseEvent = false;
    return;
  }
  const scale = state.round.sensitivity / state.baseSensitivity;
  state.cursor = applyMouseDelta(state.cursor, event.movementX, event.movementY, scale);
  setCursor();
}

function exportHistory() {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), history: getHistory() }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'cs2-sensitivity-history.json';
  link.click();
  URL.revokeObjectURL(url);
}

function addVideoSettings() {
  const dpiLabel = document.querySelector('#dpi').closest('label');
  dpiLabel.insertAdjacentHTML('afterend', `<label>CS2 分辨率<select id="resolution"><optgroup label="4:3"><option value="1024x768">1024 x 768</option><option value="1280x960">1280 x 960</option><option value="1440x1080">1440 x 1080</option></optgroup><optgroup label="16:9"><option value="1280x720">1280 x 720</option><option value="1600x900">1600 x 900</option><option value="1920x1080" selected>1920 x 1080</option><option value="2560x1440">2560 x 1440</option></optgroup><optgroup label="16:10"><option value="1280x800">1280 x 800</option><option value="1680x1050">1680 x 1050</option></optgroup></select></label><label>4:3 显示方式<select id="display-mode"><option value="letterbox">保留比例（黑边）</option><option value="stretch">拉伸铺满</option></select></label>`);
  const resolution = document.querySelector('#resolution');
  resolution.insertAdjacentHTML('beforeend', '<optgroup label="5:4"><option value="1280x1024">1280 x 1024</option></optgroup><optgroup label="16:10"><option value="1440x900">1440 x 900</option><option value="1728x1080">1728 x 1080</option></optgroup>');
  document.querySelector('#display-mode').closest('label').firstChild.textContent = '非 16:9 显示方式';
}

function init() {
  addVideoSettings();
  Object.assign(elements, {
    form: document.querySelector('#setup-form'), sensitivity: document.querySelector('#sensitivity'), dpi: document.querySelector('#dpi'), resolution: document.querySelector('#resolution'), displayMode: document.querySelector('#display-mode'),
    toast: document.querySelector('#toast'), arena: document.querySelector('#arena'), crosshair: document.querySelector('#crosshair'), target: document.querySelector('#target'),
    taskName: document.querySelector('#task-name'), taskDescription: document.querySelector('#task-description'), statHits: document.querySelector('#stat-hits'), statTime: document.querySelector('#stat-time'),
    progress: document.querySelector('#progress'), progressBar: document.querySelector('#progress-bar'), pauseOverlay: document.querySelector('#pause-overlay'), pauseMessage: document.querySelector('#pause-message'),
    recommended: document.querySelector('#recommended'), range: document.querySelector('#range'), confidence: document.querySelector('#confidence'), retest: document.querySelector('#retest'),
    resultsBody: document.querySelector('#results-body'), historyList: document.querySelector('#history-list'), historyChart: document.querySelector('#history-chart'),
  });
  elements.form.addEventListener('submit', startSession);
  elements.arena.addEventListener('click', onArenaClick);
  elements.pauseOverlay.addEventListener('click', () => {
    if (state.pointerLocked) {
      hidePause();
      if (state.round?.restartRequired) beginRound();
    } else {
      applyGameEnvironment();
    }
  });
  document.addEventListener('pointerlockchange', handlePointerLockChange);
  document.addEventListener('mousemove', handleMouseMove);
  window.addEventListener('blur', () => { if (state.pointerLocked) document.exitPointerLock(); });
  window.addEventListener('resize', () => { updateGameFrame(); if (state.round && window.innerWidth < 640) showPause('窗口过窄。请增大窗口后继续。'); });
  document.addEventListener('fullscreenchange', updateGameFrame);
  document.querySelector('#restart').addEventListener('click', () => { document.exitFullscreen?.(); document.documentElement.classList.remove('game-mode'); state.round = null; setScreen('setup'); });
  document.querySelector('#export-history').addEventListener('click', exportHistory);
  document.querySelector('#clear-history').addEventListener('click', () => {
    localStorage.removeItem(HISTORY_KEY);
    renderHistory();
    displayToast('本地历史已清除。');
  });
  renderHistory();
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', init);
