(function () {
  'use strict';
  const SETTINGS_KEY = 'socialCommentCleanerSettings';
  const STATE = { idle: '空闲', scanning: '扫描中', running: '运行中', 'cooling-down': '冷却中', paused: '已暂停', error: '错误' };
  const run = { state: 'idle', stopped: true, stats: { scanned: 0, deleted: 0, skipped: 0 }, candidates: [], timer: null };
  const delay = (ms) => new Promise((done) => { run.timer = setTimeout(done, ms); });
  const random = (a, b) => (a + Math.random() * (b - a)) * 1000;
  const send = (message) => chrome.runtime.sendMessage(message).catch(() => ({ ok: false, reason: '扩展后台不可用。' }));
  const shown = (el) => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0; };
  const label = (el) => (el.innerText || el.textContent || '').trim();

  function draw() {
    if (!run.ui) return;
    run.ui.querySelector('[data-state]').textContent = STATE[run.state];
    run.ui.querySelector('[data-stats]').textContent = `扫描 ${run.stats.scanned} · 删除 ${run.stats.deleted} · 跳过 ${run.stats.skipped}`;
    run.ui.querySelector('[data-error]').textContent = run.error || '';
    run.ui.querySelector('[data-start]').disabled = !run.stopped;
    run.ui.querySelector('[data-stop]').disabled = run.stopped;
  }
  function installPanel() {
    if (document.getElementById('icc-host')) return;
    const host = document.createElement('div'); host.id = 'icc-host'; host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>main{font:13px system-ui;color:#111;background:#fff;border:1px solid #d1d5db;border-radius:10px;box-shadow:0 8px 28px #0003;width:272px;padding:14px}h2{font-size:14px;margin:0 0 10px}p{margin:7px 0;line-height:1.35}.muted{color:#666}.error{color:#b42318;min-height:1.35em}button{border:0;border-radius:6px;padding:7px 10px;margin:8px 6px 0 0;cursor:pointer;background:#2563eb;color:#fff}button[data-stop]{background:#6b7280}button:disabled{opacity:.5}</style><main><h2>社交评论清理器</h2><p>状态：<b data-state>空闲</b></p><p class="muted" data-stats>扫描 0 · 删除 0 · 跳过 0</p><p class="error" data-error></p><button data-start>开始</button><button data-stop>停止</button></main>`;
    run.ui = root; document.documentElement.append(host);
    root.querySelector('[data-start]').addEventListener('click', start);
    root.querySelector('[data-stop]').addEventListener('click', () => stop());
  }
  function username(article) {
    const link = [...article.querySelectorAll('a[href^="/"]')].find((a) => /^\/[\w.]+\/?$/.test(a.getAttribute('href')) && label(a));
    return label(link);
  }
  function body(article, user) {
    return [...article.querySelectorAll('span')].filter(shown).map(label).filter((value) => value && value !== user && !/^(reply|回复|赞|like|\d+[smhdw])$/i.test(value)).join(' ');
  }
  function threads() {
    const comments = [...document.querySelectorAll('article')].map((element) => {
      const user = username(element); return { element, username: user, text: body(element, user), replies: [] };
    }).filter((comment) => comment.username && comment.text);
    const topLevel = [];
    for (const comment of comments) {
      const parent = comment.element.parentElement?.closest('article');
      const parentComment = comments.find((item) => item.element === parent);
      if (parentComment) parentComment.replies.push(comment); else topLevel.push(comment);
    }
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
    const result = InstagramCommentRules.selectCandidates(threads(), run.rules);
    run.candidates = result.candidates; run.stats.scanned += result.scanned; run.stats.skipped += result.skipped;
    run.state = 'idle'; draw();
  }
  function menu(candidate) {
    return [...candidate.element.querySelectorAll('button, div[role="button"]')].find((node) => shown(node) && /(more|更多|options|选项)/i.test(node.getAttribute('aria-label') || ''));
  }
  function exact(nodes) { return [...nodes].find((node) => shown(node) && /^(delete|删除)$/i.test(label(node))); }
  async function remove(candidate) {
    const more = menu(candidate); if (!more) throw new Error('无法可靠定位评论菜单，已暂停。');
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
    if (run.settings.previewMode || !run.rules.keywords.length) { await stop(); return; }
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
  async function start(resumeStats = null) {
    run.settings = (await chrome.storage.sync.get(SETTINGS_KEY))[SETTINGS_KEY]; run.rules = InstagramCommentRules.prepareRules(run.settings || {});
    if (InstagramCommentRules.normalizeTargetUrl(location.href) !== run.rules.targetUrl) { run.error = '当前 URL 与设置的目标帖子不匹配。'; draw(); return; }
    const locked = await send({ type: 'ICC_ACQUIRE_LOCK', targetUrl: run.rules.targetUrl });
    if (!locked.ok) { run.error = locked.reason; draw(); return; }
    run.stats = resumeStats || { scanned: 0, deleted: 0, skipped: 0 }; run.startedAt = Date.now(); run.stopped = false;
    try { await scan(); if (!run.stopped && run.candidates.length) await process(); else await stop(); } catch (error) { run.state = 'paused'; run.error = error.message; draw(); }
  }
  async function bootstrap() {
    if (!InstagramCommentRules.normalizeTargetUrl(location.href)) return;
    installPanel();
    const settings = (await chrome.storage.sync.get(SETTINGS_KEY))[SETTINGS_KEY]; const rules = InstagramCommentRules.prepareRules(settings || {});
    if (rules.targetUrl !== InstagramCommentRules.normalizeTargetUrl(location.href)) return;
  }
  bootstrap().catch((error) => { run.state = 'error'; run.error = error.message; draw(); });
})();
