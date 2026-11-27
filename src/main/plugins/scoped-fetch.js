// 插件统一受限 HTTP 客户端：使用 Node 原生 fetch（支持自定义 Cookie/Referer/User-Agent 且完整返回 Set-Cookie，
// 避免 Electron Chromium net.fetch 对 Cookie 请求头报 ERR_BLOCKED_BY_CLIENT 或混用宿主会话 Cookie），
// 并以 redirect:'manual' 逐跳校验重定向落点的权限与防 SSRF 约束。
import { PluginError } from '../../../packages/dreamisle-plugin-sdk/src/index.js';
import { assertUrlAllowed } from './permissions.js';

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function scopedFetch(
  rawUrl,
  permissions,
  { method = 'GET', headers = {}, body, signal, timeoutMs = 15000 } = {}
) {
  let currentUrl = assertUrlAllowed(rawUrl, permissions).href;
  let currentMethod = typeof method === 'string' ? method.toUpperCase() : 'GET';
  let currentBody = body;
  const baseHeaders = headers && typeof headers === 'object' ? { ...headers } : {};

  const ac = new AbortController();
  let timedOut = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          ac.abort();
        }, timeoutMs)
      : null;

  const onOuterAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) {
      if (timer) clearTimeout(timer);
      throw new PluginError('TIMEOUT', 'Request aborted');
    }
    signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const reqHeaders = new Headers();
      for (const [k, v] of Object.entries(baseHeaders)) {
        if (v !== undefined && v !== null) reqHeaders.set(k, String(v));
      }

      const init = {
        method: currentMethod,
        headers: reqHeaders,
        redirect: 'manual',
        signal: ac.signal,
      };
      if (currentBody !== undefined && currentMethod !== 'GET' && currentMethod !== 'HEAD') {
        init.body = currentBody;
      }

      let res;
      try {
        res = await globalThis.fetch(currentUrl, init);
      } catch (err) {
        if (timedOut) {
          throw new PluginError('TIMEOUT', `HTTP request timed out (${timeoutMs}ms)`);
        }
        if (signal?.aborted) {
          throw new PluginError('TIMEOUT', 'Request aborted');
        }
        throw new PluginError('NETWORK_ERROR', err?.message || 'HTTP request failed', {
          cause: err,
        });
      }

      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get('location');
        if (!location) return res;
        if (hop === MAX_REDIRECTS) {
          throw new PluginError('NETWORK_ERROR', 'Too many redirects');
        }
        try {
          res.body?.cancel?.();
        } catch {}
        const nextUrl = new URL(location, currentUrl).href;
        // 发起重定向请求之前即校验目标域名与私网限制，彻底阻断 SSRF
        currentUrl = assertUrlAllowed(nextUrl, permissions).href;
        if (
          res.status === 303 ||
          ((res.status === 301 || res.status === 302) && currentMethod === 'POST')
        ) {
          currentMethod = 'GET';
          currentBody = undefined;
          delete baseHeaders['Content-Type'];
          delete baseHeaders['content-type'];
          delete baseHeaders['Content-Length'];
          delete baseHeaders['content-length'];
        }
        continue;
      }

      return res;
    }

    throw new PluginError('NETWORK_ERROR', 'Too many redirects');
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
}
