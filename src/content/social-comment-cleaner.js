(function () {
  'use strict';
  const KEY = 'socialCommentCleanerSettings';
  const UI_CLOSED_KEY = 'socialCommentCleanerUiClosed';
  const TEXT = { idle: '空闲', 'waiting-surface': '等待评论区', expanding: '展开中', stabilizing: '等待稳定', scanning: '扫描中', loading: '加载下一批', 'waiting-load': '等待下一批', running: '运行中', 'waiting-delete': '确认删除', 'cooling-down': '当前轮次休息', 'scheduled-rest': '等待下一轮', completed: '已完成', paused: '已暂停', error: '错误' };
  const stabilityDefaults = globalThis.InstagramCommentSurfaceStability?.DEFAULTS || { mutationDebounceMs: 250, rafConfirmCount: 2, stablePasses: 2, initialReadyTimeoutMs: 15000, postDeleteSettleTimeoutMs: 10000, emptyRescanAttempts: 3 };
  const panelState = globalThis.SocialCommentFloatingPanel;
  const initialPanelState = panelState?.createState?.() || { uiMode: 'launcher', launcherPosition: { edge: 'right', offset: 64 }, drag: {} };
  const run = { stopped: true, paused: false, starting: false, pauseFailure: false, mode: 'preview', state: 'idle', sessionId: '', startedAt: 0, stats: { scanned: 0, matched: 0, deleted: 0, skipped: 0, loaded: 0, discovered: 0, topLevel: 0, replies: 0, batches: 0, newComments: 0 }, candidates: [], timer: null, restTimer: null, lockTimer: null, waiting: '', error: '', refresh: { count: 0, restStartedAt: 0, restDelayMs: 0, nextRefreshAt: 0, lastReason: '' }, seenIds: new Set(), seenCommentIds: new Set(), seenReplyIds: new Set(), matchedIds: new Set(), skippedIds: new Set(), processedIds: new Set(), lastScanIds: new Set(), scanInFlight: false, scanGeneration: 0, pagination: null, ui: null, host: null, uiMode: initialPanelState.uiMode, launcherPosition: { ...initialPanelState.launcherPosition }, drag: { ...initialPanelState.drag }, closeDialog: null, stability: { surface: null, surfaceGeneration: 0, mutationVersion: 0, lastMutationAt: 0, observer: null, discoveryObserver: null, pending: new Set(), discoveryCount: 0, stage: '', lastSnapshot: '' } };
  function uiClosedStorageKey() { return `${UI_CLOSED_KEY}:${location.origin}${location.pathname}`; }
  function isUiClosed() { try { return globalThis.sessionStorage?.getItem(uiClosedStorageKey()) === '1'; } catch { return false; } }
  function setUiClosed(closed) { try { if (closed) globalThis.sessionStorage?.setItem(uiClosedStorageKey(), '1'); else globalThis.sessionStorage?.removeItem(uiClosedStorageKey()); } catch { /* 隐私模式禁用 sessionStorage 时仍可正常运行 */ } }
  function send(message) {
    // 扩展热重载后，旧页面脚本仍可能运行在已失效的上下文中；此时
    // sendMessage 会同步抛错，不能只依赖 Promise.catch 捕获。
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime?.id) return Promise.resolve({ ok: false, reason: '扩展上下文已失效，请刷新 Instagram 页面。' });
      return chrome.runtime.sendMessage(message).catch(() => ({ ok: false, reason: '扩展后台不可用，请刷新 Instagram 页面。' }));
    } catch {
      return Promise.resolve({ ok: false, reason: '扩展上下文已失效，请刷新 Instagram 页面。' });
    }
  }
  const visible = (node) => { const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
  const text = (node) => (node.innerText || node.textContent || '').trim();
  const normalizedText = (node) => text(node).replace(/\s+/g, ' ').trim();
  // 兼容旧测试和旧页面的正则别名；实际扫描由独立标签配置和结构定位器完成。
  const replyExpander = /^(?:view|see)\s+(?:all\s+)?(?:\d+\s+)?(?:more\s+)?repl(?:y|ies)|^\d+\s+repl(?:y|ies)\s+(?:to\s+)?view$|^\d+件(?:すべての|の)?返信を見る$|^(?:\d+件(?:の)?返信|返信\s*\d*件?|すべての返信)(?:を見る|を表示)$|^返信をすべて見る$|^查看(?:全部|所有)?\s*\d*\s*条?回复$/i;
  const hiddenCommentExpander = /^(?:see|view)\s+hidden\s+comments?$|^非表示のコメントを見る$|^非表示.*コメント.*見る$|^查看隐藏评论$|^查看.*隐藏.*评论$/i;
  // 作品详情页的评论列表还会使用“加载/查看更多评论或回复”分页入口。
  const loadMoreExpander = /^(?:load|view|see)\s+(?:more|all)\s+(?:comments?|repl(?:y|ies))$|^(?:加载更多|查看更多|查看全部)(?:评论|回复)$|^(?:コメント|返信)を(?:さらに|もっと)(?:読み込む|見る)$|^(?:コメント|返信)をすべて見る$/i;
  function controlLabels(node) {
    return globalThis.InstagramControlLocator?.getAccessibleLabels?.(node) || (node ? [normalizedText(node), node.getAttribute?.('aria-label'), node.getAttribute?.('title')].filter(Boolean) : []);
  }
  function controlLabel(node) { return controlLabels(node).join(' '); }
  function isCommentExpansionControl(node) {
    return globalThis.InstagramControlLocator?.isExpansionControl?.(node) || controlLabels(node).some((label) => replyExpander.test(label) || hiddenCommentExpander.test(label) || loadMoreExpander.test(label));
  }
  function isLoadMoreControl(node) { return globalThis.InstagramControlLocator?.findLoadMoreControls?.(node?.parentElement || document).includes(node) || controlLabels(node).some((label) => loadMoreExpander.test(label)); }
  function findLoadingIndicator(root = document) {
    const nodes = root?.querySelectorAll ? [...root.querySelectorAll('[role="progressbar"],[aria-busy="true"]')] : [];
    return nodes.some(visible);
  }
  function cancelStabilityWait() { for (const pending of run.stability.pending) { clearTimeout(pending.timer); pending.frameIds?.forEach((id) => globalThis.cancelAnimationFrame?.(id)); pending.resolve(false); } run.stability.pending.clear(); }
  function disconnectStabilityObservers() { run.stability.observer?.disconnect(); run.stability.observer = null; run.stability.discoveryObserver?.disconnect(); run.stability.discoveryObserver = null; run.stability.surface = null; run.stability.surfaceGeneration += 1; run.stability.mutationVersion += 1; }
  function resetStability() { cancelStabilityWait(); disconnectStabilityObservers(); run.stability.discoveryCount = 0; run.stability.stage = ''; run.stability.lastSnapshot = ''; }
  function finishWait(value) { const resolve = run.waitResolve; run.waitResolve = null; run.waitObserver?.disconnect(); run.waitObserver = null; clearTimeout(run.timer); run.timer = null; run.waiting = ''; draw(); if (resolve) resolve(value); }
  const wait = (ms, why) => new Promise((resolve) => { run.waiting = why; run.waitResolve = resolve; draw(); run.timer = setTimeout(() => finishWait(!run.stopped && !run.paused), ms); });
  function waitForCondition(predicate, timeoutMs, why) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const check = () => {
        if (run.stopped || run.paused) return finishWait(false);
        let matched = false;
        try { matched = Boolean(predicate()); } catch { matched = false; }
        if (matched || Date.now() - startedAt >= timeoutMs) return finishWait(matched);
        run.timer = setTimeout(check, 120);
      };
      run.waiting = why;
      run.waitResolve = resolve;
      draw();
      check();
    });
  }

  function draw() {
    if (!run.ui) return;
    const query = (selector) => run.ui.querySelector(selector);
    const stateNode = query('[data-state]'); if (stateNode) stateNode.textContent = TEXT[run.state] || run.state;
    const statsNode = query('[data-stats]'); if (statsNode) statsNode.textContent = `累计一级评论 ${run.stats.topLevel} · 累计回复 ${run.stats.replies} · 命中 ${run.stats.matched} · 待处理 ${run.candidates.length} · 删除 ${run.stats.deleted} · 跳过 ${run.stats.skipped}`;
    const paginationState = run.pagination?.getSnapshot?.() || run.pagination?.state;
    const paginationNode = query('[data-pagination]'); if (paginationNode) paginationNode.textContent = paginationState
      ? `加载轮次 ${paginationState.batchIndex} · 本轮新增 ${paginationState.newIds} · 无新增 ${paginationState.noGrowthAttempts}/${run.settings?.pagination?.noGrowthAttempts || 0}`
      : '连续加载已启用';
    const restLeft = run.state === 'scheduled-rest' && run.refresh.nextRefreshAt ? Math.max(0, run.refresh.nextRefreshAt - Date.now()) : 0;
    const waitNode = query('[data-wait]'); if (waitNode) waitNode.textContent = restLeft ? `本轮已完成，${Math.ceil(restLeft / 60000)} 分钟后刷新并继续。` : run.waiting;
    const errorNode = query('[data-error]'); if (errorNode) errorNode.textContent = run.error || '';
    const active = !run.stopped && !run.paused; const busy = active || run.starting;
    const start = query('[data-start]'); if (start) { start.textContent = run.paused ? '继续' : '开始'; start.disabled = busy; }
    const preview = query('[data-preview]'); if (preview) preview.disabled = busy || run.paused;
    const pauseButton = query('[data-pause]'); if (pauseButton) pauseButton.disabled = !active;
    const stopButton = query('[data-stop]'); if (stopButton) stopButton.disabled = run.stopped;
    const main = query('[data-panel]'); if (main) main.hidden = !['expanded', 'confirming-close'].includes(run.uiMode);
    const launcher = query('[data-launcher]'); if (launcher) launcher.hidden = !['launcher', 'dragging'].includes(run.uiMode);
    const dialog = query('[data-close-dialog]'); if (dialog) dialog.hidden = run.uiMode !== 'confirming-close';
    const confirmButton = query('[data-confirm-close]'); if (confirmButton) confirmButton.disabled = run.closeDialog?.busy === true;
    if (run.host && run.uiMode !== 'dragging') applyLauncherPosition();
  }
  function panel(force = false) {
    if (!force && isUiClosed()) return;
    if (document.getElementById('icc-host')) return;
    const host = document.createElement('div'); host.id = 'icc-host';
    host.style.cssText = 'position:fixed;z-index:2147483647;isolation:isolate';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host{all:initial}*{box-sizing:border-box}button{font:inherit;cursor:pointer}
      .launcher-wrap{position:relative;width:36px;height:44px;display:flex;align-items:center}.launcher{width:36px;height:36px;padding:8px;border:1px solid #cbd5e1;border-radius:18px 0 0 18px;background:#eef0f2;color:#1f2937;box-shadow:0 4px 12px #0003;display:grid;place-items:center;transition:background .16s,box-shadow .16s}.launcher:hover,.launcher:focus-visible{background:#fff;box-shadow:0 6px 16px #0004;outline:2px solid #93c5fd;outline-offset:1px}.launcher[data-edge="left"]{border-radius:0 18px 18px 0}.launcher[data-edge="top"],.launcher[data-edge="bottom"]{border-radius:18px}.launcher svg{width:18px;height:18px;display:block}.launcher-label{display:none}.launcher-close{position:absolute;left:-7px;bottom:-1px;width:14px;height:14px;padding:0;border:1px solid #d1d5db;border-radius:50%;background:#fff;color:#374151;font-size:11px;line-height:11px;box-shadow:0 2px 7px #1113;opacity:0;pointer-events:none;transition:opacity .12s}.launcher-wrap:hover .launcher-close,.launcher-wrap:focus-within .launcher-close{opacity:1;pointer-events:auto}.launcher-close:focus-visible{outline:2px solid #2563eb;outline-offset:1px}
      main{font:13px system-ui,-apple-system,sans-serif;color:#111;background:#fff;border:1px solid #d1d5db;border-radius:10px;box-shadow:0 8px 28px #0003;width:340px;padding:14px}header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}h2{font-size:14px;margin:0}header .tools{display:flex;gap:4px}header button{width:28px;height:26px;padding:0;border:0;border-radius:5px;background:#eef2ff;color:#374151}header button:hover,header button:focus-visible{background:#dbeafe;outline:2px solid #93c5fd}.close-dialog{position:absolute;right:14px;bottom:14px;width:312px;padding:12px;border:1px solid #f59e0b;border-radius:8px;background:#fffbeb;box-shadow:0 6px 22px #0003;color:#78350f}.close-dialog p{margin:0 0 10px;line-height:1.5}.dialog-actions{display:flex;justify-content:flex-end;gap:7px}.dialog-actions button{border:0;border-radius:6px;padding:7px 10px}.dialog-actions [data-cancel-close]{background:#fff;color:#92400e;border:1px solid #fbbf24}.dialog-actions [data-confirm-close]{background:#d97706;color:#fff}.close-dialog[hidden],main[hidden],.launcher[hidden]{display:none!important}p{margin:7px 0}.muted{color:#666}.wait{color:#075985;min-height:1em}.pagination{color:#075985;min-height:1em}.error{color:#b42318;min-height:1em;min-height:1em}.actions{display:flex;gap:6px;flex-wrap:wrap}.actions button{border:0;border-radius:6px;padding:7px 10px;background:#2563eb;color:#fff}.actions button[data-preview]{background:#0f766e}.actions button[data-pause]{background:#d97706}.actions button[data-stop]{background:#6b7280}.actions button:disabled{opacity:.5;cursor:not-allowed}
    </style>
    <div class="launcher-wrap"><button class="launcher" data-launcher data-edge="right" role="button" tabindex="0" aria-label="打开社交评论清理器"><svg viewBox="0 0 128 128" aria-hidden="true"><rect width="128" height="128" rx="28" fill="#2563eb"/><path d="M24 38c0-10 8-18 18-18h44c10 0 18 8 18 18v29c0 10-8 18-18 18H58L38 100V86c-8-2-14-9-14-19Z" fill="#fff"/><circle cx="50" cy="53" r="6" fill="#2563eb"/><circle cx="65" cy="53" r="6" fill="#2563eb"/><circle cx="80" cy="53" r="6" fill="#2563eb"/><path d="m77 104 28-28 7 7-28 28-13 3 3-10Z" fill="#fbbf24"/></svg></button><button class="launcher-close" data-launcher-close aria-label="关闭当前页面控件" title="关闭当前页面控件">×</button></div>
    <main data-panel hidden><header><h2>社交评论清理器</h2><div class="tools"><button data-minimize aria-label="最小化面板" title="最小化">—</button><button data-close aria-label="关闭当前页面控件" title="关闭">×</button></div></header><p>状态：<b data-state>空闲</b></p><p class="muted" data-stats></p><p class="pagination" data-pagination></p><p class="wait" data-wait></p><p class="error" data-error></p><div class="actions"><button data-start aria-label="开始清理">开始</button><button data-pause aria-label="暂停任务">暂停</button><button data-stop aria-label="停止任务">停止</button><button data-preview aria-label="预览模式">预览模式</button></div></main>
    <div class="close-dialog" data-close-dialog role="dialog" aria-modal="true" aria-labelledby="close-title" hidden><p id="close-title">当前任务正在运行，关闭后将暂停任务并退出当前页面控件。确定关闭吗？</p><div class="dialog-actions"><button data-cancel-close aria-label="取消关闭">取消</button><button data-confirm-close aria-label="关闭并暂停">关闭并暂停</button></div></div>`;
    run.ui = root; run.host = host; document.documentElement.append(host);
    const launcher = root.querySelector('[data-launcher]');
    const launcherClose = root.querySelector('[data-launcher-close]');
    launcher.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); if (run.drag?.ignoreNextClick) { run.drag.ignoreNextClick = false; return; } openPanel(); });
    launcher.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openPanel(); } if (event.key === 'Escape') cancelLauncherDrag(); });
    launcher.addEventListener('pointerdown', beginLauncherDrag);
    launcher.addEventListener('pointermove', moveLauncherDrag);
    launcher.addEventListener('pointerup', finishLauncherDrag);
    launcher.addEventListener('pointercancel', cancelLauncherDrag);
    launcherClose.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); requestClose(); });
    root.addEventListener('keydown', (event) => { if (event.key === 'Escape' && run.uiMode === 'confirming-close') { event.preventDefault(); cancelClose(); } });
    root.querySelector('[data-start]').onclick = () => start('run');
    root.querySelector('[data-preview]').onclick = () => start('preview');
    root.querySelector('[data-pause]').onclick = () => pause();
    root.querySelector('[data-stop]').onclick = () => stop();
    root.querySelector('[data-minimize]').onclick = () => minimizePanel();
    root.querySelector('[data-close]').onclick = () => requestClose();
    root.querySelector('[data-cancel-close]').onclick = () => cancelClose();
    root.querySelector('[data-confirm-close]').onclick = () => confirmClose();
    window.addEventListener('resize', keepLauncherInViewport);
    window.addEventListener('blur', cancelLauncherDrag);
    applyLauncherPosition(); draw();
  }
  function ensurePanel(force = false) { if (!run.ui || !run.host?.isConnected) panel(force); return Boolean(run.ui); }
  function openPanel() { setUiClosed(false); if (!ensurePanel(true)) return; run.uiMode = panelState?.transition ? panelState.transition({ uiMode: run.uiMode }, 'open').uiMode : 'expanded'; draw(); }
  function minimizePanel() { if (!run.ui) return; run.uiMode = 'launcher'; run.closeDialog = null; draw(); }
  function closeControl() { setUiClosed(true); if (!run.host) return; run.uiMode = 'closed'; run.host.remove(); run.host = null; run.ui = null; run.closeDialog = null; }
  function requestClose() {
    if (!ensurePanel()) return;
    if (run.pauseFailure) { run.uiMode = 'expanded'; run.closeDialog = null; draw(); return; }
    const nextMode = panelState?.transition ? panelState.transition({ uiMode: run.uiMode }, 'request-close', { taskState: run.state }).uiMode : (panelState?.shouldConfirmClose?.(run.state) ? 'confirming-close' : 'closed');
    run.uiMode = nextMode;
    if (nextMode === 'closed') { closeControl(); return; }
    run.closeDialog = { busy: false }; draw(); setTimeout(() => run.ui?.querySelector('[data-cancel-close]')?.focus(), 0);
  }
  function cancelClose() { if (!run.ui) return; run.uiMode = 'expanded'; run.closeDialog = null; draw(); }
  async function confirmClose() {
    if (!run.ui || run.closeDialog?.busy) return;
    run.closeDialog = { busy: true }; draw();
    const result = await pause();
    if (!result?.ok) { run.closeDialog = null; run.uiMode = 'expanded'; run.error = result?.reason || '暂停任务失败，请使用“暂停”或“停止”按钮处理。'; draw(); return; }
    run.uiMode = 'closed'; closeControl();
  }
  function applyLauncherPosition() {
    if (!run.host || run.uiMode === 'expanded' || run.uiMode === 'confirming-close') { if (run.host && run.uiMode !== 'dragging') { run.host.style.right = '16px'; run.host.style.bottom = '16px'; run.host.style.left = 'auto'; run.host.style.top = 'auto'; } return; }
    const launcher = run.ui.querySelector('[data-launcher]'); if (!launcher) return;
    const rect = launcher.parentElement?.getBoundingClientRect?.() || launcher.getBoundingClientRect();
    const position = panelState?.clampPosition ? panelState.clampPosition(run.launcherPosition, { viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, launcherWidth: rect.width || 48, launcherHeight: rect.height || 48, safeMargin: 12 }) : run.launcherPosition;
    run.launcherPosition = position;
    launcher.dataset.edge = position.edge;
    run.host.style.left = run.host.style.right = run.host.style.top = run.host.style.bottom = 'auto';
    if (position.edge === 'left') { run.host.style.left = '0'; run.host.style.top = `${position.offset}px`; }
    if (position.edge === 'right') { run.host.style.right = '0'; run.host.style.top = `${position.offset}px`; }
    if (position.edge === 'top') { run.host.style.top = '12px'; run.host.style.left = `${position.offset}px`; }
    if (position.edge === 'bottom') { run.host.style.bottom = '12px'; run.host.style.left = `${position.offset}px`; }
  }
  function beginLauncherDrag(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const launcher = event.currentTarget; const rect = launcher.parentElement?.getBoundingClientRect?.() || launcher.getBoundingClientRect();
    clearTimeout(run.drag?.timer);
    run.drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startAt: Date.now(), moved: false, timer: setTimeout(() => beginDragging(event), 500), target: launcher, previousPosition: { ...run.launcherPosition }, width: rect.width || 48, height: rect.height || 48, ignoreNextClick: false };
  }
  function beginDragging(event) {
    if (!run.drag || run.drag.pointerId !== event.pointerId || run.uiMode === 'closed') return;
    run.drag.moved = true; run.drag.ignoreNextClick = true; run.uiMode = 'dragging';
    try { run.drag.target?.setPointerCapture?.(event.pointerId); } catch { /* 某些触控环境不支持捕获 */ }
    document.documentElement.style.userSelect = 'none'; draw();
  }
  function moveLauncherDrag(event) {
    if (!run.drag || run.drag.pointerId !== event.pointerId) return;
    if (!run.drag.moved && panelState?.hasMoved?.(run.drag.startX, run.drag.startY, event.clientX, event.clientY, 6)) beginDragging(event);
    if (run.uiMode !== 'dragging') return;
    event.preventDefault(); event.stopPropagation();
    const width = run.drag.width || 48; const height = run.drag.height || 48;
    run.host.style.left = `${Math.max(12, Math.min(window.innerWidth - width - 12, event.clientX - width / 2))}px`;
    run.host.style.top = `${Math.max(12, Math.min(window.innerHeight - height - 12, event.clientY - height / 2))}px`;
    run.host.style.right = run.host.style.bottom = 'auto';
  }
  function finishLauncherDrag(event) {
    if (!run.drag || run.drag.pointerId !== event.pointerId) return;
    clearTimeout(run.drag.timer); const wasDragging = run.uiMode === 'dragging';
    if (wasDragging) {
      const rect = run.ui.querySelector('[data-launcher]')?.parentElement?.getBoundingClientRect?.() || run.ui.querySelector('[data-launcher]')?.getBoundingClientRect();
      run.launcherPosition = panelState?.nearestEdgePosition?.({ centerX: rect.left + rect.width / 2, centerY: rect.top + rect.height / 2, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, launcherWidth: rect.width, launcherHeight: rect.height, safeMargin: 12 }) || run.launcherPosition;
      run.uiMode = 'launcher'; run.drag = { ...run.drag, pointerId: null, timer: null, moved: false, previousPosition: { ...run.launcherPosition } }; document.documentElement.style.userSelect = ''; applyLauncherPosition(); draw();
    } else { run.drag = { ...run.drag, pointerId: null, timer: null }; }
    try { event.currentTarget?.releasePointerCapture?.(event.pointerId); } catch { /* ignore */ }
  }
  function cancelLauncherDrag() {
    if (!run.drag?.pointerId && run.uiMode !== 'dragging') return;
    clearTimeout(run.drag?.timer); run.launcherPosition = { ...(run.drag.previousPosition || run.launcherPosition) }; run.uiMode = 'launcher'; run.drag = { ...run.drag, pointerId: null, timer: null, moved: false, ignoreNextClick: true }; document.documentElement.style.userSelect = ''; applyLauncherPosition(); draw();
  }
  function keepLauncherInViewport() { if (run.uiMode === 'launcher') { applyLauncherPosition(); draw(); } }
  function commentIdFromUrl(value) { return String(value || '').match(/\/c\/(\d+)(?:\/|$)/)?.[1] || ''; }
  function replyUsername(container) {
    // 个人主页链接同时承载头像和用户名，排除帖子/评论链接后首个即为回复作者。
    for (const link of container.querySelectorAll('a[href]')) {
      const match = link.getAttribute('href')?.match(/^\/([^/?#]+)\/?$/);
      if (match) return decodeURIComponent(match[1]);
    }
    return '';
  }
  function commentLinksIn(node) {
    if (!node?.querySelectorAll) return [];
    const links = [...node.querySelectorAll('a[href*="/c/"]')];
    if (node.matches?.('a[href*="/c/"]')) links.push(node);
    return [...new Set(links)].filter((link) => commentIdFromUrl(link.getAttribute('href')));
  }
  function commentRowForLink(link) {
    // Instagram 当前版本没有稳定的评论 class；以“祖先只包含当前评论链接”为行边界，
    // 这样展开的回复列表会自然形成独立行，不需要读取接口或内部 JSON。
    let node = link; let row = null;
    for (let depth = 0; node && depth < 20; depth += 1, node = node.parentElement) {
      const links = commentLinksIn(node);
      if (links.length !== 1) break;
      row = node;
      // 评论行至少包含回复、点赞或菜单等操作控件；在第一个控件祖先处截断，
      // 避免只有一条评论时一路爬到整个 main/page 容器。
      if (node !== link && node.querySelector('button,[role="button"]')) break;
    }
    return row;
  }
  function rowUsername(row) {
    const profile = [...row.querySelectorAll('a[href]')].find((link) => /^\/[^/?#]+\/?$/.test(link.getAttribute('href') || ''));
    return String(profile?.innerText || profile?.textContent || '').trim().replace(/^@+/, '');
  }
  function rowCommentText(row, username) {
    const times = new Set([...row.querySelectorAll('time')].map((node) => normalizedText(node)));
    const controls = new Set();
    [...row.querySelectorAll('button,[role="button"]')].forEach((node) => {
      controlLabels(node).forEach((label) => controls.add(label));
      // 无文字的图标按钮不应把评论正文误判为操作文案；结构定位器只负责排除其所在操作节点。
      if (globalThis.InstagramControlLocator?.findCommentMenu?.(row) === node) controls.add(normalizedText(node));
    });
    const lines = String(row.innerText || row.textContent || '').split(/\r?\n+/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
    return lines.filter((line) => line !== username && !times.has(line) && !controls.has(line)
      && !replyExpander.test(line) && !hiddenCommentExpander.test(line) && !loadMoreExpander.test(line)
      && !/^(?:translate|翻译(?:を見る)?|翻譯|翻訳を見る)$/i.test(line)).join(' ').trim();
  }
  function domComments(root = document) {
    if (!root?.querySelectorAll) return [];
    const entries = new Map();
    for (const link of root.querySelectorAll('a[href*="/c/"]')) {
      if (!visible(link)) continue;
      const id = commentIdFromUrl(link.getAttribute('href')); const row = commentRowForLink(link);
      if (!id || !row || !visible(row) || entries.has(id)) continue;
      const username = rowUsername(row); const commentText = rowCommentText(row, username);
      if (!username || !commentText) continue;
      entries.set(id, { id, parentId: '', username, text: commentText, childCount: 0, isReply: Boolean(link.closest('ul')), element: row });
    }
    const all = [...entries.values()];
    const parents = all.filter((item) => !item.isReply);
    all.filter((item) => item.isReply).forEach((reply) => {
      // 回复 DOM 紧跟所属一级评论之后；取其之前最近的一级评论作为父级，
      // 仅用于“先回复后一级”的排序和作者保护，不猜测未渲染的评论。
      const previous = parents.filter((parent) => (parent.element.compareDocumentPosition(reply.element) & 4) !== 0).pop();
      if (previous) reply.parentId = previous.id;
    });
    return all;
  }
  function visibleCommentLinks(root = document) {
    if (!root?.querySelectorAll) return [];
    return [...root.querySelectorAll('a[href*="/c/"]')].filter((link) => visible(link) && commentIdFromUrl(link.getAttribute('href')));
  }
  function surfaceScore(node) {
    const links = visibleCommentLinks(node);
    if (!links.length || !node.isConnected || !visible(node)) return -1;
    const controls = [...node.querySelectorAll('button,[role="button"]')].filter(visible).length;
    const authors = [...node.querySelectorAll('a[href]')].filter((link) => /^\/[^/?#]+\/?$/.test(link.getAttribute('href') || '') && visible(link)).length;
    // 评分偏向能容纳多条评论的最近祖先，避免把整页 main/body 当成评论容器。
    return Math.min(links.length, 12) * 20 + Math.min(authors, 8) * 3 + Math.min(controls, 8) - Math.min(node.querySelectorAll('*').length, 20000) / 20000;
  }
  function discoverCommentSurface() {
    const links = visibleCommentLinks();
    if (!links.length) return null;
    const candidates = new Set();
    links.forEach((link) => {
      let node = link;
      // Instagram 新版评论行与共同滚动容器之间可能超过 9 层，
      // 需要扩大祖先搜索范围才能覆盖同一评论区中的全部回复。
      for (let depth = 0; node && depth < 20; depth += 1, node = node.parentElement) {
        if (node !== document.body && node !== document.documentElement) candidates.add(node);
      }
    });
    const scored = [...candidates].map((node) => {
      const commentCount = visibleCommentLinks(node).length;
      const controls = [...node.querySelectorAll('button,[role="button"]')].filter(visible).length;
      const descendants = node.querySelectorAll('*').length;
      return { node, commentCount, controls, descendants, score: surfaceScore(node) };
    }).filter((candidate) => candidate.commentCount > 0 && candidate.score >= 0);
    const maxCommentCount = Math.max(...scored.map((candidate) => candidate.commentCount), 0);
    return scored
      .filter((candidate) => candidate.commentCount === maxCommentCount)
      .sort((left, right) => {
        // 优先覆盖全部可见评论，再选择最小容器；只有单条评论时优先保留带操作控件的行。
        if (maxCommentCount === 1 && left.controls !== right.controls) return right.controls - left.controls;
        return left.descendants - right.descendants || right.score - left.score;
      })[0]?.node || null;
  }
  function bindCommentSurface(surface) {
    const stability = run.stability;
    if (surface === stability.surface && surface?.isConnected) return surface;
    stability.observer?.disconnect();
    stability.observer = null;
    stability.surface = surface || null;
    stability.surfaceGeneration += 1;
    stability.mutationVersion += 1;
    stability.lastMutationAt = Date.now();
    if (surface) stability.discoveryCount += 1;
    if (surface && typeof MutationObserver === 'function') {
      stability.observer = new MutationObserver(() => {
        // Observer 只使当前快照失效；扫描始终由稳定等待流程串行触发。
        stability.mutationVersion += 1;
        stability.lastMutationAt = Date.now();
      });
      stability.observer.observe(surface, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-expanded', 'hidden', 'style', 'class'] });
    }
    return surface;
  }
  function discoveryObserver() {
    const stability = run.stability;
    if (stability.discoveryObserver || typeof MutationObserver !== 'function' || !document.documentElement) return;
    stability.discoveryObserver = new MutationObserver(() => { run.stability.lastMutationAt = Date.now(); });
    stability.discoveryObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
  function stopDiscoveryObserver() { run.stability.discoveryObserver?.disconnect(); run.stability.discoveryObserver = null; }
  function stabilityDelay(ms) {
    return new Promise((resolve) => {
      const pending = { resolve, timer: setTimeout(() => { run.stability.pending.delete(pending); resolve(!run.stopped && !run.paused); }, ms) };
      run.stability.pending.add(pending);
    });
  }
  function nextFrame() {
    return new Promise((resolve) => {
      let settled = false;
      const pending = { resolve: (value) => { if (settled) return; settled = true; clearTimeout(pending.timer); run.stability.pending.delete(pending); resolve(value); }, timer: null, frameIds: [] };
      const done = () => pending.resolve(!run.stopped && !run.paused);
      if (typeof requestAnimationFrame === 'function') pending.frameIds.push(requestAnimationFrame(done));
      pending.timer = setTimeout(done, 120);
      run.stability.pending.add(pending);
    });
  }
  function surfaceSnapshot(surface) {
    const commentIds = visibleCommentLinks(surface).map((link) => commentIdFromUrl(link.getAttribute('href'))).sort();
    const comments = domComments(surface);
    const mappedReplies = comments.filter((comment) => comment.isReply).map((reply) => ({ id: reply.id, username: reply.username, text: reply.text })).sort((left, right) => left.id.localeCompare(right.id));
    // 稳定快照和筛选数据都来自当前可见 DOM；不读取接口响应，也不解析页面内部 JSON。
    const data = comments.map((comment) => ({ id: comment.id, parentId: comment.parentId || '', childCount: comment.childCount || 0, username: comment.username, text: comment.text })).sort((left, right) => left.id.localeCompare(right.id));
    const raw = { connected: Boolean(surface?.isConnected), surfaceGeneration: run.stability.surfaceGeneration, commentIds, mappedReplies, data };
    const signature = globalThis.InstagramCommentSurfaceStability?.snapshotSignature
      ? globalThis.InstagramCommentSurfaceStability.snapshotSignature(raw)
      : JSON.stringify(raw);
    return { ...raw, signature, mutationVersion: run.stability.mutationVersion, dataError: false };
  }
  function snapshotsStable(first, second) {
    if (globalThis.InstagramCommentSurfaceStability?.samplesAreStable) return globalThis.InstagramCommentSurfaceStability.samplesAreStable(first, second);
    return Boolean(first && second && first.surfaceGeneration === second.surfaceGeneration && first.mutationVersion === second.mutationVersion && first.signature === second.signature);
  }
  async function waitForStableSurface({ timeoutMs, requireData = true, reason = '正在等待评论区稳定...' } = {}) {
    const startedAt = Date.now();
    run.state = 'waiting-surface'; run.waiting = reason; run.stability.stage = reason; draw();
    while (!run.stopped && !run.paused && Date.now() - startedAt < timeoutMs) {
      let surface = run.stability.surface;
      if (!surface?.isConnected || !visibleCommentLinks(surface).length) {
        surface = discoverCommentSurface();
        if (!surface) { bindCommentSurface(null); discoveryObserver(); await stabilityDelay(120); continue; }
        stopDiscoveryObserver(); bindCommentSurface(surface);
      } else if (surface !== discoverCommentSurface()) {
        const discovered = discoverCommentSurface();
        if (discovered && discovered !== surface) { bindCommentSurface(discovered); surface = discovered; }
      }
      const elapsedSinceMutation = Date.now() - run.stability.lastMutationAt;
      if (elapsedSinceMutation < stabilityDefaults.mutationDebounceMs) {
        await stabilityDelay(stabilityDefaults.mutationDebounceMs - elapsedSinceMutation);
        continue;
      }
      run.state = 'stabilizing'; draw();
      let framesReady = true;
      for (let frame = 0; frame < stabilityDefaults.rafConfirmCount; frame += 1) framesReady = (await nextFrame()) && framesReady;
      if (!framesReady) return false;
      const first = surfaceSnapshot(surface); run.stability.lastSnapshot = `数据 ${first.data.length} 条，DOM ${first.commentIds.length} 条，容器 ${first.surfaceGeneration}`;
      if (first.dataError) throw new Error('评论结构化数据解析失败，已暂停。');
      if (!first.connected || !first.commentIds.length || (requireData && !first.data.length)) { await stabilityDelay(120); continue; }
      let previous = first;
      let stable = true;
      for (let pass = 1; pass < Math.max(1, stabilityDefaults.stablePasses); pass += 1) {
        await stabilityDelay(stabilityDefaults.mutationDebounceMs);
        for (let frame = 0; frame < stabilityDefaults.rafConfirmCount; frame += 1) framesReady = (await nextFrame()) && framesReady;
        if (!framesReady) return false;
        const secondSurface = run.stability.surface;
        const second = surfaceSnapshot(secondSurface); run.stability.lastSnapshot = `数据 ${second.data.length} 条，DOM ${second.commentIds.length} 条，容器 ${second.surfaceGeneration}`;
        if (second.dataError) throw new Error('评论结构化数据解析失败，已暂停。');
        if (secondSurface !== surface || !snapshotsStable(previous, second)) { stable = false; break; }
        previous = second;
      }
      if (stable) { stopDiscoveryObserver(); return { surface, snapshot: previous, surfaceGeneration: run.stability.surfaceGeneration }; }
    }
    stopDiscoveryObserver();
    return false;
  }
  function locateCommentElement(comment) {
    const expectedId = String(comment.id || '');
    const expectedText = String(comment.text || '').replace(/\s+/g, ' ').trim();
    const expectedUsername = String(comment.username || '').toLocaleLowerCase();
    if (expectedId) {
      const links = visibleCommentLinks().filter((link) => commentIdFromUrl(link.getAttribute('href')) === expectedId);
      for (const link of links) {
        let node = link;
        for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
          if (!visible(node)) continue;
          const body = normalizedText(node).toLocaleLowerCase();
          if ((!expectedUsername || body.includes(expectedUsername)) && (!expectedText || body.includes(expectedText.toLocaleLowerCase())) && (node.matches('li,article,ul') || node.querySelector('button,[role="button"]'))) return node;
        }
      }
      return null;
    }
    // 兼容无 ID 的旧数据；当前候选都应当通过上方的评论 ID 路径定位。
    if (comment.element?.isConnected && visible(comment.element)) return comment.element;
    const spans = [...document.querySelectorAll('span')].filter((node) => visible(node) && normalizedText(node) === expectedText);
    for (const span of spans) {
      let node = span;
      for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
        if (!visible(node)) continue;
        const body = normalizedText(node);
        if (body.toLocaleLowerCase().includes(expectedUsername) && (node.matches('li,article') || node.querySelector('button,[role="button"]'))) return node;
      }
    }
    return spans.map((node) => node.closest('li,article,div')).find(visible) || null;
  }
  function isCommentMenu(node) {
    const row = node?.closest?.('li,article') || node?.parentElement;
    return globalThis.InstagramControlLocator?.findCommentMenu?.(row) === node
      || (globalThis.InstagramControlLabels?.matchControlLabel?.('commentOptions', controlLabels(node))?.matched && !isCommentExpansionControl(node));
  }
  function visibleDeleteDialog(beforeState) {
    const locator = globalThis.InstagramControlLocator;
    if (locator && beforeState) {
      return locator.findActionSurface(beforeState, document);
    }
    const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"],[role="dialog"],[role="menu"],[role="listbox"]')].filter(visible);
    return dialogs.reverse().find((dialog) => locator?.findDeleteAction?.(dialog) || [...dialog.querySelectorAll('[role="menuitem"],[role="button"],button')].some((node) => visible(node) && globalThis.InstagramControlLabels?.matchControlLabel?.('delete', controlLabels(node))?.matched)) || null;
  }
  function deleteButtonInDialog(dialog) {
    if (!dialog) return null;
    return globalThis.InstagramControlLocator?.findDeleteAction?.(dialog) || [...dialog.querySelectorAll('[role="menuitem"],[role="button"],button')].find((node) => visible(node) && globalThis.InstagramControlLabels?.matchControlLabel?.('delete', controlLabels(node))?.matched) || null;
  }
  function hasRenderedComments() { return visibleCommentLinks().length > 0; }
  function commentMenuFor(element) {
    return globalThis.InstagramControlLocator?.findCommentMenu?.(element) || [...element.querySelectorAll('button,[role="button"]')].filter(visible).find(isCommentMenu) || null;
  }
  function revealCommentMenu(element) {
    // React 的悬停处理会区分 PointerEvent 与 MouseEvent；指针事件优先使用原生类型，
    // 保证三点按钮在无需用户手动移动鼠标时也能挂载到回复行中。
    const pointerEvent = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    element.dispatchEvent(new pointerEvent('pointerover', { bubbles: true }));
    ['mouseover', 'mousemove'].forEach((type) => element.dispatchEvent(new MouseEvent(type, { bubbles: true })));
  }
  async function hoverCommentWithBrowserPointer(element) {
    const rect = element.getBoundingClientRect();
    const x = Math.round(rect.left + Math.min(Math.max(rect.width * 0.55, 16), Math.max(rect.width - 16, 16)));
    const y = Math.round(rect.top + Math.min(Math.max(rect.height * 0.5, 12), Math.max(rect.height - 12, 12)));
    const result = await send({ type: 'ICC_HOVER_COMMENT', x, y });
    if (!result.ok) throw new Error(result.reason || '无法显示评论菜单。');
  }
  async function revealCollapsedComments() {
    const clicked = new WeakSet();
    const locator = globalThis.InstagramControlLocator;
    let count = 0;
    for (let pass = 0; pass < 40 && !run.stopped && !run.paused; pass += 1) {
      const roots = [];
      for (let node = run.stability.surface; node && node !== document.body && roots.length < 6; node = node.parentElement) roots.push(node);
      roots.push(document);
      const controls = roots.flatMap((root) => locator?.findReplyDisclosureControls?.(root) || [...root.querySelectorAll('button,[role="button"]')].filter(isCommentExpansionControl));
      const control = [...new Set(controls)].find((node) => !clicked.has(node) && visible(node) && !locator?.isExpandedReplyDisclosure?.(node));
      if (!control) return;
      const beforeIds = new Set(visibleCommentLinks().map((link) => commentIdFromUrl(link.getAttribute('href'))));
      const beforeMutationVersion = run.stability.mutationVersion;
      const beforeState = locator?.captureExpansionState?.(control, beforeIds) || { control, ids: beforeIds, signature: controlLabel(control), ariaExpanded: control.getAttribute('aria-expanded') || '' };
      clicked.add(control);
      control.click();
      count += 1;
      const expanded = await waitForCondition(() => {
        const currentIds = new Set(visibleCommentLinks().map((link) => commentIdFromUrl(link.getAttribute('href'))));
        const stable = run.stability.mutationVersion > beforeMutationVersion && !findLoadingIndicator(run.stability.surface || document);
        const result = locator?.waitForExpansionResult?.(beforeState, { control, commentIds: currentIds, stable })
          || { ok: currentIds.size > beforeIds.size || (!control.isConnected && stable) };
        return result.ok;
      }, 8000, '正在展开回复并加载更多评论...');
      if (!expanded && (run.stopped || run.paused)) return count;
    }
    return count;
  }
  function postAuthorUsername(surface) {
    const firstComment = visibleCommentLinks(surface)[0];
    if (!firstComment) return '';
    const profileLinks = [...document.querySelectorAll('main a[href]')].filter((link) => /^\/[^/?#]+\/?$/.test(link.getAttribute('href') || '')
      && (link.compareDocumentPosition(firstComment) & 4) !== 0);
    return String(profileLinks[0]?.innerText || profileLinks[0]?.textContent || '').trim().replace(/^@+/, '');
  }
  function threads(surface = run.stability.surface) {
    const comments = domComments(surface); const authorUsername = postAuthorUsername(surface);
    const mapped = comments.map((comment) => ({ ...comment, isPostAuthor: Boolean(authorUsername) && InstagramCommentRules.normalizeUsername(comment.username) === InstagramCommentRules.normalizeUsername(authorUsername) }));
    const all = new Map(mapped.map((item) => [item.id, { ...item, replies: [] }]));
    const parents = []; const orphanReplies = new Map();
    for (const item of all.values()) {
      const parent = all.get(item.parentId);
      if (item.parentId && parent) parent.replies.push(item);
      else if (item.parentId) {
        if (!orphanReplies.has(item.parentId)) orphanReplies.set(item.parentId, { id: `orphan:${item.parentId}`, username: '', text: '', replies: [] });
        orphanReplies.get(item.parentId).replies.push(item);
      } else parents.push(item);
    }
    // 当前页面未渲染的回复不会进入候选；已渲染回复按 DOM 真实内容筛选。
    parents.push(...orphanReplies.values());
    parents.forEach((item) => { item.hasUnloadedReplies = false; });
    return parents;
  }
  // 与规则引擎保持一致，收集多层已加载回复的稳定 ID，避免漏掉嵌套回复。
  function replyIds(list) {
    const ids = new Set();
    const visit = (replies) => (replies || []).forEach((reply) => { if (reply.id) ids.add(reply.id); visit(reply.replies); });
    list.forEach((thread) => visit(thread.replies));
    return ids;
  }
  async function waitForCommentData() {
    // DOM 是唯一数据源；这里等待展开后的评论节点完成重绘，避免读取中间态。
    return waitForStableSurface({ timeoutMs: stabilityDefaults.initialReadyTimeoutMs, requireData: false, reason: '正在等待展开后的评论区稳定...' });
  }
  function createPaginationLoader() {
    const factory = globalThis.InstagramCommentPaginationLoader;
    if (!factory) return null;
    const surfaceFactory = globalThis.InstagramCommentPaginationSurface;
    const controlsFactory = globalThis.InstagramCommentPaginationControls;
    const surface = surfaceFactory?.create({
      getRoot: () => run.stability.surface || discoverCommentSurface() || document,
      getCommentIds: (root) => visibleCommentLinks(root).map((link) => commentIdFromUrl(link.getAttribute('href'))),
    });
    const controls = controlsFactory?.create({
      getRoot: () => surface?.resolveRoot?.() || run.stability.surface || discoverCommentSurface() || document,
      rootsFor: surface?.rootsFor,
      getControlLabel: controlLabel,
      isLoadMoreControl,
      findLoadingIndicator,
    });
    return factory.create({
      settings: run.settings.pagination,
      surface,
      controls,
      isActive: () => !run.stopped && !run.paused,
      waiter: { untilStable: waitForStableSurface },
      onProgress: () => draw(),
    });
  }
  async function scan() {
    if (run.scanInFlight) return run.scanPromise;
    run.scanInFlight = true;
    run.scanPromise = (async () => {
      const scanGeneration = ++run.scanGeneration;
      try {
        run.state = 'scanning'; draw();
        if (/(challenge_required|try again later|验证|verification|rate limit)/i.test(document.body.innerText)) throw new Error('检测到验证、限流或异常页面，已暂停。');
        // 先确认可见评论面，给展开回复入口一个启动点；筛选只读取随后稳定的 DOM。
        const ready = await waitForStableSurface({ timeoutMs: stabilityDefaults.initialReadyTimeoutMs, requireData: false, reason: '正在等待 Instagram 评论区出现...' });
        if (!ready) {
          if (run.stopped || run.paused) return { ids: new Set(), newIds: 0, expanded: 0, candidates: [] };
          throw new Error(`评论区在规定时间内未完成渲染，已暂停。（阶段：${run.stability.stage || '未知'}，容器发现 ${run.stability.discoveryCount} 次，Mutation ${run.stability.mutationVersion} 次，${run.stability.lastSnapshot || '暂无快照'}）`);
        }
        if (run.stopped || run.paused || scanGeneration !== run.scanGeneration) return { ids: new Set(), newIds: 0, expanded: 0, candidates: [] };
        run.state = 'expanding'; draw();
        const expanded = await revealCollapsedComments();
        if (run.stopped || run.paused || scanGeneration !== run.scanGeneration) return { ids: new Set(), newIds: 0, expanded, candidates: [] };
        const afterExpand = await waitForCommentData();
        if (!afterExpand) {
          if (run.stopped || run.paused) return { ids: new Set(), newIds: 0, expanded, candidates: [] };
          throw new Error(`展开评论后页面未能稳定，已暂停。（容器发现 ${run.stability.discoveryCount} 次，Mutation ${run.stability.mutationVersion} 次，${run.stability.lastSnapshot || '暂无快照'}）`);
        }
        let scanSurface = afterExpand.surface;
        let list = threads(scanSurface);
        let comments = domComments(scanSurface);
        let ids = replyIds(list);
        // 兼容 Instagram 把共同评论容器拆成多个深层节点的版本：
        // 若当前容器只返回单条评论，回退到整页 DOM 重新建树，避免扫描结果被记为 0。
        const pageComments = domComments(document);
        const pageList = threads(document);
        const pageIds = replyIds(pageList);
        if (pageComments.length > comments.length || pageIds.size > ids.size) {
          scanSurface = document;
          list = pageList;
          comments = pageComments;
          ids = pageIds;
        }
        if (!comments.length) throw new Error('未找到当前帖子中已渲染的评论 DOM，请先展开评论后重试。');
        const commentIdSet = new Set(comments.map((comment) => String(comment.id || '')).filter(Boolean));
        const replyIdSet = new Set(ids);
        let newIds = 0;
        replyIdSet.forEach((id) => { if (!run.seenIds.has(id)) { run.seenIds.add(id); newIds += 1; } });
        commentIdSet.forEach((id) => run.seenCommentIds.add(id));
        replyIdSet.forEach((id) => run.seenReplyIds.add(id));
        const result = InstagramCommentRules.selectCandidates(list, run.rules);
        if (scanGeneration !== run.scanGeneration) return { ids: new Set(), newIds: 0, expanded, candidates: [] };
        result.candidates.forEach((candidate) => run.matchedIds.add(candidate.id));
        run.candidates = result.candidates.filter((candidate) => !run.processedIds.has(candidate.id));
        // “扫描”统计当前 DOM 评论总数，“已加载回复”单独统计可进入筛选树的回复数。
        run.stats.scanned = comments.length;
        run.stats.loaded = run.seenReplyIds.size;
        run.stats.topLevel = [...run.seenCommentIds].filter((id) => !run.seenReplyIds.has(id)).length;
        run.stats.replies = run.seenReplyIds.size;
        run.stats.discovered = run.seenCommentIds.size;
        run.stats.matched = run.matchedIds.size;
        result.skippedIds.forEach((id) => { if (!run.skippedIds.has(id)) { run.skippedIds.add(id); run.stats.skipped += 1; } });
        run.lastScanIds = replyIdSet; run.state = 'idle'; draw();
        run.lastScanResult = { ids, newIds, expanded, candidates: run.candidates, surfaceGeneration: afterExpand.surfaceGeneration };
        return run.lastScanResult;
      } finally { run.scanInFlight = false; run.scanPromise = null; }
    })();
    return run.scanPromise;
  }
  async function waitForDeleted(candidate) {
    const expectedText = String(candidate.text || '').replace(/\s+/g, ' ').trim();
    const currentNode = () => visibleCommentLinks().find((link) => commentIdFromUrl(link.getAttribute('href')) === String(candidate.id || ''));
    const removed = await waitForCondition(() => {
      const link = currentNode();
      if (!link) return true;
      if (!expectedText) return false;
      // ID 是首选确认信号；只有旧页面无法提供 ID 时才使用作者+正文的兼容回退。
      return !normalizedText(link.closest('li,article,ul,div') || link).includes(expectedText);
    }, 7000, '正在确认回复已删除...');
    if (!removed) return false;
    const settled = await waitForStableSurface({ timeoutMs: stabilityDefaults.postDeleteSettleTimeoutMs, requireData: false, reason: '正在等待删除后的评论区稳定...' });
    return Boolean(settled);
  }
  async function ensureReplyDom(candidate) {
    const parentId = String(candidate.parentId || candidate.parent?.id || '');
    if (!parentId) return false;
    const existingReply = visibleCommentLinks().some((link) => commentIdFromUrl(link.getAttribute('href')) === String(candidate.id || ''));
    if (existingReply) return true;
    const parentElement = locateCommentElement(candidate.parent || { id: parentId });
    const locator = globalThis.InstagramControlLocator;
    const controls = parentElement ? (locator?.findReplyDisclosureControls?.(parentElement, parentElement) || [...parentElement.querySelectorAll('button,[role="button"]')].filter(isCommentExpansionControl)) : [];
    const control = controls.find((node) => !locator?.isExpandedReplyDisclosure?.(node));
    if (!control) return false;
    const beforeIds = new Set(visibleCommentLinks().map((link) => commentIdFromUrl(link.getAttribute('href'))));
    const beforeMutationVersion = run.stability.mutationVersion;
    const beforeState = locator?.captureExpansionState?.(control, beforeIds) || { control, ids: beforeIds, signature: controlLabel(control), ariaExpanded: control.getAttribute('aria-expanded') || '' };
    control.click();
    return await waitForCondition(() => {
      const currentIds = new Set(visibleCommentLinks().map((link) => commentIdFromUrl(link.getAttribute('href'))));
      if (currentIds.has(String(candidate.id || ''))) return true;
      const stable = run.stability.mutationVersion > beforeMutationVersion && !findLoadingIndicator(run.stability.surface || document);
      return Boolean(locator?.waitForExpansionResult?.(beforeState, { control, commentIds: currentIds, stable })?.ok);
    }, 8000, '正在展开目标一级评论的子级内容...');
  }
  async function remove(candidate) {
    const locator = globalThis.InstagramControlLocator;
    // 候选来自当前 DOM；执行删除前重新定位节点，避免 Instagram 重绘后使用旧引用。
    if (!(await ensureReplyDom(candidate))) throw new Error('目标一级评论的子级内容尚未渲染，已暂停。');
    candidate.element = locateCommentElement(candidate);
    if (!candidate.element?.isConnected) throw new Error('目标回复尚未渲染到页面，正在重新扫描。');
    candidate.element.scrollIntoView({ block: 'center', behavior: 'auto' });
    revealCommentMenu(candidate.element);
    // 伪造 DOM 事件无法触发 Instagram 的 CSS :hover，使用当前标签页的原生指针事件补足。
    await hoverCommentWithBrowserPointer(candidate.element);
    candidate.element.focus?.();
    // 悬停后 Instagram 会异步挂载“评论选项”按钮，不能在同一事件循环内立即查询。
    const commentMenuReady = await waitForCondition(() => Boolean(commentMenuFor(candidate.element)), 1800, '正在显示评论菜单...');
    const more = commentMenuFor(candidate.element);
    if (!commentMenuReady || !more) throw new Error('未找到可靠的评论菜单，已暂停。');
    const beforeSurface = locator?.captureActionSurfaceState?.(document) || null;
    more.focus?.(); more.click();
    let actionSurface = null;
    const menuReady = await waitForCondition(() => {
      actionSurface = locator?.findActionSurface?.(beforeSurface, document) || visibleDeleteDialog(beforeSurface);
      return Boolean(actionSurface);
    }, 5000, '正在打开删除菜单...');
    if (!menuReady || !actionSurface) throw new Error('删除菜单未出现，已暂停。');
    let deleteAction = locator?.findDeleteAction?.(actionSurface) || deleteButtonInDialog(actionSurface);
    if (!deleteAction) {
      const reason = locator?.describeDeleteAction?.(actionSurface)?.reason;
      if (reason === 'permission') throw new Error('当前评论菜单没有删除权限，已暂停。');
      throw new Error('没有可靠的删除项，可能缺少权限。');
    }

    // Instagram 版本可能在第一次点击后直接移除评论，也可能再显示一次确认弹层。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await wait(InstagramCommentDelay.generateDelayMs(run.settings.pace.deleteDialogDelay), '正在准备点击删除按钮...');
      deleteAction.click();
      const afterClick = locator?.captureActionSurfaceState?.(document) || null;
      let confirmation = null;
      let permissionFailure = false;
      const outcome = await waitForCondition(() => {
        const ids = new Set(visibleCommentLinks().map((link) => commentIdFromUrl(link.getAttribute('href'))));
        if (!ids.has(String(candidate.id || ''))) return true;
        confirmation = locator?.findActionSurface?.(afterClick, document) || null;
        if (confirmation) {
          const described = locator?.describeDeleteAction?.(confirmation);
          deleteAction = described?.action || null;
          permissionFailure = described?.reason === 'permission';
          return Boolean(deleteAction || permissionFailure);
        }
        return false;
      }, 7000, '正在确认删除结果...');
      if (!outcome) throw new Error('未确认回复已删除，已暂停。');
      const stillPresent = visibleCommentLinks().some((link) => commentIdFromUrl(link.getAttribute('href')) === String(candidate.id || ''));
      if (!stillPresent) return await waitForDeleted(candidate);
      if (permissionFailure) throw new Error('删除确认弹层没有删除权限，已暂停。');
      if (!deleteAction || !confirmation) throw new Error('删除确认弹层不明确，已暂停。');
      actionSurface = confirmation;
    }
    throw new Error('删除确认未完成，已暂停。');
  }
  function clearRestTimer() { clearInterval(run.restTimer); run.restTimer = null; }
  function checkpoint(status = run.state, reason = run.error || '') {
    return SocialCommentTaskSession.create({
      sessionId: run.sessionId,
      target: { platform: 'instagram', normalizedId: run.rules?.targetUrl || '', url: run.rules?.targetUrl || '' },
      mode: run.mode,
      status,
      startedAt: run.startedAt,
      stats: run.stats,
      processedIds: [...run.processedIds],
      refresh: run.refresh,
      pace: { state: run.pace?.state || 'NORMAL', consecutive: run.pace?.consecutive || 0, failures: run.pace?.failures || 0 },
      reason,
    });
  }
  async function saveSession(status = run.state, reason = '') {
    if (!run.rules?.targetUrl || !run.sessionId) return { ok: false, reason: '当前没有可保存的任务会话。' };
    const snapshot = checkpoint(status, reason);
    const response = await send({ type: 'ICC_SAVE_SESSION', targetUrl: run.rules.targetUrl, snapshot });
    return response?.ok ? response : { ok: false, reason: response?.reason || '任务检查点保存失败。' };
  }
  async function releaseLock() { clearInterval(run.lockTimer); run.lockTimer = null; if (run.rules) await send({ type: 'ICC_RELEASE_LOCK', targetUrl: run.rules.targetUrl }); }
  async function enterScheduledRest(reason = '本轮已完成，等待下一轮刷新。') {
    if (run.mode === 'preview' || run.stopped || run.paused || run.state === 'scheduled-rest') return;
    const delayMs = SocialCommentScheduledRest.generate(run.settings.pace.refreshRest);
    run.refresh = { ...run.refresh, count: run.refresh.count + 1, restStartedAt: Date.now(), restDelayMs: delayMs, nextRefreshAt: Date.now() + delayMs, lastReason: reason };
    run.state = 'scheduled-rest'; run.waiting = reason; run.error = ''; draw();
    const saved = await saveSession('scheduled-rest', reason);
    if (!saved.ok) { run.error = saved.reason; return pause(); }
    const scheduled = await send({ type: 'ICC_SCHEDULE_REFRESH', targetUrl: run.rules.targetUrl, nextRefreshAt: run.refresh.nextRefreshAt, sessionId: run.sessionId });
    if (!scheduled.ok) { run.error = scheduled.reason || '无法安排下一轮刷新。'; return pause(); }
    clearRestTimer(); run.restTimer = setInterval(draw, 1000); draw();
  }
  async function pause() {
    if (run.stopped || run.paused || run.starting) return { ok: true, alreadyPaused: run.paused };
    run.pauseFailure = false;
    run.paused = true;
    run.scanGeneration += 1;
    run.pagination?.cancel('自动加载已暂停。', 'paused');
    cancelStabilityWait(); disconnectStabilityObservers();
    if (run.waitResolve) finishWait(false); else clearTimeout(run.timer);
    run.timer = null; clearRestTimer();
    if (run.rules?.targetUrl) await send({ type: 'ICC_CANCEL_REFRESH', targetUrl: run.rules.targetUrl });
    run.state = 'paused'; run.waiting = '已暂停，点击“开始”继续。';
    const saved = await saveSession('paused', run.waiting); await releaseLock();
    if (!saved.ok) { run.pauseFailure = true; run.error = saved.reason; draw(); return { ok: false, reason: saved.reason }; }
    draw(); return { ok: true };
  }
  async function stop(finalState = 'idle', reason = '') {
    run.stopped = true; run.paused = false;
    run.scanGeneration += 1;
    run.pagination?.cancel('自动加载已停止。', 'cancelled');
    cancelStabilityWait(); disconnectStabilityObservers();
    if (run.waitResolve) finishWait(false); else clearTimeout(run.timer);
    run.timer = null; clearRestTimer();
    if (run.rules?.targetUrl) await send({ type: 'ICC_CANCEL_REFRESH', targetUrl: run.rules.targetUrl });
    run.state = finalState; run.waiting = reason || (finalState === 'completed' ? run.waiting : '');
    run.candidates = [];
    if (finalState === 'paused') await saveSession('paused', reason || run.error);
    else if (run.rules?.targetUrl) await send({ type: 'ICC_CLEAR_SESSION', targetUrl: run.rules.targetUrl });
    await releaseLock(); draw();
  }
  async function acquire() { while (!run.stopped && !run.paused) { const result = await send({ type: 'ICC_RATE_ACQUIRE', limits: run.settings.pace.rateLimit }); if (result.ok) return true; if (!Number.isFinite(result.retryAfterMs)) throw new Error(result.reason || '无法申请操作额度。'); if (!(await wait(result.retryAfterMs, `全局操作上限已满，等待 ${Math.ceil(result.retryAfterMs / 1000)} 秒...`))) return false; } return false; }
  async function waitBetweenBatches(batchIndex) {
    // 加载器刚完成一轮后需要立即探测是否到底；否则最后一批处理完会先休息再发现完成。
    if (run.pagination?.shouldSkipBatchRest?.()) return true;
    // 批次间使用现有随机延迟算法，参数是内置策略，不由用户配置。
    // 初始 DOM 已视为第 0 轮，首次进入加载器前也要先完成这一轮与下一轮之间的休息。
    if (batchIndex < 0) return true;
    const config = run.settings.pagination.batchRest;
    return wait(InstagramCommentDelay.generateDelayMs(config), '批次之间随机休息中...');
  }
  async function processPreview() {
    // 阶段一只允许扫描和统计；自动加载完成后再回到 scan()，绝不调用 remove()。
    while (!run.stopped && !run.paused) {
      const currentBatch = run.pagination?.getSnapshot?.().batchIndex || 0;
      if (!(await waitBetweenBatches(currentBatch))) return;
      run.state = 'loading'; run.waiting = '正在准备加载下一批评论...'; draw();
      const batch = await run.pagination.nextBatch();
      run.stats.batches = batch.batchIndex;
      run.stats.newComments = batch.newIds || 0;
      if (run.paused || run.stopped) return;
      if (batch.status === 'paused' || batch.status === 'cancelled') return;
      if (batch.status === 'completed' && !batch.newIds) return stop('completed', `预览完成：${batch.terminalReason || '当前页面没有更多可加载评论。'}`);
      if (!(await scan())) return;
      if (batch.status === 'completed') return stop('completed', `预览完成：${batch.terminalReason || '当前页面没有更多可加载评论。'}`);
    }
  }
  async function process() {
    if (run.mode === 'preview') return processPreview();
    if (!run.rules.keywords.length) { run.waiting = '扫描完成，未配置删除关键词。'; draw(); return stop(); }
    let first = true;
    let emptyRescanAttempts = 0;
    while (!run.stopped && !run.paused) {
      if (run.settings.sessionMaxMinutes > 0 && Date.now() - run.startedAt >= run.settings.sessionMaxMinutes * 60000) return stop('paused', '已达到本次任务运行时间上限。');
      if (run.settings.sessionLimit !== 'unlimited' && run.stats.deleted >= run.settings.sessionLimit) return stop('paused', '已达到本次任务删除数量上限。');
      if (run.candidates.length) {
        const candidate = run.candidates.shift();
        if (run.processedIds.has(candidate.id)) continue;
        try {
          if (!first && !(await wait(InstagramCommentDelay.generateDelayMs(run.settings.pace.operation), '正在等待下一次操作...'))) return;
          first = false; if (!(await acquire())) return;
          run.state = 'running'; draw();
          await remove(candidate); run.processedIds.add(candidate.id); run.stats.deleted += 1;
          const checkpointSaved = await saveSession('running');
          if (!checkpointSaved.ok) throw new Error(checkpointSaved.reason);
          // 目标节点消失后仍可能处于旧容器卸载、新容器挂载的中间态；以稳定快照作为下一轮边界。
          const settled = await waitForStableSurface({ timeoutMs: stabilityDefaults.postDeleteSettleTimeoutMs, requireData: false, reason: '正在等待删除后的评论区稳定...' });
          if (!settled) {
            if (!run.stopped && !run.paused) throw new Error('已确认删除，但评论区未稳定，已暂停。');
            return;
          }
          const state = run.pace.success(); await scan();
          if (state === 'REST') { run.state = 'cooling-down'; draw(); if (!(await wait(InstagramCommentDelay.generateDelayMs(run.settings.pace.rest), '连续处理达到上限，正在休息...'))) return; run.pace.restComplete(); first = true; await scan(); }
        } catch (error) {
          if (run.paused) return;
          if (error.message === '目标回复已被页面刷新，正在重新扫描。') { await scan(); continue; }
          run.error = error.message; return stop('paused');
        }
        continue;
      }
      // 当前评论容器没有候选时先做有限次稳定重扫，再自动加载下一批评论。
      if (emptyRescanAttempts < stabilityDefaults.emptyRescanAttempts) {
        emptyRescanAttempts += 1;
        const result = await scan();
        if (!run.stopped && !run.paused && result.candidates.length) { emptyRescanAttempts = 0; continue; }
        continue;
      }
      // 分页器已经确认到底且稳定空结果重扫已完成，此时不再进入批次休息，直接结束。
      const paginationSnapshot = run.pagination?.getSnapshot?.();
      if (paginationSnapshot?.phase === 'completed') {
        return enterScheduledRest(`本轮已完成：${paginationSnapshot.terminalReason || '当前页面没有更多可加载评论。'}`);
      }
      if (!run.pagination) return enterScheduledRest('本轮已完成：当前稳定评论容器中没有待处理回复。');
      const currentBatch = run.pagination.getSnapshot().batchIndex;
      if (!(await waitBetweenBatches(currentBatch))) return;
      run.state = 'loading'; run.waiting = '正在准备加载下一批评论...'; draw();
      const batch = await run.pagination.nextBatch();
      run.stats.batches = batch.batchIndex;
      run.stats.newComments = batch.newIds || 0;
      if (run.paused || run.stopped || batch.status === 'paused' || batch.status === 'cancelled') return;
      if (batch.status === 'completed' && !batch.newIds) return enterScheduledRest(`本轮已完成：${batch.terminalReason || '当前页面没有更多可加载评论。'}`);
      emptyRescanAttempts = 0;
      await scan();
      // 达到最大批次时本轮可能同时带回新增评论；扫描完成后回到循环排空候选，再停止。
      if (batch.status === 'completed' && !run.candidates.length) {
        return enterScheduledRest(`本轮已完成：${batch.terminalReason || '当前页面没有更多可加载评论。'}`);
      }
    }
  }
  function restoreCheckpoint(snapshot) {
    const restored = SocialCommentTaskSession.normalize(snapshot);
    if (!restored) throw new Error('任务检查点无效，无法恢复。');
    const defaults = { scanned: 0, matched: 0, deleted: 0, skipped: 0, loaded: 0, discovered: 0, topLevel: 0, replies: 0, batches: 0, newComments: 0 };
    run.sessionId = restored.sessionId; run.startedAt = restored.startedAt; run.mode = restored.mode; run.refresh = { ...run.refresh, ...restored.refresh };
    run.stats = { ...defaults, ...(restored.stats || {}) }; run.processedIds = new Set(restored.processedIds || []);
    run.stopped = false; run.paused = false; run.pauseFailure = false; run.error = ''; run.waiting = '';
    run.pace = new InstagramCommentPaceController(run.settings.pace);
    if (restored.pace?.state) run.pace.state = restored.pace.state;
    if (Number.isFinite(restored.pace?.consecutive)) run.pace.consecutive = restored.pace.consecutive;
    if (Number.isFinite(restored.pace?.failures)) run.pace.failures = restored.pace.failures;
    run.state = restored.status === 'scheduled-rest' && restored.refresh.nextRefreshAt > Date.now() ? 'scheduled-rest' : 'idle';
  }
  async function restoreScheduledRest() {
    const scheduled = await send({ type: 'ICC_SCHEDULE_REFRESH', targetUrl: run.rules.targetUrl, nextRefreshAt: run.refresh.nextRefreshAt, sessionId: run.sessionId });
    if (!scheduled.ok) throw new Error(scheduled.reason || '无法恢复下一轮刷新。');
    clearRestTimer(); run.restTimer = setInterval(draw, 1000); draw();
  }
  async function start(mode, checkpoint = null) {
    if (run.starting || (!run.stopped && !run.paused)) return;
    const restoring = Boolean(checkpoint);
    const resuming = !restoring && !run.stopped && run.paused;
    run.starting = true; run.pauseFailure = false; draw();
    try {
      run.settings = InstagramCommentPaceConfig.validateSettings((await chrome.storage.sync.get(KEY))[KEY] || {}); run.rules = InstagramCommentRules.prepareRules(run.settings);
      // Instagram 完成导航后可能还会短暂替换地址（例如重定向或 SPA 路由更新）。
      // 启动消息只发送一次，因此在校验前等待目标 URL 稳定，避免用户再次点击页面内“开始”。
      for (let attempt = 0; attempt < 20 && InstagramCommentRules.normalizeTargetUrl(location.href) !== run.rules.targetUrl; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      if (InstagramCommentRules.normalizeTargetUrl(location.href) !== run.rules.targetUrl) throw new Error('当前 URL 与设置的目标帖子不匹配。');
      const lock = await send({ type: 'ICC_ACQUIRE_LOCK', targetUrl: run.rules.targetUrl }); if (!lock.ok) throw new Error(lock.reason);
      if (restoring) {
        resetStability(); restoreCheckpoint(checkpoint); run.pagination = createPaginationLoader();
      } else if (!resuming) {
        resetStability();
        run.stopped = false; run.mode = mode; run.sessionId = SocialCommentTaskSession.createId(); run.startedAt = Date.now(); run.refresh = { count: 0, restStartedAt: 0, restDelayMs: 0, nextRefreshAt: 0, lastReason: '' }; run.seenIds = new Set(); run.seenCommentIds = new Set(); run.seenReplyIds = new Set(); run.matchedIds = new Set(); run.skippedIds = new Set(); run.processedIds = new Set(); run.lastScanIds = new Set(); run.stats = { scanned: 0, matched: 0, deleted: 0, skipped: 0, loaded: 0, discovered: 0, topLevel: 0, replies: 0, batches: 0, newComments: 0 }; run.pace = new InstagramCommentPaceController(run.settings.pace); run.pagination = createPaginationLoader();
      } else {
        resetStability();
        run.paused = false; run.error = ''; run.waiting = ''; run.state = 'idle'; run.pagination = createPaginationLoader();
        if (run.pace?.state === 'REST') run.pace.restComplete();
      }
      run.starting = false; run.lockTimer = setInterval(() => send({ type: 'ICC_RENEW_LOCK', targetUrl: run.rules.targetUrl }), 30000); draw();
      if (run.state === 'scheduled-rest' || (resuming && run.refresh.nextRefreshAt > Date.now())) {
        run.state = 'scheduled-rest'; await saveSession('scheduled-rest', '本轮已完成，等待下一轮刷新。'); await restoreScheduledRest(); return;
      }
      if (resuming && run.refresh.nextRefreshAt && run.refresh.nextRefreshAt <= Date.now()) {
        run.state = 'scheduled-rest'; run.refresh.nextRefreshAt = Date.now(); await saveSession('scheduled-rest', '休息时间已到，准备刷新目标页面。'); await restoreScheduledRest(); return;
      }
      const startedSaved = await saveSession('running');
      if (!startedSaved.ok) throw new Error(startedSaved.reason);
      // 恢复时同样重扫，避免沿用暂停前已被 Instagram 重绘的候选元素。
      await scan();
      await process();
    } catch (error) {
      run.starting = false;
      if (!resuming && !restoring) run.stopped = true;
      run.paused = true; run.state = 'paused'; run.error = error.message; await releaseLock(); draw();
      if (run.sessionId && run.rules?.targetUrl) await saveSession('paused', error.message);
    }
  }
  async function restorePending() {
    const targetUrl = InstagramCommentRules.normalizeTargetUrl(location.href);
    if (!targetUrl) return;
    const response = await send({ type: 'ICC_GET_SESSION', targetUrl });
    const snapshot = response?.snapshot;
    // 页面因浏览器崩溃或手动刷新重建时，活动会话也应从最近检查点继续；暂停/停止状态永不自动恢复。
    if (!snapshot || !['running', 'scheduled-rest', 'refreshing'].includes(snapshot.status)) return;
    await start('run', snapshot);
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type === 'ICC_PAUSE') { pause(); reply({ ok: true }); return false; }
    if (message?.type === 'ICC_STOP') { stop(); reply({ ok: true }); return false; }
    if (!['ICC_START', 'ICC_PREVIEW'].includes(message?.type)) return false;
    // 配置页启动时才展开面板；页面刷新自动恢复保持边缘 Logo，避免遮挡评论区。
    openPanel(); start(message.type === 'ICC_START' ? 'run' : 'preview'); reply({ ok: true }); return false;
  });
  if (InstagramCommentRules.normalizeTargetUrl(location.href)) { if (!isUiClosed()) panel(); restorePending().catch((error) => { run.error = error.message; run.state = 'paused'; draw(); }); }
})();
