(function (global) {
  'use strict';

  const platform = global.SocialCommentActivePlatform || global.SocialCommentPlatformRegistry?.resolve?.(global.location?.href || '');
  if (!platform) return;

  const TEXT = { idle: '空闲', preflight: '准备中', 'waiting-surface': '等待评论区', expanding: '展开中', stabilizing: '等待稳定', scanning: '扫描中', loading: '加载下一批', running: '运行中', 'cooling-down': '当前轮次休息', 'scheduled-rest': '等待下一轮', completed: '已完成', paused: '已暂停', error: '错误', stopped: '空闲' };
  const panelState = global.SocialCommentFloatingPanel;
  const initial = panelState?.createState?.() || { uiMode: 'launcher', launcherPosition: { edge: 'right', offset: 64 }, drag: {} };
  const view = {
    ui: null,
    host: null,
    uiMode: initial.uiMode,
    launcherPosition: { ...initial.launcherPosition },
    drag: { ...initial.drag },
    closeDialog: null,
    pauseFailure: false,
    snapshot: { status: 'idle', stats: {}, candidates: [], waiting: '', error: '', pagination: null, refresh: null, actions: { canStart: true, canPreview: true, canPause: false, canStop: false } },
  };
  let runtime = null;

  function uiClosedStorageKey() { return `socialCommentCleanerUiClosed:${global.location.origin}${global.location.pathname}`; }
  function isUiClosed() { try { return global.sessionStorage?.getItem(uiClosedStorageKey()) === '1'; } catch { return false; } }
  function setUiClosed(closed) { try { if (closed) global.sessionStorage?.setItem(uiClosedStorageKey(), '1'); else global.sessionStorage?.removeItem(uiClosedStorageKey()); } catch { /* 隐私模式禁用 sessionStorage 时仍可正常运行。 */ } }

  function receiveSnapshot(snapshot) {
    view.snapshot = snapshot;
    draw();
  }

  function draw() {
    if (!view.ui) return;
    const snapshot = view.snapshot;
    const query = (selector) => view.ui.querySelector(selector);
    const stateNode = query('[data-state]'); if (stateNode) stateNode.textContent = TEXT[snapshot.status] || snapshot.status;
    const stats = snapshot.stats || {};
    const statsNode = query('[data-stats]'); if (statsNode) statsNode.textContent = `累计一级评论 ${stats.topLevel || 0} · 累计回复 ${stats.replies || 0} · 命中 ${stats.matched || 0} · 待处理 ${(snapshot.candidates || []).length} · 删除 ${stats.deleted || 0} · 跳过 ${stats.skipped || 0}`;
    const paginationNode = query('[data-pagination]');
    if (paginationNode) {
      const pagination = snapshot.pagination;
      paginationNode.textContent = pagination
        ? `加载轮次 ${pagination.batchIndex} · 本轮新增 ${pagination.newIds} · 无新增 ${pagination.noGrowthAttempts}/${runtime?.settings?.pagination?.noGrowthAttempts || 0}`
        : '连续加载已启用';
    }
    const restLeft = snapshot.status === 'scheduled-rest' && snapshot.refresh?.nextRefreshAt ? Math.max(0, snapshot.refresh.nextRefreshAt - Date.now()) : 0;
    const waitNode = query('[data-wait]'); if (waitNode) waitNode.textContent = restLeft ? `本轮已完成，${Math.ceil(restLeft / 60000)} 分钟后刷新并继续。` : (snapshot.waiting || '');
    const errorNode = query('[data-error]'); if (errorNode) errorNode.textContent = snapshot.error || '';
    const start = query('[data-start]'); if (start) { start.textContent = snapshot.status === 'paused' ? '继续' : '开始'; start.disabled = !snapshot.actions?.canStart; }
    const preview = query('[data-preview]'); if (preview) preview.disabled = !snapshot.actions?.canPreview;
    const pauseButton = query('[data-pause]'); if (pauseButton) pauseButton.disabled = !snapshot.actions?.canPause;
    const stopButton = query('[data-stop]'); if (stopButton) stopButton.disabled = !snapshot.actions?.canStop;
    const main = query('[data-panel]'); if (main) main.hidden = !['expanded', 'confirming-close'].includes(view.uiMode);
    const launcher = query('[data-launcher]'); if (launcher) launcher.hidden = !['launcher', 'dragging'].includes(view.uiMode);
    const dialog = query('[data-close-dialog]'); if (dialog) dialog.hidden = view.uiMode !== 'confirming-close';
    const confirmButton = query('[data-confirm-close]'); if (confirmButton) confirmButton.disabled = view.closeDialog?.busy === true;
    if (view.host && view.uiMode !== 'dragging') applyLauncherPosition();
  }

  function panel(force = false) {
    if (!force && isUiClosed()) return;
    if (global.document.getElementById('icc-host')) return;
    const host = global.document.createElement('div'); host.id = 'icc-host';
    host.style.cssText = 'position:fixed;z-index:2147483647;isolation:isolate';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host{all:initial}*{box-sizing:border-box}button{font:inherit;cursor:pointer}
      .launcher-wrap{position:relative;width:36px;height:44px;display:flex;align-items:center}.launcher{width:36px;height:36px;padding:8px;border:1px solid #cbd5e1;border-radius:18px 0 0 18px;background:#eef0f2;color:#1f2937;box-shadow:0 4px 12px #0003;display:grid;place-items:center;transition:background .16s,box-shadow .16s}.launcher:hover,.launcher:focus-visible{background:#fff;box-shadow:0 6px 16px #0004;outline:2px solid #93c5fd;outline-offset:1px}.launcher[data-edge="left"]{border-radius:0 18px 18px 0}.launcher[data-edge="top"],.launcher[data-edge="bottom"]{border-radius:18px}.launcher svg{width:18px;height:18px;display:block}.launcher-close{position:absolute;left:-7px;bottom:-1px;width:14px;height:14px;padding:0;border:1px solid #d1d5db;border-radius:50%;background:#fff;color:#374151;font-size:11px;line-height:11px;box-shadow:0 2px 7px #1113;opacity:0;pointer-events:none;transition:opacity .12s}.launcher-wrap:hover .launcher-close,.launcher-wrap:focus-within .launcher-close{opacity:1;pointer-events:auto}.launcher-close:focus-visible{outline:2px solid #2563eb;outline-offset:1px}
      main{font:13px system-ui,-apple-system,sans-serif;color:#111;background:#fff;border:1px solid #d1d5db;border-radius:10px;box-shadow:0 8px 28px #0003;width:340px;padding:14px}header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}h2{font-size:14px;margin:0}header .tools{display:flex;gap:4px}header button{width:28px;height:26px;padding:0;border:0;border-radius:5px;background:#eef2ff;color:#374151}header button:hover,header button:focus-visible{background:#dbeafe;outline:2px solid #93c5fd}.close-dialog{position:absolute;right:14px;bottom:14px;width:312px;padding:12px;border:1px solid #f59e0b;border-radius:8px;background:#fffbeb;box-shadow:0 6px 22px #0003;color:#78350f}.close-dialog p{margin:0 0 10px;line-height:1.5}.dialog-actions{display:flex;justify-content:flex-end;gap:7px}.dialog-actions button{border:0;border-radius:6px;padding:7px 10px}.dialog-actions [data-cancel-close]{background:#fff;color:#92400e;border:1px solid #fbbf24}.dialog-actions [data-confirm-close]{background:#d97706;color:#fff}.close-dialog[hidden],main[hidden],.launcher[hidden]{display:none!important}p{margin:7px 0}.muted{color:#666}.wait,.pagination{color:#075985;min-height:1em}.error{color:#b42318;min-height:1em}.actions{display:flex;gap:6px;flex-wrap:wrap}.actions button{border:0;border-radius:6px;padding:7px 10px;background:#2563eb;color:#fff}.actions button[data-preview]{background:#0f766e}.actions button[data-pause]{background:#d97706}.actions button[data-stop]{background:#6b7280}.actions button:disabled{opacity:.5;cursor:not-allowed}
    </style>
    <div class="launcher-wrap"><button class="launcher" data-launcher data-edge="right" role="button" tabindex="0" aria-label="打开社交评论清理器"><svg viewBox="0 0 128 128" aria-hidden="true"><rect width="128" height="128" rx="28" fill="#2563eb"/><path d="M24 38c0-10 8-18 18-18h44c10 0 18 8 18 18v29c0 10-8 18-18 18H58L38 100V86c-8-2-14-9-14-19Z" fill="#fff"/><circle cx="50" cy="53" r="6" fill="#2563eb"/><circle cx="65" cy="53" r="6" fill="#2563eb"/><circle cx="80" cy="53" r="6" fill="#2563eb"/><path d="m77 104 28-28 7 7-28 28-13 3 3-10Z" fill="#fbbf24"/></svg></button><button class="launcher-close" data-launcher-close aria-label="关闭当前页面控件" title="关闭当前页面控件">×</button></div>
    <main data-panel hidden><header><h2>社交评论清理器</h2><div class="tools"><button data-minimize aria-label="最小化面板" title="最小化">—</button><button data-close aria-label="关闭当前页面控件" title="关闭">×</button></div></header><p>状态：<b data-state>空闲</b></p><p class="muted" data-stats></p><p class="pagination" data-pagination></p><p class="wait" data-wait></p><p class="error" data-error></p><div class="actions"><button data-start aria-label="开始清理">开始</button><button data-pause aria-label="暂停任务">暂停</button><button data-stop aria-label="停止任务">停止</button><button data-preview aria-label="预览模式">预览模式</button></div></main>
    <div class="close-dialog" data-close-dialog role="dialog" aria-modal="true" aria-labelledby="close-title" hidden><p id="close-title">当前任务正在运行，关闭后将暂停任务并退出当前页面控件。确定关闭吗？</p><div class="dialog-actions"><button data-cancel-close aria-label="取消关闭">取消</button><button data-confirm-close aria-label="关闭并暂停">关闭并暂停</button></div></div>`;
    view.ui = root; view.host = host; global.document.documentElement.append(host);
    const launcher = root.querySelector('[data-launcher]');
    launcher.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); if (view.drag?.ignoreNextClick) { view.drag.ignoreNextClick = false; return; } openPanel(); });
    launcher.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openPanel(); } if (event.key === 'Escape') cancelLauncherDrag(); });
    launcher.addEventListener('pointerdown', beginLauncherDrag);
    launcher.addEventListener('pointermove', moveLauncherDrag);
    launcher.addEventListener('pointerup', finishLauncherDrag);
    launcher.addEventListener('pointercancel', cancelLauncherDrag);
    root.querySelector('[data-launcher-close]').onclick = requestClose;
    root.addEventListener('keydown', (event) => { if (event.key === 'Escape' && view.uiMode === 'confirming-close') { event.preventDefault(); cancelClose(); } });
    root.querySelector('[data-start]').onclick = () => start('run');
    root.querySelector('[data-preview]').onclick = () => start('preview');
    root.querySelector('[data-pause]').onclick = pause;
    root.querySelector('[data-stop]').onclick = stop;
    root.querySelector('[data-minimize]').onclick = minimizePanel;
    root.querySelector('[data-close]').onclick = requestClose;
    root.querySelector('[data-cancel-close]').onclick = cancelClose;
    root.querySelector('[data-confirm-close]').onclick = confirmClose;
    global.addEventListener('resize', keepLauncherInViewport);
    global.addEventListener('blur', cancelLauncherDrag);
    applyLauncherPosition(); draw();
  }

  function ensurePanel(force = false) { if (!view.ui || !view.host?.isConnected) panel(force); return Boolean(view.ui); }
  function openPanel() { setUiClosed(false); if (!ensurePanel(true)) return; view.uiMode = panelState?.transition ? panelState.transition({ uiMode: view.uiMode }, 'open').uiMode : 'expanded'; draw(); }
  function minimizePanel() { if (!view.ui) return; view.uiMode = 'launcher'; view.closeDialog = null; draw(); }
  function closeControl() { setUiClosed(true); if (!view.host) return; view.uiMode = 'closed'; view.host.remove(); view.host = null; view.ui = null; view.closeDialog = null; }
  function requestClose() {
    if (!ensurePanel()) return;
    if (view.pauseFailure) { view.uiMode = 'expanded'; view.closeDialog = null; draw(); return; }
    const next = panelState?.transition ? panelState.transition({ uiMode: view.uiMode }, 'request-close', { taskState: view.snapshot.status }).uiMode : (panelState?.shouldConfirmClose?.(view.snapshot.status) ? 'confirming-close' : 'closed');
    view.uiMode = next;
    if (next === 'closed') return closeControl();
    view.closeDialog = { busy: false }; draw(); setTimeout(() => view.ui?.querySelector('[data-cancel-close]')?.focus(), 0);
  }
  function cancelClose() { if (!view.ui) return; view.uiMode = 'expanded'; view.closeDialog = null; draw(); }
  async function confirmClose() {
    if (!view.ui || view.closeDialog?.busy) return;
    view.closeDialog = { busy: true }; draw();
    const result = await pause();
    if (!result?.ok) { view.closeDialog = null; view.uiMode = 'expanded'; view.snapshot = { ...view.snapshot, error: result?.reason || '暂停任务失败，请使用“暂停”或“停止”按钮处理。' }; draw(); return; }
    view.uiMode = 'closed'; closeControl();
  }

  function applyLauncherPosition() {
    if (!view.host || view.uiMode === 'expanded' || view.uiMode === 'confirming-close') { if (view.host && view.uiMode !== 'dragging') { view.host.style.right = '16px'; view.host.style.bottom = '16px'; view.host.style.left = 'auto'; view.host.style.top = 'auto'; } return; }
    const launcher = view.ui.querySelector('[data-launcher]'); if (!launcher) return;
    const rect = launcher.parentElement?.getBoundingClientRect?.() || launcher.getBoundingClientRect();
    view.launcherPosition = panelState?.clampPosition ? panelState.clampPosition(view.launcherPosition, { viewportWidth: global.innerWidth, viewportHeight: global.innerHeight, launcherWidth: rect.width || 48, launcherHeight: rect.height || 48, safeMargin: 12 }) : view.launcherPosition;
    launcher.dataset.edge = view.launcherPosition.edge;
    view.host.style.left = view.host.style.right = view.host.style.top = view.host.style.bottom = 'auto';
    if (view.launcherPosition.edge === 'left') { view.host.style.left = '0'; view.host.style.top = `${view.launcherPosition.offset}px`; }
    if (view.launcherPosition.edge === 'right') { view.host.style.right = '0'; view.host.style.top = `${view.launcherPosition.offset}px`; }
    if (view.launcherPosition.edge === 'top') { view.host.style.top = '12px'; view.host.style.left = `${view.launcherPosition.offset}px`; }
    if (view.launcherPosition.edge === 'bottom') { view.host.style.bottom = '12px'; view.host.style.left = `${view.launcherPosition.offset}px`; }
  }
  function beginLauncherDrag(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const rect = event.currentTarget.parentElement?.getBoundingClientRect?.() || event.currentTarget.getBoundingClientRect();
    clearTimeout(view.drag?.timer);
    view.drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false, timer: setTimeout(() => beginDragging(event), 500), target: event.currentTarget, previousPosition: { ...view.launcherPosition }, width: rect.width || 48, height: rect.height || 48, ignoreNextClick: false };
  }
  function beginDragging(event) { if (!view.drag || view.drag.pointerId !== event.pointerId || view.uiMode === 'closed') return; view.drag.moved = true; view.drag.ignoreNextClick = true; view.uiMode = 'dragging'; try { view.drag.target?.setPointerCapture?.(event.pointerId); } catch { /* 某些触控环境不支持捕获。 */ } global.document.documentElement.style.userSelect = 'none'; draw(); }
  function moveLauncherDrag(event) {
    if (!view.drag || view.drag.pointerId !== event.pointerId) return;
    if (!view.drag.moved && panelState?.hasMoved?.(view.drag.startX, view.drag.startY, event.clientX, event.clientY, 6)) beginDragging(event);
    if (view.uiMode !== 'dragging') return;
    event.preventDefault(); event.stopPropagation();
    const width = view.drag.width || 48; const height = view.drag.height || 48;
    view.host.style.left = `${Math.max(12, Math.min(global.innerWidth - width - 12, event.clientX - width / 2))}px`;
    view.host.style.top = `${Math.max(12, Math.min(global.innerHeight - height - 12, event.clientY - height / 2))}px`;
    view.host.style.right = view.host.style.bottom = 'auto';
  }
  function finishLauncherDrag(event) {
    if (!view.drag || view.drag.pointerId !== event.pointerId) return;
    clearTimeout(view.drag.timer);
    if (view.uiMode === 'dragging') {
      const rect = view.ui.querySelector('[data-launcher]')?.parentElement?.getBoundingClientRect?.() || view.ui.querySelector('[data-launcher]')?.getBoundingClientRect();
      view.launcherPosition = panelState?.nearestEdgePosition?.({ centerX: rect.left + rect.width / 2, centerY: rect.top + rect.height / 2, viewportWidth: global.innerWidth, viewportHeight: global.innerHeight, launcherWidth: rect.width, launcherHeight: rect.height, safeMargin: 12 }) || view.launcherPosition;
      view.uiMode = 'launcher'; global.document.documentElement.style.userSelect = ''; applyLauncherPosition();
    }
    view.drag = { ...view.drag, pointerId: null, timer: null, moved: false };
    try { event.currentTarget?.releasePointerCapture?.(event.pointerId); } catch { /* ignore */ }
    draw();
  }
  function cancelLauncherDrag() { if (!view.drag?.pointerId && view.uiMode !== 'dragging') return; clearTimeout(view.drag?.timer); view.launcherPosition = { ...(view.drag.previousPosition || view.launcherPosition) }; view.uiMode = 'launcher'; view.drag = { ...view.drag, pointerId: null, timer: null, moved: false, ignoreNextClick: true }; global.document.documentElement.style.userSelect = ''; applyLauncherPosition(); draw(); }
  function keepLauncherInViewport() { if (view.uiMode === 'launcher') { applyLauncherPosition(); draw(); } }

  async function getSettings() {
    const response = await global.chrome.runtime.sendMessage({ type: 'SC_GET_SETTINGS' });
    if (!response?.ok) throw new Error(response?.reason || '无法读取扩展设置。');
    const paced = global.SocialCommentPaceConfig.validateSettings(response.settings || {});
    const settings = global.SocialCommentPlatformSettings.normalize(paced);
    if (settings.platformId !== platform.id) throw new Error('当前页面与已保存的平台设置不匹配。');
    return settings;
  }

  function createRuntime(settings) {
    const targetUrl = platform.identity.normalizeTargetUrl(settings.targetUrl);
    const transport = global.SocialCommentRuntimeTransport.create({ platformId: platform.id, canonicalTargetUrl: targetUrl });
    return global.SocialCommentCleanerRuntime.create({
      platform,
      settings,
      transport,
      pace: new global.SocialCommentActionPaceController(settings.pace),
      delayGenerator: (config) => global.DelayGenerator.generateDelayMs(config),
      onSnapshot: receiveSnapshot,
    });
  }

  async function start(mode, checkpoint = null) {
    if (runtime?.isActive()) return { ok: false, reason: '任务正在运行。' };
    view.pauseFailure = false;
    try {
      const settings = await getSettings();
      const targetUrl = platform.identity.normalizeTargetUrl(settings.targetUrl);
      if (!targetUrl) throw new Error('目标 URL 无效。');
      const restored = checkpoint || (runtime?.snapshot?.().status === 'paused' ? runtime.checkpoint('paused') : null);
      runtime = createRuntime(settings);
      const result = await runtime.start({ mode, targetUrl, page: global.document, checkpoint: restored });
      if (!result.ok) return result;
      if (!result.scheduled) runtime.run();
      return result;
    } catch (error) {
      view.snapshot = { ...view.snapshot, status: 'paused', error: error.message || '启动失败' };
      draw();
      return { ok: false, reason: error.message || '启动失败' };
    }
  }

  async function pause() {
    if (!runtime) return { ok: true };
    const result = await runtime.pause();
    view.pauseFailure = !result?.ok;
    return result;
  }

  async function stop() {
    if (!runtime) return { ok: true };
    return runtime.stop('idle');
  }

  async function restorePending() {
    const targetUrl = platform.identity.normalizeTargetUrl(global.location.href);
    if (!targetUrl) return;
    const response = await global.chrome.runtime.sendMessage({ type: 'SC_GET_SESSION', platformId: platform.id, canonicalTargetUrl: targetUrl });
    const snapshot = response?.snapshot;
    if (!snapshot || !['running', 'scheduled-rest', 'refreshing'].includes(snapshot.status)) return;
    await start('run', snapshot);
  }

  global.chrome.runtime.onMessage.addListener((message, sender, reply) => {
    const type = message?.type === 'ICC_PAUSE' ? 'SC_PAUSE' : message?.type === 'ICC_STOP' ? 'SC_STOP' : message?.type === 'ICC_START' ? 'SC_START' : message?.type === 'ICC_PREVIEW' ? 'SC_PREVIEW' : message?.type;
    if (message?.platformId && message.platformId !== platform.id) return false;
    if (type === 'SC_PAUSE') { pause().then(reply); return true; }
    if (type === 'SC_STOP') { stop().then(reply); return true; }
    if (!['SC_START', 'SC_PREVIEW'].includes(type)) return false;
    openPanel(); start(type === 'SC_START' ? 'run' : 'preview').then(reply); return true;
  });

  if (platform.identity.matchesPage(global.location)) {
    if (!isUiClosed()) panel();
    restorePending().catch((error) => { view.snapshot = { ...view.snapshot, status: 'paused', error: error.message || '恢复任务失败' }; draw(); });
  }
})(globalThis);
