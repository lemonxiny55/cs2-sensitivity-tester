import {
  CS2_V_FOV_DEG,
  CS2_YAW_PER_COUNT,
  TEST_TYPES,
  TEST_TYPE_IDS,
  aggregateFlickMetrics,
  aggregateRecommendations,
  analyzeFlickRound,
  applyMouseDelta,
  buildCandidates,
  buildMain,
  buildRetest,
  calculateRecommendation,
  classifyDirectionBias,
  cmPer360,
  computeSegmentScore,
  summarizeRetest,
  frameHygieneIssue,
  frameHygieneStats,
  getFovBounds,
  getGameFrame,
  getResolutionProfile,
  isPositiveNumber,
  MIN_REACTION_MS,
  POINTER_LOCK_FALLBACK_MESSAGE,
  requestRawPointerLock,
  sanitizeHistory,
  shouldAcceptShot,
  nearestTargetIndex,
  stepTrackingProgress,
  stepTrackingTarget,
  targetAngularHalfSizeDeg,
  TRACKING_SPEED_MAX,
  TRACKING_SPEED_MIN,
  TRACKING_SEGMENT_MAX_S,
  TRACKING_SEGMENT_MIN_S,
} from './engine.js';
import { createRange3d } from './scene3d.js';
import { getAudioConfig, loadAudioConfig, playDryFire, playHit, playMiss, playRoundStart, playShot, primeAudio, setAudioConfig } from './audio.js';

const HISTORY_KEY = 'cs2-sensitivity-history-v2';
const PHASE_LABELS = { main: '初测', retest: '复测' };
const CONFIDENCE_TEXT = { high: '高', medium: '中', low: '低' };
// 新旧任务列名：旧历史记录用 flick/reaction，报告按其原始列名展示。
const TYPE_SHORT = { quad: '四目标', tracking: '跟枪', hex: '六目标', single: '单球点击', flick: '定位', reaction: '反应' };
const CLICK_TASK_IDS = ['quad', 'hex', 'single']; // 走点击计分 + 拉枪轨迹分析的任务

// 各任务的球体规格与生成范围。四目标=中距离球群（微调/转火节奏，对齐常见练枪软件）；
// 六目标=更小的球、明显更大的范围；单球点击与六目标同大小、中等范围。
const TASK_SPAWN = {
  quad: { concurrent: 4, size: 2.6, spawn: () => randomSpawnAngles(0.3, 0.3), distance: () => 16 + Math.random() * 6 },
  hex: { concurrent: 6, size: 1.8, spawn: () => randomSpawnAngles(0.4, 0.35), distance: () => 16 + Math.random() * 12 },
  single: { size: 1.8, spawn: () => randomSpawnAngles(0.45, 0.35), distance: () => 16 + Math.random() * 12 },
};
const TRACKING_SIZE_MIN = 2.4; // 跟枪球随机大小区间（% 视场宽）
const TRACKING_SIZE_MAX = 4.0;

// 鼠标原始输入状态：首次请求锁定时检测一次，整个页面生命周期复用结论。
const RAW_INPUT_STATUS = {
  pending: { className: 'raw-badge pending', text: '待检测 · 开始测试时自动检测' },
  raw: { className: 'raw-badge ok', text: '已启用 · 已绕过系统指针加速' },
  fallback: { className: 'raw-badge warn', text: '不可用 · 请关闭“提高指针精确度”后重测' },
};

const state = {
  baseSensitivity: 0,
  dpi: '',
  resolution: null,
  displayMode: 'letterbox',
  fovBounds: { hHalfDeg: 45, vHalfDeg: 36.87 },
  hFovDeg: 90,
  candidates: [],
  phase: null, // 'main' | 'retest'（报告页逐轮明细还兼容旧记录的 warmup/stage1/stage2）
  schedule: [],
  index: 0,
  roundResults: [], // 每轮汇总 { sensitivity, typeId, shots, hits, elapsedMs, deviation, stability, flick? }
  pointerLocked: false,
  paused: false,
  awaitingTransition: false,
  nextRoundTimer: 0,
  round: null,
  range3d: null,
  cursor: { xDeg: 0, yDeg: 0 },
  animationId: 0,
  lockTimer: 0,
  ignoreNextMouseEvent: true,
  fpsWatch: { rafId: 0, frames: [], prev: 0, lastEmit: 0 },
  roundKey: '',
  retryCount: 0,
  rawInput: null, // null=未检测 | 'pending' | 'raw' | 'fallback'
  lastSessionId: null, // 刚完成的会话，供“查看完整报告”按钮使用
  reportReturnTo: 'setup', // 报告页返回目标：'setup' | 'results'
  reportSessionId: null, // 报告页当前展示的会话 id，供“删除此记录”使用
  mouseDown: false, // 左键按住状态（跟枪只有按住左键条才递减）
};

const elements = {};

function getHistory() {
  try {
    return sanitizeHistory(JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'));
  } catch {
    return [];
  }
}

function getType(typeId) {
  return TEST_TYPES.find((type) => type.id === typeId);
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

function renderRawInputStatus() {
  if (!elements.rawInputStatus) return;
  const status = RAW_INPUT_STATUS[state.rawInput] || RAW_INPUT_STATUS.pending;
  elements.rawInputStatus.textContent = status.text;
  elements.rawInputStatus.className = status.className;
}

function requestPointerLock() {
  // 原始输入只检测一次：重试/恢复锁定时保留已得出的结论，避免徽章被重置回“待检测”。
  if (!state.rawInput) {
    state.rawInput = 'pending';
    renderRawInputStatus();
  }
  requestRawPointerLock(elements.arena, (reason, kind) => {
    if (kind === 'unsupported') {
      state.rawInput = 'fallback';
      renderRawInputStatus();
    }
    displayToast(reason, true);
  }).then((locked) => {
    if (locked && state.rawInput === 'pending') {
      state.rawInput = 'raw';
      renderRawInputStatus();
    }
  });
  window.clearTimeout(state.lockTimer);
  state.lockTimer = window.setTimeout(() => {
    if (!state.pointerLocked && !state.round) showPause('浏览器没有授予鼠标锁定。请点击继续并允许当前页面捕获鼠标。');
  }, 500);
}

function applyGameEnvironment() {
  document.documentElement.classList.add('game-mode');
  updateGameFrame();
  if (!ensureRange3d()) return;
  state.range3d.start();
  const fullscreen = document.documentElement.requestFullscreen?.();
  Promise.resolve(fullscreen).then(() => {
    updateGameFrame();
    requestPointerLock();
  }).catch(() => {
    displayToast('浏览器未进入全屏；可按 F11 后重新开始测试。', true);
    requestPointerLock();
  });
}

// 3D 靶场按所选虚拟分辨率建一次；换分辨率时仅 resize。WebGL 不可用时放弃进入并提示。
function ensureRange3d() {
  if (state.range3d) {
    state.range3d.resize(state.resolution.width, state.resolution.height);
    return true;
  }
  try {
    state.range3d = createRange3d({
      container: elements.arena,
      width: state.resolution.width,
      height: state.resolution.height,
      vFovDeg: CS2_V_FOV_DEG,
    });
    return true;
  } catch {
    displayToast('WebGL 初始化失败，无法进入 3D 靶场。', true);
    setScreen('setup');
    return false;
  }
}

function displayToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.dataset.error = String(isError);
  elements.toast.hidden = false;
  window.clearTimeout(displayToast.timeout);
  displayToast.timeout = window.setTimeout(() => { elements.toast.hidden = true; }, 4000);
}

// 第一人称视角：准星固定居中，视角角直接驱动相机（真 FPS 的“世界动、准星不动”）。
function setView() {
  state.range3d?.setView(state.cursor.xDeg, state.cursor.yDeg);
}

function startFpsWatch() {
  stopFpsWatch();
  elements.statFps.textContent = '';
  const tick = (time) => {
    const watch = state.fpsWatch;
    if (!state.round || state.paused) {
      watch.rafId = 0;
      watch.prev = 0;
      return;
    }
    if (watch.prev) state.round.frameDeltas.push(Math.min(500, time - watch.prev));
    watch.prev = time;
    watch.frames.push(time);
    while (watch.frames.length > 2 && time - watch.frames[0] > 1000) watch.frames.shift();
    if (time - watch.lastEmit >= 250 && watch.frames.length > 1) {
      watch.lastEmit = time;
      const span = (watch.frames.at(-1) - watch.frames[0]) / 1000;
      const fps = Math.round((watch.frames.length - 1) / span);
      const stats = frameHygieneStats(state.round.frameDeltas);
      elements.statFps.textContent = stats
        ? `${fps} FPS · 1% ${Math.round(stats.onePercentLowFps)}`
        : `${fps} FPS`;
    }
    watch.rafId = requestAnimationFrame(tick);
  };
  state.fpsWatch.rafId = requestAnimationFrame(tick);
}

function stopFpsWatch() {
  if (state.fpsWatch.rafId) cancelAnimationFrame(state.fpsWatch.rafId);
  state.fpsWatch.rafId = 0;
  state.fpsWatch.prev = 0;
  state.fpsWatch.frames.length = 0;
}

function updateProgress() {
  const total = state.schedule.length;
  const current = Math.min(state.index + 1, total);
  const phaseLabel = PHASE_LABELS[state.phase] ?? '';
  elements.progress.textContent = `${phaseLabel} ${current} / ${total}`;
  elements.progressBar.style.width = `${Math.min(100, state.index / total * 100)}%`;
}

function showPause(message) {
  state.paused = true;
  cancelAnimationFrame(state.animationId);
  window.clearTimeout(state.nextRoundTimer); // 暂停期间不启动下一轮，恢复时重开
  if (state.round) {
    window.clearTimeout(state.round.reactionTimer);
    window.clearTimeout(state.round.endTimer);
    window.clearInterval(state.round.clockTimer);
    state.round.restartRequired = true;
  }
  elements.pauseMessage.textContent = message;
  elements.pauseOverlay.hidden = false;
}

function hidePause() {
  state.paused = false;
  elements.pauseOverlay.hidden = true;
}

// 阶段之间的确认浮层：不重置当前轮次，仅等待用户点“继续”进入下一阶段。
// 浮层期间释放指针锁定，让用户能看到真实光标再点击继续。
function showTransition(message) {
  state.paused = true;
  state.awaitingTransition = true;
  cancelAnimationFrame(state.animationId);
  window.clearTimeout(state.nextRoundTimer);
  document.exitPointerLock?.();
  elements.pauseMessage.textContent = message;
  elements.pauseOverlay.hidden = false;
}

// 定时制：轮次没有目标数，命中数实时刷新，时间到由 endTimer 收轮。
function registerShot(hit, distance = 1) {
  const round = state.round;
  round.shots += 1;
  round.deviationTotal += distance;
  if (hit) {
    round.hits += 1;
    round.hitIndex += 1;
  }
  elements.statHits.textContent = String(round.hits);
}

function createTarget({ xDeg, yDeg, size = 5, distanceM, vxDeg = 0, vyDeg = 0, material, withProgressBar = false }) {
  const angularHalfDeg = targetAngularHalfSizeDeg(size, state.hFovDeg);
  const distance = distanceM ?? 13 + Math.random() * 15;
  const handle = state.range3d.spawnTarget({ xDeg, yDeg, distanceM: distance, angularHalfDeg, material, withProgressBar });
  const target = {
    index: state.round.targetCounter,
    xDeg,
    yDeg,
    size,
    angularHalfDeg,
    handle,
    vxDeg,
    vyDeg,
    startedAt: performance.now(),
  };
  state.round.targetCounter += 1;
  state.round.target = target;
  state.round.targets.push(target);
  state.round.logs.targets.push({
    index: target.index,
    spawnT: target.startedAt,
    xDeg,
    yDeg,
    angularHalfDeg: target.angularHalfDeg,
  });
}

function hideTarget() {
  if (state.round?.targets) {
    for (const t of state.round.targets) {
      if (t.handle) state.range3d.removeTarget(t.handle);
    }
    state.round.targets.length = 0;
  }
  if (state.round?.target?.handle) state.range3d.removeTarget(state.round.target.handle);
  if (state.round) state.round.target = null;
}

// 当前场上活着的可射击目标（flick 为剩余目标池，reaction/tracking 为单个目标）。
function liveTargets() {
  const round = state.round;
  if (!round) return [];
  return round.targets.length ? round.targets : (round.target ? [round.target] : []);
}

function distanceToTarget() {
  const list = liveTargets();
  if (!list.length) return 1;
  return Math.min(...list.map((t) => Math.hypot(state.cursor.xDeg - t.xDeg, state.cursor.yDeg - t.yDeg) / Math.max(t.angularHalfDeg, 1e-6)));
}

function findHitTarget() {
  for (const t of liveTargets()) {
    if (t.handle.angleFromViewDeg() <= t.angularHalfDeg) return t;
  }
  return null;
}

// 生成角度：水平按 xFactor 铺开，垂直只取视平线【上方】（yDeg ≤ 0），
// 球永远不会出现在地板附近；需要的大角度横向样本由四目标之外的负责，这里先保证观感自然。
function randomSpawnAngles(xFactor = 0.4, yUpFactor = 0.3) {
  return {
    xDeg: (Math.random() * 2 - 1) * state.fovBounds.hHalfDeg * xFactor,
    yDeg: -Math.random() * state.fovBounds.vHalfDeg * yUpFactor,
  };
}

// 点击类任务统一生成一颗球：大小/范围/距离由各任务规格决定。
// 候选位置须与场上现有球、准星当前位置都保持最小间距（1.5 倍球径，约 6°）：
// 太近会两球重叠，贴着准星刷则是白给连杀。抽 12 个候选取第一个达标的，
// 全都不达标时退回“离避让点最远”的一个兜底；达标即用（而非取最远）让分布更接近均匀随机，
// 避免球群总被推到生成区边缘。
function spawnClickTarget(typeId) {
  const config = TASK_SPAWN[typeId];
  const ballHalfDeg = targetAngularHalfSizeDeg(config.size, state.hFovDeg);
  const minSeparation = ballHalfDeg * 3; // 球心距 ≥ 1.5 倍球径
  const avoid = [
    ...liveTargets().map((target) => ({ xDeg: target.xDeg, yDeg: target.yDeg })),
    { xDeg: state.cursor.xDeg, yDeg: state.cursor.yDeg },
  ];
  let best = config.spawn();
  let bestNearest = -1;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const angles = config.spawn();
    const nearest = avoid.reduce(
      (min, point) => Math.min(min, Math.hypot(angles.xDeg - point.xDeg, angles.yDeg - point.yDeg)),
      Infinity,
    );
    if (nearest >= minSeparation) {
      createTarget({ ...angles, size: config.size, distanceM: config.distance() });
      return;
    }
    if (nearest > bestNearest) {
      bestNearest = nearest;
      best = angles;
    }
  }
  createTarget({ ...best, size: config.size, distanceM: config.distance() });
}

// 单球点击：小球延迟随机出现（兼任反应测量），空枪期点击按抢跑处理。
function beginSingleTarget() {
  hideTarget();
  const delay = 350 + Math.random() * 700;
  state.round.reactionTimer = window.setTimeout(() => {
    if (state.paused) {
      beginSingleTarget(); // 暂停期间目标不出现，恢复后再试
      return;
    }
    state.round.reactionStart = performance.now();
    spawnClickTarget('single');
  }, delay);
}

function startTracking() {
  const round = state.round;
  const spawn = randomSpawnAngles(0.45);
  round.trackingState = {
    xDeg: spawn.xDeg,
    yDeg: spawn.yDeg,
    dirDeg: Math.random() > 0.5 ? 1 : -1,
    speed: TRACKING_SPEED_MIN + Math.random() * (TRACKING_SPEED_MAX - TRACKING_SPEED_MIN),
    segmentLeftS: TRACKING_SEGMENT_MIN_S + Math.random() * (TRACKING_SEGMENT_MAX_S - TRACKING_SEGMENT_MIN_S),
    pauseLeftS: 0,
    swayPhase: Math.random() * Math.PI * 2,
  };
  round.trackingProgress = 1; // 满条开始，贴住递减
  createTarget({
    xDeg: spawn.xDeg,
    yDeg: spawn.yDeg,
    size: trackingTargetSize(),
    distanceM: 16 + Math.random() * 8,
    material: 'tracking',
    withProgressBar: true,
  });
  state.round.target.handle.setProgress(1);
  state.animationId = requestAnimationFrame(animateTracking);
}

// 跟枪球大小在小区间内随机（有小的也有大的），每球独立抽取。
function trackingTargetSize() {
  return TRACKING_SIZE_MIN + Math.random() * (TRACKING_SIZE_MAX - TRACKING_SIZE_MIN);
}

function animateTracking(time) {
  if (state.paused || !state.round || state.round.type.id !== 'tracking') return;
  const round = state.round;
  const last = round.lastTick || time;
  const delta = Math.min(50, time - last) / 1000;
  round.lastTick = time;
  const target = round.target;
  if (!target) return;
  const step = stepTrackingTarget(round.trackingState, delta, state.fovBounds);
  round.trackingState = step.state;
  target.xDeg = step.moved.xDeg;
  target.yDeg = step.moved.yDeg;
  target.handle.setAngles(target.xDeg, target.yDeg);
  const onTarget = Boolean(findHitTarget());
  round.trackingSamples.push(distanceToTarget());
  // 满条开始、贴住递减、脱靶暂停；且必须按住左键才有效（松开=条暂停）。
  // 轨迹样本照常记录（不按住也在瞄准，偏离幅度仍应反映真实表现）。
  const effective = onTarget && state.mouseDown;
  if (effective) round.followMs += delta * 1000;
  round.trackingProgress = stepTrackingProgress(round.trackingProgress, delta, effective);
  target.handle.setProgress(round.trackingProgress);
  if (round.trackingProgress <= 0) {
    round.hits += 1;
    round.shots += 1;
    round.deviationTotal += 0;
    elements.statHits.textContent = String(round.hits);
    playHit();
    target.handle.killAtView();
    state.range3d.removeTarget(target.handle);
    state.range3d.spawnImpact('hit', target.xDeg, target.yDeg, target.distanceM, Math.max(target.angularHalfDeg * 0.05 * target.distanceM, 0.4));
    round.target = null;
    state.animationId = 0;
    round.trackingProgress = 1;
    setTimeoutSpawnNextTrackingTarget(round);
  } else {
    state.animationId = requestAnimationFrame(animateTracking);
  }
}

// 换球间隙：250ms 空窗让击杀动画播完，也避免下一球与旧球位置重叠导致瞬间贴满。
function setTimeoutSpawnNextTrackingTarget(round) {
  window.setTimeout(() => {
    if (state.round !== round || state.paused) return;
    const spawn = randomSpawnAngles(0.45);
    round.trackingState.xDeg = spawn.xDeg;
    round.trackingState.yDeg = spawn.yDeg;
    round.trackingState.pauseLeftS = 0;
    createTarget({
      xDeg: spawn.xDeg,
      yDeg: spawn.yDeg,
      size: trackingTargetSize(),
      distanceM: 16 + Math.random() * 8,
      material: 'tracking',
      withProgressBar: true,
    });
    round.target.handle.setProgress(1);
    if (!state.animationId) state.animationId = requestAnimationFrame(animateTracking);
  }, 250);
}

function onArenaClick(event) {
  event.preventDefault();
  if (!state.pointerLocked || state.paused || !state.round) return;
  const round = state.round;
  const hasTarget = round.targets.length > 0 || Boolean(round.target);
  if (!shouldAcceptShot(round.type.id, hasTarget)) return;
  if (!hasTarget) return;
  if (round.type.id === 'single' && performance.now() - round.reactionStart < MIN_REACTION_MS) {
    round.earlyClicks += 1;
    playDryFire();
    return;
  }
  const hitTarget = findHitTarget();
  const hit = Boolean(hitTarget);
  playShot();
  if (hit) {
    playHit();
    hitTarget.handle.killAtView();
    state.range3d.spawnImpact('hit', hitTarget.xDeg, hitTarget.yDeg, hitTarget.distanceM, Math.max(hitTarget.angularHalfDeg * 0.05 * hitTarget.distanceM, 0.4));
  } else {
    playMiss();
    // 空枪特效沿准星方向落在 12m 处(视野中前方,尺寸按角尺寸放大到该距离)。
    state.range3d.spawnImpact('miss', state.cursor.xDeg, state.cursor.yDeg, 12, Math.max(targetAngularHalfSizeDeg(3, state.hFovDeg) * 0.05 * 12, 0.4));
  }
  round.logs.clicks.push({
    t: performance.now(),
    xDeg: state.cursor.xDeg,
    yDeg: state.cursor.yDeg,
    hit,
    // 空枪必须归因到角度最近的目标：分析层靠 targetIndex 找“该目标的第一枪”，
    // 记成 -1 会让首发命中率/微调幅度/微调准确永远只统计到命中枪。
    targetIndex: hitTarget ? hitTarget.index : nearestTargetIndex(state.cursor, liveTargets()),
  });
  if (hit) {
    const elapsed = performance.now() - (round.reactionStart || hitTarget.startedAt || round.startedAt);
    round.timings.push(elapsed);
  }
  registerShot(hit, distanceToTarget());
  if (hit && (round.type.id === 'quad' || round.type.id === 'hex')) {
    // 四目标/六目标：场上恒定 N 颗，命中一颗移除一颗、立即补一颗（等大）。
    const idx = round.targets.indexOf(hitTarget);
    if (idx >= 0) round.targets.splice(idx, 1);
    state.range3d.removeTarget(hitTarget.handle);
  }
  if (!hit) return;
  if (round.type.id === 'single') beginSingleTarget();
  if (round.type.id === 'quad' || round.type.id === 'hex') spawnClickTarget(round.type.id);
}

function beginRound() {
  // 清场：正常收轮由 finishRound 调 hideTarget，但 ESC 暂停后重开本轮走不到那条路，
  // 旧 round 的目标若不在此处移除，会以“幽灵球”形式永远留在场景里（不动也不消失）。
  hideTarget();
  const scheduled = state.schedule[state.index];
  const type = getType(scheduled.typeId);
  const roundKey = `${state.phase}:${state.index}`;
  if (state.roundKey !== roundKey) {
    state.roundKey = roundKey;
    state.retryCount = 0;
  }
  state.round = {
    sensitivity: scheduled.sensitivity,
    type,
    quick: scheduled.quick,
    warmup: scheduled.warmup,
    durationMs: scheduled.durationMs || 0,
    startedAt: performance.now(),
    shots: 0,
    hits: 0,
    hitIndex: 0,
    deviationTotal: 0,
    timings: [],
    trackingSamples: [],
    followMs: 0,
    target: null,
    targets: [],
    targetCounter: 0,
    earlyClicks: 0,
    frameDeltas: [],
    logs: { samples: [], targets: [], clicks: [] },
    reactionTimer: 0,
    endTimer: 0,
    clockTimer: 0,
    finishAt: 0,
  };
  setView();
  // 降级锁定（未绕过系统指针加速）时如实标注，提醒本轮标定可信度有限。
  const rawLabel = state.rawInput === 'fallback' ? 'OS CURVE' : 'RAW INPUT';
  elements.calibrationBar.textContent = `CALIBRATION: ${CS2_YAW_PER_COUNT}°/COUNT · H-FOV ${state.hFovDeg.toFixed(1)}° · V-FOV ${CS2_V_FOV_DEG.toFixed(1)}° · ${rawLabel}`;
  const stageMark = scheduled.quick ? '筛选' : '';
  elements.taskName.textContent = scheduled.warmup ? '暖手轮' : `${type.name}${stageMark ? ` · ${stageMark}` : ''}`;
  elements.taskDescription.textContent = scheduled.warmup ? '不计分，先活动一下手感' : type.description;
  elements.statHits.textContent = '0';
  elements.statTime.textContent = `${((scheduled.durationMs || 0) / 1000).toFixed(1)}s`;
  updateProgress();
  startFpsWatch();
  playRoundStart();
  if (type.id === 'quad' || type.id === 'hex') {
    // 多球任务：开局铺满并发数（四目标恒定 4 颗 / 六目标 6 颗），命中一颗补一颗；
    // 并发数与轮次时长解耦——场上始终保持 N 颗供玩家自由选择目标。
    const concurrent = TASK_SPAWN[type.id].concurrent;
    for (let i = 0; i < concurrent; i += 1) spawnClickTarget(type.id);
  } else if (type.id === 'single') beginSingleTarget();
  else startTracking();
  if (scheduled.durationMs) {
    // 定时收轮：时间到正常 finishRound（不是超时惩罚）；暂停时计时器被 showPause 清掉，恢复后重开本轮。
    state.round.endTimer = window.setTimeout(() => {
      if (state.paused) return;
      finishRound();
    }, scheduled.durationMs);
    state.round.clockTimer = window.setInterval(() => {
      const active = state.round;
      if (!active || !active.durationMs) return;
      const leftMs = Math.max(0, active.durationMs - (performance.now() - active.startedAt));
      elements.statTime.textContent = `${(leftMs / 1000).toFixed(1)}s`;
    }, 100);
  }
}

function summarizeRound(round) {
  if (round.type.id === 'tracking') {
    const samples = round.trackingSamples;
    const averageSample = samples.length ? samples.reduce((total, item) => total + item, 0) / samples.length : 0;
    const sampleVariance = samples.length ? samples.reduce((total, item) => total + (item - averageSample) ** 2, 0) / samples.length : 0;
    return {
      shots: Math.max(round.hits, 1), // 跟枪无命中率概念：shots 记成 hits 使 accuracy 恒为 1，记分环节跳过该维度
      hits: round.hits,
      elapsedMs: Math.max(round.finishAt - round.startedAt, 1),
      deviation: averageSample,
      stability: Math.sqrt(sampleVariance),
    };
  }
  const elapsedMs = Math.max(round.finishAt - round.startedAt, 1);
  const summary = {
    shots: round.shots || 1,
    hits: round.hits,
    elapsedMs,
    deviation: round.deviationTotal / Math.max(round.shots, 1),
    stability: round.timings.length > 1
      ? Math.sqrt(round.timings.reduce((total, item) => total + (item - round.timings.reduce((a, b) => a + b, 0) / round.timings.length) ** 2, 0) / round.timings.length) / 1000
      : 0.5,
  };
  if (CLICK_TASK_IDS.includes(round.type.id)) summary.flick = analyzeFlickRound(round.logs);
  return summary;
}

// 档位块切换浮层文案：汇总本阶段该档位四项任务的成绩（初测 5 档 / 复测 2 档，每档一块）。
// 绝对分可分解：点击类展示 杀数 → 基础分 × √命中 × 停点系数；跟枪展示 球数 × 贴迹系数。
function blockSummaryText(sensitivity, phase) {
  const rows = state.roundResults.filter((row) => row.phase === phase && row.sensitivity === sensitivity);
  const parts = TEST_TYPE_IDS.map((typeId) => {
    const row = rows.find((item) => item.typeId === typeId);
    if (!row) return null;
    const name = getType(typeId)?.name ?? typeId;
    const { score, base, hitCoef, stopCoef } = computeSegmentScore(row);
    if (typeId === 'tracking') return `${name} ${row.hits} 球 → ${Math.round(score)} 分（${base} × 贴迹 ${stopCoef}）`;
    const accuracy = row.shots ? Math.round((row.hits / row.shots) * 100) : 0;
    return `${name} ${row.hits} 杀 → ${Math.round(score)} 分（${base} × √命中 ${hitCoef} × 停点 ${stopCoef}）`;
  }).filter(Boolean);
  const phaseLabel = phase === 'retest' ? '复测' : '初测';
  return `${phaseLabel} · 灵敏度 ${sensitivity.toFixed(2)} 四项完成：${parts.join('；')}。点击继续测下一档。`;
}

function finishRound() {
  if (!state.round) return;
  cancelAnimationFrame(state.animationId);
  stopFpsWatch();
  window.clearTimeout(state.round.reactionTimer);
  window.clearTimeout(state.round.endTimer);
  window.clearInterval(state.round.clockTimer);
  hideTarget();
  const round = state.round;
  round.finishAt = performance.now();
  const hygiene = frameHygieneIssue(frameHygieneStats(round.frameDeltas));
  if (hygiene && !round.warmup && state.retryCount < 1) {
    // 均值 / 最大单帧 / 1% low 任一不达标的数据都不可信：不记录、不推进，直接重测同一轮（每轮最多重测一次防死循环）。
    state.retryCount += 1;
    displayToast(`检测到帧率异常（${hygiene}），本轮将重测以保证数据可靠。`);
    state.round = null;
    state.nextRoundTimer = window.setTimeout(beginRound, 800);
    return;
  }
  if (!round.warmup) {
    state.roundResults.push({ phase: state.phase, sensitivity: round.sensitivity, typeId: round.type.id, ...summarizeRound(round) });
  }
  state.index += 1;
  const blockEnded = state.index < state.schedule.length
    && state.schedule[state.index].sensitivity !== round.sensitivity;
  if (state.index < state.schedule.length) {
    if (blockEnded) {
      // 每档连测四项制：灵敏度切换处弹本档成绩，档内任务切换仍走 450ms 快速衔接。
      showTransition(blockSummaryText(round.sensitivity, state.phase));
      return;
    }
    state.nextRoundTimer = window.setTimeout(beginRound, 450);
  } else {
    advancePhase();
  }
}

function advancePhase() {
  if (state.phase === 'main') {
    // 条件复测：初测自检通过（分差明显、峰值在区间内部、环节结论一致）直接出结果；
    // 任一不过才让前二名加测一轮做仲裁。
    const recommendation = calculateRecommendation(state.roundResults);
    const scored = recommendation?.scored ?? [];
    const finalists = scored.slice(0, 2).map((row) => row.sensitivity);
    if (finalists.length < 2) {
      completeSession();
      return;
    }
    if (recommendation.stable) {
      state.retestSkipped = true;
      completeSession();
      return;
    }
    const reasons = [];
    if (recommendation.spreadPct < 0.05) reasons.push('两档分差较近');
    if (recommendation.agreementCount < 3) reasons.push('各环节指向不一致');
    if (!recommendation.interior) reasons.push('最优区间贴近档位边缘');
    state.phase = 'retest';
    state.schedule = buildRetest(finalists);
    state.index = 0;
    const format = (value) => value.toFixed(2);
    showTransition(`初测完成，前二名：${format(finalists[0])}、${format(finalists[1])}。\n${reasons.join('、') || '数据区分度不足'}，加测四项任务一轮（约 3 分钟）确认。`);
    return;
  }
  if (state.phase === 'retest') {
    completeSession();
    return;
  }
  completeSession();
}

function completeSession() {
  document.exitPointerLock?.();
  document.exitFullscreen?.();
  state.range3d?.stop();
  document.documentElement.classList.remove('game-mode');
  const recommendation = calculateRecommendation(state.roundResults);
  if (!recommendation) {
    setScreen('setup');
    return;
  }
  const retestSummary = summarizeRetest(state.roundResults, recommendation);
  let confidence = recommendation.confidence;
  let significant = recommendation.significant;
  if (retestSummary && !retestSummary.agreed) {
    // 复测推翻初测排名：结论不可复现，置信度降一级并按“差异不显著”处理。
    confidence = { high: 'medium', medium: 'low', low: 'low' }[confidence];
    significant = false;
  }
  const session = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    baseSensitivity: state.baseSensitivity,
    dpi: state.dpi || null,
    recommendedSensitivity: recommendation.recommendedSensitivity,
    fittedPeak: recommendation.fitPeak,
    range: recommendation.range,
    confidence,
    significant,
    score: recommendation.scored[0].score,
    results: recommendation.scored,
    perType: recommendation.perType,
    bestPerType: recommendation.bestPerType,
    flickMetrics: aggregateFlickMetrics(state.roundResults),
    calibration: { yawPerCount: CS2_YAW_PER_COUNT, hFovDeg: Number(state.hFovDeg.toFixed(2)), vFovDeg: Number(CS2_V_FOV_DEG.toFixed(2)), rawInput: state.rawInput },
    retest: retestSummary,
    retestSkipped: state.retestSkipped === true,
    rounds: state.roundResults,
    version: 4,
  };
  const history = sanitizeHistory([...getHistory(), session]);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  state.lastSessionId = session.id;
  renderResults(session);
  setScreen('results');
}

function renderResults(session) {
  elements.recommended.textContent = session.recommendedSensitivity.toFixed(2);
  elements.range.textContent = `${session.range[0].toFixed(2)} - ${session.range[1].toFixed(2)}`;
  const confidenceText = { high: '高', medium: '中', low: '低' }[session.confidence];
  elements.confidence.textContent = `${confidenceText}置信度`;
  elements.retest.hidden = session.significant;
  elements.fitNote.textContent = '';
  if (session.fitPeak != null && session.results[0] && Math.abs(session.fitPeak - session.results[0].sensitivity) > 0.005) {
    elements.fitNote.textContent = `得分曲线拟合峰值在 ${session.fitPeak.toFixed(2)} 附近，与实测最高档 ${session.results[0].sensitivity.toFixed(2)} 略有出入；正式推荐取实测档位，建议区间已按拟合峰值给出。`;
  }
  if (session.dpi && Number(session.dpi) > 0) {
    const baseCm = cmPer360(session.baseSensitivity, session.dpi);
    const recommendedCm = cmPer360(session.recommendedSensitivity, session.dpi);
    if (baseCm != null && recommendedCm != null) {
      elements.cm360.textContent = `基准 ${session.baseSensitivity.toFixed(2)} ≈ ${baseCm.toFixed(1)} cm/360° → 推荐 ${session.recommendedSensitivity.toFixed(2)} ≈ ${recommendedCm.toFixed(1)} cm/360°`;
    }
  } else {
    elements.cm360.textContent = '';
  }

  const deepSet = new Set(session.results.map((row) => row.sensitivity));
  const order = [
    ...session.results.map((row) => row.sensitivity),
    ...state.candidates.filter((sensitivity) => !deepSet.has(sensitivity)),
  ];

  renderHeadRow(elements.resultsHeadRow, sessionColumns(session));
  elements.resultsBody.replaceChildren(...buildCandidateRows(session, order));
  renderFlickAnalysis(session, order);
  renderPerTypeNote(session);
  renderRetestNote(session);
  renderHistory();
}

// 列 = 会话里实际出现过的任务类型：新记录为四类；旧记录（flick/reaction）按原始三类展示。
function sessionColumns(session) {
  const present = new Set(Object.keys(session.perType ?? {}));
  const canonical = ['quad', 'tracking', 'hex', 'single'].filter((id) => present.has(id));
  if (canonical.length) return canonical;
  return ['flick', 'tracking', 'reaction'].filter((id) => present.has(id));
}

function renderHeadRow(row, columns) {
  const cells = ['灵敏度', ...columns.map((id) => TYPE_SHORT[id] ?? id), '综合分'];
  row.replaceChildren(...cells.map((text) => {
    const th = document.createElement('th');
    th.textContent = text;
    return th;
  }));
}

// 候选对比表构建（结果页与报告页共用）。列 = 各任务单独排序 + 阶段 2 综合分，列内最优高亮。
function buildCandidateRows(session, order) {
  const columns = sessionColumns(session);
  const columnMax = {};
  const perTypeScore = {};
  for (const typeId of columns) {
    const ranked = (session.perType && session.perType[typeId]) || [];
    perTypeScore[typeId] = {};
    for (const row of ranked) perTypeScore[typeId][row.sensitivity] = row.score;
    columnMax[typeId] = ranked[0] ? ranked[0].score : null;
  }
  // 综合分只来自阶段 2 深度测试（session.results）；被淘汰档位不参与综合判定。
  const combinedScore = {};
  for (const row of session.results) combinedScore[row.sensitivity] = row.score;
  const combinedMax = session.results[0] ? session.results[0].score : null;
  return order.map((sensitivity) => {
    const tr = document.createElement('tr');
    const cells = [sensitivity.toFixed(2), ...columns.map((typeId) => {
      const value = perTypeScore[typeId][sensitivity];
      return value == null ? '—' : value.toFixed(1);
    }), combinedScore[sensitivity] != null ? combinedScore[sensitivity].toFixed(1) : '—'];
    cells.forEach((text, columnIndex) => {
      const td = document.createElement('td');
      td.textContent = text;
      const isMax = ((columnIndex >= 1 && columnIndex <= columns.length) && columnMax[columns[columnIndex - 1]] != null && Number(text) === columnMax[columns[columnIndex - 1]])
        || (columnIndex === columns.length + 1 && Number(text) === combinedMax);
      if (isMax) td.className = 'highlight';
      tr.appendChild(td);
    });
    return tr;
  });
}

// 分任务偏好解读：各任务最优档相互印证时增强可信度；相差一档以上时给出方向冲突提示。
function renderPerTypeNote(session) {
  const el = elements.perTypeNote;
  if (!el) return;
  const labels = { flick: '定位', tracking: '跟枪', reaction: '反应' };
  const entries = ['flick', 'tracking', 'reaction']
    .filter((typeId) => session.bestPerType?.[typeId])
    .map((typeId) => ({ label: labels[typeId], sens: session.bestPerType[typeId].sensitivity }));
  const sorted = [...state.candidates].sort((a, b) => a - b);
  const spacing = sorted.length > 1 ? (sorted[sorted.length - 1] - sorted[0]) / (sorted.length - 1) : 0;
  if (entries.length < 2 || !spacing) {
    el.hidden = true;
    return;
  }
  const sens = entries.map((entry) => entry.sens);
  const min = Math.min(...sens);
  const max = Math.max(...sens);
  el.hidden = false;
  if (max - min >= spacing - 1e-9) {
    const bySens = [...entries].sort((a, b) => a.sens - b.sens);
    const low = bySens[0];
    const high = bySens[bySens.length - 1];
    el.textContent = `分任务解读：${entries.map((entry) => `${entry.label}最优 ${entry.sens.toFixed(2)}`).join('、')}——各任务最优档相差超过一档，${low.label}偏好更低、${high.label}偏好更高灵敏度。两类需求相反时建议取中间值；首发命中通常对灵敏度最敏感，可优先参考定位列。`;
  } else {
    el.textContent = `分任务解读：三类任务的最优档都落在 ${min.toFixed(2)} ~ ${max.toFixed(2)}（相差不足一档），定位、跟枪、反应相互印证，综合建议可信度较高。`;
  }
}

// 复测结论行：初测与复测排名一致时给出确认，不一致时明确警告（置信度已在 completeSession 降级）。
function renderRetestNote(session) {
  const el = elements.retestNote;
  if (!el) return;
  if (session.retestSkipped && !session.retest) {
    el.hidden = false;
    el.className = 'per-type-note';
    el.textContent = '初测结论自洽（分差明显、各环节指向一致），未触发复测，直接给出结果。';
    return;
  }
  if (!session.retest) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const initialTop = session.retest.initialOrder[0];
  const retestTop = session.retest.candidates[0];
  if (session.retest.agreed) {
    el.className = 'per-type-note';
    el.textContent = `复测确认：前二名 ${initialTop.toFixed(2)}、${session.retest.initialOrder[1].toFixed(2)} 的初测排名在复测中复现（复测分差 ${session.retest.gap.toFixed(1)}）。`;
  } else {
    el.className = 'caution';
    el.textContent = `复测预警：初测 #1（${initialTop.toFixed(2)}）在复测中回落到 #2（复测 #1 为 ${retestTop.toFixed(2)}），两档难分高下，本次置信度已下调，建议休息后重测。`;
  }
}

// 拉枪分析表构建（结果页与报告页共用）。
function buildFlickRows(session, order) {
  const metrics = session.flickMetrics || {};
  const formatPercent = (value) => (value == null ? '—' : `${Math.round(value * 100)}%`);
  const formatMs = (value) => (value == null ? '—' : `${Math.round(value)} ms`);
  const formatDeg = (value) => (value == null ? '—' : `${value.toFixed(2)}°`);
  return order.map((sensitivity) => {
    const row = metrics[sensitivity];
    const tr = document.createElement('tr');
    const cells = [
      sensitivity.toFixed(2),
      row ? formatMs(row.initiationDelayMs) : '—',
      row ? row.directionLabel : '—',
      row ? formatPercent(row.overshootRate) : '—',
      row ? formatPercent(row.undershootRate) : '—',
      row ? formatPercent(row.firstShotHitRate) : '—',
      row ? formatDeg(row.adjustMagnitudeDeg) : '—',
      row ? formatPercent(row.adjustmentAccuracy) : '—',
      row ? formatPercent(row.pathEfficiency) : '—',
    ];
    cells.forEach((text) => {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    });
    return tr;
  });
}

// ---- 测试报告页 ----
// 报告从存储的会话 JSON 渲染，历史里任何一场都能回看；旧记录缺字段时降级显示。

function openReport(session, returnTo) {
  state.reportReturnTo = returnTo;
  state.reportSessionId = session.id;
  renderReport(session);
  setScreen('report');
  window.scrollTo(0, 0);
}

function clearAllHistory() {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
  displayToast('本地历史已清除。');
}

// 报告页删除单条记录：删完返回来源页；若删的正是刚测完的这场，回首页避免结果页展示幽灵数据。
function deleteReportedSession() {
  if (!state.reportSessionId) return;
  const deletedId = state.reportSessionId;
  deleteSessionById(deletedId);
  if (deletedId === state.lastSessionId) state.reportReturnTo = 'setup';
  setScreen(state.reportReturnTo === 'results' ? 'results' : 'setup');
}

function handleHistoryClick(event) {
  // 行内 × 按钮：只删这一条，不再冒泡打开报告。
  const deleteButton = event.target.closest('[data-delete]');
  if (deleteButton) {
    deleteSessionById(deleteButton.dataset.delete);
    return;
  }
  const row = event.target.closest('[data-session]');
  if (!row) return;
  const session = getHistory().find((item) => item.id === row.dataset.session);
  if (!session) return;
  openReport(session, row.closest('[data-screen="results"]') ? 'results' : 'setup');
}

function deleteSessionById(id) {
  const history = getHistory().filter((item) => item.id !== id);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  renderHistory();
  displayToast('已删除该条记录。');
  // 删的正是结果页展示的刚测场次时，回首页避免幽灵数据。
  if (id === state.lastSessionId) {
    state.lastSessionId = null;
    if (document.querySelector('[data-screen="results"]')?.hidden === false) setScreen('setup');
  }
}

// 报告里的候选顺序：阶段 2 综合排名在前，其后是只在阶段 1 出现过的档位（升序）。
function reportOrder(session) {
  const deep = (session.results ?? []).map((row) => row.sensitivity);
  const extras = new Set();
  for (const typeId of ['flick', 'tracking', 'reaction']) {
    for (const row of session.perType?.[typeId] ?? []) extras.add(row.sensitivity);
  }
  for (const key of Object.keys(session.flickMetrics ?? {})) extras.add(Number(key));
  return [...deep, ...[...extras].filter((value) => !deep.includes(value)).sort((a, b) => a - b)];
}

function renderReport(session) {
  elements.reportRecommended.textContent = session.recommendedSensitivity.toFixed(2);
  elements.reportRange.textContent = `${session.range[0].toFixed(2)} - ${session.range[1].toFixed(2)}`;
  elements.reportConfidence.textContent = `${CONFIDENCE_TEXT[session.confidence] ?? '低'}置信度`;
  const agreement = elements.reportAgreement;
  if (session.retest) {
    agreement.hidden = false;
    agreement.textContent = session.retest.agreed ? '复测一致' : '复测不一致';
    agreement.className = session.retest.agreed ? 'badge' : 'badge badge-warn';
  } else if (session.retestSkipped) {
    agreement.hidden = false;
    agreement.textContent = '未触发复测';
    agreement.className = 'badge';
  } else {
    agreement.hidden = true;
  }
  const parts = [new Date(session.createdAt).toLocaleString('zh-CN')];
  const base = session.baseSensitivity;
  const dpi = Number(session.dpi);
  if (isPositiveNumber(base)) {
    const relPct = (session.recommendedSensitivity - base) / base * 100;
    parts.push(`相对起始值 ${relPct >= 0 ? '+' : ''}${relPct.toFixed(0)}%`);
    if (Number.isFinite(dpi) && dpi > 0) {
      parts.push(`eDPI ${Math.round(base * dpi)}`);
      const cm = cmPer360(session.recommendedSensitivity, dpi);
      if (cm != null) parts.push(`推荐 ≈ ${cm.toFixed(1)} cm/360°`);
    }
  }
  elements.reportMeta.textContent = parts.join(' · ');
  const order = reportOrder(session);
  renderHeadRow(elements.reportHeadRow, sessionColumns(session));
  elements.reportResultsBody.replaceChildren(...buildCandidateRows(session, order));
  elements.reportFlickBody.replaceChildren(...buildFlickRows(session, order));
  renderReportRetest(session);
  renderReportRounds(session);
}

function renderReportRetest(session) {
  const box = elements.reportRetest;
  const retest = session.retest;
  if (!retest && session.retestSkipped) {
    box.innerHTML = '<p class="empty-state">初测结论自洽（分差明显、各环节指向一致），本次未触发复测。</p>';
    return;
  }
  if (!retest) {
    box.innerHTML = '<p class="empty-state">该记录完成于复测功能上线前，仅含初测数据。</p>';
    return;
  }
  const initialRank = new Map(retest.initialOrder.map((sens, index) => [sens, index + 1]));
  const rows = retest.candidates.map((sens, index) => {
    const scoreRow = (retest.scored ?? []).find((row) => row.sensitivity === sens);
    return `<div class="history-row"><span>复测 #${index + 1}</span><strong>${sens.toFixed(2)}</strong><span>初测 #${initialRank.get(sens) ?? '—'} · 复测分 ${scoreRow ? scoreRow.score.toFixed(1) : '—'}</span></div>`;
  }).join('');
  const verdict = retest.agreed
    ? `<p class="per-type-note">复测与初测排名一致：初测结论可复现（复测分差 ${retest.gap.toFixed(1)}）。</p>`
    : `<p class="caution">复测与初测排名不一致：初测 #1 在复测中跌至 #2，两档实际难分高下，建议休息后重测。</p>`;
  box.innerHTML = rows + verdict;
}

const ROUND_PHASE_TEXT = { warmup: '暖手', stage1: '阶段 1', stage2: '阶段 2', main: '初测', retest: '复测' };

function renderReportRounds(session) {
  const rounds = session.rounds ?? [];
  elements.reportRoundsCount.textContent = rounds.length ? `展开全部 ${rounds.length} 轮明细` : '暂无逐轮数据';
  elements.reportRoundsBody.replaceChildren(...rounds.map((round) => {
    const tr = document.createElement('tr');
    const cells = [
      ROUND_PHASE_TEXT[round.phase] ?? '—',
      TYPE_SHORT[round.typeId] ?? round.typeId ?? '—',
      round.sensitivity != null ? round.sensitivity.toFixed(2) : '—',
      `${round.hits ?? 0}/${round.shots ?? 0}`,
      `${((round.elapsedMs ?? 0) / 1000).toFixed(1)}s`,
      round.deviation != null ? round.deviation.toFixed(2) : '—',
      round.stability != null ? round.stability.toFixed(2) : '—',
    ];
    cells.forEach((text) => {
      const td = document.createElement('td');
      td.textContent = String(text);
      tr.appendChild(td);
    });
    return tr;
  }));
}

function renderFlickAnalysis(session, order) {
  elements.flickAnalysisBody.replaceChildren(...buildFlickRows(session, order));
  renderFlickCurve(session);
}

function renderFlickCurve(session) {
  const flickRounds = state.roundResults.filter((row) => CLICK_TASK_IDS.includes(row.typeId) && row.flick?.speedCurve?.length);
  if (!flickRounds.length || !elements.flickCurve) {
    elements.flickCurve.hidden = true;
    return;
  }
  const recommended = session.recommendedSensitivity;
  const candidates = flickRounds.filter((row) => row.sensitivity === recommended);
  const pool = candidates.length ? candidates : flickRounds;
  const best = pool.reduce((top, row) => (Math.max(...row.flick.speedCurve) > Math.max(...top.flick.speedCurve) ? row : top));
  const curve = best.flick.speedCurve;
  const peak = Math.max(...curve, 1);
  const width = 100;
  const height = 100;
  const points = curve.map((value, index) => {
    const x = (index / Math.max(curve.length - 1, 1)) * width;
    const y = height - (value / peak) * (height - 12) - 4;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
  const peakIndex = curve.indexOf(peak);
  const peakX = (peakIndex / Math.max(curve.length - 1, 1)) * width;
  elements.flickCurve.hidden = false;
  elements.flickCurve.replaceChildren();
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.innerHTML = `<polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.6" vector-effect="non-scaling-stroke" /><line x1="${peakX.toFixed(2)}" y1="0" x2="${peakX.toFixed(2)}" y2="${height}" stroke="currentColor" stroke-width="0.4" stroke-dasharray="2 2" opacity="0.5" /><text x="${Math.min(peakX + 1.5, width - 16).toFixed(2)}" y="10" font-size="6" fill="currentColor" opacity="0.85">峰值 ${peak}°/s</text>`;
  elements.flickCurve.appendChild(svg);
  const caption = document.createElement('p');
  caption.className = 'fine-print';
  caption.textContent = `拉枪速度曲线（推荐档 ${best.sensitivity.toFixed(2)} 的一轮）：速度 ≥127°/s 视为启动，点击前 50ms 均速 ≤8°/s 视为停点。`;
  elements.flickCurve.appendChild(caption);
}

function renderLandingHistory(history) {
  if (!elements.landingHistoryList || !elements.landingStats) return;
  if (!history.length) {
    elements.landingHistoryList.innerHTML = '<p class="empty-state">完成第一次测试后，这里会显示每次的推荐灵敏度与得分。</p>';
    elements.landingStats.textContent = '尚未开始测试';
    return;
  }
  const confidenceText = { high: '高', medium: '中', low: '低' };
  const recent = history.slice(-5).reverse();
  elements.landingHistoryList.innerHTML = recent.map((item) => {
    const chip = item.confidence && confidenceText[item.confidence]
      ? ` <span class="badge">${confidenceText[item.confidence]}</span>`
      : '';
    return `<div class="history-row" data-session="${item.id}" title="点击查看当次测试报告"><span>${new Date(item.createdAt).toLocaleDateString('zh-CN')}</span><strong>${item.recommendedSensitivity.toFixed(2)}</strong><span>${item.score.toFixed(1)} 分${chip}</span><button class="row-delete" data-delete="${item.id}" title="删除此记录" aria-label="删除此记录">×</button></div>`;
  }).join('');
  const latest = history[history.length - 1];
  elements.landingStats.textContent = `${history.length} 次测试 · 最近推荐 ${latest.recommendedSensitivity.toFixed(2)}`;
  renderLandingRecap(history);
}

// 落地页「上次报告速览」：取最近一次会话的推荐值/区间/置信度/各环节最优档位。
function renderLandingRecap(history) {
  const recap = document.querySelector('#landing-recap');
  if (!recap) return;
  const latest = history[history.length - 1];
  if (!latest) {
    recap.hidden = true;
    return;
  }
  recap.hidden = false;
  const fmt = (value) => Number(value).toFixed(2);
  document.querySelector('#recap-title').textContent = `上次报告速览 · ${new Date(latest.createdAt).toLocaleDateString('zh-CN')}`;
  document.querySelector('#recap-recommended').textContent = fmt(latest.recommendedSensitivity);
  document.querySelector('#recap-range').textContent = Array.isArray(latest.range) ? latest.range.map(fmt).join(' – ') : '—';
  document.querySelector('#recap-confidence').textContent = CONFIDENCE_TEXT[latest.confidence] ?? '—';
  for (const typeId of TEST_TYPE_IDS) {
    const cell = document.querySelector(`#recap-${typeId}`);
    if (!cell) continue;
    const best = latest.bestPerType?.[typeId];
    cell.textContent = best ? fmt(best.sensitivity) : '—';
  }
  const divergent = TEST_TYPE_IDS
    .map((typeId) => ({ typeId, best: latest.bestPerType?.[typeId] }))
    .filter((entry) => entry.best && Number(entry.best.sensitivity) !== Number(latest.recommendedSensitivity));
  const nameOf = (typeId) => getType(typeId)?.name ?? typeId;
  const note = divergent.length
    ? `${divergent.map((entry) => `${nameOf(entry.typeId)}环节单独 favor ${fmt(entry.best.sensitivity)}`).join('、')}，与综合推荐有出入，完整解读见报告。`
    : '各环节最优档位与综合推荐一致。';
  document.querySelector('#recap-note').innerHTML = `${note} —— <a data-session="${latest.id}" class="recap-link">查看完整报告 →</a>`;
}

function renderHistory() {
  const history = getHistory();
  renderLandingHistory(history);
  const trend = elements.historyTrend;
  if (!history.length) {
    elements.historyList.innerHTML = '<p class="empty-state">完成测试后会显示最近 20 次记录。</p>';
    elements.historyChart.replaceChildren();
    elements.historyAggregate.textContent = '';
    trend.textContent = '';
    return;
  }
  const confidenceText = { high: '高', medium: '中', low: '低' };
  elements.historyList.innerHTML = history.slice().reverse().map((item) => {
    const chip = item.confidence && confidenceText[item.confidence]
      ? ` <span class="badge">${confidenceText[item.confidence]}置信度</span>`
      : '';
    return `<div class="history-row" data-session="${item.id}" title="点击查看当次测试报告"><span>${new Date(item.createdAt).toLocaleDateString('zh-CN')}</span><strong>${item.recommendedSensitivity.toFixed(2)}</strong><span>${item.score.toFixed(1)} 分${chip}</span><button class="row-delete" data-delete="${item.id}" title="删除此记录" aria-label="删除此记录">×</button></div>`;
  }).join('');

  // 多场次加权建议（同基准、按置信度加权）。
  const aggregate = aggregateRecommendations(history);
  elements.historyAggregate.textContent = aggregate && aggregate.count >= 2
    ? `近 ${aggregate.count} 次同基准加权建议 ≈ ${aggregate.value.toFixed(2)}（各场次区间 ${aggregate.min.toFixed(2)} ~ ${aggregate.max.toFixed(2)}${aggregate.max - aggregate.min >= 0.05 ? `，波动 ${(aggregate.max - aggregate.min).toFixed(2)}` : '，已稳定'}）`
    : '';

  // 近 5 次推荐收敛趋势。
  const recent = history.slice(-5);
  const recents = recent.map((item) => item.recommendedSensitivity);
  const span = Math.max(...recents) - Math.min(...recents);
  trend.textContent = history.length < 2
    ? '完成多次测试后这里会显示推荐值是否收敛。'
    : `近 ${recent.length} 次推荐: ${recent[0].recommendedSensitivity.toFixed(2)} → ${recent.at(-1).recommendedSensitivity.toFixed(2)}，区间 ${Math.min(...recents).toFixed(2)} ~ ${Math.max(...recents).toFixed(2)}${span < 0.05 ? '（已收敛）' : `，波动 ${span.toFixed(2)}`}`;

  const max = Math.max(...history.map((item) => item.recommendedSensitivity));
  const min = Math.min(...history.map((item) => item.recommendedSensitivity));
  const scale = Math.max(0.05, max - min);
  elements.historyChart.innerHTML = history.map((item, index) => {
    const height = 28 + ((item.recommendedSensitivity - min) / scale) * 62;
    return `<div class="chart-bar" title="${new Date(item.createdAt).toLocaleDateString('zh-CN')} ${item.recommendedSensitivity.toFixed(2)}" style="height:${height}%"><span>${index + 1}</span></div>`;
  }).join('');
}

function updateCmHint() {
  const sensitivity = Number(elements.sensitivity.value);
  const dpi = Number(elements.dpi.value);
  if (!isPositiveNumber(String(sensitivity)) || !Number.isFinite(dpi) || dpi <= 0) {
    elements.cmHint.textContent = '';
    return;
  }
  const distance = cmPer360(sensitivity, dpi);
  elements.cmHint.textContent = distance != null ? `约 ${distance.toFixed(1)} cm 转一圈（360°）` : '';
}

// ---- 装备校准表单持久化：上次填过的灵敏度/DPI/分辨率/显示方式自动带回 ----
const SETUP_KEY = 'cs2-setup-v1';

function saveSetup() {
  try {
    localStorage.setItem(SETUP_KEY, JSON.stringify({
      sensitivity: elements.sensitivity.value,
      dpi: elements.dpi.value,
      resolution: elements.resolution.value,
      displayMode: elements.displayMode.value,
    }));
  } catch { /* 隐私模式等场景下 localStorage 不可用，静默跳过 */ }
}

function restoreSetup() {
  let setup = null;
  try {
    setup = JSON.parse(localStorage.getItem(SETUP_KEY) || 'null');
  } catch { setup = null; }
  if (!setup || typeof setup !== 'object') return;
  if (typeof setup.sensitivity === 'string' && setup.sensitivity) elements.sensitivity.value = setup.sensitivity;
  if (typeof setup.dpi === 'string') elements.dpi.value = setup.dpi;
  if (typeof setup.resolution === 'string' && elements.resolution.querySelector(`option[value="${setup.resolution}"]`)) {
    elements.resolution.value = setup.resolution;
  }
  if (setup.displayMode === 'letterbox' || setup.displayMode === 'stretch') {
    elements.displayMode.value = setup.displayMode;
  }
  updateCmHint();
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
  state.fovBounds = getFovBounds(state.resolution);
  state.hFovDeg = state.fovBounds.hHalfDeg * 2;
  state.candidates = buildCandidates(state.baseSensitivity);
  saveSetup();
  state.phase = 'main';
  state.schedule = buildMain(state.candidates);
  state.index = 0;
  state.roundResults = [];
  state.retestSkipped = false;
  primeAudio();
  setScreen('test');
  elements.arena.focus();
  applyGameEnvironment();
}

function handlePointerLockChange() {
  state.pointerLocked = document.pointerLockElement === elements.arena;
  window.clearTimeout(state.lockTimer);
  if (!state.pointerLocked) state.mouseDown = false; // 解锁瞬间松开的按键不再算数
  if (state.pointerLocked) {
    state.ignoreNextMouseEvent = true;
    // 重锁吞哑窗口：锁定瞬间 OS 注入补偿性巨型 movement（光标跳到锁定点的差值），仅吞首个事件
    // 挡不住紧随的残余跳变；64ms 内移动按 0 处理，代价远低于感知阈值，收益是消灭重锁瞬移。
    state.lockGraceUntil = performance.now() + 64;
    hidePause();
    if (!state.round || state.round.restartRequired) beginRound();
    return;
  }
  if (state.round && state.index < state.schedule.length && !state.awaitingTransition) {
    showPause('鼠标未锁定。点击继续回到测试。');
  }
}

function handleMouseMove(event) {
  if (!state.pointerLocked || state.paused || !state.round) return;
  if (state.ignoreNextMouseEvent) {
    state.ignoreNextMouseEvent = false;
    return;
  }
  if (state.lockGraceUntil && performance.now() < state.lockGraceUntil) return;
  state.cursor = applyMouseDelta(state.cursor, event.movementX, event.movementY, state.round.sensitivity, state.fovBounds);
  const samples = state.round.logs.samples;
  samples.push({ t: performance.now(), xDeg: state.cursor.xDeg, yDeg: state.cursor.yDeg });
  if (samples.length > 6000) samples.splice(0, 2000);
  setView();
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

function init() {
  Object.assign(elements, {
    form: document.querySelector('#setup-form'), sensitivity: document.querySelector('#sensitivity'), dpi: document.querySelector('#dpi'), resolution: document.querySelector('#resolution'), displayMode: document.querySelector('#display-mode'), cmHint: document.querySelector('#cm-hint'),
    audioEnabled: document.querySelector('#audio-enabled'), fireVolume: document.querySelector('#fire-volume'), hitVolume: document.querySelector('#hit-volume'),
    toast: document.querySelector('#toast'), arena: document.querySelector('#arena'), crosshair: document.querySelector('#crosshair'),
    taskName: document.querySelector('#task-name'), taskDescription: document.querySelector('#task-description'), statHits: document.querySelector('#stat-hits'), statTime: document.querySelector('#stat-time'), statFps: document.querySelector('#stat-fps'), calibrationBar: document.querySelector('#calibration-bar'),
    progress: document.querySelector('#progress'), progressBar: document.querySelector('#progress-bar'), pauseOverlay: document.querySelector('#pause-overlay'), pauseMessage: document.querySelector('#pause-message'),
    recommended: document.querySelector('#recommended'), range: document.querySelector('#range'), confidence: document.querySelector('#confidence'), retest: document.querySelector('#retest'), cm360: document.querySelector('#cm360'), fitNote: document.querySelector('#fit-note'),
    resultsBody: document.querySelector('#results-body'), flickAnalysisBody: document.querySelector('#flick-analysis-body'), flickCurve: document.querySelector('#flick-curve'), historyList: document.querySelector('#history-list'), historyChart: document.querySelector('#history-chart'), historyTrend: document.querySelector('#history-trend'), historyAggregate: document.querySelector('#history-aggregate'),
    landingHistoryList: document.querySelector('#landing-history-list'), landingStats: document.querySelector('#landing-stats'),
    resultsHeadRow: document.querySelector('#results-head-row'), reportHeadRow: document.querySelector('#report-head-row'),
    rawInputStatus: document.querySelector('#raw-input-status'), perTypeNote: document.querySelector('#per-type-note'), retestNote: document.querySelector('#retest-note'),
    viewReport: document.querySelector('#view-report'),
    reportBack: document.querySelector('#report-back'), reportRecommended: document.querySelector('#report-recommended'), reportRange: document.querySelector('#report-range'), reportConfidence: document.querySelector('#report-confidence'), reportAgreement: document.querySelector('#report-agreement'), reportMeta: document.querySelector('#report-meta'),
    reportResultsBody: document.querySelector('#report-results-body'), reportFlickBody: document.querySelector('#report-flick-body'), reportRetest: document.querySelector('#report-retest'), reportRoundsBody: document.querySelector('#report-rounds-body'), reportRoundsCount: document.querySelector('#report-rounds-count'),
    reportDelete: document.querySelector('#report-delete'), landingClearHistory: document.querySelector('#landing-clear-history'),
  });
  elements.form.addEventListener('submit', startSession);
  document.querySelector('#start-test').addEventListener('click', startSession);
  elements.sensitivity.addEventListener('input', updateCmHint);
  elements.dpi.addEventListener('input', updateCmHint);
  restoreSetup();
  loadAudioConfig();
  const audioConfig = getAudioConfig();
  elements.audioEnabled.checked = audioConfig.enabled;
  elements.fireVolume.value = String(Math.round(audioConfig.fireVolume * 100));
  elements.hitVolume.value = String(Math.round(audioConfig.hitVolume * 100));
  elements.audioEnabled.addEventListener('change', () => {
    if (elements.audioEnabled.checked) primeAudio();
    setAudioConfig({ enabled: elements.audioEnabled.checked });
  });
  elements.fireVolume.addEventListener('input', () => {
    setAudioConfig({ fireVolume: Number(elements.fireVolume.value) / 100 });
  });
  elements.hitVolume.addEventListener('input', () => {
    setAudioConfig({ hitVolume: Number(elements.hitVolume.value) / 100 });
  });
  elements.arena.addEventListener('click', onArenaClick);
  elements.pauseOverlay.addEventListener('click', () => {
    if (state.awaitingTransition) {
      state.awaitingTransition = false;
      state.round = null;
      hidePause();
      if (state.pointerLocked) {
        beginRound();
      } else {
        applyGameEnvironment();
      }
      return;
    }
    if (state.pointerLocked) {
      hidePause();
      if (state.round?.restartRequired) beginRound();
    } else {
      applyGameEnvironment();
    }
  });
  document.addEventListener('pointerlockchange', handlePointerLockChange);
  // 左键按住状态：跟枪只有在按住左键时条才递减（指针锁定期间事件直达 document）。
  document.addEventListener('mousedown', (event) => {
    if (event.button === 0 && state.pointerLocked) state.mouseDown = true;
  });
  document.addEventListener('mouseup', (event) => {
    if (event.button === 0) state.mouseDown = false;
  });
  document.addEventListener('mousemove', handleMouseMove);
  window.addEventListener('blur', () => { if (state.pointerLocked) document.exitPointerLock(); });
  window.addEventListener('resize', () => { updateGameFrame(); if (state.round && window.innerWidth < 640) showPause('窗口过窄。请增大窗口后继续。'); });
  document.addEventListener('fullscreenchange', updateGameFrame);
  document.querySelector('#restart').addEventListener('click', () => { document.exitFullscreen?.(); state.range3d?.stop(); document.documentElement.classList.remove('game-mode'); state.round = null; setScreen('setup'); });
  document.querySelector('#export-history').addEventListener('click', exportHistory);
  elements.viewReport.addEventListener('click', () => {
    const session = getHistory().find((item) => item.id === state.lastSessionId);
    if (session) openReport(session, 'results');
  });
  elements.reportBack.addEventListener('click', () => setScreen(state.reportReturnTo === 'results' ? 'results' : 'setup'));
  document.addEventListener('click', handleHistoryClick);
  document.querySelector('#clear-history').addEventListener('click', clearAllHistory);
  elements.landingClearHistory.addEventListener('click', clearAllHistory);
  elements.reportDelete.addEventListener('click', deleteReportedSession);
  renderHistory();
  renderRawInputStatus();
  elements.crosshair.style.left = '50%';
  elements.crosshair.style.top = '50%';
  window.__cs2debug = state; // 调试/自动化钩子：暴露角度状态供诊断脚本读取
  window.__cs2booted = true; // 标记应用已成功初始化（供 index.html 兜底脚本探测）
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', init);