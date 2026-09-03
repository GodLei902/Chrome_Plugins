const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(tag = 'div', attrs = {}, text = '') { this.tagName = tag.toUpperCase(); this.attrs = { ...attrs }; this.children = []; this.parentElement = null; this.ownerDocument = null; this.isConnected = true; this.text = text; this.clickCount = 0; this.style = {}; this.onClick = null; }
  append(...children) { children.forEach((child) => { child.parentElement = this; child.setOwnerDocument(this.ownerDocument); this.children.push(child); }); return this; }
  setOwnerDocument(documentLike) { this.ownerDocument = documentLike; this.children.forEach((child) => child.setOwnerDocument(documentLike)); }
  remove() { const siblings = this.parentElement?.children || []; const index = siblings.indexOf(this); if (index >= 0) siblings.splice(index, 1); this.isConnected = false; this.parentElement = null; }
  get textContent() { return [this.text, ...this.children.map((child) => child.textContent)].filter(Boolean).join(' '); }
  get innerText() { return this.textContent; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  matches(selector) { return selector.split(',').some((part) => { const match = part.trim().match(/^([a-z]+)?(?:\[([^=\]]+)(?:="([^"]*)")?\])?$/i); if (!match) return false; return (!match[1] || this.tagName === match[1].toUpperCase()) && (!match[2] || (this.attrs[match[2]] != null && (!match[3] || this.attrs[match[2]] === match[3]))); }); }
  querySelectorAll(selector) { const found = []; const visit = (node) => { node.children.forEach((child) => { if (child.matches(selector)) found.push(child); visit(child); }); }; visit(this); return found; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  contains(node) { for (let current = node; current; current = current.parentElement) if (current === this) return true; return false; }
  getBoundingClientRect() { return this.isConnected ? { width: 10, height: 10 } : { width: 0, height: 0 }; }
  click() { this.clickCount += 1; this.onClick?.(); }
}
class FixtureDocument extends Element { constructor() { super('document'); this.ownerDocument = this; this.location = { href: 'https://www.tiktok.com/@creator/video/123' }; this.defaultView = { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) }; } }
function node(tag, attrs = {}, text = '') { return new Element(tag, attrs, text); }
function comment(level, author, text) { const row = node('div'); const user = node('div', { 'data-e2e': `comment-username-${level}` }); user.append(node('a', { href: `/@${author}` }, author)); if (author === 'creator') user.append(node('span', {}, 'Creator')); const body = node('span', { 'data-e2e': `comment-level-${level}` }, text); row.append(user, body); return row; }
function thread(parent, replies = []) { const root = node('div'); root.append(parent, ...replies); return root; }
function commentTabs(active = 'recommended') { const group = node('div', { 'data-testid': 'tux-web-tab-bar' }); const comments = node('button', { 'data-testid': 'tux-web-tab-bar' }, '评论'); const recommended = node('button', { 'data-testid': 'tux-web-tab-bar' }, '推荐'); comments.style.color = active === 'comments' ? 'color-ui-text-1' : ''; recommended.style.color = active === 'recommended' ? 'color-ui-text-1' : ''; comments.onClick = () => { comments.style.color = 'color-ui-text-1'; recommended.style.color = ''; }; group.append(comments, recommended); return { group, comments }; }
function loadContext(files) { const context = { URL, Map, Set, Array, Object, String, Boolean, Number, Error, TypeError, Date, Math, Promise, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, console }; context.globalThis = context; vm.createContext(context); files.forEach((file) => vm.runInContext(fs.readFileSync(path.join(process.cwd(), file), 'utf8'), context, { filename: file })); return context; }

function context() {
  return loadContext([
    'src/shared/comment-types.js',
    'src/shared/comment-surface-stability.js',
    'src/platform/contract.js',
    'src/platform/registry.js',
    'src/platform/tiktok/identity.js',
    'src/platform/tiktok/dom.js',
    'src/platform/tiktok/surface.js',
    'src/platform/tiktok/comments.js',
    'src/platform/tiktok/loader.js',
    'src/platform/tiktok/plugin.js',
  ]);
}

test('TikTok 第二阶段脚本提供唯一评论面、稳定快照和安全观察器', async () => {
  const c = context();
  const documentLike = new FixtureDocument();
  const tabs = commentTabs('recommended');
  const surface = node('div');
  surface.append(thread(comment(1, 'creator', '一级评论')));
  documentLike.append(tabs.group, surface);
  const plugin = c.SocialCommentPlatformRegistry.get('tiktok');
  const waits = {
    until: async (predicate) => Boolean(await predicate()),
    delay: async () => true,
  };
  const stable = await plugin.surface.waitUntilStable(documentLike, { canonicalUrl: documentLike.location.href }, { wait: waits });
  assert.equal(stable.ok, true);
  assert.equal(tabs.comments.clickCount, 1);
  assert.equal(plugin.surface.findCommentSurface(documentLike).surface.contains(surface.querySelector('[data-e2e="comment-level-1"]')), true);
  assert.equal(plugin.surface.snapshot(surface).snapshot.count, 1);
  const observed = plugin.surface.observe(surface, { MutationObserver: class { observe() {} disconnect() {} } });
  assert.equal(observed.ok, true);
  observed.disconnect();
});

test('TikTok 记录解析区分一级/回复、唯一父级和 Creator 区域保护', () => {
  const c = context();
  const documentLike = new FixtureDocument();
  const surface = node('div');
  const parent = comment(1, 'creator', '一级评论');
  const reply = comment(2, 'visitor', '命中回复');
  surface.append(thread(parent, [reply]));
  documentLike.append(surface);
  const comments = c.SocialCommentTikTokComments;
  const collected = comments.collect(surface, { contentId: '123', creatorHandle: 'creator' });
  assert.equal(collected.ok, true);
  assert.equal(collected.records.length, 2);
  assert.equal(collected.records[0].kind, 'root');
  assert.equal(collected.records[0].isPostAuthor, true);
  assert.equal(collected.records[1].kind, 'reply');
  assert.equal(collected.records[1].parentId, collected.records[0].id);
  const threads = comments.buildThreads(collected.records);
  assert.equal(threads.ok, true);
  assert.equal(threads.threads[0].replies.length, 1);
  const orphan = comment(2, 'visitor', '孤立回复');
  assert.equal(comments.toRecord(orphan, { contentId: '123' }).error.code, 'ambiguous');
});

test('TikTok 第二阶段 Preview 只允许页签点击，展开和删除保持安全占位', async () => {
  const c = context();
  const plugin = c.SocialCommentPlatformRegistry.get('tiktok');
  assert.equal(plugin.capabilities.supportsPreview, true);
  assert.equal(plugin.capabilities.supportsReplies, true);
  assert.equal(plugin.capabilities.supportsCommentDelete, false);
  assert.equal(plugin.loader.expandAll().ok, true);
  assert.equal(plugin.loader.expandAll().expanded, false);
  assert.equal((await plugin.loader.expandParent()).error.code, 'not-ready');
  assert.equal(plugin.actions.confirmDelete().error.code, 'unsupported');
});

test('TikTok 回复展开只点击当前一级评论唯一入口，并确认新增回复', async () => {
  const c = loadContext([
    'src/shared/comment-types.js', 'src/shared/comment-surface-stability.js',
    'src/platform/contract.js', 'src/platform/tiktok/identity.js', 'src/platform/tiktok/dom.js',
    'src/platform/tiktok/loader.js',
  ]);
  const documentLike = new FixtureDocument();
  const surface = node('div');
  const parent = comment(1, 'visitor', '一级评论');
  const threadRoot = thread(parent);
  const control = node('p', {}, '1件の返信を表示');
  control.onClick = () => { threadRoot.append(comment(2, 'guest', '回复内容')); control.remove(); };
  threadRoot.append(control);
  surface.append(threadRoot);
  documentLike.append(surface);
  const result = await c.SocialCommentTikTokLoader.expandParent(surface, parent, {}, {
    wait: { until: async (predicate) => Boolean(await predicate()) },
    coordinateAction: async (type, action) => ({ ok: true, value: action(type) }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.expanded, true);
  assert.equal(surface.querySelectorAll('[data-e2e="comment-level-2"]').length, 1);
  assert.equal(control.clickCount, 1);
});

test('TikTok 日文“あと N 件表示”会作为同一父评论的后续展开入口，非表示则表示完成', async () => {
  const c = loadContext([
    'src/shared/comment-types.js', 'src/shared/comment-surface-stability.js',
    'src/platform/contract.js', 'src/platform/tiktok/identity.js', 'src/platform/tiktok/dom.js', 'src/platform/tiktok/loader.js',
  ]);
  const documentLike = new FixtureDocument();
  const surface = node('div');
  const parent = comment(1, 'visitor', '一级评论');
  const threadRoot = thread(parent);
  const firstControl = node('p', {}, '— あと106件表示');
  firstControl.onClick = () => {
    threadRoot.append(comment(2, 'guest-1', '第一批回复'));
    firstControl.remove();
    const nextControl = node('p', {}, 'あと98件表示');
    nextControl.onClick = () => {
      threadRoot.append(comment(2, 'guest-2', '第二批回复'));
      nextControl.remove();
      threadRoot.append(node('p', {}, '非表示'));
    };
    threadRoot.append(nextControl);
  };
  threadRoot.append(firstControl);
  surface.append(threadRoot);
  documentLike.append(surface);
  const options = {
    wait: { until: async (predicate) => Boolean(await predicate()) },
    coordinateAction: async (type, action) => ({ ok: true, value: action(type) }),
  };
  const first = await c.SocialCommentTikTokLoader.expandParent(surface, parent, {}, options);
  assert.equal(first.ok, true);
  assert.equal(first.complete, false);
  const second = await c.SocialCommentTikTokLoader.expandParent(surface, parent, {}, options);
  assert.equal(second.ok, true);
  assert.equal(second.complete, false);
  const complete = await c.SocialCommentTikTokLoader.expandParent(surface, parent, {}, options);
  assert.equal(complete.ok, true);
  assert.equal(complete.complete, true);
  assert.equal(firstControl.clickCount, 1);
  assert.equal(surface.querySelectorAll('[data-e2e="comment-level-2"]').length, 2);
});

test('TikTok 回复展开会在父评论重绘后按稳定键重新定位，并安全拒绝重复入口和取消', async () => {
  const c = loadContext([
    'src/shared/comment-types.js', 'src/shared/comment-surface-stability.js', 'src/platform/contract.js',
    'src/platform/tiktok/identity.js', 'src/platform/tiktok/dom.js', 'src/platform/tiktok/comments.js', 'src/platform/tiktok/loader.js',
  ]);
  const documentLike = new FixtureDocument();
  const surface = node('div');
  const original = comment(1, 'visitor', '一级评论');
  const originalThread = thread(original);
  surface.append(originalThread);
  documentLike.append(surface);
  const target = { contentId: '123' };
  const parentId = c.SocialCommentTikTokComments.toRecord(original, target).record.id;
  originalThread.remove();
  const replacement = comment(1, 'visitor', '一级评论');
  const replacementThread = thread(replacement);
  const control = node('p', {}, '1件の返信を表示');
  control.onClick = () => { replacementThread.append(comment(2, 'guest', '回复内容')); control.remove(); };
  replacementThread.append(control);
  surface.append(replacementThread);
  const result = await c.SocialCommentTikTokLoader.expandParent(surface, original, target, {
    parentId,
    wait: { until: async (predicate) => Boolean(await predicate()) },
    coordinateAction: async (type, action) => ({ ok: true, value: action(type) }),
  });
  assert.equal(result.ok, true);
  assert.equal(control.clickCount, 1);

  const duplicateParent = comment(1, 'other', '另一条评论');
  const duplicateThread = thread(duplicateParent);
  duplicateThread.append(node('p', {}, '查看 1 条回复'), node('p', {}, '查看 2 条回复'));
  surface.append(duplicateThread);
  const duplicate = await c.SocialCommentTikTokLoader.expandParent(surface, duplicateParent, target, {});
  assert.equal(duplicate.error.code, 'ambiguous');

  const cancelled = await c.SocialCommentTikTokLoader.expandParent(surface, replacement, target, {
    parentId,
    signal: AbortSignal.abort(),
  });
  assert.equal(cancelled.error.code, 'cancelled');
});

test('TikTok 回复展开未确认新增结果时暂停，不会跳过当前一级评论', async () => {
  const c = loadContext([
    'src/shared/comment-types.js', 'src/shared/comment-surface-stability.js', 'src/platform/contract.js',
    'src/platform/tiktok/identity.js', 'src/platform/tiktok/dom.js', 'src/platform/tiktok/loader.js',
  ]);
  const documentLike = new FixtureDocument();
  const surface = node('div');
  const parent = comment(1, 'visitor', '一级评论');
  const item = thread(parent);
  const control = node('p', {}, '查看 1 条回复');
  item.append(control);
  surface.append(item);
  documentLike.append(surface);
  const result = await c.SocialCommentTikTokLoader.expandParent(surface, parent, {}, {
    wait: { until: async () => false },
    coordinateAction: async (type, action) => ({ ok: true, value: action(type) }),
  });
  assert.equal(control.clickCount, 1);
  assert.equal(result.error.code, 'ambiguous');
});

test('TikTok Preview 仅扫描和统计，不调用菜单、确认或删除动作', async () => {
  const c = loadContext([
    'src/shared/comment-types.js', 'src/shared/comment-surface-stability.js', 'src/shared/task-session.js',
    'src/shared/action-pace-controller.js', 'src/platform/contract.js', 'src/platform/registry.js',
    'src/platform/tiktok/identity.js', 'src/platform/tiktok/preflight.js', 'src/platform/tiktok/errors.js',
    'src/platform/tiktok/dom.js', 'src/platform/tiktok/surface.js', 'src/platform/tiktok/comments.js', 'src/platform/tiktok/loader.js',
    'src/platform/tiktok/plugin.js', 'src/core/candidate-policy.js', 'src/core/task-session.js',
    'src/core/wait-coordinator.js', 'src/core/ui-model.js', 'src/core/cleaner-runtime.js',
  ]);
  const documentLike = new FixtureDocument();
  documentLike.body = { innerText: '' };
  const tabs = commentTabs('comments');
  const surface = node('div');
  surface.append(thread(comment(1, 'creator', '一级评论'), [comment(2, 'visitor', 'spam 回复')]));
  documentLike.append(tabs.group, surface);
  const plugin = c.SocialCommentPlatformRegistry.get('tiktok');
  const calls = [];
  ['revealMenu', 'getMenu', 'findDeleteAction', 'confirmDelete', 'verifyDeleted'].forEach((name) => {
    const original = plugin.actions[name];
    plugin.actions[name] = (...args) => { calls.push(name); return original(...args); };
  });
  const runtime = c.SocialCommentCleanerRuntime.create({
    platform: plugin,
    settings: { deleteKeywords: 'spam', pace: { rateLimit: { perMinute: 5, perHour: 60 } } },
    transport: { send: async () => ({ ok: true }) },
    clock: { now: () => Date.now(), setInterval: () => null, clearInterval: () => {} },
  });
  assert.equal((await runtime.start({ mode: 'preview', targetUrl: documentLike.location.href, page: documentLike })).ok, true);
  assert.equal((await runtime.run()).ok, true);
  assert.equal(runtime.snapshot().stats.matched, 1);
  assert.equal(runtime.snapshot().stats.deleted, 0);
  assert.deepEqual(calls, []);
});

test('TikTok Preview 按一级评论逐个展开、扫描和筛选，且从不调用删除动作', async () => {
  const c = loadContext([
    'src/shared/comment-types.js', 'src/shared/comment-surface-stability.js', 'src/shared/task-session.js',
    'src/shared/action-pace-controller.js', 'src/platform/contract.js', 'src/platform/registry.js',
    'src/platform/tiktok/identity.js', 'src/platform/tiktok/preflight.js', 'src/platform/tiktok/errors.js',
    'src/platform/tiktok/dom.js', 'src/platform/tiktok/surface.js', 'src/platform/tiktok/comments.js', 'src/platform/tiktok/loader.js',
    'src/platform/tiktok/plugin.js', 'src/core/candidate-policy.js', 'src/core/task-session.js',
    'src/core/wait-coordinator.js', 'src/core/ui-model.js', 'src/core/cleaner-runtime.js',
  ]);
  const documentLike = new FixtureDocument();
  documentLike.body = { innerText: '' };
  const tabs = commentTabs('comments');
  const surface = node('div');
  const expansionOrder = [];
  ['first', 'second'].forEach((name) => {
    const parent = comment(1, name, `${name} 一级评论`);
    const item = thread(parent);
    const control = node('p', {}, '1件の返信を表示');
    control.onClick = () => {
      expansionOrder.push(`${name}-1`);
      item.append(comment(2, `${name}-reply-1`, 'spam 回复'));
      control.remove();
      if (name === 'first') {
        const followup = node('p', {}, 'あと106件表示');
        followup.onClick = () => {
          expansionOrder.push(`${name}-2`);
          item.append(comment(2, `${name}-reply-2`, 'spam 回复'));
          followup.remove();
          item.append(node('p', {}, '非表示'));
        };
        item.append(followup);
      }
    };
    item.append(control);
    surface.append(item);
  });
  documentLike.append(tabs.group, surface);
  const plugin = c.SocialCommentPlatformRegistry.get('tiktok');
  const calls = [];
  ['revealMenu', 'getMenu', 'findDeleteAction', 'confirmDelete', 'verifyDeleted'].forEach((name) => {
    const original = plugin.actions[name];
    plugin.actions[name] = (...args) => { calls.push(name); return original(...args); };
  });
  const runtime = c.SocialCommentCleanerRuntime.create({
    platform: plugin,
    settings: { deleteKeywords: 'spam', pace: { rateLimit: { perMinute: 5, perHour: 60 } } },
    transport: { send: async () => ({ ok: true }) },
    clock: { now: () => Date.now(), setInterval: () => null, clearInterval: () => {} },
  });
  assert.equal((await runtime.start({ mode: 'preview', targetUrl: documentLike.location.href, page: documentLike })).ok, true);
  assert.equal((await runtime.run()).ok, true);
  assert.deepEqual(expansionOrder, ['first-1', 'first-2', 'second-1']);
  assert.equal(runtime.snapshot().stats.matched, 3);
  assert.deepEqual(calls, []);
});
