// 设置页「05 · 插件与扩展」管理控制器（随 settings.js 懒加载，不影响冷启动）。
import { t } from '../../shared/i18n.js';
import { state } from './state.js';
import { escapeHtml, showSyncToast } from './helpers.js';

const QR_POLL_INTERVAL_MS = 2000;

let bound = false;
// 记录每个插件当前展开的子面板：'config' | 'auth' | 'logs' | null
const expandedPanelByPlugin = new Map();
// 卸载两段式确认计时器
const uninstallConfirmTimers = new Map();
// 扫码登录轮询会话（一次最多一个活跃轮询，关闭面板或设置页时立即清理）
let activeQrSession = null;

function getEl(id) {
  return document.getElementById(id);
}

function setSwitch(el, on) {
  if (!el) return;
  el.classList.toggle('active', !!on);
  el.setAttribute('aria-checked', String(!!on));
}

function formatErrorMessage(err) {
  if (!err) return t('plugins.err.INTERNAL_ERROR');
  const code = err.code || '';
  if (code) {
    const key = `plugins.err.${code}`;
    const translated = t(key);
    if (translated !== key) return translated;
  }
  return err.message || String(err);
}

function stopQrPolling() {
  if (!activeQrSession) return;
  clearInterval(activeQrSession.timer);
  activeQrSession = null;
}

function closeAllPluginSelects(except = null) {
  document.querySelectorAll('.plugin-select.open').forEach((el) => {
    if (el !== except) {
      el.classList.remove('open');
      const btn = el.querySelector('.plugin-select-btn');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }
  });
}

export function cleanupPluginSettingsOnClose() {
  stopQrPolling();
  closeAllPluginSelects();
  for (const timer of uninstallConfirmTimers.values()) clearTimeout(timer);
  uninstallConfirmTimers.clear();
}

function buildPermissionsText(manifest) {
  const perms = manifest?.permissions || {};
  const parts = [];
  if (Array.isArray(perms.network) && perms.network.length > 0) {
    parts.push(t('plugins.permNetwork', { hosts: perms.network.join(', ') }));
  } else {
    parts.push(t('plugins.permNone'));
  }
  if (perms.allowLocalNetwork) parts.push(t('plugins.permLocalNet'));
  if (perms.secrets) parts.push(t('plugins.permSecrets'));
  return parts.join(' · ');
}

function renderPluginsSummary(plugins) {
  const summaryEl = getEl('pluginsSummary');
  if (!summaryEl) return;
  const total = plugins.length;
  const enabled = plugins.filter((p) => p.enabled && !p.invalid).length;
  summaryEl.textContent = t('settings.pluginsCount', { enabled, total });
}

function renderPluginList(plugins = state.plugins || []) {
  const listEl = getEl('pluginsList');
  const emptyEl = getEl('pluginsEmpty');
  if (!listEl) return;

  renderPluginsSummary(plugins);

  if (plugins.length === 0) {
    listEl.replaceChildren();
    if (emptyEl) emptyEl.hidden = false;
    return;
  }
  if (emptyEl) emptyEl.hidden = true;

  const frag = document.createDocumentFragment();
  for (const plugin of plugins) {
    const card = buildPluginCard(plugin);
    frag.appendChild(card);
  }
  listEl.replaceChildren(frag);

  // 如果之前有插件保持展开态，重新渲染后立即填充其子面板内容
  for (const plugin of plugins) {
    const mode = expandedPanelByPlugin.get(plugin.id);
    if (!mode) continue;
    const sub = listEl.querySelector(
      `.plugin-card[data-plugin-id="${CSS.escape(plugin.id)}"] .plugin-subpanel`
    );
    if (sub) populateSubpanel(plugin, mode, sub);
  }
}

function buildPluginCard(plugin) {
  const card = document.createElement('div');
  card.className = `plugin-card${plugin.invalid ? ' is-invalid' : ''}${plugin.enabled ? ' is-enabled' : ''}`;
  card.dataset.pluginId = plugin.id;

  const manifest = plugin.manifest || {
    id: plugin.id,
    name: plugin.id,
    version: '?',
    capabilities: [],
    configSchema: [],
  };

  const statusKey = `plugins.status.${plugin.status || 'stopped'}`;
  const statusLabel = t(statusKey);
  const capsHtml = (manifest.capabilities || [])
    .map((cap) => `<span class="plugin-cap-pill">${escapeHtml(t(`plugins.cap.${cap}`))}</span>`)
    .join('');

  const activeSub = expandedPanelByPlugin.get(plugin.id) || null;
  const hasConfig = Array.isArray(manifest.configSchema) && manifest.configSchema.length > 0;
  const hasAuth = Boolean(
    plugin.authMeta?.supported && plugin.enabled && plugin.status === 'running'
  );

  card.innerHTML = `
    <div class="plugin-card-head">
      <div class="plugin-card-title-wrap">
        <div class="plugin-card-title-row">
          <span class="plugin-card-name">${escapeHtml(manifest.name || plugin.id)}</span>
          <span class="plugin-card-ver">v${escapeHtml(manifest.version || '0.0.0')}</span>
          <span class="plugin-status-pill is-${escapeHtml(plugin.status || 'stopped')}">${escapeHtml(statusLabel)}</span>
        </div>
        <div class="plugin-card-sub">
          ${manifest.author ? `<span class="plugin-card-author">${escapeHtml(manifest.author)}</span>` : ''}
          ${capsHtml}
        </div>
      </div>
      <button
        type="button"
        class="settings-switch plugin-enable-switch${plugin.enabled ? ' active' : ''}"
        role="switch"
        aria-checked="${plugin.enabled ? 'true' : 'false'}"
        title="${escapeHtml(t('plugins.enable'))}"
        data-role="toggle-enable"
        ${plugin.invalid ? 'disabled' : ''}
      ></button>
    </div>
    ${manifest.description ? `<p class="plugin-card-desc">${escapeHtml(manifest.description)}</p>` : ''}
    ${plugin.lastError ? `<p class="plugin-card-error">${escapeHtml(plugin.lastError)}</p>` : ''}
    <div class="plugin-card-perms">${escapeHtml(buildPermissionsText(manifest))}</div>
    <div class="plugin-card-actions">
      ${
        hasConfig && !plugin.invalid
          ? `<button type="button" class="plugin-action-btn${activeSub === 'config' ? ' active' : ''}" data-role="panel-config">${escapeHtml(t('plugins.config'))}</button>`
          : ''
      }
      ${
        hasAuth
          ? `<button type="button" class="plugin-action-btn${activeSub === 'auth' ? ' active' : ''}" data-role="panel-auth">${escapeHtml(t('plugins.auth'))}</button>`
          : ''
      }
      ${
        !plugin.invalid
          ? `<button type="button" class="plugin-action-btn${activeSub === 'logs' ? ' active' : ''}" data-role="panel-logs">${escapeHtml(t('plugins.logs'))}</button>`
          : ''
      }
      ${
        plugin.enabled && !plugin.invalid
          ? `<button type="button" class="plugin-action-btn" data-role="restart">${escapeHtml(t('plugins.restart'))}</button>`
          : ''
      }
      <button type="button" class="plugin-action-btn danger" data-role="uninstall">${escapeHtml(t('plugins.uninstall'))}</button>
    </div>
    <div class="plugin-subpanel" ${activeSub ? '' : 'hidden'}></div>
  `;

  return card;
}

async function populateSubpanel(plugin, mode, container) {
  container.hidden = false;
  container.innerHTML = `<div class="plugin-sub-loading">${escapeHtml(t('online.loading'))}</div>`;

  if (mode === 'config') {
    await renderConfigSubpanel(plugin, container);
  } else if (mode === 'auth') {
    await renderAuthSubpanel(plugin, container);
  } else if (mode === 'logs') {
    await renderLogsSubpanel(plugin, container);
  }
}

async function renderConfigSubpanel(plugin, container) {
  const schema = plugin.manifest?.configSchema || [];
  let data = { values: {}, secretSet: {} };
  try {
    data = (await window.dreamApi.plugins.getConfig(plugin.id)) || data;
  } catch {}

  const form = document.createElement('form');
  form.className = 'plugin-config-form';
  const clearedSecrets = new Set();

  for (const field of schema) {
    const row = document.createElement('div');
    row.className = 'plugin-field-row';

    const labelEl = document.createElement('label');
    labelEl.className = 'plugin-field-label';
    labelEl.textContent = field.label || field.key;
    row.appendChild(labelEl);

    if (field.description) {
      const desc = document.createElement('div');
      desc.className = 'plugin-field-desc';
      desc.textContent = field.description;
      row.appendChild(desc);
    }

    const curVal = Object.hasOwn(data.values || {}, field.key)
      ? data.values[field.key]
      : field.default;

    if (field.type === 'boolean') {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = `settings-switch${curVal ? ' active' : ''}`;
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-checked', String(Boolean(curVal)));
      sw.dataset.fieldKey = field.key;
      sw.dataset.fieldType = 'boolean';
      sw.onclick = () => {
        const next = sw.getAttribute('aria-checked') !== 'true';
        setSwitch(sw, next);
      };
      row.classList.add('is-inline');
      row.appendChild(sw);
    } else if (field.type === 'select') {
      const options = Array.isArray(field.options) ? field.options : [];
      const initialOpt =
        options.find((opt) => String(opt.value) === String(curVal ?? '')) || options[0] || null;
      const initialVal = initialOpt ? String(initialOpt.value) : '';
      const initialLabel = initialOpt ? initialOpt.label : '';

      const wrap = document.createElement('div');
      wrap.className = 'plugin-select';
      wrap.dataset.fieldKey = field.key;
      wrap.dataset.fieldType = 'select';
      wrap.dataset.value = initialVal;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'plugin-select-btn';
      btn.setAttribute('aria-haspopup', 'listbox');
      btn.setAttribute('aria-expanded', 'false');
      btn.innerHTML = `<span class="plugin-select-value">${escapeHtml(initialLabel)}</span>
        <svg class="plugin-select-arrow" width="10" height="6" viewBox="0 0 10 6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M1 1l4 4 4-4"></path>
        </svg>`;

      const list = document.createElement('ul');
      list.className = 'plugin-select-list';
      list.setAttribute('role', 'listbox');

      for (const opt of options) {
        const li = document.createElement('li');
        li.className = `plugin-select-option${String(opt.value) === initialVal ? ' selected' : ''}`;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(String(opt.value) === initialVal));
        li.dataset.value = String(opt.value);
        li.textContent = opt.label;
        li.addEventListener('click', (ev) => {
          ev.stopPropagation();
          wrap.dataset.value = String(opt.value);
          const valSpan = btn.querySelector('.plugin-select-value');
          if (valSpan) valSpan.textContent = opt.label;
          list.querySelectorAll('.plugin-select-option').forEach((item) => {
            const sel = item === li;
            item.classList.toggle('selected', sel);
            item.setAttribute('aria-selected', String(sel));
          });
          wrap.classList.remove('open');
          btn.setAttribute('aria-expanded', 'false');
        });
        list.appendChild(li);
      }

      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const willOpen = !wrap.classList.contains('open');
        closeAllPluginSelects(willOpen ? wrap : null);
        wrap.classList.toggle('open', willOpen);
        btn.setAttribute('aria-expanded', String(willOpen));
        if (willOpen) {
          requestAnimationFrame(() => {
            const scroller = getEl('settingsScroll');
            if (!scroller) return;
            const overflow =
              list.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom;
            if (overflow > 0) {
              scroller.scrollTo({
                top: scroller.scrollTop + overflow + 14,
                behavior: 'smooth',
              });
            }
          });
        }
      });

      wrap.appendChild(btn);
      wrap.appendChild(list);
      row.appendChild(wrap);
    } else if (field.type === 'textarea') {
      const ta = document.createElement('textarea');
      ta.className = 'plugin-field-input';
      ta.rows = 3;
      ta.dataset.fieldKey = field.key;
      ta.dataset.fieldType = 'textarea';
      ta.placeholder = field.placeholder || '';
      ta.value = typeof curVal === 'string' ? curVal : '';
      row.appendChild(ta);
    } else {
      const wrap = document.createElement('div');
      wrap.className = 'plugin-field-input-wrap';
      const input = document.createElement('input');
      input.className = 'plugin-field-input';
      input.type =
        field.type === 'password' || field.secret
          ? 'password'
          : field.type === 'number'
            ? 'number'
            : 'text';
      input.dataset.fieldKey = field.key;
      input.dataset.fieldType = field.type;
      if (field.secret) input.dataset.fieldSecret = '1';
      if (field.min !== undefined) input.min = String(field.min);
      if (field.max !== undefined) input.max = String(field.max);
      if (field.step !== undefined) input.step = String(field.step);

      if (field.secret) {
        input.placeholder = data.secretSet?.[field.key]
          ? t('plugins.secretPlaceholder')
          : field.placeholder || '';
        input.value = '';
      } else {
        input.placeholder = field.placeholder || '';
        input.value = curVal !== undefined && curVal !== null ? String(curVal) : '';
      }
      wrap.appendChild(input);

      if (field.secret && data.secretSet?.[field.key]) {
        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'plugin-action-btn';
        clearBtn.textContent = t('plugins.clearSecret');
        clearBtn.onclick = () => {
          clearedSecrets.add(field.key);
          input.value = '';
          input.placeholder = field.placeholder || '';
          clearBtn.remove();
        };
        wrap.appendChild(clearBtn);
      }
      row.appendChild(wrap);
    }

    form.appendChild(row);
  }

  const footer = document.createElement('div');
  footer.className = 'plugin-sub-footer';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'settings-add-btn';
  saveBtn.textContent = t('plugins.saveConfig');
  footer.appendChild(saveBtn);
  form.appendChild(footer);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {};
    for (const key of clearedSecrets) payload[key] = null;

    form.querySelectorAll('[data-field-key]').forEach((el) => {
      const key = el.dataset.fieldKey;
      const type = el.dataset.fieldType;
      const isSecret = el.dataset.fieldSecret === '1';
      if (type === 'boolean') {
        payload[key] = el.getAttribute('aria-checked') === 'true';
      } else if (type === 'select') {
        payload[key] = el.dataset.value ?? el.value ?? '';
      } else if (type === 'number') {
        if (el.value !== '') payload[key] = Number(el.value);
      } else if (isSecret) {
        if (el.value.length > 0) payload[key] = el.value;
      } else {
        payload[key] = el.value;
      }
    });

    saveBtn.disabled = true;
    try {
      const res = await window.dreamApi.plugins.setConfig(plugin.id, payload);
      if (!res?.ok) {
        showSyncToast(t('plugins.actionFailed', { msg: formatErrorMessage(res?.error) }));
      } else {
        showSyncToast(t('plugins.configSaved'));
        await renderConfigSubpanel(plugin, container);
      }
    } finally {
      saveBtn.disabled = false;
    }
  });

  container.replaceChildren(form);
}

async function renderAuthSubpanel(plugin, container) {
  stopQrPolling();
  const wrap = document.createElement('div');
  wrap.className = 'plugin-auth-panel';

  const accRes = await window.dreamApi.plugins.authGetAccount(plugin.id);
  const account = accRes?.ok ? accRes.data : null;

  if (account?.loggedIn) {
    const info = document.createElement('div');
    info.className = 'plugin-auth-account';
    info.innerHTML = `
      <div class="plugin-auth-account-copy">
        <span class="plugin-auth-name">${escapeHtml(
          t('plugins.authLoggedIn', { name: account.displayName || 'User' })
        )}</span>
        ${account.badge ? `<span class="plugin-cap-pill">${escapeHtml(account.badge)}</span>` : ''}
      </div>
      <button type="button" class="plugin-action-btn danger" data-role="auth-logout">${escapeHtml(
        t('plugins.authLogout')
      )}</button>
    `;
    info.querySelector('[data-role="auth-logout"]').onclick = async () => {
      const res = await window.dreamApi.plugins.authLogout(plugin.id);
      if (res?.ok) {
        showSyncToast(t('plugins.authLogoutSuccess'));
        await renderAuthSubpanel(plugin, container);
      } else {
        showSyncToast(t('plugins.actionFailed', { msg: formatErrorMessage(res?.error) }));
      }
    };
    wrap.appendChild(info);
    container.replaceChildren(wrap);
    return;
  }

  const statusLine = document.createElement('div');
  statusLine.className = 'plugin-auth-status';
  statusLine.textContent = t('plugins.authNotLoggedIn');
  wrap.appendChild(statusLine);

  const authMeta = plugin.authMeta || {};

  // 扫码登录区
  if (authMeta.hasQr) {
    const qrSection = document.createElement('div');
    qrSection.className = 'plugin-auth-qr-box';

    const startQrBtn = document.createElement('button');
    startQrBtn.type = 'button';
    startQrBtn.className = 'plugin-action-btn';
    startQrBtn.textContent = t('plugins.authQrLogin');

    const qrBody = document.createElement('div');
    qrBody.className = 'plugin-auth-qr-stage';
    qrBody.hidden = true;

    const startQrFlow = async () => {
      stopQrPolling();
      startQrBtn.disabled = true;
      qrBody.hidden = false;
      qrBody.innerHTML = `<div class="plugin-sub-loading">${escapeHtml(t('online.loading'))}</div>`;

      const res = await window.dreamApi.plugins.authQrStart(plugin.id);
      startQrBtn.disabled = false;
      if (!res?.ok || !res.data?.key) {
        qrBody.innerHTML = `<div class="plugin-card-error">${escapeHtml(
          formatErrorMessage(res?.error)
        )}</div>`;
        return;
      }

      const { key, qrDataUrl, qrText, tip } = res.data;
      qrBody.innerHTML = `
        ${
          qrDataUrl
            ? `<img class="plugin-qr-img" src="${escapeHtml(qrDataUrl)}" alt="QR Code" />`
            : ''
        }
        ${qrText && !qrDataUrl ? `<code class="plugin-qr-text">${escapeHtml(qrText)}</code>` : ''}
        <div class="plugin-qr-tip" data-role="qr-tip">${escapeHtml(
          tip || t('plugins.authQrWaiting')
        )}</div>
        <button type="button" class="plugin-action-btn" data-role="qr-retry" hidden>${escapeHtml(
          t('plugins.authQrRetry')
        )}</button>
      `;

      const tipEl = qrBody.querySelector('[data-role="qr-tip"]');
      const retryBtn = qrBody.querySelector('[data-role="qr-retry"]');
      if (retryBtn) retryBtn.onclick = startQrFlow;

      const pollOnce = async () => {
        if (!activeQrSession || activeQrSession.key !== key) return;
        const pollRes = await window.dreamApi.plugins.authQrPoll(plugin.id, key);
        if (!activeQrSession || activeQrSession.key !== key) return;
        if (!pollRes?.ok) return;
        const { status, message } = pollRes.data || {};
        if (status === 'scanned') {
          if (tipEl) tipEl.textContent = message || t('plugins.authQrScanned');
        } else if (status === 'expired') {
          stopQrPolling();
          if (tipEl) tipEl.textContent = message || t('plugins.authQrExpired');
          if (retryBtn) retryBtn.hidden = false;
        } else if (status === 'confirmed') {
          stopQrPolling();
          showSyncToast(t('plugins.authLoginSuccess'));
          await renderAuthSubpanel(plugin, container);
        }
      };

      const timer = setInterval(pollOnce, QR_POLL_INTERVAL_MS);
      activeQrSession = { pluginId: plugin.id, key, timer };
    };

    startQrBtn.onclick = startQrFlow;
    qrSection.appendChild(startQrBtn);
    qrSection.appendChild(qrBody);
    wrap.appendChild(qrSection);
  }

  // 表单凭据登录区
  if (authMeta.hasForm && Array.isArray(authMeta.formFields) && authMeta.formFields.length > 0) {
    const form = document.createElement('form');
    form.className = 'plugin-config-form plugin-auth-form';

    for (const field of authMeta.formFields) {
      const row = document.createElement('div');
      row.className = 'plugin-field-row';
      const label = document.createElement('label');
      label.className = 'plugin-field-label';
      label.textContent = field.label || field.key;
      row.appendChild(label);

      const input = document.createElement('input');
      input.className = 'plugin-field-input';
      input.type = field.type === 'password' ? 'password' : 'text';
      input.dataset.authKey = field.key;
      input.placeholder = field.placeholder || '';
      if (field.required) input.required = true;
      row.appendChild(input);
      form.appendChild(row);
    }

    const footer = document.createElement('div');
    footer.className = 'plugin-sub-footer';
    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'settings-add-btn';
    submitBtn.textContent = t('plugins.authFormSubmit');
    footer.appendChild(submitBtn);
    form.appendChild(footer);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const values = {};
      form.querySelectorAll('[data-auth-key]').forEach((el) => {
        values[el.dataset.authKey] = el.value;
      });
      submitBtn.disabled = true;
      try {
        const res = await window.dreamApi.plugins.authFormSubmit(plugin.id, values);
        if (res?.ok && res.data?.loggedIn) {
          showSyncToast(t('plugins.authLoginSuccess'));
          await renderAuthSubpanel(plugin, container);
        } else {
          showSyncToast(t('plugins.actionFailed', { msg: formatErrorMessage(res?.error) }));
        }
      } finally {
        submitBtn.disabled = false;
      }
    });

    wrap.appendChild(form);
  }

  container.replaceChildren(wrap);
}

async function renderLogsSubpanel(plugin, container) {
  const logs = (await window.dreamApi.plugins.getLogs(plugin.id)) || [];
  if (logs.length === 0) {
    container.innerHTML = `<div class="plugin-logs-empty">${escapeHtml(
      t('plugins.logsEmpty')
    )}</div>`;
    return;
  }

  const pre = document.createElement('div');
  pre.className = 'plugin-logs-list';
  const frag = document.createDocumentFragment();
  for (const entry of logs.slice(-50)) {
    const line = document.createElement('div');
    line.className = `plugin-log-line is-${entry.level || 'info'}`;
    const d = new Date(entry.ts || Date.now());
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const metaStr = entry.meta ? ` ${entry.meta}` : '';
    line.textContent = `[${hh}:${mm}:${ss}] [${String(entry.level || 'info').toUpperCase()}] ${entry.message}${metaStr}`;
    frag.appendChild(line);
  }
  pre.appendChild(frag);
  container.replaceChildren(pre);
  pre.scrollTop = pre.scrollHeight;
}

export async function refreshPluginSettingsUi() {
  if (!window.dreamApi.plugins) return;
  try {
    const plugins = await window.dreamApi.plugins.list();
    if (Array.isArray(plugins)) state.plugins = plugins;
  } catch {}
  renderPluginList(state.plugins);
}

export function bindPluginSettingsEvents() {
  if (bound || !window.dreamApi.plugins) return;
  bound = true;

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.plugin-select')) {
      closeAllPluginSelects();
    }
  });

  const btnInstallFolder = getEl('btnPluginInstallFolder');
  if (btnInstallFolder) {
    btnInstallFolder.addEventListener('click', async () => {
      const res = await window.dreamApi.plugins.installFolder();
      if (!res || res.canceled) return;
      if (res.ok && res.data?.installed) {
        if (Array.isArray(res.data.plugins)) state.plugins = res.data.plugins;
        showSyncToast(t('plugins.installedOk', { name: res.data.installed.name }));
        renderPluginList(state.plugins);
      } else {
        showSyncToast(t('plugins.actionFailed', { msg: formatErrorMessage(res?.error) }));
      }
    });
  }

  const btnInstallZip = getEl('btnPluginInstallZip');
  if (btnInstallZip) {
    btnInstallZip.addEventListener('click', async () => {
      const res = await window.dreamApi.plugins.installZip();
      if (!res || res.canceled) return;
      if (res.ok && res.data?.installed) {
        if (Array.isArray(res.data.plugins)) state.plugins = res.data.plugins;
        showSyncToast(t('plugins.installedOk', { name: res.data.installed.name }));
        renderPluginList(state.plugins);
      } else {
        showSyncToast(t('plugins.actionFailed', { msg: formatErrorMessage(res?.error) }));
      }
    });
  }

  const btnOpenDir = getEl('btnPluginOpenDir');
  if (btnOpenDir) {
    btnOpenDir.addEventListener('click', () => {
      window.dreamApi.plugins.openDir().catch(() => {});
    });
  }

  const btnRefresh = getEl('btnPluginRefresh');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', async () => {
      btnRefresh.disabled = true;
      try {
        const list = await window.dreamApi.plugins.refresh();
        if (Array.isArray(list)) state.plugins = list;
        renderPluginList(state.plugins);
      } finally {
        btnRefresh.disabled = false;
      }
    });
  }

  // 插件卡片事件委托
  const listEl = getEl('pluginsList');
  if (listEl) {
    listEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-role]');
      const card = e.target.closest('.plugin-card');
      if (!btn || !card) return;
      const pluginId = card.dataset.pluginId;
      const plugin = (state.plugins || []).find((p) => p.id === pluginId);
      if (!plugin) return;

      const role = btn.dataset.role;

      if (role === 'toggle-enable') {
        if (plugin.invalid) return;
        const next = !plugin.enabled;
        btn.disabled = true;
        try {
          const res = await window.dreamApi.plugins.setEnabled(pluginId, next);
          if (!res?.ok) {
            showSyncToast(t('plugins.actionFailed', { msg: formatErrorMessage(res?.error) }));
          } else if (Array.isArray(res.data)) {
            state.plugins = res.data;
          }
          if (!next && expandedPanelByPlugin.get(pluginId) === 'auth') {
            stopQrPolling();
            expandedPanelByPlugin.delete(pluginId);
          }
          renderPluginList(state.plugins);
        } finally {
          btn.disabled = false;
        }
        return;
      }

      if (role === 'restart') {
        btn.disabled = true;
        try {
          const res = await window.dreamApi.plugins.restart(pluginId);
          if (res?.ok) {
            if (Array.isArray(res.data)) state.plugins = res.data;
            showSyncToast(t('plugins.restartedOk'));
          } else {
            showSyncToast(t('plugins.actionFailed', { msg: formatErrorMessage(res?.error) }));
          }
          renderPluginList(state.plugins);
        } finally {
          btn.disabled = false;
        }
        return;
      }

      if (role === 'uninstall') {
        if (btn.classList.contains('confirm-danger')) {
          clearTimeout(uninstallConfirmTimers.get(pluginId));
          uninstallConfirmTimers.delete(pluginId);
          expandedPanelByPlugin.delete(pluginId);
          if (activeQrSession?.pluginId === pluginId) stopQrPolling();
          btn.disabled = true;
          const res = await window.dreamApi.plugins.uninstall(pluginId);
          if (res?.ok) {
            if (Array.isArray(res.data)) state.plugins = res.data;
            showSyncToast(t('plugins.uninstalledOk'));
          } else {
            showSyncToast(t('plugins.actionFailed', { msg: formatErrorMessage(res?.error) }));
          }
          renderPluginList(state.plugins);
        } else {
          btn.classList.add('confirm-danger');
          btn.textContent = t('plugins.confirmUninstall');
          clearTimeout(uninstallConfirmTimers.get(pluginId));
          uninstallConfirmTimers.set(
            pluginId,
            setTimeout(() => {
              uninstallConfirmTimers.delete(pluginId);
              if (btn.isConnected) {
                btn.classList.remove('confirm-danger');
                btn.textContent = t('plugins.uninstall');
              }
            }, 3000)
          );
        }
        return;
      }

      if (role === 'panel-config' || role === 'panel-auth' || role === 'panel-logs') {
        const nextMode = role.replace('panel-', '');
        const prevMode = expandedPanelByPlugin.get(pluginId) || null;
        if (prevMode === nextMode) {
          if (prevMode === 'auth') stopQrPolling();
          expandedPanelByPlugin.delete(pluginId);
          renderPluginList(state.plugins);
        } else {
          if (prevMode === 'auth') stopQrPolling();
          expandedPanelByPlugin.set(pluginId, nextMode);
          renderPluginList(state.plugins);
        }
      }
    });
  }

  window.addEventListener('dreamisle:plugins-changed', () => {
    const overlay = getEl('settingsOverlay');
    if (overlay && overlay.classList.contains('open')) {
      renderPluginList(state.plugins);
    }
  });
}
