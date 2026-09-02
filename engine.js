// engine.js — CS2 灵敏度盲测的纯逻辑层。零 DOM / 浏览器依赖，Node 可直接测试。

export const MAX_RAW_POINTER_DELTA = 8000;

// Windows 上 Chromium 的 requestPointerLock 默认把 OS 指针加速曲线（“提高指针精确度”）和
// 指针速度滑杆应用到 movementX/Y，快甩被放大、慢移被压扁，破坏 0.022°/count 标定。
// { unadjustedMovement: true } 请求绕过 OS 曲线的原始硬件增量（真 RAW INPUT）；
// 浏览器不支持时抛 NotSupportedError，降级为普通锁定并提示用户手动关闭系统加速。
export const POINTER_LOCK_FALLBACK_MESSAGE = '浏览器不支持原始鼠标输入（unadjustedMovement），已降级为普通鼠标锁定。请在 Windows 设置中关闭“提高指针精确度”，否则灵敏度会失真。';

// 返回 true=锁定请求已成功发起（含降级路径）；false=两种方式都被拒绝。
// onFallback(reason, kind) 在降级/失败时回调，reason 为面向用户的原因说明，
// kind 为 'unsupported'（浏览器不支持原始输入，已降级）或 'rejected'（锁定请求本身被拒绝），
// 供 UI 区分「锁定失败」与「标定降级」两种状态。
export async function requestRawPointerLock(element, onFallback = () => {}) {
  try {
    await element.requestPointerLock({ unadjustedMovement: true });
    return true;
  } catch (rawError) {
    try {
      await element.requestPointerLock();
    } catch (plainError) {
      onFallback(`鼠标锁定被拒绝：${plainError?.message || plainError}`, 'rejected');
      return false;
    }
    if (rawError?.name === 'NotSupportedError') onFallback(POINTER_LOCK_FALLBACK_MESSAGE, 'unsupported');
    return true;
  }
}

// ---- 帧率数据卫生 ----
// 平均 FPS 会被时长稀释：20 秒里混入 2 秒卡顿，均值几乎不动。1% low（最差 1% 帧
// 的平均帧时换算）与最大单帧专门捕捉这类尖刺，任一超标即触发该轮重测。
export const FRAME_HYGIENE = {
  minAvgFps: 45,
  minOnePercentLowFps: 20,
  maxFrameMs: 250,
};

export function frameHygieneStats(frameDeltas) {
  if (!Array.isArray(frameDeltas) || frameDeltas.length < 10) return null;
  const sorted = [...frameDeltas].sort((a, b) => a - b);
  const mean = sorted.reduce((total, item) => total + item, 0) / sorted.length;
  const lowCount = Math.max(1, Math.round(sorted.length * 0.01));
  let lowSum = 0;
  for (let index = sorted.length - lowCount; index < sorted.length; index += 1) lowSum += sorted[index];
  const lowMean = lowSum / lowCount;
  return {
    avgFps: mean > 0 ? 1000 / mean : 0,
    onePercentLowFps: lowMean > 0 ? 1000 / lowMean : 0,
    maxFrameMs: sorted[sorted.length - 1],
  };
}

// 返回 null 表示帧率达标；否则给出第一条不达标原因（面向用户的短文案，供重测提示复用）。
export function frameHygieneIssue(stats) {
  if (!stats) return null;
  if (stats.avgFps < FRAME_HYGIENE.minAvgFps) return `平均仅 ${Math.round(stats.avgFps)} FPS`;
  if (stats.maxFrameMs > FRAME_HYGIENE.maxFrameMs) return `出现 ${Math.round(stats.maxFrameMs)} ms 单帧卡顿`;
  if (stats.onePercentLowFps < FRAME_HYGIENE.minOnePercentLowFps) return `1% low 仅 ${Math.round(stats.onePercentLowFps)} FPS`;
  return null;
}

export const TEST_TYPE_IDS = ['quad', 'tracking', 'hex', 'single'];

export const RESOLUTION_PROFILES = {
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

export const TEST_TYPES = [
  { id: 'quad', name: '四目标', description: '场上保持 4 个等大的球，命中一个立即刷新一个' },
  { id: 'tracking', name: '跟枪', description: '按住左键贴住急停变向的移动目标，条减空即换球' },
  { id: 'hex', name: '六目标', description: '6 个更小的球铺开在大范围，命中一个随机刷新一个' },
  { id: 'single', name: '单球点击', description: '小球延迟出现，尽快点击，命中后刷新下一个' },
];

// 定时制（用户选定 20s/轮）：时间到即收轮，不再按目标数收轮；
// 记分以击杀数为主轴（20 秒内打掉多少），见下方分环节记分。
// 30s 单轮数据更稳但全程偏长；10s 击杀数波动 ±40% 过噪，20s 为折中。
const FULL_ROUND_CONFIG = {
  quad: { durationMs: 20000 },
  tracking: { durationMs: 20000 },
  hex: { durationMs: 20000 },
  single: { durationMs: 20000 },
};

export function isPositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0.1;
}

// 候选档位设计（参考行内 PSA 方法的百分比步进，等比 = 等手感，并对数等距）：
// 向下两步各 −15%（社区共识：多数人当前灵敏度偏高，最优更可能在下方，往下多探），
// 向上两步各 +12%（上侧贴近习惯值，步距收窄）；总覆盖约 −24% ~ +26%。
const CANDIDATE_DOWN_STEP = Math.log(1.15);
const CANDIDATE_UP_STEP = Math.log(1.12);

export function buildCandidates(baseSensitivity) {
  const base = Number(baseSensitivity);
  return [-2, -1, 0, 1, 2].map((k) => (
    Number((base * Math.exp(k < 0 ? k * CANDIDATE_DOWN_STEP : k * CANDIDATE_UP_STEP)).toFixed(2))
  ));
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

// ---- 真实标定（calibration）----
// CS2 的 m_yaw / m_pitch 均为 0.022 度/count，灵敏度直接决定每 count 的转角。
export const CS2_YAW_PER_COUNT = 0.022;
// CS2 沿用 CS:GO 的 hor+ 视场模型：4:3 下 hFOV = 90°，垂直视场恒为 2·atan(3/4) ≈ 73.74°。
export const CS2_V_FOV_DEG = 2 * Math.atan(0.75) * (180 / Math.PI);

export function parseAspect(aspectText) {
  const match = /^([\d.]+)\s*\/\s*([\d.]+)$/.exec(String(aspectText ?? ''));
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return null;
  return width / height;
}

// hor+ 规则：垂直视场固定，水平视场随宽高比扩展。4:3 → 90°，16:9 → ≈106.26°。
export function getHorizontalFovDeg(aspectValue) {
  const vHalfTan = Math.tan((CS2_V_FOV_DEG / 2) * (Math.PI / 180));
  return 2 * Math.atan(vHalfTan * aspectValue) * (180 / Math.PI);
}

export function getFovBounds(profile) {
  const aspect = parseAspect(profile?.aspect) ?? 16 / 9;
  return {
    hHalfDeg: getHorizontalFovDeg(aspect) / 2,
    vHalfDeg: CS2_V_FOV_DEG / 2,
  };
}

// 跟枪急停变向横移参数（用户可感知手感，全部单点可调）。
export const TRACKING_STOP_CHANCE = 0.3;      // 急停时 30% 概率停顿后反向，其余立即反向
export const TRACKING_PAUSE_MIN_S = 0.12;     // 停顿最短时长（秒）
export const TRACKING_PAUSE_MAX_S = 0.2;      // 停顿最长时长（秒）
export const TRACKING_SPEED_MIN = 10;         // 横移速度下限（°/s）
export const TRACKING_SPEED_MAX = 14;         // 横移速度上限（°/s）
export const TRACKING_SEGMENT_MIN_S = 0.4;    // 两次急停间最短直行时长（秒）
export const TRACKING_SEGMENT_MAX_S = 1.1;    // 两次急停间最长直行时长（秒）
export const TRACKING_SWAY_DEG = 1.5;         // 上下正弦浮动幅度（°）
export const TRACKING_SWAY_SPEED = 0.9;       // 上下浮动角速度（rad/s）
export const TRACKING_DRAIN_S = 1.2;          // 贴住时把满条减空所需时长（秒）；脱靶时条暂停不减

// 跟枪目标每帧状态推进（纯函数，便于测试）。
// state: { xDeg, yDeg, dirDeg, speed, segmentLeftS, pauseLeftS, swayPhase }
// 返回 { state, moved } —— moved 为本帧角度位移，供渲染层直接 setAngles。
export function stepTrackingTarget(state, deltaS, bounds) {
  const next = { ...state };
  if (next.pauseLeftS > 0) {
    next.pauseLeftS -= deltaS;
  } else {
    next.segmentLeftS -= deltaS;
    if (next.segmentLeftS <= 0) {
      if (Math.random() < TRACKING_STOP_CHANCE) {
        next.pauseLeftS = TRACKING_PAUSE_MIN_S + Math.random() * (TRACKING_PAUSE_MAX_S - TRACKING_PAUSE_MIN_S);
      }
      next.dirDeg *= -1;
      next.speed = TRACKING_SPEED_MIN + Math.random() * (TRACKING_SPEED_MAX - TRACKING_SPEED_MIN);
      next.segmentLeftS = TRACKING_SEGMENT_MIN_S + Math.random() * (TRACKING_SEGMENT_MAX_S - TRACKING_SEGMENT_MIN_S);
    }
    const paused = next.pauseLeftS > 0;
    const vx = paused ? 0 : next.dirDeg * next.speed;
    next.xDeg += vx * deltaS;
  }
  next.swayPhase += TRACKING_SWAY_SPEED * deltaS;
  next.yDeg += Math.sin(next.swayPhase) * TRACKING_SWAY_DEG * TRACKING_SWAY_SPEED * deltaS;

  const maxX = bounds.hHalfDeg * 0.85;
  const maxY = bounds.vHalfDeg * 0.85;
  if (next.xDeg < -maxX) { next.xDeg = -maxX; next.dirDeg = 1; next.segmentLeftS = Math.max(next.segmentLeftS, TRACKING_SEGMENT_MIN_S); }
  if (next.xDeg > maxX) { next.xDeg = maxX; next.dirDeg = -1; next.segmentLeftS = Math.max(next.segmentLeftS, TRACKING_SEGMENT_MIN_S); }
  if (next.yDeg > maxY) next.yDeg = maxY;
  if (next.yDeg < -maxY) next.yDeg = -maxY;
  return { state: next, moved: { xDeg: next.xDeg, yDeg: next.yDeg } };
}

// 递减条推进：条从满开始，贴住时按 TRACKING_DRAIN_S 减空；脱靶时暂停（不倒扣）。
export function stepTrackingProgress(progress, deltaS, onTarget) {
  if (!onTarget) return progress;
  return Math.max(0, progress - deltaS / TRACKING_DRAIN_S);
}

export function angleOffsetToPercent(angleDeg, fullFovDeg) {
  const halfTan = Math.tan((fullFovDeg / 2) * (Math.PI / 180));
  return (Math.tan(angleDeg * (Math.PI / 180)) / halfTan) * 50;
}

export function percentToAngleOffset(percent, fullFovDeg) {
  const halfTan = Math.tan((fullFovDeg / 2) * (Math.PI / 180));
  return Math.atan(((percent - 50) / 50) * halfTan) * (180 / Math.PI);
}

export function targetAngularHalfSizeDeg(sizePct, hFovDeg) {
  const halfTan = Math.tan((hFovDeg / 2) * (Math.PI / 180));
  return Math.atan((sizePct / 100) * halfTan) * (180 / Math.PI);
}

// 游标状态存放在角度空间 {xDeg, yDeg}。movement 为 pointer lock 的原始增量（≈硬件 counts，
// 要求系统指针速度 6/11 且无加速），sensitivity 为候选档位的绝对灵敏度。
// 单帧增量超过上限视为 USB 尖峰/抖动：夹持到上限而非整帧丢弃——丢弃会让视角冻结一帧再跳回，
// 主观上就是“瞬移/卡顿”；夹持保证视角连续，且尖峰帧的实际角位移远超正常范围，截断误差可忽略。
export function applyMouseDelta(angles, movementX, movementY, sensitivity, fovBounds) {
  const limit = MAX_RAW_POINTER_DELTA;
  const clampedX = Math.max(-limit, Math.min(limit, movementX));
  const clampedY = Math.max(-limit, Math.min(limit, movementY));
  const gain = CS2_YAW_PER_COUNT * sensitivity;
  const limitX = fovBounds.hHalfDeg * 0.98;
  const limitY = fovBounds.vHalfDeg * 0.98;
  return {
    xDeg: Math.max(-limitX, Math.min(limitX, angles.xDeg + clampedX * gain)),
    yDeg: Math.max(-limitY, Math.min(limitY, angles.yDeg + clampedY * gain)),
  };
}

export function cmPer360(sensitivity, dpi) {
  const sens = Number(sensitivity);
  const dots = Number(dpi);
  if (!Number.isFinite(sens) || sens <= 0 || !Number.isFinite(dots) || dots <= 0) return null;
  // CS2: sens × 0.022 度/count → 一整圈需要 (360 / (0.022 × sens)) counts。
  return (360 / (0.022 * sens)) * (2.54 / dots);
}

export function shuffle(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[randomIndex]] = [copy[randomIndex], copy[index]];
  }
  return copy;
}

function makeRound(sensitivity, typeId, config, { quick = false, warmup = false } = {}) {
  return {
    sensitivity,
    typeId,
    quick,
    warmup,
    durationMs: config.durationMs ?? null,
  };
}

// 暖手轮已移除；冷手噪声靠随机档位顺序摊开，而不是固定压在某一档头上。

// 初测：以灵敏度为主轴——第一块先测用户填写的基准档（热手 + 有熟悉参照），其余 4 档
// 随机先后；每档连测四项（四目标→跟枪→六目标→单球）再换下一档。
// 档内任务顺序固定给出一致节奏，全部档位拿到完整四项数据。
export function buildMain(candidates) {
  // buildCandidates 约定：5 档按 ±24%/±12%/0 生成，第 3 项（index 2）即用户填写的基准档。
  const base = candidates[2];
  const rest = candidates.filter((_, index) => index !== 2);
  return [base, ...shuffle(rest)].flatMap((sensitivity) => (
    TEST_TYPE_IDS.map((typeId) => makeRound(sensitivity, typeId, FULL_ROUND_CONFIG[typeId]))
  ));
}

export function selectFinalists(scoredRows, count = 3) {
  return scoredRows
    .slice()
    .sort((a, b) => b.score - a.score || b.accuracy - a.accuracy || a.deviation - b.deviation)
    .slice(0, count)
    .map((row) => row.sensitivity);
}

// 复测确认：对初测前二名各连测四项一轮（共 8 轮）后对比排名，两档先后随机。
// 复测结论用于验证初测排名能否复现。
export function buildRetest(finalists) {
  return shuffle(finalists).flatMap((sensitivity) => (
    TEST_TYPE_IDS.map((typeId) => makeRound(sensitivity, typeId, FULL_ROUND_CONFIG[typeId]))
  ));
}

// 复测确认聚合：用复测轮次对前二名独立重排名，与初测（阶段 2 综合分）次序比对。
// rows 含全部阶段的轮次；recommendation 为初测结论。无复测数据（旧版本会话）返回 null。
export function summarizeRetest(rows, recommendation) {
  const retestRows = (Array.isArray(rows) ? rows : []).filter((row) => row.phase === 'retest' && row.typeId);
  const candidates = new Set(retestRows.map((row) => row.sensitivity));
  if (candidates.size < 2) return null;
  const retestVerdict = calculateRecommendation(retestRows);
  if (!retestVerdict || retestVerdict.scored.length < 2) return null;
  const scored = retestVerdict.scored;
  const retestOrder = scored.slice(0, 2).map((row) => row.sensitivity);
  const initialOrder = (recommendation?.scored ?? [])
    .map((row) => row.sensitivity)
    .filter((sensitivity) => candidates.has(sensitivity))
    .slice(0, 2);
  return {
    candidates: retestOrder,
    initialOrder,
    agreed: initialOrder.length >= 2 && retestOrder[0] === initialOrder[0],
    gap: Number((scored[0].score - scored[1].score).toFixed(1)),
    scored: scored.map((row) => ({ sensitivity: row.sensitivity, score: row.score, accuracy: row.accuracy })),
  };
}

function det3(matrix) {
  const [a, b, c] = matrix[0];
  const [d, e, f] = matrix[1];
  const [g, h, i] = matrix[2];
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

// y = a·x² + b·x + c 最小二乘拟合；仅当凸峰（a < 0）且 ≥3 个不同 x 时返回。
export function quadraticFit(points) {
  if (new Set(points.map((point) => point.x)).size < 3) return null;
  const n = points.length;
  let sx = 0; let sy = 0; let sx2 = 0; let sx3 = 0; let sx4 = 0; let sxy = 0; let sx2y = 0;
  for (const point of points) {
    const { x, y } = point;
    sx += x; sy += y; sx2 += x * x; sx3 += x * x * x; sx4 += x ** 4;
    sxy += x * y; sx2y += x * x * y;
  }
  // 正规方程: [[n,sx,sx2],[sx,sx2,sx3],[sx2,sx3,sx4]] · [c,b,a]ᵀ = [sy,sxy,sx2y]ᵀ
  const matrix = [
    [n, sx, sx2],
    [sx, sx2, sx3],
    [sx2, sx3, sx4],
  ];
  const det = det3(matrix);
  if (Math.abs(det) < 1e-12) return null;
  const rhs = [sy, sxy, sx2y];
  const replaceColumn = (pivotColumn) => matrix.map((row, rowIndex) => (
    row.map((value, columnIndex) => (columnIndex === pivotColumn ? rhs[rowIndex] : value))
  ));
  const c = det3(replaceColumn(0)) / det;
  const b = det3(replaceColumn(1)) / det;
  const a = det3(replaceColumn(2)) / det;
  if (a >= 0) return null;
  return { a, b, c };
}

const clamp01 = (value) => Math.max(0, Math.min(1, value));

// 环节权重：四目标/六目标考连续定位与目标转移（各 30%），单球考首发精准（25%），
// 跟枪的击杀数含义偏弱（贴条递减节奏），给 15%。
export const SEGMENT_WEIGHTS = { quad: 0.3, hex: 0.3, single: 0.25, tracking: 0.15 };

// 绝对分：锚点固定、不随同场候选变化，跨场次可比（综合各家练枪软件的记分思路）：
// 点击类 = 击杀×10 × √命中率 × 停点系数。√ 命中系数学 KovaaK（奖励精度但不鼓励蹲命中率）；
// 停点系数学 Aimlabs 的“目标内精度”——准星停在目标圆心多近（拉枪分析的停点误差，
// 按目标角半径归一化），也是对灵敏度最敏感的指标。
// 跟枪无命中率概念：球数×20 × 贴迹系数（每帧准星-目标角距越近越高）。
export function computeSegmentScore(row) {
  const stopMean = Number.isFinite(row.stopPrecision)
    ? row.stopPrecision
    : (Number.isFinite(row.flick?.stopPrecision) ? row.flick.stopPrecision : null);
  if (row.typeId === 'tracking') {
    const quality = clamp01(1.2 - row.deviation);
    const base = row.hits * 20;
    const stopCoef = Number((0.75 + 0.45 * quality).toFixed(3));
    return { base, hitCoef: null, stopCoef, score: Number((base * stopCoef).toFixed(1)) };
  }
  const accuracy = row.shots ? Math.min(1, row.hits / row.shots) : 0;
  const hitCoef = Number(Math.sqrt(accuracy).toFixed(3));
  // 缺停点数据（旧记录/跟枪外的极端情况）时按保守中性 0.975 处理：不奖不罚、略倾向保守。
  const stopCoef = Number((0.75 + 0.45 * clamp01(1.1 - (stopMean ?? 0.6))).toFixed(3));
  const base = row.hits * 10;
  return { base, hitCoef, stopCoef, score: Number((base * hitCoef * stopCoef).toFixed(1)) };
}

function scoreSegmentRows(rows) {
  return rows
    .map((row) => ({
      ...row,
      accuracy: row.shots ? Math.min(1, row.hits / row.shots) : 0,
      ...computeSegmentScore(row),
    }))
    .sort((a, b) => b.score - a.score || b.hits - a.hits || a.deviation - b.deviation);
}

// 把多轮结果按 keyOf 聚合到档位：命中/次数/耗时累计，deviation/stability/停点精度取组内均值。
function aggregateBy(rows, keyOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    const entry = groups.get(key) || {
      key, sensitivity: row.sensitivity, shots: 0, hits: 0, elapsedMs: 0, deviation: 0, stability: 0, entries: 0,
      stopPrecisionSum: 0, stopPrecisionCount: 0,
    };
    entry.shots += row.shots;
    entry.hits += row.hits;
    entry.elapsedMs += row.elapsedMs;
    entry.deviation += row.deviation;
    entry.stability += row.stability;
    entry.entries += 1;
    const stopPrecision = row.stopPrecision ?? row.flick?.stopPrecision;
    if (Number.isFinite(stopPrecision)) {
      entry.stopPrecisionSum += stopPrecision;
      entry.stopPrecisionCount += 1;
    }
    groups.set(key, entry);
  }
  return [...groups.values()].map((entry) => ({
    ...entry,
    deviation: entry.deviation / entry.entries,
    stability: entry.stability / entry.entries,
    stopPrecision: entry.stopPrecisionCount ? entry.stopPrecisionSum / entry.stopPrecisionCount : null,
  }));
}

// 综合 + 按任务类型分维的分析（分环节记分制）。
// 每个任务类型内部独立打分（scoreSegmentRows），再按 SEGMENT_WEIGHTS 加权平均出综合分，
// 对综合分做二次拟合取峰值。phase 存在时综合判定只看初测（main）轮次；
// 无 phase 标记则全部轮次参与（向后兼容旧记录）；perType 覆盖传入的全部轮次。
export function calculateRecommendation(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const hasPhase = rows.some((row) => row.phase);
  const verdictRows = hasPhase ? rows.filter((row) => row.phase === 'main') : rows;
  const viableRows = verdictRows.length ? verdictRows : rows;
  const typedVerdictRows = viableRows.filter((row) => row.typeId);

  const perType = {};
  const bestPerType = {};
  for (const typeId of TEST_TYPE_IDS) {
    // 分环节表只统计初测轮次：复测过的档位若混入会把分数翻倍，跨档位比较不公平。
    const typeRows = viableRows.filter((row) => row.typeId === typeId);
    if (!typeRows.length) continue;
    const ranked = scoreSegmentRows(aggregateBy(typeRows, (row) => row.sensitivity));
    perType[typeId] = ranked;
    const top = ranked[0];
    bestPerType[typeId] = { sensitivity: top.sensitivity, score: top.score, accuracy: top.accuracy };
  }

  // 环节加权合成：某档位缺某环节时按实际参与的权重归一，缺环节不占坑。
  const typeIds = Object.keys(perType);
  const sensitivities = [...new Set(typedVerdictRows.map((row) => row.sensitivity))];
  const scored = sensitivities.map((sensitivity) => {
    let weighted = 0;
    let weightSum = 0;
    for (const typeId of typeIds) {
      const row = perType[typeId].find((entry) => entry.sensitivity === sensitivity);
      if (!row) continue;
      const weight = SEGMENT_WEIGHTS[typeId] ?? 0;
      weighted += row.score * weight;
      weightSum += weight;
    }
    const own = typedVerdictRows.filter((row) => row.sensitivity === sensitivity);
    const shots = own.reduce((total, row) => total + row.shots, 0);
    const hits = own.reduce((total, row) => total + row.hits, 0);
    return {
      sensitivity,
      score: weightSum ? Number((weighted / weightSum).toFixed(1)) : 0,
      accuracy: shots ? Math.min(1, hits / shots) : 0,
      shots,
      hits,
      deviation: own.reduce((total, row) => total + row.deviation, 0) / own.length,
      stability: own.reduce((total, row) => total + row.stability, 0) / own.length,
    };
  }).sort((a, b) => b.score - a.score || b.accuracy - a.accuracy || a.deviation - b.deviation);
  if (!scored.length) return null;

  const best = scored[0];
  const runnerUp = scored[1] ?? best;
  const spread = best.score - runnerUp.score;

  const candidatesSorted = scored.map((row) => row.sensitivity).sort((a, b) => a - b);
  const minCandidate = candidatesSorted[0];
  const maxCandidate = candidatesSorted[candidatesSorted.length - 1];
  // 手感是乘法关系：峰值搜索在对数坐标上进行（等比档距 = 等手感间距），结果再换回线性值。
  const lnMin = Math.log(minCandidate);
  const lnMax = Math.log(maxCandidate);
  const lnSpacing = (lnMax - lnMin) / Math.max(candidatesSorted.length - 1, 1);

  const fit = quadraticFit(scored.map((row) => ({ x: Math.log(row.sensitivity), y: row.score })));
  const fitPeakLn = fit ? -fit.b / (2 * fit.a) : null;
  const fitPeak = fitPeakLn != null ? Number(Math.exp(fitPeakLn).toFixed(2)) : null;
  const bestIndex = candidatesSorted.indexOf(best.sensitivity);
  const interior = fitPeakLn != null
    ? fitPeakLn >= lnMin + lnSpacing * 0.15 && fitPeakLn <= lnMax - lnSpacing * 0.15
    : bestIndex > 0 && bestIndex < candidatesSorted.length - 1;

  const clampLn = (value) => Number(Math.max(lnMin, Math.min(lnMax, value))).valueOf();
  const clamp = (value) => Number(Math.max(minCandidate, Math.min(maxCandidate, value)).toFixed(2));
  // 推荐值只取实测档位：拟合峰值仅用于建议区间与参考说明，避免推荐一个没测过的值。
  const recommended = best.sensitivity;
  let range;
  if (interior && fitPeakLn != null) {
    range = [
      Number(Math.exp(clampLn(fitPeakLn - lnSpacing)).toFixed(2)),
      Number(Math.exp(clampLn(fitPeakLn + lnSpacing)).toFixed(2)),
    ];
  } else {
    range = [candidatesSorted[Math.max(0, bestIndex - 1)], candidatesSorted[Math.min(candidatesSorted.length - 1, bestIndex + 1)]];
  }

  const plateau = scored.filter((row) => best.score - row.score <= Math.max(best.score * 0.04, 1)).length;
  const meanScore = scored.reduce((total, row) => total + row.score, 0) / scored.length;
  const spreadPct = meanScore ? spread / meanScore : 0;
  const confidence = spreadPct >= 0.05 && interior && plateau <= 2 ? 'high' : spreadPct >= 0.02 && interior ? 'medium' : 'low';

  // 条件复测自检：分差明显 + 峰值在档位区间内部 + 环节结论一致（≥3 个环节最优落在前二之间）
  // 三条全过 = 初测数据自洽，可跳过复测直接出结果；任一不过才触发复测仲裁。
  const topTwo = new Set(scored.slice(0, 2).map((row) => row.sensitivity));
  const agreementCount = TEST_TYPE_IDS.filter((typeId) => {
    const segmentBest = bestPerType[typeId];
    return segmentBest && topTwo.has(segmentBest.sensitivity);
  }).length;
  const stable = spreadPct >= 0.05 && interior && agreementCount >= 3;

  return {
    scored,
    recommendedSensitivity: recommended,
    fitPeak: fitPeak != null ? Number(fitPeak.toFixed(2)) : null,
    range,
    confidence,
    significant: spreadPct >= 0.02 && interior,
    interior,
    spreadPct,
    agreementCount,
    stable,
    perType,
    bestPerType,
  };
}

export function shouldAcceptShot(type, hasVisibleTarget) {
  if (type === 'tracking') return false;
  return type !== 'single' || hasVisibleTarget;
}

// 空枪归因：把一发空枪记到角度最近的目标上。flick 轮目标池多球同屏，空枪若记为
// “无主”（-1），拉枪分析按 targetIndex 找“该目标的第一枪”时只会看到命中枪，
// 首发命中率/二次修正幅度/微调准确会结构性失真（恒 100% / 0 / —）。
export function nearestTargetIndex(cursor, targets) {
  let bestIndex = -1;
  let bestDist = Infinity;
  for (const target of targets) {
    const dist = Math.hypot(cursor.xDeg - target.xDeg, cursor.yDeg - target.yDeg);
    if (dist < bestDist) {
      bestDist = dist;
      bestIndex = target.index;
    }
  }
  return bestIndex;
}

// ---- 拉枪轨迹分析 ----
// 判定口径对齐业内做法：朝目标 127°/s 视为启动；点击前 50ms 窗口均速 ≤ 8°/s 视为停点；
// 停点误差按目标角半径归一化，目标内的正常停点波动不计入真实过冲/欠冲。
export const FLICK_INITIATION_SPEED_DEG_S = 127;
export const FLICK_STOP_SPEED_DEG_S = 8;
export const FLICK_STOP_WINDOW_MS = 50;
export const MIN_REACTION_MS = 100;

export function classifyDirectionBias(bias) {
  if (bias == null || !Number.isFinite(bias)) return '—';
  if (bias < -0.5) return '明显欠冲';
  if (bias < -0.15) return '轻微欠冲';
  if (bias <= 0.15) return '平衡';
  if (bias <= 0.5) return '轻微过冲';
  return '明显过冲';
}

function sampleSpeedDegS(a, b) {
  const dt = (b.t - a.t) / 1000;
  if (dt <= 0) return 0;
  return Math.hypot(b.xDeg - a.xDeg, b.yDeg - a.yDeg) / dt;
}

function lowerBoundIndex(samples, time) {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (samples[mid].t < time) low = mid + 1;
    else high = mid;
  }
  return low;
}

function buildPathPrefix(samples) {
  const prefix = new Array(samples.length).fill(0);
  for (let i = 1; i < samples.length; i += 1) {
    prefix[i] = prefix[i - 1] + Math.hypot(samples[i].xDeg - samples[i - 1].xDeg, samples[i].yDeg - samples[i - 1].yDeg);
  }
  return prefix;
}

function windowMeanSpeed(samples, prefix, index) {
  const start = samples[index].t;
  const endIndex = Math.min(lowerBoundIndex(samples, start + FLICK_STOP_WINDOW_MS) - 1, samples.length - 1);
  if (endIndex <= index) return null;
  const dt = (samples[endIndex].t - start) / 1000;
  if (dt <= 0) return null;
  return (prefix[endIndex] - prefix[index]) / dt;
}

// 输入一次 flick 轮的原始记录：
//   samples: [{t, xDeg, yDeg}] 角度空间轨迹；targets: [{index, spawnT, xDeg, yDeg, angularHalfDeg}]；
//   clicks: [{t, xDeg, yDeg, hit, targetIndex}]（按时间升序）。
// 返回该轮的拉枪指标聚合；样本不足时对应字段为 null。
export function analyzeFlickRound({ samples, targets, clicks }) {
  if (!Array.isArray(samples) || samples.length < 2 || !Array.isArray(targets) || !targets.length) return null;
  const prefix = buildPathPrefix(samples);
  const safeClicks = Array.isArray(clicks) ? clicks : [];

  const perTarget = targets.map((target) => {
    const targetClicks = safeClicks.filter((click) => click.targetIndex === target.index);
    const firstClick = targetClicks[0] ?? null;
    const killClick = targetClicks.find((click) => click.hit) ?? null;
    const startIndex = lowerBoundIndex(samples, target.spawnT);
    const endIndex = firstClick
      ? Math.max(0, Math.min(lowerBoundIndex(samples, firstClick.t + 0.5) - 1, samples.length - 1))
      : samples.length - 1;

    let initiation = null;
    for (let i = Math.max(startIndex, 1); i <= endIndex; i += 1) {
      if (sampleSpeedDegS(samples[i - 1], samples[i]) < FLICK_INITIATION_SPEED_DEG_S) continue;
      const moveX = samples[i].xDeg - samples[i - 1].xDeg;
      const moveY = samples[i].yDeg - samples[i - 1].yDeg;
      if ((target.xDeg - samples[i - 1].xDeg) * moveX + (target.yDeg - samples[i - 1].yDeg) * moveY > 0) {
        initiation = samples[i];
        break;
      }
    }

    let stopSample = null;
    for (let i = endIndex; i >= startIndex; i -= 1) {
      const meanSpeed = windowMeanSpeed(samples, prefix, i);
      if (meanSpeed != null && meanSpeed <= FLICK_STOP_SPEED_DEG_S) {
        stopSample = samples[i];
        break;
      }
    }
    if (!stopSample) stopSample = samples[endIndex];

    const origin = samples[startIndex];
    const axisX = target.xDeg - origin.xDeg;
    const axisY = target.yDeg - origin.yDeg;
    const axisLength = Math.hypot(axisX, axisY);
    const unitX = axisLength > 1e-6 ? axisX / axisLength : 1;
    const unitY = axisLength > 1e-6 ? axisY / axisLength : 0;
    const signedError = (sample) => ((sample.xDeg - target.xDeg) * unitX + (sample.yDeg - target.yDeg) * unitY) / target.angularHalfDeg;
    const stopError = signedError(stopSample);

    let peakError = stopError;
    for (let i = Math.max(startIndex, 1); i <= endIndex; i += 1) {
      const error = signedError(samples[i]);
      if (error > peakError) peakError = error;
    }

    const trueOvershoot = (peakError > 1 && stopError < 1) || (stopError > 1 && firstClick != null && !firstClick.hit);
    const trueUndershoot = stopError < -1;

    let adjustMagnitude = null;
    if (killClick) {
      const killIndex = Math.min(lowerBoundIndex(samples, killClick.t), samples.length - 1);
      adjustMagnitude = firstClick && !firstClick.hit
        ? Math.max(0, prefix[killIndex] - prefix[endIndex])
        : 0;
    }

    let pathEfficiency = null;
    const endClick = killClick ?? firstClick;
    if (endClick && axisLength > 1e-6) {
      const endIndexFull = Math.min(lowerBoundIndex(samples, endClick.t), samples.length - 1);
      const traveled = prefix[endIndexFull] - prefix[startIndex];
      if (traveled >= 1) pathEfficiency = Math.min(1, axisLength / traveled);
    }

    return {
      initiated: initiation != null,
      initiationDelayMs: initiation ? initiation.t - target.spawnT : null,
      stopError,
      trueOvershoot,
      trueUndershoot,
      missed: firstClick != null && !firstClick.hit,
      killedAfterMiss: firstClick != null && !firstClick.hit && killClick != null,
      adjustMagnitude,
      pathEfficiency,
      firstShotHit: firstClick != null && firstClick.hit,
      hasClick: firstClick != null,
    };
  });

  const clicked = perTarget.filter((item) => item.hasClick);
  const initiated = perTarget.filter((item) => item.initiated);
  const stopped = clicked.filter((item) => Number.isFinite(item.stopError));
  const missed = clicked.filter((item) => item.missed);
  const killedAfterMiss = clicked.filter((item) => item.killedAfterMiss);
  const adjusted = clicked.filter((item) => item.adjustMagnitude != null);
  const efficient = clicked.filter((item) => item.pathEfficiency != null);
  const mean = (values) => (values.length ? values.reduce((total, value) => total + value, 0) / values.length : null);

  const t0 = samples[0].t;
  const binMs = 25;
  const binCount = Math.min(120, Math.max(1, Math.ceil((samples.at(-1).t - t0) / binMs)));
  const binMsExpanded = Math.max(binMs, (samples.at(-1).t - t0) / binCount);
  const bins = Array.from({ length: binCount }, () => ({ total: 0, count: 0 }));
  for (let i = 1; i < samples.length; i += 1) {
    const speed = sampleSpeedDegS(samples[i - 1], samples[i]);
    const binIndex = Math.min(binCount - 1, Math.floor((samples[i].t - t0) / binMsExpanded));
    bins[binIndex].total += speed;
    bins[binIndex].count += 1;
  }
  const speedCurve = bins.map((bin) => (bin.count ? Math.round(bin.total / bin.count) : 0));

  return {
    attempted: clicked.length,
    initiationDelayMs: mean(initiated.map((item) => item.initiationDelayMs)),
    directionBias: mean(stopped.map((item) => item.stopError)),
    overshootRate: clicked.length ? clicked.filter((item) => item.trueOvershoot).length / clicked.length : null,
    undershootRate: clicked.length ? clicked.filter((item) => item.trueUndershoot).length / clicked.length : null,
    adjustMagnitudeDeg: mean(adjusted.map((item) => item.adjustMagnitude)),
    adjustmentAccuracy: missed.length ? killedAfterMiss.length / missed.length : null,
    pathEfficiency: mean(efficient.map((item) => item.pathEfficiency)),
    firstShotHitRate: clicked.length ? clicked.filter((item) => item.firstShotHit).length / clicked.length : null,
    // 停点精度：各目标首次定位停点误差的绝对值均值（按目标角半径归一化，越小越贴圆心）。
    stopPrecision: mean(stopped.map((item) => Math.abs(item.stopError))),
    speedCurve,
  };
}

// 跨轮聚合：同一灵敏度的多轮 flick 指标取均值（每轮等权），方向倾向由均值重新分级。
export function aggregateFlickMetrics(rows) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.flick) continue;
    const list = groups.get(row.sensitivity) ?? [];
    list.push(row.flick);
    groups.set(row.sensitivity, list);
  }
  const result = {};
  for (const [sensitivity, flicks] of groups) {
    const mean = (pick) => {
      const values = flicks.map(pick).filter((value) => value != null && Number.isFinite(value));
      return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
    };
    const directionBias = mean((flick) => flick.directionBias);
    result[sensitivity] = {
      rounds: flicks.length,
      initiationDelayMs: mean((flick) => flick.initiationDelayMs),
      directionBias,
      directionLabel: classifyDirectionBias(directionBias),
      overshootRate: mean((flick) => flick.overshootRate),
      undershootRate: mean((flick) => flick.undershootRate),
      adjustMagnitudeDeg: mean((flick) => flick.adjustMagnitudeDeg),
      adjustmentAccuracy: mean((flick) => flick.adjustmentAccuracy),
      pathEfficiency: mean((flick) => flick.pathEfficiency),
      firstShotHitRate: mean((flick) => flick.firstShotHitRate),
    };
  }
  return result;
}

export function sanitizeHistory(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item.id === 'string' && typeof item.createdAt === 'string'
      && isPositiveNumber(item.recommendedSensitivity) && Number.isFinite(item.score))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .slice(-20);
}

const CONFIDENCE_WEIGHT = { high: 2, medium: 1.5, low: 1 };

// 多场次加权建议：按置信度给最近 N 次会话加权，并只聚合同一基准灵敏度（不同基准不可比）。
// history 需已按时间升序。返回 null 表示数据不足。
export function aggregateRecommendations(history, { recent = 5 } = {}) {
  if (!Array.isArray(history) || !history.length) return null;
  const sessions = history.filter((session) => isPositiveNumber(session.recommendedSensitivity) && Number.isFinite(session.score)).slice(-recent);
  if (!sessions.length) return null;
  // 以最近一次会话的基准作为聚合基准；旧数据缺 baseSensitivity 时视为同基准。
  const base = sessions.at(-1).baseSensitivity ?? null;
  const group = base == null ? sessions : sessions.filter((session) => session.baseSensitivity === base);
  if (!group.length) return null;
  let weightSum = 0;
  let weighted = 0;
  const values = group.map((session) => session.recommendedSensitivity);
  for (const session of group) {
    const weight = CONFIDENCE_WEIGHT[session.confidence] || 1;
    weightSum += weight;
    weighted += session.recommendedSensitivity * weight;
  }
  return {
    value: Number((weighted / weightSum).toFixed(2)),
    min: Math.min(...values),
    max: Math.max(...values),
    count: group.length,
  };
}