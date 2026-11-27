// 共享 Web Audio 链路：<audio> → MediaElementSource → 10 段均衡器 Biquad → 前级 Gain → AnalyserNode → destination。
//
// HTMLAudioElement 只能绑定一次 createMediaElementSource，且拆不掉；均衡器与实时频谱分析
// 必须共用同一条图。均衡器关闭时 10 段增益均为 0dB、前级增益为 1，整段滤波链为透明直通，
// 频谱分析放在均衡器之后，调节均衡器时频谱响应与实际听感一致。

import { EQ_BAND_SPECS, FLAT_GAINS, computePreampDb } from '../../shared/equalizer.js';
import { audio } from './dom.js';
import { state } from './state.js';

const ANALYSER_FFT_SIZE = 4096;
// 轻度频域平滑去抖即可，主要视觉攻防曲线由 visualizer.js 的快攻慢放控制；
// 过高会导致低频瞬态发闷、静音拖尾过长，且调低音量瞬间出现补偿过冲。
const ANALYSER_SMOOTHING = 0.2;

let graph = null;
let graphFailed = false;
let resumeListenersBound = false;

export function getAudioGraph() {
  return graph;
}

export function resumeAudioGraph() {
  if (graph && graph.ctx.state !== 'running') {
    graph.ctx.resume().catch(() => {});
  }
}

function bindResumeGuards() {
  if (resumeListenersBound) return;
  resumeListenersBound = true;

  // AudioContext 被系统休眠/自动播放策略挂起后再播会整体静音，播放及首次交互均兜底 resume
  audio.addEventListener('play', resumeAudioGraph);
  audio.addEventListener('playing', resumeAudioGraph);

  const resumeOnGesture = () => {
    resumeAudioGraph();
    if (graph && graph.ctx.state === 'running') {
      window.removeEventListener('pointerdown', resumeOnGesture, true);
      window.removeEventListener('keydown', resumeOnGesture, true);
    }
  };
  window.addEventListener('pointerdown', resumeOnGesture, { capture: true, passive: true });
  window.addEventListener('keydown', resumeOnGesture, { capture: true, passive: true });
}

const EQ_RAMP_TIME_CONSTANT = 0.015; // 15ms 指数平滑过渡，切换预设或拖推子零爆音

export function applyEqualizerToGraph(eqState = state.equalizer) {
  if (!graph) return;
  const effective = eqState && eqState.enabled ? eqState.gains : FLAT_GAINS;
  const now = graph.ctx.currentTime;
  graph.filters.forEach((node, i) => {
    const targetGain = effective[i] || 0;
    node.gain.cancelScheduledValues(now);
    node.gain.setTargetAtTime(targetGain, now, EQ_RAMP_TIME_CONSTANT);
  });
  const targetPreamp = Math.pow(10, computePreampDb(effective) / 20);
  graph.preampNode.gain.cancelScheduledValues(now);
  graph.preampNode.gain.setTargetAtTime(targetPreamp, now, EQ_RAMP_TIME_CONSTANT);
  resumeAudioGraph();
}

// 惰性或预建共享音频图；失败时保留 <audio> 原生直出，不影响播放。
export function ensureAudioGraph() {
  if (graph) return graph;
  if (graphFailed) return null;

  let built = null;
  try {
    built = new AudioContext();

    const filters = EQ_BAND_SPECS.map((spec) => {
      const node = built.createBiquadFilter();
      node.type = spec.type;
      node.frequency.value = spec.filterFreq;
      node.Q.value = spec.Q;
      node.gain.value = 0;
      return node;
    });

    const preampNode = built.createGain();
    const analyser = built.createAnalyser();
    analyser.fftSize = ANALYSER_FFT_SIZE;
    analyser.smoothingTimeConstant = ANALYSER_SMOOTHING;

    let tail = filters[0];
    for (let i = 1; i < filters.length; i++) {
      tail.connect(filters[i]);
      tail = filters[i];
    }
    tail.connect(preampNode);
    preampNode.connect(analyser);
    analyser.connect(built.destination);

    // 最后一步才接管 <audio>，避免前面抛错时提前切断原生输出
    built.createMediaElementSource(audio).connect(filters[0]);

    graph = { ctx: built, filters, preampNode, analyser };
    bindResumeGuards();
    applyEqualizerToGraph(state.equalizer);
    resumeAudioGraph();
    return graph;
  } catch (e) {
    graphFailed = true;
    graph = null;
    try {
      if (built) built.close();
    } catch (e2) {}
    return null;
  }
}
