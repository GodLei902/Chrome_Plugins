(function () {
  'use strict';
  const KEY = 'socialCommentCleanerSettings';
  const TEXT = { idle: '空闲', 'waiting-surface': '等待评论区', expanding: '展开中', stabilizing: '等待稳定', scanning: '扫描中', running: '运行中', 'waiting-delete': '确认删除', 'cooling-down': '休息中', completed: '已完成', paused: '已暂停', error: '错误' };
  const stabilityDefaults = globalThis.InstagramCommentSurfaceStability?.DEFAULTS || { mutationDebounceMs: 250, rafConfirmCount: 2, stablePasses: 2, initialReadyTimeoutMs: 15000, postDeleteSettleTimeoutMs: 10000, emptyRescanAttempts: 3 };
  const run = { stopped: true, paused: false, starting: false, state: 'idle', stats: { scanned: 0, matched: 0, deleted: 0, skipped: 0, loaded: 0 }, candidates: [], timer: null, lockTimer: null, waiting: '', error: '', seenIds: new Set(), matchedIds: new Set(), skippedIds: new Set(), processedIds: new Set(), lastScanIds: new Set(), scanInFlight: false, scanGeneration: 0, stability: { surface: null, surfaceGeneration: 0, mutationVersion: 0, lastMutationAt: 0, observer: null, discoveryObserver: null, pending: new Set(), discoveryCount: 0, stage: '', lastSnapshot: '' } };
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
  // Instagram 会按界面语言显示折叠入口；只匹配完整短语，避免误点“回复”按钮。
  const replyExpander = /^(?:view|see)\s+(?:all\s+)?(?:\d+\s+)?(?:more\s+)?repl(?:y|ies)|^\d+\s+repl(?:y|ies)\s+(?:to\s+)?view$|^\d+件(?:すべての)?返信を見る$|^(?:\d+件(?:の)?返信|返信\s*\d*件?|すべての返信)(?:を見る|を表示)$|^返信をすべて見る$|^查看(?:全部|所有)?回复$|^查看\s*\d+\s*条回复$/i;
  const hiddenCommentExpander = /^(?:see|view)\s+hidden\s+comments?$|^非表示のコメントを見る$|^非表示.*コメント.*見る$|^查看隐藏评论$|^查看.*隐藏.*评论$/i;
  // 作品详情页的评论列表还会使用“加载/查看更多评论或回复”分页入口；
  // 这些入口有时只有 SVG 的 aria-label/title，没有可读的按钮文本。
  const loadMoreExpander = /^(?:load|view|see)\s+(?:more|all)\s+(?:comments?|repl(?:y|ies))$|^(?:加载更多|查看更多|查看全部)(?:评论|回复)$|^(?:コメント|返信)を(?:さらに|もっと)(?:読み込む|見る)$|^(?:コメント|返信)をすべて見る$/i;
  function controlLabel(node) {
    if (!node) return '';
    const labels = [normalizedText(node), node.getAttribute?.('aria-label'), node.getAttribute?.('title')];
    node.querySelectorAll?.('[aria-label],[title]').forEach((child) => {
      labels.push(child.getAttribute('aria-label'), child.getAttribute('title'));
    });
    return [...new Set(labels.map((value) => String(value || '').replace(/\s+/g, ' ').trim()).filter(Boolean))].join(' ');
  }
  function isCommentExpansionControl(node) {
    const label = controlLabel(node);
    return replyExpander.test(label) || hiddenCommentExpander.test(label) || loadMoreExpander.test(label);
  }
  // Instagram 日文界面在悬停评论后使用“コメントのオプション”，而非通用的“その他”。
  const menuLabel = /(?:^more$|more\s+options?|options?|comment options?|评论(?:的)?选项|选项|更多|その他|オプション|コメント(?:の)?オプション|メニュー|^…$|^\.\.\.$)/i;
  const deleteLabel = /^(?:delete|删除|刪除|削除)(?:\s*(?:comment|コメント))?(?:する)?$/i;
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
    run.ui.querySelector('[data-state]').textContent = TEXT[run.state] || run.state;
    run.ui.querySelector('[data-stats]').textContent = `扫描 ${run.stats.scanned} · 已加载回复 ${run.stats.loaded} · 命中 ${run.stats.matched} · 待处理 ${run.candidates.length} · 删除 ${run.stats.deleted} · 跳过 ${run.stats.skipped}`;
    run.ui.querySelector('[data-wait]').textContent = run.waiting;
    run.ui.querySelector('[data-error]').textContent = run.error || '';
    const active = !run.stopped && !run.paused; const busy = active || run.starting;
    const start = run.ui.querySelector('[data-start]'); start.textContent = run.paused ? '继续' : '开始'; start.disabled = busy;
    run.ui.querySelector('[data-preview]').disabled = busy || run.paused; run.ui.querySelector('[data-pause]').disabled = !active; run.ui.querySelector('[data-stop]').disabled = run.stopped;
  }
  function panel() { if (document.getElementById('icc-host')) return; const host = document.createElement('div'); host.id = 'icc-host'; host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647'; const root = host.attachShadow({ mode: 'open' }); root.innerHTML = `<style>main{font:13px system-ui;color:#111;background:#fff;border:1px solid #d1d5db;border-radius:8px;box-shadow:0 8px 28px #0003;width:320px;padding:14px}h2{font-size:14px;margin:0 0 10px}p{margin:7px 0}.muted{color:#666}.wait{color:#075985;min-height:1em}.error{color:#b42318;min-height:1em}.actions{display:flex;gap:6px;flex-wrap:wrap}button{border:0;border-radius:6px;padding:7px 10px;background:#2563eb;color:#fff}button[data-preview]{background:#0f766e}button[data-pause]{background:#d97706}button[data-stop]{background:#6b7280}button:disabled{opacity:.5}</style><main><h2>社交评论清理器</h2><p>状态：<b data-state>空闲</b></p><p class=muted data-stats></p><p class=wait data-wait></p><p class=error data-error></p><div class=actions><button data-start>开始</button><button data-pause>暂停</button><button data-stop>停止</button><button data-preview>预览模式</button></div></main>`; run.ui = root; document.documentElement.append(host); root.querySelector('[data-start]').onclick = () => start('run'); root.querySelector('[data-preview]').onclick = () => start('preview'); root.querySelector('[data-pause]').onclick = () => pause(); root.querySelector('[data-stop]').onclick = () => stop(); draw(); }
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
    const controls = new Set([...row.querySelectorAll('button,[role="button"]')].map((node) => normalizedText(node) || `${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''}`.trim()).filter(Boolean));
    const lines = String(row.innerText || row.textContent || '').split(/\r?\n+/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
    return lines.filter((line) => line !== username && !times.has(line) && !controls.has(line)
      && !replyExpander.test(line) && !hiddenCommentExpander.test(line) && !/^(?:translate|翻译(?:を見る)?|翻訳を見る)$/i.test(line)).join(' ').trim();
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
    const label = `${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''} ${node.querySelector('svg')?.getAttribute('aria-label') || ''} ${normalizedText(node)}`.trim();
    // 展开回复按钮也可能带有 More 文案，必须先排除，防止误点后改变扫描范围。
    if (replyExpander.test(normalizedText(node)) || hiddenCommentExpander.test(normalizedText(node))) return false;
    return menuLabel.test(label);
  }
  function visibleDeleteDialog() {
    // Instagram 新版本会把评论操作和确认删除都渲染成可见 dialog；
    // 优先锁定 aria-modal 的弹层，再回退到普通 dialog，避免点到页面其他区域。
    const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"],[role="dialog"]')].filter(visible);
    return dialogs.reverse().find((dialog) => [...dialog.querySelectorAll('[role="menuitem"],[role="button"],button')].some((node) => visible(node) && deleteLabel.test(normalizedText(node)))) || null;
  }
  function deleteButtonInDialog(dialog) {
    if (!dialog) return null;
    return [...dialog.querySelectorAll('[role="menuitem"],[role="button"],button')].find((node) => visible(node) && deleteLabel.test(normalizedText(node))) || null;
  }
  function hasRenderedComments() { return visibleCommentLinks().length > 0; }
  function commentMenuFor(element) {
    // 已加载回复的三点按钮直接挂在其 ul 容器中；不向父级搜索以免命中帖子自身的更多菜单。
    const controls = [...element.querySelectorAll('button,[role="button"]')].filter(visible);
    const labelledMenu = controls.find(isCommentMenu);
    if (labelledMenu) return labelledMenu;
    // 有些 Instagram A/B 页面不给三点图标提供文字标签。回复行中只有该控件是 24x24
    // 的非点赞 SVG 按钮，限制在候选行的近层作用域内可避免点到帖子的更多菜单。
    return controls.find((node) => {
      const icon = node.querySelector('svg'); const label = `${icon?.getAttribute('aria-label') || ''} ${normalizedText(node)}`;
      const rect = node.getBoundingClientRect();
      return icon && !/(?:like|いいね|赞)/i.test(label) && rect.width >= 20 && rect.height >= 20;
    }) || null;
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
    let count = 0;
    for (let pass = 0; pass < 40 && !run.stopped && !run.paused; pass += 1) {
      const roots = [];
      for (let node = run.stability.surface; node && node !== document.body && roots.length < 6; node = node.parentElement) roots.push(node);
      roots.push(document);
      const controls = roots.flatMap((root) => [...root.querySelectorAll('button,[role="button"]')]);
      const control = controls.find((node) => {
        if (clicked.has(node) || !visible(node)) return false;
        return isCommentExpansionControl(node);
      });
      if (!control) return;
      const beforeIds = new Set(visibleCommentLinks().map((link) => commentIdFromUrl(link.getAttribute('href'))));
      const beforeLabel = controlLabel(control);
      clicked.add(control);
      control.click();
      count += 1;
      // 点击后要同时等待入口状态变化或新的评论 ID 出现；后者覆盖“加载更多”
      // 入口仍保留但列表追加节点的情况，避免在中间态开始筛选。
      const expanded = await waitForCondition(() => {
        const currentLabel = controlLabel(control);
        const controlChanged = !control.isConnected || !visible(control) || currentLabel !== beforeLabel || !isCommentExpansionControl(control);
        const newComment = visibleCommentLinks().some((link) => {
          const id = commentIdFromUrl(link.getAttribute('href'));
          return id && !beforeIds.has(id);
        });
        return controlChanged || newComment;
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
        const list = threads(afterExpand.surface); const ids = replyIds(list); let newIds = 0;
        ids.forEach((id) => { if (!run.seenIds.has(id)) { run.seenIds.add(id); newIds += 1; } });
        const result = InstagramCommentRules.selectCandidates(list, run.rules);
        if (scanGeneration !== run.scanGeneration) return { ids: new Set(), newIds: 0, expanded, candidates: [] };
        result.candidates.forEach((candidate) => run.matchedIds.add(candidate.id));
        run.candidates = result.candidates.filter((candidate) => !run.processedIds.has(candidate.id));
        // 扫描统计只计算当前 DOM 中已渲染的回复；重复预览不会重复累加。
        run.stats.scanned = ids.size; run.stats.loaded = ids.size; run.stats.matched = run.matchedIds.size;
        result.skippedIds.forEach((id) => { if (!run.skippedIds.has(id)) { run.skippedIds.add(id); run.stats.skipped += 1; } });
        run.lastScanIds = ids; run.state = 'idle'; draw();
        run.lastScanResult = { ids, newIds, expanded, candidates: run.candidates, surfaceGeneration: afterExpand.surfaceGeneration };
        return run.lastScanResult;
      } finally { run.scanInFlight = false; run.scanPromise = null; }
    })();
    return run.scanPromise;
  }
  async function waitForDeleted(candidate) {
    const expectedText = String(candidate.text || '').replace(/\s+/g, ' ').trim();
    const currentNode = () => visibleCommentLinks().find((link) => commentIdFromUrl(link.getAttribute('href')) === String(candidate.id || ''));
    return waitForCondition(() => {
      const link = currentNode();
      if (!link) return true;
      if (!expectedText) return false;
      return !normalizedText(link.closest('li,article,ul,div') || link).includes(expectedText);
    }, 7000, '正在确认回复已删除...');
  }
  async function ensureReplyDom(candidate) {
    const parentId = String(candidate.parentId || candidate.parent?.id || '');
    if (!parentId) return false;
    const existingReply = visibleCommentLinks().some((link) => commentIdFromUrl(link.getAttribute('href')) === String(candidate.id || ''));
    if (existingReply) return true;
    const parentElement = locateCommentElement(candidate.parent || { id: parentId });
    const controls = parentElement ? [...parentElement.querySelectorAll('button,[role="button"]')].filter(visible) : [];
    const control = controls.find((node) => replyExpander.test(normalizedText(node) || `${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''}`.trim()));
    if (!control) return false;
    control.click();
    return await waitForCondition(() => visibleCommentLinks().some((link) => commentIdFromUrl(link.getAttribute('href')) === String(candidate.id || '')), 8000, '正在展开目标一级评论的子级内容...');
  }
  async function remove(candidate) {
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
    more.focus?.(); more.click();
    const menuReady = await waitForCondition(() => Boolean(visibleDeleteDialog()), 5000, '正在打开删除菜单...');
    if (!menuReady) throw new Error('删除菜单未出现，已暂停。');
    const menuDialog = visibleDeleteDialog();
    const del = deleteButtonInDialog(menuDialog);
    if (!del) throw new Error('没有可靠的删除项，可能缺少权限。');
    await wait(InstagramCommentDelay.generateDelayMs(run.settings.pace.deleteDialogDelay), '正在准备点击删除按钮...');
    del.click();
    if (!(await waitForDeleted(candidate))) throw new Error('未确认回复已删除，已暂停。');
    return true;
  }
  async function releaseLock() { clearInterval(run.lockTimer); run.lockTimer = null; if (run.rules) await send({ type: 'ICC_RELEASE_LOCK', targetUrl: run.rules.targetUrl }); }
  async function pause() {
    if (run.stopped || run.paused || run.starting) return;
    run.paused = true;
    run.scanGeneration += 1;
    cancelStabilityWait(); disconnectStabilityObservers();
    if (run.waitResolve) finishWait(false); else clearTimeout(run.timer);
    run.timer = null; run.state = 'paused'; run.waiting = '已暂停，点击“开始”继续。';
    await releaseLock(); draw();
  }
  async function stop(finalState = 'idle', reason = '') {
    run.stopped = true; run.paused = false;
    run.scanGeneration += 1;
    cancelStabilityWait(); disconnectStabilityObservers();
    if (run.waitResolve) finishWait(false); else clearTimeout(run.timer);
    run.timer = null; run.state = finalState; run.waiting = reason || (finalState === 'completed' ? run.waiting : '');
    run.candidates = [];
    await releaseLock(); draw();
  }
  async function acquire() { while (!run.stopped && !run.paused) { const result = await send({ type: 'ICC_RATE_ACQUIRE', limits: run.settings.pace.rateLimit }); if (result.ok) return true; if (!Number.isFinite(result.retryAfterMs)) throw new Error(result.reason || '无法申请操作额度。'); if (!(await wait(result.retryAfterMs, `全局操作上限已满，等待 ${Math.ceil(result.retryAfterMs / 1000)} 秒...`))) return false; } return false; }
  async function process() {
    if (run.mode === 'preview' || !run.rules.keywords.length) { run.waiting = run.mode === 'preview' ? '预览完成，未执行删除。' : '扫描完成，未配置删除关键词。'; draw(); return stop(); }
    let first = true;
    let emptyRescanAttempts = 0;
    while (!run.stopped && !run.paused) {
      if (run.settings.sessionMaxMinutes && Date.now() - run.startedAt >= run.settings.sessionMaxMinutes * 60000) return stop('paused', '已达到本次任务运行时间上限。');
      if (run.settings.sessionLimit !== 'unlimited' && run.stats.deleted >= run.settings.sessionLimit) return stop('paused', '已达到本次任务删除数量上限。');
      if (run.candidates.length) {
        const candidate = run.candidates.shift();
        if (run.processedIds.has(candidate.id)) continue;
        try {
          if (!first && !(await wait(InstagramCommentDelay.generateDelayMs(run.settings.pace.operation), '正在等待下一次操作...'))) return;
          first = false; if (!(await acquire())) return;
          run.state = 'running'; draw();
          await remove(candidate); run.processedIds.add(candidate.id); run.stats.deleted += 1;
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
      // 当前评论容器没有候选时只做有限次稳定重扫；一级评论分页/滚动加载由用户控制。
      if (emptyRescanAttempts < stabilityDefaults.emptyRescanAttempts) {
        emptyRescanAttempts += 1;
        const result = await scan();
        if (!run.stopped && !run.paused && result.candidates.length) { emptyRescanAttempts = 0; continue; }
        continue;
      }
      return stop('completed', '已完成：当前稳定评论容器中没有待处理回复。');
    }
  }
  async function start(mode) {
    if (run.starting || (!run.stopped && !run.paused)) return;
    const resuming = !run.stopped && run.paused;
    run.starting = true; draw();
    try {
      run.settings = InstagramCommentPaceConfig.validateSettings((await chrome.storage.sync.get(KEY))[KEY] || {}); run.rules = InstagramCommentRules.prepareRules(run.settings);
      // Instagram 完成导航后可能还会短暂替换地址（例如重定向或 SPA 路由更新）。
      // 启动消息只发送一次，因此在校验前等待目标 URL 稳定，避免用户再次点击页面内“开始”。
      for (let attempt = 0; attempt < 20 && InstagramCommentRules.normalizeTargetUrl(location.href) !== run.rules.targetUrl; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      if (InstagramCommentRules.normalizeTargetUrl(location.href) !== run.rules.targetUrl) throw new Error('当前 URL 与设置的目标帖子不匹配。');
      const lock = await send({ type: 'ICC_ACQUIRE_LOCK', targetUrl: run.rules.targetUrl }); if (!lock.ok) throw new Error(lock.reason);
      if (!resuming) {
        resetStability();
        run.stopped = false; run.mode = mode; run.startedAt = Date.now(); run.seenIds = new Set(); run.matchedIds = new Set(); run.skippedIds = new Set(); run.processedIds = new Set(); run.lastScanIds = new Set(); run.stats = { scanned: 0, matched: 0, deleted: 0, skipped: 0, loaded: 0 }; run.pace = new InstagramCommentPaceController(run.settings.pace);
      } else {
        resetStability();
        run.paused = false; run.error = ''; run.waiting = ''; run.state = 'idle';
        if (run.pace?.state === 'REST') run.pace.restComplete();
      }
      run.starting = false; run.lockTimer = setInterval(() => send({ type: 'ICC_RENEW_LOCK', targetUrl: run.rules.targetUrl }), 30000); draw();
      // 恢复时同样重扫，避免沿用暂停前已被 Instagram 重绘的候选元素。
      await scan();
      await process();
    } catch (error) {
      run.starting = false;
      if (!resuming) run.stopped = true;
      run.paused = true; run.state = 'paused'; run.error = error.message; await releaseLock(); draw();
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type === 'ICC_PAUSE') { pause(); reply({ ok: true }); return false; }
    if (message?.type === 'ICC_STOP') { stop(); reply({ ok: true }); return false; }
    if (!['ICC_START', 'ICC_PREVIEW'].includes(message?.type)) return false;
    start(message.type === 'ICC_START' ? 'run' : 'preview'); reply({ ok: true }); return false;
  });
  if (InstagramCommentRules.normalizeTargetUrl(location.href)) panel();
})();
