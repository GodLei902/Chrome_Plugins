(function () {
  'use strict';
  const SETTINGS_KEY = 'socialCommentCleanerSettings';
  const STATE = { idle: '空闲', scanning: '扫描中', running: '运行中', 'cooling-down': '冷却中', paused: '已暂停', error: '错误' };
  const run = { state: 'idle', stopped: true, starting: false, stats: { scanned: 0, deleted: 0, skipped: 0 }, candidates: [], timer: null };
  const delay = (ms) => new Promise((done) => { run.timer = setTimeout(done, ms); });
  const random = (a, b) => (a + Math.random() * (b - a)) * 1000;
  const send = (message) => chrome.runtime.sendMessage(message).catch(() => ({ ok: false, reason: '扩展后台不可用。' }));
  const shown = (el) => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0; };
  const label = (el) => (el.innerText || el.textContent || '').trim();
  const usernameFromHref = (href) => ((href || '').match(/^\/([\w.]+)\/?$/) || [])[1] || '';
  const normalized = (value) => String(value || '').trim().toLocaleLowerCase();
  const replyLabel = /^(reply|replies|回复|返信)$/i;
  const optionLabel = /(comment\s+options|options|more|评论选项|評論選項|コメントのオプション|选项|選項)/i;
  const deleteLabel = /^(delete|删除|刪除|削除)$/i;

  function draw() {
    if (!run.ui) return;
    run.ui.querySelector('[data-state]').textContent = STATE[run.state];
    run.ui.querySelector('[data-stats]').textContent = `扫描 ${run.stats.scanned} · 删除 ${run.stats.deleted} · 跳过 ${run.stats.skipped}`;
    run.ui.querySelector('[data-error]').textContent = run.error || '';
    const busy = !run.stopped || run.starting;
    run.ui.querySelector('[data-start]').disabled = busy;
    run.ui.querySelector('[data-preview]').disabled = busy;
    run.ui.querySelector('[data-stop]').disabled = !busy;
  }
  function installPanel() {
    if (document.getElementById('icc-host')) return;
    const host = document.createElement('div'); host.id = 'icc-host'; host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>main{font:13px system-ui;color:#111;background:#fff;border:1px solid #d1d5db;border-radius:10px;box-shadow:0 8px 28px #0003;width:272px;padding:14px}h2{font-size:14px;margin:0 0 10px}p{margin:7px 0;line-height:1.35}.muted{color:#666}.error{color:#b42318;min-height:1.35em}.actions{display:flex;gap:6px;margin-top:8px}button{border:0;border-radius:6px;padding:7px 10px;cursor:pointer;background:#2563eb;color:#fff}button[data-preview]{background:#0f766e}button[data-stop]{background:#6b7280;margin-top:8px}button:disabled{opacity:.5}</style><main><h2>社交评论清理器</h2><p>状态：<b data-state>空闲</b></p><p class="muted" data-stats>扫描 0 · 删除 0 · 跳过 0</p><p class="error" data-error></p><div class="actions"><button data-start>开始</button><button data-preview>预览模式</button></div><button data-stop>停止</button></main>`;
    run.ui = root; document.documentElement.append(host);
    root.querySelector('[data-start]').addEventListener('click', (event) => {
      event.preventDefault(); event.stopPropagation(); start('run').catch(reportError);
    });
    root.querySelector('[data-preview]').addEventListener('click', (event) => {
      event.preventDefault(); event.stopPropagation(); start('preview').catch(reportError);
    });
    root.querySelector('[data-stop]').addEventListener('click', (event) => {
      event.preventDefault(); event.stopPropagation(); stop();
    });
  }
  function commentNodes(value, found = []) {
    if (!value || typeof value !== 'object') return found;
    for (const [key, child] of Object.entries(value)) {
      if (key === '__typename' && child === 'XDTCommentDict') found.push(value);
      commentNodes(child, found);
    }
    return found;
  }
  function loadedComments() {
    const byId = new Map();
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      try {
        for (const node of commentNodes(JSON.parse(script.textContent || ''))) {
          const id = String(node?.pk || node?.id || '');
          const username = String(node?.user?.username || '');
          const text = String(node?.text || '');
          if (!id || !username || !text) continue;
          byId.set(id, {
            id,
            parentId: node.parent_comment_id == null ? '' : String(node.parent_comment_id),
            username,
            text,
            childCount: Number(node.child_comment_count) || 0,
          });
        }
      } catch {
        // Instagram also embeds unrelated JSON; only its hydrated Relay payload is useful here.
      }
    }
    return [...byId.values()];
  }
  function hasReplyAction(root) {
    return [...root.querySelectorAll('button, [role="button"]')].some((node) => replyLabel.test(label(node)));
  }
  function commentRootForText(textNode, comment) {
    for (let depth = 0, node = textNode; node && depth < 10; depth += 1, node = node.parentElement) {
      if (!shown(node) || !hasReplyAction(node)) continue;
      const authors = [...node.querySelectorAll('a[href^="/"]')]
        .map((link) => usernameFromHref(link.getAttribute('href')))
        .filter(Boolean)
        .map(normalized);
      if (authors.includes(normalized(comment.username))) return node;
    }
    return null;
  }
  function mapCommentsToDom(comments) {
    const usedRoots = new Set();
    return comments.map((comment) => {
      const textNodes = [...document.querySelectorAll('span')]
        .filter(shown)
        .filter((node) => label(node) === comment.text)
        .sort((a, b) => a.querySelectorAll('span').length - b.querySelectorAll('span').length);
      const element = textNodes
        .map((node) => commentRootForText(node, comment))
        .find((node) => node && !usedRoots.has(node));
      if (element) usedRoots.add(element);
      return { ...comment, element };
    });
  }
  function threads() {
    const comments = mapCommentsToDom(loadedComments()).filter((comment) => comment.element);
    const byId = new Map(comments.map((comment) => [comment.id, { ...comment, replies: [] }]));
    const topLevel = [];
    for (const comment of byId.values()) {
      const parent = byId.get(comment.parentId);
      if (parent) parent.replies.push(comment); else topLevel.push(comment);
    }
    for (const comment of topLevel) comment.hasUnloadedReplies = comment.childCount > comment.replies.length;
    return topLevel;
  }
  async function expandReplies() {
    for (const node of [...document.querySelectorAll('button, div[role="button"]')]) {
      if (shown(node) && /(view .*repl|more repl|查看.*回复|更多回复)/i.test(label(node))) { node.click(); await delay(600); if (run.stopped) return; }
    }
  }
  async function scan() {
    run.state = 'scanning'; run.error = ''; draw();
    if (/(challenge_required|try again later|请稍后重试|验证)/i.test(document.body.innerText)) throw new Error('检测到验证、限流或异常页面，已暂停。');
    await expandReplies();
    const comments = loadedComments();
    if (!comments.length) throw new Error('未找到 Instagram 返回的评论数据，请刷新页面并等待评论加载后重试。');
    const result = InstagramCommentRules.selectCandidates(threads(), run.rules);
    run.candidates = result.candidates; run.stats.scanned += result.scanned; run.stats.skipped += result.skipped;
    if (!result.scanned) run.error = '评论数据已加载，但页面中没有可可靠定位的评论内容块。';
    run.state = 'idle'; draw();
  }
  async function menu(candidate) {
    candidate.element.scrollIntoView({ block: 'center', inline: 'nearest' });
    candidate.element.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
    candidate.element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, view: window }));
    candidate.element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, view: window }));
    await delay(180);
    return [...candidate.element.querySelectorAll('button, [role="button"]')].find((node) => {
      const aria = node.getAttribute('aria-label') || '';
      const svgAria = node.querySelector('svg')?.getAttribute('aria-label') || '';
      return shown(node) && optionLabel.test(`${aria} ${svgAria}`);
    });
  }
  function exact(nodes) { return [...nodes].find((node) => shown(node) && deleteLabel.test(label(node))); }
  async function remove(candidate) {
    const more = await menu(candidate); if (!more) throw new Error('悬浮评论内容块后未找到三点菜单，已暂停。');
    more.click(); await delay(500); if (run.stopped) return false;
    const action = exact(document.querySelectorAll('[role="menuitem"], [role="button"], button'));
    if (!action) throw new Error('没有可靠的删除项（可能缺少权限），已暂停。');
    action.click(); await delay(450); if (run.stopped) return false;
    const confirm = exact(document.querySelectorAll('[role="dialog"] button, [role="dialog"] [role="button"]'));
    if (!confirm) throw new Error('未找到删除确认按钮，已暂停。');
    confirm.click(); await delay(800); return true;
  }
  async function persist() { await send({ type: 'ICC_SAVE_SESSION', targetUrl: run.rules.targetUrl, snapshot: { running: !run.stopped, stats: run.stats, savedAt: Date.now() } }); }
  async function stop(clear = true) {
    run.stopped = true; clearTimeout(run.timer); run.candidates = []; run.state = 'idle'; draw();
    if (run.rules) { await send({ type: 'ICC_RELEASE_LOCK', targetUrl: run.rules.targetUrl }); if (clear) await send({ type: 'ICC_CLEAR_SESSION', targetUrl: run.rules.targetUrl }); }
  }
  async function process() {
    run.stopped = false; run.state = 'running'; draw();
    if (run.mode === 'preview' || !run.rules.keywords.length) { await stop(); return; }
    try {
      while (run.candidates.length) {
        for (const candidate of run.candidates.slice(0, run.settings.batchLimit)) {
          if (run.stopped) return;
          if (run.stats.deleted >= run.settings.sessionLimit) throw new Error('已达到本次会话删除上限。');
          if (Date.now() - run.startedAt > run.settings.sessionMaxMinutes * 60000) throw new Error('已达到本次会话运行时长上限。');
          if (await remove(candidate)) run.stats.deleted++;
          await persist(); if (!run.stopped) await delay(random(run.settings.deleteDelayMin, run.settings.deleteDelayMax));
        }
        if (run.stopped) return;
        run.state = 'cooling-down'; draw(); await delay(random(run.settings.cooldownMin, run.settings.cooldownMax));
        if (run.stopped) return;
        run.candidates = [];
        await scan();
      }
      await stop();
    } catch (error) { run.stopped = true; run.state = 'paused'; run.error = error.message; draw(); await persist(); }
  }
  async function start(mode = 'run', resumeStats = null) {
    if (run.starting || !run.stopped) return;
    run.starting = true; run.error = '正在准备扫描...'; draw();
    try {
      run.settings = (await chrome.storage.sync.get(SETTINGS_KEY))[SETTINGS_KEY];
      run.rules = InstagramCommentRules.prepareRules(run.settings || {});
      if (InstagramCommentRules.normalizeTargetUrl(location.href) !== run.rules.targetUrl) throw new Error('当前 URL 与设置的目标帖子不匹配。');
      const locked = await send({ type: 'ICC_ACQUIRE_LOCK', targetUrl: run.rules.targetUrl });
      if (!locked.ok) throw new Error(locked.reason);
      run.mode = mode; run.stats = resumeStats || { scanned: 0, deleted: 0, skipped: 0 }; run.startedAt = Date.now(); run.stopped = false;
      run.starting = false;
      await scan();
      if (!run.stopped && run.candidates.length) await process(); else await stop();
    } catch (error) {
      run.starting = false; run.stopped = true; run.state = 'paused'; run.error = error.message; draw();
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!['ICC_START', 'ICC_PREVIEW'].includes(message?.type)) return false;
    if (!run.stopped) {
      sendResponse({ ok: false, reason: '当前任务正在运行。' });
      return false;
    }
    start(message.type === 'ICC_PREVIEW' ? 'preview' : 'run').catch((error) => {
      run.state = 'error';
      run.error = error.message;
      draw();
    });
    sendResponse({ ok: true });
    return false;
  });
  async function bootstrap() {
    if (!InstagramCommentRules.normalizeTargetUrl(location.href)) return;
    installPanel();
    const settings = (await chrome.storage.sync.get(SETTINGS_KEY))[SETTINGS_KEY]; const rules = InstagramCommentRules.prepareRules(settings || {});
    if (rules.targetUrl !== InstagramCommentRules.normalizeTargetUrl(location.href)) return;
  }
  function reportError(error) {
    run.starting = false; run.stopped = true; run.state = 'error'; run.error = error.message || '启动失败。'; draw();
  }
  bootstrap().catch(reportError);
})();
