import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyMouseDelta,
  buildCandidates,
  calculateRecommendation,
  getResolutionProfile,
  getGameFrame,
  isPositiveNumber,
  sanitizeHistory,
  shouldAcceptShot,
} from '../app.js';

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

test('applyMouseDelta ignores a single abnormal mouse event', () => {
  const cursor = { x: 50, y: 50 };
  assert.deepEqual(applyMouseDelta(cursor, 900, -900, 1), cursor);
});

test('applyMouseDelta preserves normal movement and keeps the cursor in bounds', () => {
  assert.deepEqual(applyMouseDelta({ x: 50, y: 50 }, 40, -30, 1), { x: 53.2, y: 47 });
  assert.deepEqual(applyMouseDelta({ x: 97, y: 3 }, 100, -100, 1), { x: 98, y: 2 });
});

test('buildCandidates creates five symmetric, rounded sensitivity values', () => {
  assert.deepEqual(buildCandidates(1), [0.76, 0.88, 1, 1.12, 1.24]);
  assert.deepEqual(buildCandidates(0.1), [0.08, 0.09, 0.1, 0.11, 0.12]);
});

test('isPositiveNumber accepts positive decimal input only', () => {
  assert.equal(isPositiveNumber('1.25'), true);
  assert.equal(isPositiveNumber('0'), false);
  assert.equal(isPositiveNumber('-1'), false);
  assert.equal(isPositiveNumber(''), false);
  assert.equal(isPositiveNumber('0.001'), false);
  assert.equal(isPositiveNumber('0.05'), false);
});

test('calculateRecommendation favors accuracy, speed, and consistency together', () => {
  const result = calculateRecommendation([
    { sensitivity: 0.88, shots: 20, hits: 18, elapsedMs: 22000, deviation: 0.38, stability: 0.4 },
    { sensitivity: 1, shots: 20, hits: 19, elapsedMs: 19000, deviation: 0.24, stability: 0.18 },
    { sensitivity: 1.12, shots: 20, hits: 16, elapsedMs: 17000, deviation: 0.55, stability: 0.62 },
  ]);

  assert.equal(result.recommendedSensitivity, 1);
  assert.deepEqual(result.range, [0.88, 1.12]);
  assert.equal(result.confidence, 'high');
});

test('calculateRecommendation clamps impossible accuracy to 100 percent', () => {
  const result = calculateRecommendation([
    { sensitivity: 0.9, shots: 1, hits: 12, elapsedMs: 15000, deviation: 0.2, stability: 0.2 },
    { sensitivity: 1, shots: 100, hits: 55, elapsedMs: 15000, deviation: 0.4, stability: 0.4 },
  ]);

  assert.ok(result.scored.every((row) => row.accuracy <= 1));
});

test('sanitizeHistory keeps the ten newest valid sessions', () => {
  const history = Array.from({ length: 12 }, (_, index) => ({
    id: String(index),
    createdAt: `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    recommendedSensitivity: 1 + index / 100,
    score: 70 + index,
  }));

  const result = sanitizeHistory([...history, { malformed: true }]);
  assert.equal(result.length, 10);
  assert.equal(result[0].id, '2');
  assert.equal(result.at(-1).id, '11');
});

test('shouldAcceptShot blocks reaction clicks until a visible target exists', () => {
  assert.equal(shouldAcceptShot('reaction', false), false);
  assert.equal(shouldAcceptShot('reaction', true), true);
  assert.equal(shouldAcceptShot('flick', false), true);
  assert.equal(shouldAcceptShot('tracking', true), false);
});
