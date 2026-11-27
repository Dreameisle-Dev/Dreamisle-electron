// 插件网络权限与 SSRF 校验：限制仅放行 http(s)、按 manifest.permissions.network 匹配域名，
// 并默认阻断本机回环与局域网私有 IP（除非插件声明 allowLocalNetwork: true）。
import net from 'node:net';
import { PluginError } from '../../../packages/dreamisle-plugin-sdk/src/index.js';

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isPrivateIpv6(rawIp) {
  const ip = rawIp.toLowerCase().replace(/^\[|\]$/g, '');
  if (ip === '::1' || ip === '::') return true;
  if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:')) return true;
  const v4Mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (v4Mapped) return isPrivateIpv4(v4Mapped[1]);
  return false;
}

export function isLocalOrPrivateHost(hostname) {
  if (typeof hostname !== 'string' || !hostname) return true;
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return true;
  }
  const ipVer = net.isIP(host);
  if (ipVer === 4) return isPrivateIpv4(host);
  if (ipVer === 6) return isPrivateIpv6(host);
  return false;
}

export function matchesHostPattern(hostname, pattern) {
  if (typeof hostname !== 'string' || typeof pattern !== 'string') return false;
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const pat = pattern.trim().toLowerCase();
  if (!host || !pat) return false;
  if (pat === '*') return true;
  if (pat.startsWith('*.')) {
    const suffix = pat.slice(1); // '.example.com'
    return host.length > suffix.length && host.endsWith(suffix);
  }
  return host === pat;
}

/**
 * 严格校验插件发出的 HTTP 请求目标 URL 是否符合声明权限与防 SSRF 约束。
 */
export function assertUrlAllowed(urlString, permissions = {}) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new PluginError('PERMISSION_DENIED', `Invalid URL: ${String(urlString)}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PluginError(
      'PERMISSION_DENIED',
      `Protocol "${parsed.protocol}" is not allowed for plugins`
    );
  }

  const allowLocal = permissions?.allowLocalNetwork === true;
  if (!allowLocal && isLocalOrPrivateHost(parsed.hostname)) {
    throw new PluginError(
      'PERMISSION_DENIED',
      `Access to local/private host "${parsed.hostname}" requires allowLocalNetwork permission`
    );
  }

  const patterns = Array.isArray(permissions?.network) ? permissions.network : [];
  if (patterns.length === 0) {
    throw new PluginError(
      'PERMISSION_DENIED',
      `Plugin has no network permission for host "${parsed.hostname}"`
    );
  }

  const allowed = patterns.some((pat) => matchesHostPattern(parsed.hostname, pat));
  if (!allowed) {
    throw new PluginError(
      'PERMISSION_DENIED',
      `Host "${parsed.hostname}" is not declared in permissions.network`
    );
  }

  return parsed;
}
