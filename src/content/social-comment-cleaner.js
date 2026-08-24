(function () {
  'use strict';
  const KEY = 'socialCommentCleanerSettings';
  const TEXT = { idle: '空闲', scanning: '扫描中', running: '运行中', 'cooling-down': '休息中', completed: '已完成', paused: '已暂停', error: '错误' };
  const run = { stopped: true, paused: false, starting: false, state: 'idle', stats: { scanned: 0, matched: 0, deleted: 0, skipped: 0, loaded: 0 }, candidates: [], timer: null, lockTimer: null, waiting: '', error: '', seenIds: new Set(), matchedIds: new Set(), skippedIds: new Set(), processedIds: new Set(), lastScanIds: new Set() };
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
  const replyExpander = /^(?:view|see)\s+(?:all\s+)?(?:\d+\s+)?(?:more\s+)?repl(?:y|ies)|^\d+\s+repl(?:y|ies)\s+(?:to\s+)?view$|^\d+件(?:すべての)?返信を見る$|^返信をすべて見る$|^すべての返信を見る$|^查看(?:全部|所有)?回复$|^查看\s*\d+\s*条回复$/i;
  const hiddenCommentExpander = /^(?:see|view)\s+hidden\s+comments?$|^非表示のコメントを見る$|^非表示.*コメント.*見る$|^查看隐藏评论$|^查看.*隐藏.*评论$/i;
  // Instagram 日文界面在悬停评论后使用“コメントのオプション”，而非通用的“その他”。
  const menuLabel = /(?:^more$|more\s+options?|options?|comment options?|评论(?:的)?选项|选项|更多|その他|オプション|コメント(?:の)?オプション|メニュー|^…$|^\.\.\.$)/i;
  const deleteLabel = /^(?:delete|删除|刪除|削除)(?:\s*(?:comment|コメント))?(?:する)?$/i;
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
      if (typeof MutationObserver === 'function' && document.body) { run.waitObserver = new MutationObserver(check); run.waitObserver.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true }); }
      draw();
      check();
    });
  }

  function draw() { if (!run.ui) return; run.ui.querySelector('[data-state]').textContent = TEXT[run.state] || run.state; run.ui.querySelector('[data-stats]').textContent = `扫描 ${run.stats.scanned} · 已加载回复 ${run.stats.loaded} · 命中 ${run.stats.matched} · 待处理 ${run.candidates.length} · 删除 ${run.stats.deleted} · 跳过 ${run.stats.skipped}`; run.ui.querySelector('[data-wait]').textContent = run.waiting; run.ui.querySelector('[data-error]').textContent = run.error || ''; const active = !run.stopped && !run.paused; const busy = active || run.starting; const start = run.ui.querySelector('[data-start]'); start.textContent = run.paused ? '继续' : '开始'; start.disabled = busy; run.ui.querySelector('[data-preview]').disabled = busy || run.paused; run.ui.querySelector('[data-pause]').disabled = !active; run.ui.querySelector('[data-stop]').disabled = run.stopped; }
  function panel() { if (document.getElementById('icc-host')) return; const host = document.createElement('div'); host.id = 'icc-host'; host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647'; const root = host.attachShadow({ mode: 'open' }); root.innerHTML = `<style>main{font:13px system-ui;color:#111;background:#fff;border:1px solid #d1d5db;border-radius:8px;box-shadow:0 8px 28px #0003;width:320px;padding:14px}h2{font-size:14px;margin:0 0 10px}p{margin:7px 0}.muted{color:#666}.wait{color:#075985;min-height:1em}.error{color:#b42318;min-height:1em}.actions{display:flex;gap:6px;flex-wrap:wrap}button{border:0;border-radius:6px;padding:7px 10px;background:#2563eb;color:#fff}button[data-preview]{background:#0f766e}button[data-pause]{background:#d97706}button[data-stop]{background:#6b7280}button:disabled{opacity:.5}</style><main><h2>社交评论清理器</h2><p>状态：<b data-state>空闲</b></p><p class=muted data-stats></p><p class=wait data-wait></p><p class=error data-error></p><div class=actions><button data-start>开始</button><button data-pause>暂停</button><button data-stop>停止</button><button data-preview>预览模式</button></div></main>`; run.ui = root; document.documentElement.append(host); root.querySelector('[data-start]').onclick = () => start('run'); root.querySelector('[data-preview]').onclick = () => start('preview'); root.querySelector('[data-pause]').onclick = () => pause(); root.querySelector('[data-stop]').onclick = () => stop(); draw(); }
  function dataNodes(value, found = []) { if (!value || typeof value !== 'object') return found; for (const [key, child] of Object.entries(value)) { if (key === '__typename' && child === 'XDTCommentDict') found.push(value); dataNodes(child, found); } return found; }
  // 优先按目标 shortcode 读取媒体 owner，避免把其他推荐媒体作者当成帖子作者。
  function mediaAuthors(value, shortcode, found = []) { if (!value || typeof value !== 'object') return found; const code = String(value.shortcode || value.code || ''); const looksLikeMedia = /media/i.test(String(value.__typename || '')) || Boolean(code && (value.owner?.username || value.user?.username)); if (looksLikeMedia && (value.owner?.username || value.user?.username) && (!shortcode || code === shortcode)) found.push(value.owner?.username || value.user?.username); for (const child of Object.values(value)) mediaAuthors(child, shortcode, found); return found; }
  function commentIdFromUrl(value) { return String(value || '').match(/\/c\/(\d+)(?:\/|$)/)?.[1] || ''; }
  function replyUsername(container) {
    // 个人主页链接同时承载头像和用户名，排除帖子/评论链接后首个即为回复作者。
    for (const link of container.querySelectorAll('a[href]')) {
      const match = link.getAttribute('href')?.match(/^\/([^/?#]+)\/?$/);
      if (match) return decodeURIComponent(match[1]);
    }
    return '';
  }
  function domReplyComments() {
    const replies = new Map();
    for (const timeLink of document.querySelectorAll('a[href*="/c/"]')) {
      const container = timeLink.closest('ul');
      const id = commentIdFromUrl(timeLink.getAttribute('href'));
      if (!container || !id || !visible(container)) continue;
      const username = replyUsername(container); const body = normalizedText(container);
      if (!username || !body) continue;
      // 当前页面版本把已展开回复只渲染到 ul 中，不会同步写回 application/json。
      // 使用独立虚拟父级可让规则引擎把它稳定地当作回复而非一级评论。
      replies.set(id, { id, parentId: `dom-reply-parent:${id}`, username, text: body, childCount: 0, element: container });
    }
    return [...replies.values()];
  }
  function locateCommentElement(comment) {
    if (comment.element?.isConnected && visible(comment.element)) return comment.element;
    const expectedText = String(comment.text || '').replace(/\s+/g, ' ').trim();
    const expectedUsername = String(comment.username || '').toLocaleLowerCase();
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
  function hasRenderedComments() { return [...document.querySelectorAll('a[href*="/c/"]')].some(visible); }
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
    for (let pass = 0; pass < 40 && !run.stopped; pass += 1) {
      const control = [...document.querySelectorAll('button,[role="button"]')].find((node) => {
        if (clicked.has(node) || !visible(node)) return false;
        const label = normalizedText(node) || `${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''}`.trim();
        return replyExpander.test(label) || hiddenCommentExpander.test(label);
      });
      if (!control) return;
      clicked.add(control);
      control.click();
      count += 1;
      // 展开操作会触发网络请求。等待原控制项消失或变为“隐藏回复”，避免仅等固定时间
      // 就在回复尚未渲染时开始下一轮扫描。
      const expanded = await waitForCondition(() => !control.isConnected || !visible(control) || !(replyExpander.test(normalizedText(control)) || hiddenCommentExpander.test(normalizedText(control))), 5000, '正在展开折叠的回复和非表示评论...');
      if (!expanded && (run.stopped || run.paused)) return count;
    }
    return count;
  }
  function threads() {
    const source = new Map(); const authors = new Set(); const allAuthors = new Set();
    const shortcode = InstagramCommentRules.normalizeTargetUrl(run.rules.targetUrl).split('/').filter(Boolean).pop() || '';
    for (const script of document.querySelectorAll('script[type="application/json"]')) try {
      const data = JSON.parse(script.textContent || '');
      mediaAuthors(data, shortcode, authors); mediaAuthors(data, '', allAuthors);
      for (const node of dataNodes(data)) {
        const id = String(node.pk || node.id || '');
        if (id && node.user?.username && node.text) source.set(id, { id, parentId: node.parent_comment_id == null ? '' : String(node.parent_comment_id), username: node.user.username, text: node.text, childCount: Number(node.child_comment_count) || 0 });
      }
    } catch { /* Ignore unrelated JSON. */ }
    for (const reply of domReplyComments()) {
      // 结构化数据可用时优先保留其父级关系，只补充 DOM 节点供删除时定位菜单。
      const structured = source.get(reply.id);
      source.set(reply.id, structured ? { ...structured, element: reply.element } : reply);
    }
    const authorUsername = authors.values().next().value || (allAuthors.size === 1 ? allAuthors.values().next().value : '');
    // 扫描阶段只使用结构化数据；DOM 节点可能尚未渲染，删除时再按候选重新定位。
    const mapped = [...source.values()].map((comment) => ({ ...comment, isPostAuthor: Boolean(authorUsername) && InstagramCommentRules.normalizeUsername(comment.username) === InstagramCommentRules.normalizeUsername(authorUsername) }));
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
    parents.push(...orphanReplies.values());
    parents.forEach((item) => { item.hasUnloadedReplies = item.childCount > item.replies.length; });
    return parents;
  }
  // 与规则引擎保持一致，收集多层已加载回复的稳定 ID，避免漏掉嵌套回复。
  function replyIds(list) {
    const ids = new Set();
    const visit = (replies) => (replies || []).forEach((reply) => { if (reply.id) ids.add(reply.id); visit(reply.replies); });
    list.forEach((thread) => visit(thread.replies));
    return ids;
  }
  async function scan() {
    run.state = 'scanning'; draw();
    if (/(challenge_required|try again later|验证|verification|rate limit)/i.test(document.body.innerText)) throw new Error('检测到验证、限流或异常页面，已暂停。');
    // 从扩展按钮启动新页面时，document_idle 早于评论数据渲染；先等待稳定评论链接出现。
    if (!hasRenderedComments()) await waitForCondition(hasRenderedComments, 12000, '正在等待 Instagram 加载评论...');
    if (run.stopped || run.paused) return { ids: new Set(), newIds: 0, expanded: 0 };
    const expanded = await revealCollapsedComments(); if (run.stopped || run.paused) return { ids: new Set(), newIds: 0, expanded };
    const list = threads(); const ids = replyIds(list); let newIds = 0;
    ids.forEach((id) => { if (!run.seenIds.has(id)) { run.seenIds.add(id); newIds += 1; } });
    const result = InstagramCommentRules.selectCandidates(list, run.rules);
    result.candidates.forEach((candidate) => run.matchedIds.add(candidate.id));
    run.candidates = result.candidates.filter((candidate) => !run.processedIds.has(candidate.id));
    run.stats.scanned += newIds; run.stats.loaded = run.seenIds.size; run.stats.matched = run.matchedIds.size;
    result.skippedIds.forEach((id) => { if (!run.skippedIds.has(id)) { run.skippedIds.add(id); run.stats.skipped += 1; } });
    run.lastScanIds = ids; run.state = 'idle'; draw();
    return { ids, newIds, expanded };
  }
  /*
   * 暂停自动分页和滚动加载（2026-08-24）。
   * 当前阶段只处理 Instagram 当前评论容器中已经加载的内容，改由用户手动下滑
   * 触发页面加载后再次启动任务。保留旧实现以便后续在确认页面结构和加载边界后恢复。
   *
   * function findScrollContainer() {
   *   const anchor = run.candidates[0]?.element;
   *   if (anchor) {
   *     let node = anchor.parentElement;
   *     while (node && node !== document.body) { if (node.scrollHeight > node.clientHeight + 80 && visible(node)) return node; node = node.parentElement; }
   *   }
   *   const candidates = [document.scrollingElement, ...document.querySelectorAll('main,section,div')].filter((node) => node && node.scrollHeight > node.clientHeight + 80 && visible(node));
   *   return candidates.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0] || document.scrollingElement;
   * }
   * async function loadNextBatch(previousIds) {
   *   run.state = 'loading'; run.stats.scrollRounds += 1; draw();
   *   const container = findScrollContainer(); const before = new Set(previousIds); const amount = Math.max(360, Math.floor((container.clientHeight || window.innerHeight || 720) * 0.75));
   *   if (container === document.scrollingElement) window.scrollBy({ top: amount, behavior: 'auto' });
   *   else container.scrollBy({ top: amount, behavior: 'auto' });
   *   await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
   *   const changed = await waitForCondition(() => {
   *     const current = threads(); return current.some((thread) => thread.replies.some((reply) => reply.id && !before.has(reply.id)));
   *   }, 4500, '正在等待评论区加载下一批回复...');
   *   const result = await scan();
   *   const added = result.newIds > 0 || result.expanded > 0;
   *   if (added || changed) run.stats.emptyRounds = 0; else run.stats.emptyRounds += 1;
   *   draw(); return added || changed;
   * }
   */
  async function waitForDeleted(candidate) {
    const expectedText = String(candidate.text || '').replace(/\s+/g, ' ').trim();
    return waitForCondition(() => !candidate.element.isConnected || !visible(candidate.element) || !normalizedText(candidate.element).includes(expectedText), 7000, '正在确认回复已删除...');
  }
  async function remove(candidate) {
    // 候选来自接口数据，只有执行删除时才要求对应 DOM 已渲染。
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
    if (run.waitResolve) finishWait(false); else clearTimeout(run.timer);
    run.timer = null; run.state = 'paused'; run.waiting = '已暂停，点击“开始”继续。';
    await releaseLock(); draw();
  }
  async function stop(finalState = 'idle', reason = '') {
    run.stopped = true; run.paused = false;
    if (run.waitResolve) finishWait(false); else clearTimeout(run.timer);
    run.timer = null; run.state = finalState; run.waiting = reason || (finalState === 'completed' ? run.waiting : '');
    run.candidates = [];
    await releaseLock(); draw();
  }
  async function acquire() { while (!run.stopped && !run.paused) { const result = await send({ type: 'ICC_RATE_ACQUIRE', limits: run.settings.pace.rateLimit }); if (result.ok) return true; if (!Number.isFinite(result.retryAfterMs)) throw new Error(result.reason || '无法申请操作额度。'); if (!(await wait(result.retryAfterMs, `全局操作上限已满，等待 ${Math.ceil(result.retryAfterMs / 1000)} 秒...`))) return false; } return false; }
  async function process() {
    if (run.mode === 'preview' || !run.rules.keywords.length) { run.waiting = '预览完成，未执行删除。'; draw(); return stop(); }
    let first = true;
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
          // 删除 mutation 会短暂卸载整个回复列表；等页面重绘后再扫描，防止漏掉下一条候选。
          if (!(await wait(1300, '正在等待 Instagram 更新评论区...'))) return;
          const state = run.pace.success(); await scan();
          if (state === 'REST') { run.state = 'cooling-down'; draw(); if (!(await wait(InstagramCommentDelay.generateDelayMs(run.settings.pace.rest), '连续处理达到上限，正在休息...'))) return; run.pace.restComplete(); first = true; await scan(); }
        } catch (error) {
          if (run.paused) return;
          if (error.message === '目标回复已被页面刷新，正在重新扫描。') { await scan(); continue; }
          run.error = error.message; return stop('paused');
        }
        continue;
      }
      // 暂停自动分页/滚动加载：当前评论容器没有候选时结束本次任务。
      // 用户手动下滑加载更多内容后，再点击“开始”即可重新扫描新容器内容。
      return stop('completed', '已完成：当前评论容器中没有待处理回复。');
      /*
       * 原自动加载流程暂时停用，保留用于后续恢复：
       * const before = new Set(run.lastScanIds); const loaded = await loadNextBatch(before);
       * if (!run.paused && !loaded && run.stats.emptyRounds >= 3) return stop('completed', '已完成：连续三轮没有新的可加载子级回复。');
       */
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
        run.stopped = false; run.mode = mode; run.startedAt = Date.now(); run.seenIds = new Set(); run.matchedIds = new Set(); run.skippedIds = new Set(); run.processedIds = new Set(); run.lastScanIds = new Set(); run.stats = { scanned: 0, matched: 0, deleted: 0, skipped: 0, loaded: 0 }; run.pace = new InstagramCommentPaceController(run.settings.pace);
      } else {
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
