import test from 'node:test';
import assert from 'node:assert/strict';

import { requestRawPointerLock, POINTER_LOCK_FALLBACK_MESSAGE } from '../engine.js';

// unadjustedMovement 修复的回归测试：
// Windows 上 Chromium 的 requestPointerLock 默认应用 OS 指针加速曲线（“提高指针精确度”），
// movementX/Y 被放大/压扁，导致“快甩过冲、接近目标时准星粘滞（卡一下）”。
// 修复 = 调用时传 { unadjustedMovement: true }；浏览器不支持时（NotSupportedError）降级为普通锁定并提示。

function mockElement(errors = []) {
  const calls = [];
  const pendingErrors = [...errors];
  return {
    calls,
    requestPointerLock(options) {
      calls.push(options);
      if (pendingErrors.length) return Promise.reject(pendingErrors.shift());
      return Promise.resolve();
    },
  };
}

test('requestRawPointerLock requests unadjusted movement so OS pointer acceleration cannot distort input', async () => {
  const element = mockElement();
  const reasons = [];
  const result = await requestRawPointerLock(element, (reason) => reasons.push(reason));
  assert.equal(result, true);
  assert.equal(element.calls.length, 1);
  assert.deepEqual(element.calls[0], { unadjustedMovement: true });
  assert.equal(reasons.length, 0);
});

test('requestRawPointerLock falls back to a plain lock when the browser rejects unadjustedMovement', async () => {
  const element = mockElement([Object.assign(new Error('not supported here'), { name: 'NotSupportedError' })]);
  const reasons = [];
  const result = await requestRawPointerLock(element, (reason) => reasons.push(reason));
  assert.equal(result, true);
  assert.equal(element.calls.length, 2);
  assert.deepEqual(element.calls[0], { unadjustedMovement: true });
  assert.deepEqual(element.calls[1], undefined);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /提高指针精确度/);
});

test('requestRawPointerLock reports failure when even the plain lock request rejects', async () => {
  const element = mockElement([
    Object.assign(new Error('nope'), { name: 'NotSupportedError' }),
    Object.assign(new Error('user gesture required'), { name: 'NotAllowedError' }),
  ]);
  const reasons = [];
  const result = await requestRawPointerLock(element, (reason) => reasons.push(reason));
  assert.equal(result, false);
  assert.equal(element.calls.length, 2);
  assert.equal(reasons.length, 1);
});

test('requestRawPointerLock reports the degradation kind so the UI can badge raw-input status', async () => {
  const element = mockElement([Object.assign(new Error('not supported here'), { name: 'NotSupportedError' })]);
  const kinds = [];
  await requestRawPointerLock(element, (reason, kind) => kinds.push(kind));
  assert.deepEqual(kinds, ['unsupported'], '降级锁定应上报 unsupported，供“原始输入”徽章显示降级状态');

  const rejecting = mockElement([
    Object.assign(new Error('nope'), { name: 'NotSupportedError' }),
    Object.assign(new Error('user gesture required'), { name: 'NotAllowedError' }),
  ]);
  const rejectKinds = [];
  await requestRawPointerLock(rejecting, (reason, kind) => rejectKinds.push(kind));
  assert.deepEqual(rejectKinds, ['rejected'], '锁定被整体拒绝应上报 rejected，不应污染原始输入徽章');
});

test('POINTER_LOCK_FALLBACK_MESSAGE tells the user to disable OS pointer acceleration', () => {
  assert.match(POINTER_LOCK_FALLBACK_MESSAGE, /提高指针精确度/);
});
