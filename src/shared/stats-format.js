// 统计面板的音质分级与格式化,供渲染层使用

const LOSSLESS_CODECS = /flac|alac|pcm/i;
const LOSSLESS_EXTS = new Set(['.flac', '.wav']);

// 分级:Hi-Res / SQ / HQ / Other
// 无损 = FLAC/WAV/ALAC;Hi-Res = 无损且采样率 > 44.1kHz 或位深 > 16bit;HQ = 有损且码率 >= 192kbps
export function classifyTier(song) {
  const ext = song.path ? song.path.slice(song.path.lastIndexOf('.')).toLowerCase() : '';
  const codec = String(song.codec || '');
  const lossless = LOSSLESS_EXTS.has(ext) || LOSSLESS_CODECS.test(codec);

  if (lossless) {
    if (
      (song.sampleRate && song.sampleRate > 44100) ||
      (song.bitsPerSample && song.bitsPerSample > 16)
    ) {
      return 'hires';
    }
    return 'sq';
  }
  return song.bitrate && song.bitrate >= 192000 ? 'hq' : 'other';
}

export function formatBitrate(bitrate) {
  return bitrate ? `${Math.round(bitrate / 1000)} kbps` : '--';
}

export function formatSampleRate(sampleRate) {
  if (!sampleRate) return '--';
  const kHz = sampleRate / 1000;
  return `${Number.isInteger(kHz) ? kHz : kHz.toFixed(1)} kHz`;
}
