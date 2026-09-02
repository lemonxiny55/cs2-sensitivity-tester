// audio.js — 零资产程序化音效层（Web Audio 实时合成，无任何音频文件）。
// 五种事件音：射击(枪响)、命中(双音上行 blip)、空枪(墙呜)、干火(轻嗒)、轮开始(短提示)。
// 浏览器自动播放策略：AudioContext 必须在用户手势后 resume；本工具的首次手势是点击“开始测试”。

const STORAGE_KEY = 'cs2-sensitivity-audio-v1';

const state = {
  ctx: null,
  master: null,
  fireVolume: 0.5,
  hitVolume: 0.7,
  enabled: true,
};

function ensureContext() {
  if (!state.ctx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    state.ctx = new Ctor();
    state.master = state.ctx.createGain();
    state.master.connect(state.ctx.destination);
  }
  if (state.ctx.state === 'suspended') state.ctx.resume().catch(() => {});
  return state.ctx;
}

function now() {
  return state.ctx.currentTime;
}

// 指数衰减包络：起音即时，末尾趋零（value<=0 时按 1e-4 处理，避免 math domain error）。
function expDecay(param, peak, duration) {
  const t = now();
  const floor = 1e-4;
  param.cancelScheduledValues(t);
  param.setValueAtTime(Math.max(peak, floor), t);
  param.exponentialRampToValueAtTime(floor, t + Math.max(duration, 0.01));
}

// 低通噪声脉冲 —— 枪声主体。白噪声经 lowpass + 快速指数衰减，模拟“砰”。
// 白噪声 buffer 预分配一次常驻复用：每枪现场生成 0.25s 缓冲（~24000 次 Math.random + ~192KB 分配）
// 会在连点时造成 GC 停顿，主观表现为鼠标卡顿；噪声波形本身不可闻差异，复用无副作用。
let noiseBuffer = null;

function getNoiseBuffer(ctx) {
  if (!noiseBuffer) {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 0.25 | 0, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
}

function playNoiseBurst({ duration, filterFrom, filterTo, gainPeak, when = 0 }) {
  const ctx = state.ctx;
  const t = now() + when;
  const source = ctx.createBufferSource();
  source.buffer = getNoiseBuffer(ctx);
  source.loop = true;

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  const floor = 40;
  filter.frequency.setValueAtTime(Math.max(filterFrom, floor), t);
  filter.frequency.exponentialRampToValueAtTime(Math.max(filterTo, floor), t + duration);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(Math.max(gainPeak, 1e-4), t);
  gain.gain.exponentialRampToValueAtTime(1e-4, t + duration);

  source.connect(filter).connect(gain).connect(state.master);
  source.start(t);
  source.stop(t + duration + 0.02);
}

// 短正弦 blip —— 命中反馈。可选滑音(fromFreq→toFreq)。
function playBlip({ fromFreq, toFreq, duration, gainPeak, when = 0, type = 'sine' }) {
  const ctx = state.ctx;
  const t = now() + when;
  const osc = ctx.createOscillator();
  osc.type = type;
  const floor = 1;
  osc.frequency.setValueAtTime(Math.max(fromFreq, floor), t);
  if (toFreq && toFreq !== fromFreq) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(toFreq, floor), t + duration);
  }

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(Math.max(gainPeak, 1e-4), t);
  gain.gain.exponentialRampToValueAtTime(1e-4, t + duration);

  osc.connect(gain).connect(state.master);
  osc.start(t);
  osc.stop(t + duration + 0.02);
}

// ---- 对外音效 API（每次调用先确保 ctx 存在且开启） ----

export function primeAudio() {
  ensureContext();
}

export function setAudioConfig({ fireVolume, hitVolume, enabled } = {}) {
  if (fireVolume != null) state.fireVolume = clamp01(fireVolume);
  if (hitVolume != null) state.hitVolume = clamp01(hitVolume);
  if (enabled != null) state.enabled = Boolean(enabled);
  persistConfig();
}

export function getAudioConfig() {
  return { fireVolume: state.fireVolume, hitVolume: state.hitVolume, enabled: state.enabled };
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

function persistConfig() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fireVolume: state.fireVolume, hitVolume: state.hitVolume, enabled: state.enabled }));
  } catch {
    // localStorage 不可用（隐私模式等）时静默降级为不持久化。
  }
}

export function loadAudioConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved.fireVolume != null) state.fireVolume = clamp01(saved.fireVolume);
      if (saved.hitVolume != null) state.hitVolume = clamp01(saved.hitVolume);
      if (saved.enabled != null) state.enabled = Boolean(saved.enabled);
    }
  } catch {
    // 配置损坏时用默认值。
  }
  persistConfig();
}

export function playShot() {
  if (!state.enabled || !ensureContext()) return;
  const v = state.fireVolume;
  // 主体：低通噪声 “砰”，滤镜从亮到闷快速下滑。
  playNoiseBurst({ duration: 0.11, filterFrom: 5200, filterTo: 320, gainPeak: 0.5 * v });
  // 加一层极短高频“啪”提升打击感。
  playNoiseBurst({ duration: 0.03, filterFrom: 9000, filterTo: 4500, gainPeak: 0.25 * v });
  // 低频“咚”身体感。
  playBlip({ fromFreq: 150, toFreq: 55, duration: 0.1, gainPeak: 0.35 * v, type: 'sine' });
}

export function playHit() {
  if (!state.enabled || !ensureContext()) return;
  const v = state.hitVolume;
  // 双音上行 blip（音高略带随机 ±4% 防止连续命中的机械感）。
  const wobble = 1 + (Math.random() * 0.08 - 0.04);
  playBlip({ fromFreq: 880 * wobble, toFreq: 1320 * wobble, duration: 0.07, gainPeak: 0.3 * v, type: 'triangle' });
  playBlip({ fromFreq: 1320 * wobble, toFreq: 1980 * wobble, duration: 0.06, gainPeak: 0.18 * v, when: 0.05, type: 'triangle' });
}

export function playMiss() {
  if (!state.enabled || !ensureContext()) return;
  const v = state.hitVolume;
  // 闷“呜”下滑，明确但不刺耳。
  playBlip({ fromFreq: 220, toFreq: 130, duration: 0.12, gainPeak: 0.16 * v, type: 'sine' });
}

export function playDryFire() {
  if (!state.enabled || !ensureContext()) return;
  const v = state.fireVolume;
  // 轻机械“嗒”：极短高通噪声。
  playNoiseBurst({ duration: 0.02, filterFrom: 6500, filterTo: 3000, gainPeak: 0.14 * v });
}

export function playRoundStart() {
  if (!state.enabled || !ensureContext()) return;
  const v = state.hitVolume;
  playBlip({ fromFreq: 660, toFreq: 660, duration: 0.06, gainPeak: 0.2 * v, type: 'sine' });
  playBlip({ fromFreq: 990, toFreq: 990, duration: 0.08, gainPeak: 0.2 * v, when: 0.09, type: 'sine' });
}
