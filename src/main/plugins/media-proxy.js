// 主进程流媒体代理协议 dream-media://audio/<pluginId>/<encodedTrackId>：
// 透传 Range 请求支持进度条拖动、注入插件自定义防盗链请求头、403/410 过期链接自动刷新一次，
// 并统一附加 CORS 响应头使 Web Audio 实时 FFT 频谱与 10 段均衡器零污染工作。
import { net, protocol } from 'electron';
import { formatTrackUri, parseMediaUrl } from '../../../packages/dreamisle-plugin-sdk/src/index.js';
import { assertUrlAllowed } from './permissions.js';
import {
  invalidatePluginStream,
  notifyRendererStreamError,
  resolvePluginStream,
} from './plugin-manager.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Cache-Control': 'no-store',
};

function errorStatusForCode(code) {
  if (code === 'AUTH_REQUIRED') return 401;
  if (code === 'VIP_REQUIRED') return 402;
  if (code === 'GEO_BLOCKED' || code === 'PERMISSION_DENIED') return 403;
  if (code === 'NOT_FOUND') return 404;
  if (code === 'RATE_LIMITED') return 429;
  if (code === 'TIMEOUT') return 504;
  return 502;
}

async function fetchUpstreamStream(stream, permissions, method, rangeHeader, signal) {
  const headers = { ...(stream.headers || {}) };
  if (rangeHeader) headers.Range = rangeHeader;
  const res = await net.fetch(stream.url, {
    method: method === 'HEAD' ? 'HEAD' : 'GET',
    headers,
    signal,
  });
  if (res.url && res.url !== stream.url) {
    assertUrlAllowed(res.url, permissions);
  }
  return res;
}

export function registerPluginMediaProtocol() {
  protocol.handle('dream-media', async (request) => {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const parsed = parseMediaUrl(request.url);
    if (!parsed) {
      return new Response('Invalid media URL', { status: 400, headers: CORS_HEADERS });
    }

    const { pluginId, trackId, quality } = parsed;
    const songUri = formatTrackUri(pluginId, trackId);
    const rangeHeader = request.headers.get('range') || request.headers.get('Range') || null;
    const method = request.method === 'HEAD' ? 'HEAD' : 'GET';

    try {
      let resolved = await resolvePluginStream(pluginId, trackId, { quality, forceRefresh: false });
      let upstream = await fetchUpstreamStream(
        resolved.stream,
        resolved.permissions,
        method,
        rangeHeader,
        request.signal
      );

      // 直链临期提前失效（403 / 410）：自动失效缓存并重新 resolveStream 一次
      if ((upstream.status === 403 || upstream.status === 410) && !request.signal?.aborted) {
        try {
          upstream.body?.cancel?.();
        } catch {}
        invalidatePluginStream(pluginId, trackId, quality);
        resolved = await resolvePluginStream(pluginId, trackId, { quality, forceRefresh: true });
        upstream = await fetchUpstreamStream(
          resolved.stream,
          resolved.permissions,
          method,
          rangeHeader,
          request.signal
        );
      }

      if (!upstream.ok && upstream.status !== 206) {
        const err = {
          code: upstream.status === 403 ? 'GEO_BLOCKED' : 'NETWORK_ERROR',
          message: `Upstream audio server responded ${upstream.status}`,
        };
        notifyRendererStreamError(songUri, err);
        return new Response(null, { status: upstream.status, headers: CORS_HEADERS });
      }

      const outHeaders = new Headers(CORS_HEADERS);
      outHeaders.set(
        'Content-Type',
        upstream.headers.get('content-type') || resolved.stream.mimeType || 'audio/mpeg'
      );
      outHeaders.set('Accept-Ranges', upstream.headers.get('accept-ranges') || 'bytes');
      const contentLength = upstream.headers.get('content-length');
      if (contentLength) outHeaders.set('Content-Length', contentLength);
      const contentRange = upstream.headers.get('content-range');
      if (contentRange) outHeaders.set('Content-Range', contentRange);

      return new Response(method === 'HEAD' ? null : upstream.body, {
        status: upstream.status,
        headers: outHeaders,
      });
    } catch (err) {
      if (request.signal?.aborted) {
        return new Response(null, { status: 499, headers: CORS_HEADERS });
      }
      notifyRendererStreamError(songUri, err);
      return new Response(err?.message || 'Plugin stream failed', {
        status: errorStatusForCode(err?.code),
        headers: CORS_HEADERS,
      });
    }
  });
}
