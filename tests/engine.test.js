import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateFlickMetrics,
  aggregateRecommendations,
  angleOffsetToPercent,
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
  getHorizontalFovDeg,
  getResolutionProfile,
  getGameFrame,
  isPositiveNumber,
  parseAspect,
  percentToAngleOffset,
  quadraticFit,
  sanitizeHistory,
  selectFinalists,
  shouldAcceptShot,
  nearestTargetIndex,
  stepTrackingProgress,
  stepTrackingTarget,
  targetAngularHalfSizeDeg,
} from '../engine.js';

test('getResolutionProfile exposes common CS2 resolutions with their native aspect ratio', () => {
  assert.deepEqual(getResolutionProfile('1280x960'), { width: 1280, height: 960, aspect: '4 / 3', family: '4:3' });
  assert.deepEqual(getResolutionProfile('1920x1080'), { width: 1920, height: 1080, aspect: '16 / 9', family: '16:9' });
  assert.equal(getResolutionProfile('invalid'), null);
});

test('getGameFrame preserves a virtual resolution with black bars or stretch', () => {
  const profile = getResolutionProfile('1280x960');
  assert.deepEqual(getGameFrame(profile, 1920, 1080, 'letterbox'), { scaleX: 1.125, scaleY: 1.125, offsetX: 240, offsetY: 0 });
  assert.deepEqual(getGameFrame(profile, 1920, 1080, 'stretch'), { scaleX: 1.5, scaleY: 1.125, offsetX: 0, offsetY: 0 });
});

test('parseAspect reads CSS aspect ratio strings', () => {
  assert.equal(parseAspect('4 / 3'), 4 / 3);
  assert.equal(parseAspect('16 / 9'), 16 / 9);
  assert.equal(parseAspect('bogus'), null);
  assert.equal(parseAspect(null), null);
});

test('getHorizontalFovDeg follows the hor+ model with a constant vertical FOV', () => {
  assert.ok(Math.abs(getHorizontalFovDeg(4 / 3) - 90) < 0.01);
  assert.ok(Math.abs(getHorizontalFovDeg(16 / 9) - 106.26) < 0.01);
});

test('getFovBounds derives half angles from a resolution profile', () => {
  const bounds = getFovBounds(getResolutionProfile('1280x960'));
  assert.ok(Math.abs(bounds.hHalfDeg - 45) < 0.01);
  assert.ok(Math.abs(bounds.vHalfDeg - 36.87) < 0.01);
  const widescreen = getFovBounds(getResolutionProfile('1920x1080'));
  assert.ok(Math.abs(widescreen.hHalfDeg - 53.13) < 0.01);
});

test('angleOffsetToPercent and percentToAngleOffset are inverse tan projections', () => {
  assert.equal(angleOffsetToPercent(0, 90), 0);
  assert.ok(Math.abs(angleOffsetToPercent(45, 90) - 50) < 0.001, '4:3 视场边缘应投影到 ±50%');
  const roundTrip = percentToAngleOffset(50 + angleOffsetToPercent(30, getHorizontalFovDeg(16 / 9)), getHorizontalFovDeg(16 / 9));
  assert.ok(Math.abs(roundTrip - 30) < 0.0001);
});

test('targetAngularHalfSizeDeg converts screen percent width into degrees', () => {
  assert.ok(Math.abs(targetAngularHalfSizeDeg(4.4, getHorizontalFovDeg(16 / 9)) - 3.358) < 0.001);
});

const FOV_BOUNDS_4_3 = { hHalfDeg: 45, vHalfDeg: 36.86989764584402 };

test('applyMouseDelta clamps a single abnormal mouse event instead of dropping the frame', () => {
  const angles = { xDeg: 5, yDeg: -5 };
  const next = applyMouseDelta(angles, 2500, -2500, 1.2, FOV_BOUNDS_4_3);
  // 尖峰帧夹持到 MAX_RAW_POINTER_DELTA：视角连续移动 2000×0.022×1.2=52.8°（再被视锥夹持），
  // 而不是整帧丢弃造成“冻结一帧再跳回”的瞬移感。
  assert.ok(next.xDeg > angles.xDeg);
  assert.ok(next.yDeg < angles.yDeg);
  const saturated = applyMouseDelta({ xDeg: 0, yDeg: 0 }, 1e9, -1e9, 1.2, FOV_BOUNDS_4_3);
  assert.ok(Math.abs(saturated.xDeg) <= 45 * 0.98 + 1e-9);
  assert.ok(Math.abs(saturated.yDeg) <= 36.86989764584402 * 0.98 + 1e-9);
});

test('applyMouseDelta converts counts to degrees through the CS2 yaw constant', () => {
  const next = applyMouseDelta({ xDeg: 0, yDeg: 0 }, 100, -50, 1.2, FOV_BOUNDS_4_3);
  assert.ok(Math.abs(next.xDeg - 2.64) < 1e-9);
  assert.ok(Math.abs(next.yDeg - -1.32) < 1e-9);
});

test('applyMouseDelta clamps to the visible frustum', () => {
  const clamped = applyMouseDelta({ xDeg: 44, yDeg: -36 }, 100, -100, 2.4, FOV_BOUNDS_4_3);
  assert.ok(Math.abs(clamped.xDeg - 45 * 0.98) < 0.001);
  assert.ok(Math.abs(clamped.yDeg - -36.86989764584402 * 0.98) < 0.001);
});

test('buildCandidates creates five log-even candidates with a downward bias', () => {
  // 向下两步各 −15%，向上两步各 +12%（等比 = 等手感；最优更可能在当前值下方，下探更深）
  assert.deepEqual(buildCandidates(1), [0.76, 0.87, 1, 1.12, 1.25]);
  assert.deepEqual(buildCandidates(0.1), [0.08, 0.09, 0.1, 0.11, 0.13]);
});

test('isPositiveNumber accepts positive decimal input only', () => {
  assert.equal(isPositiveNumber('1.25'), true);
  assert.equal(isPositiveNumber('0'), false);
  assert.equal(isPositiveNumber('-1'), false);
  assert.equal(isPositiveNumber(''), false);
  assert.equal(isPositiveNumber('0.001'), false);
  assert.equal(isPositiveNumber('0.05'), false);
});

test('cmPer360 converts a sensitivity to mouse distance for a full turn', () => {
  assert.ok(Math.abs(cmPer360(2, 400) - 51.9545) < 0.01);
  assert.equal(cmPer360(1.2, 0), null);
  assert.equal(cmPer360('', 800), null);
});

test('buildMain tests the user-entered base first, then the other candidates shuffled', () => {
  const candidates = [0.9, 1, 1.1, 1.2, 1.3]; // index 2 = 1.1 为用户填写的基准档
  const rounds = buildMain(candidates);
  assert.equal(rounds.length, 20);
  const keys = new Set(rounds.map((r) => `${r.sensitivity}:${r.typeId}`));
  assert.equal(keys.size, 20, '每个 (候选, 类型) 组合应恰出现一次');
  for (const sensitivity of candidates) {
    for (const typeId of ['quad', 'tracking', 'hex', 'single']) {
      assert.ok(keys.has(`${sensitivity}:${typeId}`), `${sensitivity} 应测 ${typeId}`);
    }
  }
  assert.ok(rounds.every((r) => !r.quick && !r.warmup), '初测轮全部按完整时长计分');
  assert.ok(rounds.every((r) => r.durationMs === 20000), '定时制：每轮统一 20 秒');
  // 第一块固定是基准档，档内任务顺序固定 四目标→跟枪→六目标→单球。
  const firstBlock = rounds.slice(0, 4);
  assert.ok(firstBlock.every((r) => r.sensitivity === 1.1), '第一块应先测用户填写的基准档');
  assert.deepEqual(
    firstBlock.map((r) => r.typeId),
    ['quad', 'tracking', 'hex', 'single'],
    '档内任务顺序应为 四目标→跟枪→六目标→单球',
  );
  // 其余 4 档各占一块、先后随机，每档连测四项再换档。
  for (let block = 0; block < 5; block += 1) {
    const slice = rounds.slice(block * 4, block * 4 + 4);
    assert.equal(new Set(slice.map((r) => r.sensitivity)).size, 1, '每档应连测四项再换档');
  }
  const rest = rounds.slice(4);
  assert.equal(new Set(rest.map((r) => r.sensitivity)).size, 4, '其余 4 档各测一块');
});

test('buildRetest runs each finalist through all four tasks before the other', () => {
  const rounds = buildRetest([0.9, 1.0]);
  assert.equal(rounds.length, 8);
  const keys = new Set(rounds.map((r) => `${r.sensitivity}:${r.typeId}`));
  assert.equal(keys.size, 8, '每个 (候选, 类型) 组合应恰出现一次');
  for (const sensitivity of [0.9, 1.0]) {
    for (const typeId of ['quad', 'tracking', 'hex', 'single']) {
      assert.ok(keys.has(`${sensitivity}:${typeId}`), `${sensitivity} 应测 ${typeId}`);
    }
  }
  assert.ok(rounds.every((r) => !r.quick && !r.warmup), '复测轮按完整时长计分');
  assert.ok(rounds.every((r) => r.durationMs === 20000), '定时制：每轮统一 20 秒');
  assert.deepEqual(
    rounds.map((r) => r.typeId),
    Array.from({ length: 2 }, () => ['quad', 'tracking', 'hex', 'single']).flat(),
    '复测沿用同样的档内任务顺序',
  );
  for (let block = 0; block < 2; block += 1) {
    const slice = rounds.slice(block * 4, block * 4 + 4);
    assert.equal(new Set(slice.map((r) => r.sensitivity)).size, 1, '每档应连测四项再换档');
  }
  assert.equal(new Set(rounds.map((r) => r.sensitivity)).size, 2, '两档各测一块');
});

test('summarizeRetest checks whether the retest reproduces the initial ranking', () => {
  const main = [
    { sensitivity: 0.9, typeId: 'quad', phase: 'main', shots: 10, hits: 9, elapsedMs: 5000, deviation: 0.3, stability: 0.2 },
    { sensitivity: 0.9, typeId: 'tracking', phase: 'main', shots: 100, hits: 80, elapsedMs: 10000, deviation: 0.4, stability: 0.2 },
    { sensitivity: 0.9, typeId: 'hex', phase: 'main', shots: 10, hits: 9, elapsedMs: 5000, deviation: 0.3, stability: 0.2 },
    { sensitivity: 0.9, typeId: 'single', phase: 'main', shots: 8, hits: 7, elapsedMs: 5000, deviation: 0.3, stability: 0.2 },
    { sensitivity: 1.0, typeId: 'quad', phase: 'main', shots: 10, hits: 7, elapsedMs: 6000, deviation: 0.5, stability: 0.4 },
    { sensitivity: 1.0, typeId: 'tracking', phase: 'main', shots: 100, hits: 60, elapsedMs: 10000, deviation: 0.6, stability: 0.3 },
    { sensitivity: 1.0, typeId: 'hex', phase: 'main', shots: 10, hits: 7, elapsedMs: 6000, deviation: 0.5, stability: 0.4 },
    { sensitivity: 1.0, typeId: 'single', phase: 'main', shots: 8, hits: 6, elapsedMs: 5500, deviation: 0.4, stability: 0.3 },
  ];
  const recommendation = calculateRecommendation(main);
  assert.equal(recommendation.scored[0].sensitivity, 0.9, '初测 #1 应为 0.9');

  const agreeRounds = [
    ...['quad', 'tracking', 'hex', 'single'].map((typeId) => ({ sensitivity: 0.9, typeId, phase: 'retest', shots: 10, hits: 9, elapsedMs: 5000, deviation: 0.3, stability: 0.2 })),
    ...['quad', 'tracking', 'hex', 'single'].map((typeId) => ({ sensitivity: 1.0, typeId, phase: 'retest', shots: 10, hits: 7, elapsedMs: 6000, deviation: 0.5, stability: 0.4 })),
  ];
  const agreed = summarizeRetest([...main, ...agreeRounds], recommendation);
  assert.equal(agreed.agreed, true);
  assert.deepEqual(agreed.initialOrder, [0.9, 1.0]);
  assert.deepEqual(agreed.candidates, [0.9, 1.0]);
  assert.ok(agreed.gap > 0);

  const flipRounds = [
    ...['quad', 'tracking', 'hex', 'single'].map((typeId) => ({ sensitivity: 0.9, typeId, phase: 'retest', shots: 10, hits: 6, elapsedMs: 6000, deviation: 0.5, stability: 0.4 })),
    ...['quad', 'tracking', 'hex', 'single'].map((typeId) => ({ sensitivity: 1.0, typeId, phase: 'retest', shots: 10, hits: 9, elapsedMs: 5000, deviation: 0.3, stability: 0.2 })),
  ];
  const flipped = summarizeRetest([...main, ...flipRounds], recommendation);
  assert.equal(flipped.agreed, false, '复测推翻初测排名应判定为不一致');
  assert.deepEqual(flipped.candidates, [1.0, 0.9]);

  assert.equal(summarizeRetest(main, recommendation), null, '没有复测轮次时返回 null');
});

test('selectFinalists keeps the top candidates by combined score', () => {
  const scored = [
    { sensitivity: 0.8, score: 40, accuracy: 0.7, deviation: 0.2 },
    { sensitivity: 0.9, score: 50, accuracy: 0.5, deviation: 0.5 },
    { sensitivity: 1, score: 80, accuracy: 0.8, deviation: 0.3 },
    { sensitivity: 1.1, score: 60, accuracy: 0.6, deviation: 0.4 },
    { sensitivity: 1.2, score: 70, accuracy: 0.9, deviation: 0.1 },
  ];
  assert.deepEqual(selectFinalists(scored), [1, 1.2, 1.1]);
});

test('quadraticFit recovers a concave parabola and rejects degenerate fits', () => {
  const fit = quadraticFit([{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 1 }]);
  assert.ok(fit);
  assert.ok(Math.abs(fit.a - -2) < 0.01);
  assert.ok(Math.abs(fit.b - 4) < 0.01);
  assert.ok(Math.abs(fit.c - 1) < 0.01);
  assert.equal(quadraticFit([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]), null, '线性数据没有可靠的凸峰');
  assert.equal(quadraticFit([{ x: 1, y: 1 }, { x: 1, y: 2 }]), null, '少于 3 个不同 x 时不拟合');
});

test('computeSegmentScore is absolute and decomposable', () => {
  // 点击类：击杀×10 × √命中率 × 停点系数（停点误差 0.3 → 系数 0.75+0.45×0.8 = 1.11）
  const click = computeSegmentScore({ typeId: 'quad', hits: 10, shots: 20, deviation: 1.2, stopPrecision: 0.3 });
  assert.equal(click.base, 100);
  assert.ok(Math.abs(click.hitCoef - 0.707) < 0.001);
  assert.ok(Math.abs(click.stopCoef - 1.11) < 0.001);
  assert.ok(Math.abs(click.score - 78.5) < 0.1);
  // 跟枪：球数×20 × 贴迹系数（每帧角距 0.4 → 系数 1.11）
  const tracking = computeSegmentScore({ typeId: 'tracking', hits: 7, deviation: 0.4 });
  assert.equal(tracking.base, 140);
  assert.ok(Math.abs(tracking.stopCoef - 1.11) < 0.001);
  assert.ok(Math.abs(tracking.score - 155.4) < 0.1);
  // 缺停点数据时用中性锚点 0.5（系数 0.975），不炸不奖
  const neutral = computeSegmentScore({ typeId: 'single', hits: 10, shots: 10 });
  assert.equal(neutral.base, 100);
  assert.ok(Math.abs(neutral.stopCoef - 0.975) < 0.001);
  assert.ok(Math.abs(neutral.score - 97.5) < 0.1);
});

test('calculateRecommendation weights per-segment scores into a composite', () => {
  const make = (sensitivity, quadHits, trackingHits, hexHits, singleHits) => ([
    { sensitivity, typeId: 'quad', shots: 20, hits: quadHits, elapsedMs: 20000, deviation: 0.5, stability: 0.3, stopPrecision: 0.3 },
    { sensitivity, typeId: 'tracking', shots: 100, hits: trackingHits, elapsedMs: 20000, deviation: 0.5, stability: 0.3 },
    { sensitivity, typeId: 'hex', shots: 20, hits: hexHits, elapsedMs: 20000, deviation: 0.5, stability: 0.3, stopPrecision: 0.3 },
    { sensitivity, typeId: 'single', shots: 15, hits: singleHits, elapsedMs: 20000, deviation: 0.5, stability: 0.3, stopPrecision: 0.3 },
  ]);
  const result = calculateRecommendation([
    ...make(0.88, 8, 30, 8, 6),
    ...make(1, 16, 60, 15, 11),
    ...make(1.12, 7, 25, 6, 5),
  ]);

  assert.equal(result.scored[0].sensitivity, 1, '各环节全胜的档位综合分应最高');
  assert.ok(Math.abs(result.recommendedSensitivity - 1) < 0.05, '中位档全胜，拟合峰值应落在 1 附近');
  assert.deepEqual(result.range.map((value) => value.toFixed(1)), ['0.9', '1.1']);
  assert.equal(result.confidence, 'high');
  assert.equal(result.significant, true);
  assert.equal(result.stable, true, '分差明显 + 环节一致 + 峰值居中 → 初测自洽，可跳过复测');
});

test('calculateRecommendation splits rankings per task type', () => {
  const result = calculateRecommendation([
    { sensitivity: 0.9, typeId: 'quad', shots: 10, hits: 7, elapsedMs: 6000, deviation: 0.5, stability: 0.4 },
    { sensitivity: 1, typeId: 'quad', shots: 10, hits: 9, elapsedMs: 5000, deviation: 0.3, stability: 0.2 },
    { sensitivity: 0.9, typeId: 'tracking', shots: 100, hits: 60, elapsedMs: 10000, deviation: 0.8, stability: 0.3 },
    { sensitivity: 1, typeId: 'tracking', shots: 100, hits: 70, elapsedMs: 10000, deviation: 0.6, stability: 0.25 },
  ]);

  assert.equal(result.perType.quad[0].sensitivity, 1);
  assert.equal(result.perType.tracking[0].sensitivity, 1);
  assert.equal(result.bestPerType.quad.sensitivity, 1);
  assert.deepEqual(result.perType.quad.map((row) => row.sensitivity), [1, 0.9]);
});

test('calculateRecommendation marks a boundary peak as low confidence', () => {
  const result = calculateRecommendation([
    { sensitivity: 1, typeId: 'quad', shots: 10, hits: 10, elapsedMs: 4000, deviation: 0.2, stability: 0.1 },
    { sensitivity: 2, typeId: 'quad', shots: 10, hits: 5, elapsedMs: 6000, deviation: 0.5, stability: 0.5 },
    { sensitivity: 3, typeId: 'quad', shots: 10, hits: 2, elapsedMs: 8000, deviation: 0.9, stability: 0.9 },
  ]);

  assert.equal(result.recommendedSensitivity, 1);
  assert.equal(result.confidence, 'low');
  assert.equal(result.significant, false);
  assert.equal(result.stable, false, '峰值贴边 → 必须复测仲裁');
});

test('calculateRecommendation bases the verdict on main (initial-test) rounds only', () => {
  const result = calculateRecommendation([
    { sensitivity: 0.6, typeId: 'quad', phase: 'stage1', shots: 5, hits: 5, elapsedMs: 3000, deviation: 0.2, stability: 0.1 },
    { sensitivity: 0.7, typeId: 'quad', phase: 'stage1', shots: 5, hits: 5, elapsedMs: 3100, deviation: 0.25, stability: 0.12 },
    { sensitivity: 0.8, typeId: 'quad', phase: 'stage1', shots: 5, hits: 5, elapsedMs: 3200, deviation: 0.3, stability: 0.14 },
    { sensitivity: 0.6, typeId: 'quad', phase: 'main', shots: 8, hits: 8, elapsedMs: 4000, deviation: 0.2, stability: 0.1 },
    { sensitivity: 0.7, typeId: 'quad', phase: 'main', shots: 8, hits: 8, elapsedMs: 4200, deviation: 0.24, stability: 0.12 },
    { sensitivity: 0.8, typeId: 'quad', phase: 'main', shots: 8, hits: 7, elapsedMs: 4600, deviation: 0.35, stability: 0.2 },
    { sensitivity: 0.6, typeId: 'tracking', phase: 'main', shots: 100, hits: 60, elapsedMs: 10000, deviation: 0.7, stability: 0.3 },
    { sensitivity: 0.7, typeId: 'tracking', phase: 'main', shots: 100, hits: 90, elapsedMs: 10000, deviation: 0.4, stability: 0.15 },
    { sensitivity: 0.8, typeId: 'tracking', phase: 'main', shots: 100, hits: 85, elapsedMs: 10000, deviation: 0.5, stability: 0.2 },
    { sensitivity: 0.6, typeId: 'hex', phase: 'main', shots: 8, hits: 7, elapsedMs: 5000, deviation: 0.3, stability: 0.2 },
    { sensitivity: 0.7, typeId: 'hex', phase: 'main', shots: 8, hits: 8, elapsedMs: 4500, deviation: 0.25, stability: 0.15 },
    { sensitivity: 0.8, typeId: 'hex', phase: 'main', shots: 8, hits: 6, elapsedMs: 4800, deviation: 0.4, stability: 0.25 },
  ]);

  // 综合判定只包含初测（main）轮次，不掺入其他阶段的轮次。
  assert.deepEqual(result.scored.map((row) => row.sensitivity).sort(), [0.6, 0.7, 0.8]);
  assert.equal(result.scored[0].sensitivity, 0.7);
  // 分环节表只统计初测轮次；stage1 的四目标参考分不参与（长度按初测档位数计）。
  assert.equal(result.perType.quad.length, 3);
});

test('calculateRecommendation clamps impossible accuracy to 100 percent', () => {
  const result = calculateRecommendation([
    { sensitivity: 0.9, typeId: 'quad', shots: 1, hits: 12, elapsedMs: 15000, deviation: 0.2, stability: 0.2 },
    { sensitivity: 1, typeId: 'quad', shots: 100, hits: 55, elapsedMs: 15000, deviation: 0.4, stability: 0.4 },
  ]);

  assert.ok(result.scored.every((row) => row.accuracy <= 1));
});

test('sanitizeHistory keeps the twenty newest valid sessions', () => {
  const history = Array.from({ length: 22 }, (_, index) => ({
    id: String(index),
    createdAt: `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    recommendedSensitivity: 1 + index / 100,
    score: 70 + index,
  }));

  const result = sanitizeHistory([...history, { malformed: true }]);
  assert.equal(result.length, 20);
  assert.equal(result[0].id, '2');
  assert.equal(result.at(-1).id, '21');
});

test('aggregateRecommendations weights recent sessions and groups by base sensitivity', () => {
  const history = [
    { id: 'a', createdAt: '2026-08-01T00:00:00.000Z', baseSensitivity: 0.8, recommendedSensitivity: 0.8, score: 90, confidence: 'high' },
    { id: 'b', createdAt: '2026-08-02T00:00:00.000Z', baseSensitivity: 2.0, recommendedSensitivity: 2.1, score: 92, confidence: 'high' },
    { id: 'c', createdAt: '2026-08-03T00:00:00.000Z', baseSensitivity: 0.8, recommendedSensitivity: 0.85, score: 95, confidence: 'medium' },
    { id: 'd', createdAt: '2026-08-04T00:00:00.000Z', baseSensitivity: 0.8, recommendedSensitivity: 0.9, score: 88, confidence: 'low' },
  ];
  // 最近 3 次 = [b,c,d]，按最近一次基准（0.8）分组，排除不同基准的 b。
  const result = aggregateRecommendations(history, { recent: 3 });
  assert.equal(result.count, 2);
  // c(medium=1.5)@0.85 + d(low=1)@0.9
  const expected = (0.85 * 1.5 + 0.9 * 1) / 2.5;
  assert.ok(Math.abs(result.value - expected) < 0.005);
  assert.deepEqual([result.min, result.max], [0.85, 0.9]);
  assert.equal(aggregateRecommendations([]), null);
});

test('shouldAcceptShot blocks single clicks until a visible target exists', () => {
  assert.equal(shouldAcceptShot('single', false), false);
  assert.equal(shouldAcceptShot('single', true), true);
  assert.equal(shouldAcceptShot('quad', false), true);
  assert.equal(shouldAcceptShot('tracking', true), false);
});

test('nearestTargetIndex attributes a missed shot to the closest live target', () => {
  const targets = [
    { index: 0, xDeg: -10, yDeg: 0 },
    { index: 1, xDeg: 8, yDeg: 0 },
  ];
  assert.equal(nearestTargetIndex({ xDeg: 6, yDeg: 0 }, targets), 1, '打到 1 号附近应归因 1 号');
  assert.equal(nearestTargetIndex({ xDeg: -9, yDeg: 0 }, targets), 0);
  assert.equal(nearestTargetIndex({ xDeg: 3, yDeg: 0 }, targets), 1, '等距时取严格更近者');
  assert.equal(nearestTargetIndex({ xDeg: 0, yDeg: 0 }, []), -1, '无目标保持无主');
});

test('frameHygieneStats reports average, 1% low, and max frame time', () => {
  const smooth = Array.from({ length: 600 }, () => 17);
  const stats = frameHygieneStats(smooth);
  assert.ok(Math.abs(stats.avgFps - 1000 / 17) < 0.1);
  assert.ok(Math.abs(stats.onePercentLowFps - 1000 / 17) < 0.1, '平滑帧率的 1% low 应贴近均值');
  assert.equal(stats.maxFrameMs, 17);
  assert.equal(frameHygieneStats([10, 20, 15]), null, '样本太少不给结论');
  assert.equal(frameHygieneStats(null), null);
});

test('frameHygieneIssue flags spikes and stutter that averages dilute away', () => {
  const smooth = Array.from({ length: 600 }, () => 17);
  assert.equal(frameHygieneIssue(frameHygieneStats(smooth)), null);
  // 单帧 400ms 尖刺：均值仍 >45 FPS，但应被最大单帧判据抓住
  const spiked = [...smooth, 400];
  assert.match(frameHygieneIssue(frameHygieneStats(spiked)), /单帧卡顿/);
  // 无大尖刺的持续顿挫（70ms 帧）：只有 1% low 能发现
  const stutter = [...Array.from({ length: 95 }, () => 17), ...Array.from({ length: 5 }, () => 70)];
  assert.match(frameHygieneIssue(frameHygieneStats(stutter)), /1% low/);
  const slow = Array.from({ length: 100 }, () => 30);
  assert.match(frameHygieneIssue(frameHygieneStats(slow)), /平均/);
  assert.equal(frameHygieneIssue(null), null);
});

test('classifyDirectionBias buckets the normalized stop error', () => {
  assert.equal(classifyDirectionBias(-0.8), '明显欠冲');
  assert.equal(classifyDirectionBias(-0.3), '轻微欠冲');
  assert.equal(classifyDirectionBias(0.1), '平衡');
  assert.equal(classifyDirectionBias(0.4), '轻微过冲');
  assert.equal(classifyDirectionBias(1.2), '明显过冲');
  assert.equal(classifyDirectionBias(null), '—');
});

test('analyzeFlickRound returns null without usable samples', () => {
  assert.equal(analyzeFlickRound({ samples: [], targets: [], clicks: [] }), null);
  assert.equal(analyzeFlickRound({ samples: [{ t: 0, xDeg: 0, yDeg: 0 }], targets: [{ index: 0, spawnT: 0, xDeg: 1, yDeg: 0, angularHalfDeg: 1 }], clicks: [] }), null);
});

test('analyzeFlickRound measures initiation, stop bias, and one-shot efficiency', () => {
  const samples = [
    { t: 0, xDeg: 0, yDeg: 0 },
    { t: 100, xDeg: 0, yDeg: 0 },
    { t: 200, xDeg: 0, yDeg: 0 },
    { t: 250, xDeg: 9, yDeg: 0 },
    { t: 350, xDeg: 9, yDeg: 0 },
    { t: 450, xDeg: 9, yDeg: 0 },
  ];
  const targets = [{ index: 0, spawnT: 0, xDeg: 10, yDeg: 0, angularHalfDeg: 3 }];
  const clicks = [{ t: 460, xDeg: 9, yDeg: 0, hit: true, targetIndex: 0 }];

  const result = analyzeFlickRound({ samples, targets, clicks });
  assert.equal(result.attempted, 1);
  assert.equal(result.initiationDelayMs, 250);
  assert.ok(Math.abs(result.directionBias - (-1 / 3)) < 0.001, '停在目标内 1/3 半径处');
  assert.equal(result.overshootRate, 0);
  assert.equal(result.undershootRate, 0);
  assert.equal(result.adjustMagnitudeDeg, 0, '一枪命中的微调幅度为 0');
  assert.equal(result.adjustmentAccuracy, null, '没有空枪就没有修正准确度');
  assert.equal(result.firstShotHitRate, 1);
  assert.ok(Math.abs(result.pathEfficiency - 1) < 0.001, '直线拉枪路径效率应为 1');
});

test('analyzeFlickRound detects a true overshoot followed by a correction', () => {
  const samples = [
    { t: 900, xDeg: 9, yDeg: 0 },
    { t: 1000, xDeg: 9, yDeg: 0 },
    { t: 1150, xDeg: -15, yDeg: 0 },
    { t: 1350, xDeg: -15, yDeg: 0 },
    { t: 1460, xDeg: -11.5, yDeg: 0 },
    { t: 1560, xDeg: -11.5, yDeg: 0 },
  ];
  const targets = [{ index: 0, spawnT: 1000, xDeg: -12, yDeg: 0, angularHalfDeg: 2 }];
  const clicks = [
    { t: 1360, xDeg: -15, yDeg: 0, hit: false, targetIndex: 0 },
    { t: 1570, xDeg: -11.5, yDeg: 0, hit: true, targetIndex: 0 },
  ];

  const result = analyzeFlickRound({ samples, targets, clicks });
  assert.equal(result.initiationDelayMs, 150);
  assert.ok(Math.abs(result.directionBias - 1.5) < 0.001, '停在越过远边界 1.5 倍半径处');
  assert.equal(result.overshootRate, 1, '越过边界且空枪应计为真实过冲');
  assert.equal(result.undershootRate, 0);
  assert.ok(Math.abs(result.adjustMagnitudeDeg - 3.5) < 0.001, '修正幅度 = 停点到击杀的路径');
  assert.equal(result.adjustmentAccuracy, 1);
  assert.equal(result.firstShotHitRate, 0);
  assert.ok(Math.abs(result.pathEfficiency - (21 / 27.5)) < 0.001);
  assert.ok(Math.max(...result.speedCurve) >= 150, '速度曲线应捕捉到拉枪峰值');
});

test('aggregateFlickMetrics averages rounds per sensitivity and reclassifies bias', () => {
  const rows = [
    { sensitivity: 1, flick: { initiationDelayMs: 200, directionBias: -0.2, overshootRate: 0, undershootRate: 0.5, adjustMagnitudeDeg: 1, adjustmentAccuracy: null, pathEfficiency: 0.9, firstShotHitRate: 0.8 } },
    { sensitivity: 1, flick: { initiationDelayMs: 300, directionBias: 0.4, overshootRate: 0.5, undershootRate: 0, adjustMagnitudeDeg: 3, adjustmentAccuracy: 1, pathEfficiency: null, firstShotHitRate: 0.6 } },
    { sensitivity: 1.2, flick: { initiationDelayMs: 150, directionBias: 0, overshootRate: 0, undershootRate: 0, adjustMagnitudeDeg: 0, adjustmentAccuracy: null, pathEfficiency: 1, firstShotHitRate: 1 } },
  ];

  const aggregated = aggregateFlickMetrics(rows);
  assert.equal(aggregated[1].rounds, 2);
  assert.ok(Math.abs(aggregated[1].initiationDelayMs - 250) < 1e-9);
  assert.ok(Math.abs(aggregated[1].directionBias - 0.1) < 1e-9);
  assert.equal(aggregated[1].directionLabel, '平衡');
  assert.ok(Math.abs(aggregated[1].overshootRate - 0.25) < 1e-9);
  assert.ok(Math.abs(aggregated[1].adjustMagnitudeDeg - 2) < 1e-9);
  assert.equal(aggregated[1].pathEfficiency, 0.9, 'null 字段不参与均值');
  assert.equal(aggregated[1.2].firstShotHitRate, 1);
  assert.deepEqual(Object.keys(aggregateFlickMetrics([])), []);
});

test('stepTrackingTarget moves horizontally, reverses direction, and clamps to the arena', () => {
  const bounds = { hHalfDeg: 45, vHalfDeg: 36.87 };
  const base = { xDeg: 0, yDeg: 0, dirDeg: 1, speed: 12, segmentLeftS: 10, pauseLeftS: 0, swayPhase: 0 };
  const r1 = stepTrackingTarget(base, 0.1, bounds);
  assert.ok(r1.state.xDeg > 0, '向右移动');
  assert.ok(r1.state.yDeg !== 0, '上下正弦浮动生效');
  // 反向：segment 到期后 dirDeg 翻转
  const turning = { ...base, segmentLeftS: 0.05 };
  const r2 = stepTrackingTarget(turning, 0.1, bounds);
  assert.equal(r2.state.dirDeg, -1, '急停后反向');
  // 边界夹持：推到边界后强制反向
  const atEdge = { ...base, xDeg: 45 * 0.85, dirDeg: 1 };
  const r3 = stepTrackingTarget(atEdge, 0.1, bounds);
  assert.ok(r3.state.xDeg <= 45 * 0.85 + 1e-9, '不越过右边界');
  assert.equal(r3.state.dirDeg, -1, '撞墙反向');
  // 停顿帧：pauseLeftS > 0 时横移为 0
  const pausing = { ...base, pauseLeftS: 0.2 };
  const r4 = stepTrackingTarget(pausing, 0.05, bounds);
  assert.equal(r4.state.xDeg, base.xDeg, '停顿期间不横移');
  assert.ok(r4.state.pauseLeftS < 0.2, '停顿计时递减');
});

test('stepTrackingProgress drains the full bar while tracking and pauses off-target', () => {
  assert.ok(Math.abs(stepTrackingProgress(1, 0.6, true) - (1 - 0.6 / 1.2)) < 1e-9, '贴住 0.6s 减掉一半');
  assert.equal(stepTrackingProgress(1, 1.2, true), 0, '贴住 1.2s 减空');
  assert.equal(stepTrackingProgress(0.7, 0.5, false), 0.7, '脱靶时条暂停不减');
  assert.equal(stepTrackingProgress(0.01, 10, true), 0, '不低于 0');
});