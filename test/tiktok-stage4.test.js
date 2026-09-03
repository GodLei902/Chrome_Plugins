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
  getBoundingClientRect() { return this.isConnected ? { left: 10, top: 10, width: 40, height: 20 } : { left: 0, top: 0, width: 0, height: 0 }; }
  scrollIntoView() {}
  focus() {}
  click() { this.clickCount += 1; this.onClick?.(); }
}
class FixtureDocument extends Element { constructor() { super('document'); this.ownerDocument = this; this.location = { href: 'https://www.tiktok.com/@creator/video/123' }; this.defaultView = { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) }; } }
function node(tag, attrs = {}, text = '') { return new Element(tag, attrs, text); }
function comment(level, author, text) { const row = node('div'); const user = node('div', { 'data-e2e': `comment-username-${level}` }); user.append(node('a', { href: `/@${author}` }, author)); const body = node('span', { 'data-e2e': `comment-level-${level}` }, text); row.append(user, body); return { row, body }; }
function loadContext() {
  const context = { URL, Map, Set, Array, Object, String, Boolean, Number, Error, TypeError, Date, Math, Promise, AbortController, setTimeout, clearTimeout, console };
  context.globalThis = context;
  vm.createContext(context);
  for (const file of ['src/shared/comment-types.js', 'src/platform/contract.js', 'src/platform/tiktok/dom.js', 'src/platform/tiktok/comments.js', 'src/platform/tiktok/actions.js']) vm.runInContext(fs.readFileSync(path.join(process.cwd(), file), 'utf8'), context, { filename: file });
  return context;
}

function loadRuntimeContext() {
  const context = { Map, Set, Array, Object, String, Boolean, Number, Error, TypeError, JSON, Date, Math, Promise, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, console };
  context.globalThis = context;
  vm.createContext(context);
  for (const file of ['src/shared/delay-generator.js', 'src/shared/scheduled-rest.js', 'src/shared/action-pace-controller.js', 'src/platform/contract.js', 'src/core/candidate-policy.js', 'src/core/task-session.js', 'src/core/wait-coordinator.js', 'src/core/ui-model.js', 'src/core/cleaner-runtime.js']) vm.runInContext(fs.readFileSync(path.join(process.cwd(), file), 'utf8'), context, { filename: file });
  return context;
}

function createFixture() {
  const documentLike = new FixtureDocument();
  const surface = node('div');
  const thread = node('div');
  const parent = comment(1, 'owner', 'root comment');
  const item = comment(2, 'guest', 'spam reply');
  const trigger = node('div', { 'aria-haspopup': 'dialog' });
  const menu = node('div', { role: 'dialog' });
  const deleteButton = node('button', { 'data-e2e': 'comment-delete' }, '削除');
  menu.append(deleteButton);
  trigger.onClick = () => documentLike.append(menu);
  deleteButton.onClick = () => { menu.remove(); item.row.remove(); };
  item.row.append(trigger);
  thread.append(parent.row, item.row);
  surface.append(thread);
  documentLike.append(surface);
  return { documentLike, surface, parent, item, trigger, menu, deleteButton };
}

test('TikTok 阶段 4 动作严格按稳定键重定位并拒绝重复更多入口', () => {
  const c = loadContext();
  const fixture = createFixture();
  const target = { contentId: '123' };
  const record = c.SocialCommentTikTokComments.toRecord(fixture.item.body, target).record;
  fixture.item.row.remove();
  const replacement = comment(2, 'guest', 'spam reply');
  replacement.row.append(node('div', { 'aria-haspopup': 'dialog' }));
  fixture.surface.children[0].append(replacement.row);
  const resolved = c.SocialCommentTikTokActions.resolveElement(record, { page: fixture.documentLike, target });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.element, replacement.row);
  replacement.row.append(node('div', { 'aria-haspopup': 'dialog' }));
  const menu = c.SocialCommentTikTokActions.revealMenu(resolved.element, { page: fixture.documentLike, target });
  return menu.then((result) => assert.equal(result.error.code, 'ambiguous'));
});

test('TikTok 阶段 4 可打开唯一菜单、识别唯一删除项并验证直接删除', async () => {
  const c = loadContext();
  const fixture = createFixture();
  const target = { contentId: '123' };
  const record = c.SocialCommentTikTokComments.toRecord(fixture.item.body, target).record;
  const context = { page: fixture.documentLike, surface: fixture.surface, target, record, wait: { until: async (predicate) => Boolean(await predicate()), delay: async () => true }, waitUntilStable: async () => ({ ok: true }) };
  const revealed = await c.SocialCommentTikTokActions.revealMenu(fixture.item.row, context);
  assert.equal(revealed.ok, true);
  const opened = await c.SocialCommentTikTokActions.getMenu(revealed.element, context);
  assert.equal(opened.ok, true);
  const deletion = c.SocialCommentTikTokActions.findDeleteAction(opened.menu);
  assert.equal(deletion.ok, true);
  const confirmed = await c.SocialCommentTikTokActions.confirmDelete(deletion.action, context);
  assert.equal(confirmed.ok, true);
  const verified = await c.SocialCommentTikTokActions.verifyDeleted(record, context);
  assert.equal(verified.ok, true);
  assert.equal(verified.deleted, true);
  assert.equal(fixture.deleteButton.clickCount, 1);
});

test('TikTok 阶段 4 缺少删除项、确认弹层重复或预览模式均安全失败', async () => {
  const c = loadContext();
  const fixture = createFixture();
  const target = { contentId: '123' };
  const record = c.SocialCommentTikTokComments.toRecord(fixture.item.body, target).record;
  const context = { page: fixture.documentLike, surface: fixture.surface, target, record, mode: 'preview', wait: { until: async (predicate) => Boolean(await predicate()) } };
  assert.equal((await c.SocialCommentTikTokActions.revealMenu(fixture.item.row, context)).error.code, 'unsupported');
  assert.equal((await c.SocialCommentTikTokActions.getMenu(fixture.item.row, context)).error.code, 'unsupported');
  const emptyMenu = node('div', { role: 'dialog' });
  assert.equal(c.SocialCommentTikTokActions.findDeleteAction(emptyMenu).error.code, 'not-found');
  const duplicateMenu = node('div', { role: 'dialog' });
  duplicateMenu.append(node('button', { 'data-e2e': 'comment-delete' }, '删除'), node('button', { 'data-e2e': 'comment-delete' }, '删除'));
  assert.equal(c.SocialCommentTikTokActions.findDeleteAction(duplicateMenu).error.code, 'ambiguous');
});

test('TikTok 阶段 4 二次确认歧义或删除验证超时都会停止在计数前', async () => {
  const c = loadContext();
  const fixture = createFixture();
  const target = { contentId: '123' };
  const record = c.SocialCommentTikTokComments.toRecord(fixture.item.body, target).record;
  fixture.deleteButton.onClick = () => {
    fixture.menu.remove();
    const confirmation = node('div', { role: 'dialog' });
    confirmation.append(node('button', { 'data-e2e': 'comment-delete' }, '删除'), node('button', { 'data-e2e': 'comment-delete' }, '删除'));
    fixture.documentLike.append(confirmation);
  };
  const context = { page: fixture.documentLike, surface: fixture.surface, target, record, wait: { until: async (predicate) => Boolean(await predicate()) }, waitUntilStable: async () => ({ ok: true }) };
  const ambiguous = await c.SocialCommentTikTokActions.confirmDelete(fixture.deleteButton, context);
  assert.equal(ambiguous.error.code, 'ambiguous');

  const timeoutFixture = createFixture();
  const timeoutRecord = c.SocialCommentTikTokComments.toRecord(timeoutFixture.item.body, target).record;
  const timedOut = await c.SocialCommentTikTokActions.verifyDeleted(timeoutRecord, {
    page: timeoutFixture.documentLike,
    surface: timeoutFixture.surface,
    target,
    wait: { until: async () => false },
    waitUntilStable: async () => ({ ok: true }),
  });
  assert.equal(timedOut.error.code, 'ambiguous');
});

test('TikTok 插件在页面模块加载后声明删除能力，且动作脚本先于插件加载', () => {
  const c = { URL, Map, Set, Array, Object, String, Boolean, Number, Error, TypeError, Promise, console };
  c.globalThis = c;
  vm.createContext(c);
  for (const file of ['src/shared/comment-types.js', 'src/platform/contract.js', 'src/platform/registry.js', 'src/platform/tiktok/identity.js', 'src/platform/tiktok/dom.js', 'src/platform/tiktok/comments.js', 'src/platform/tiktok/actions.js', 'src/platform/tiktok/plugin.js']) vm.runInContext(fs.readFileSync(path.join(process.cwd(), file), 'utf8'), c, { filename: file });
  assert.equal(c.SocialCommentPlatformRegistry.get('tiktok').capabilities.supportsCommentDelete, true);
  const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'manifest.json'), 'utf8'));
  const scripts = manifest.content_scripts.find((entry) => entry.matches.includes('https://www.tiktok.com/*')).js;
  assert.ok(scripts.indexOf('src/platform/tiktok/actions.js') < scripts.indexOf('src/platform/tiktok/plugin.js'));
});

test('TikTok 删除验证失败时核心不会增加删除数或写入 processedIds', async () => {
  const c = loadRuntimeContext();
  const record = { id: 'reply', parentId: 'root', kind: 'reply', username: 'guest', text: 'spam' };
  const plugin = {
    id: 'tiktok', displayName: 'TikTok', capabilities: { supportsReplies: true, supportsCommentDelete: true },
    identity: { normalizeTargetUrl: (value) => value, getTargetContext: (canonicalUrl) => ({ platformId: 'tiktok', canonicalUrl }) },
    preflight: { checkTarget: () => ({ ok: true }), detectLogin: () => ({ ok: true }), detectPageState: () => ({ ok: true }), checkDeletePermission: () => ({ ok: true }) },
    surface: { waitUntilStable: () => ({ ok: true, surface: {} }) },
    loader: { createPagination: () => null, cancel: () => ({ ok: true }) },
    comments: { collect: () => ({ ok: true, records: [] }), buildThreads: () => ({ ok: true, threads: [] }) },
    actions: {
      ensureReplyVisible: () => ({ ok: true }), resolveElement: () => ({ ok: true, element: {} }), revealMenu: () => ({ ok: true }), getMenu: () => ({ ok: true, menu: {} }), findDeleteAction: () => ({ ok: true, action: {} }), confirmDelete: () => ({ ok: true }), verifyDeleted: () => ({ ok: false, code: 'ambiguous', message: '删除结果无法确认。' }),
    },
    errors: { classify: (error) => error.platformError || { code: 'unknown', message: error.message }, toUserMessage: (error) => error.message || '未知错误' },
  };
  const runtime = c.SocialCommentCleanerRuntime.create({
    platform: plugin,
    settings: { deleteKeywords: 'spam', pace: { rateLimit: { perMinute: 5, perHour: 60 } } },
    transport: { send: async () => ({ ok: true }) },
    clock: { now: () => Date.now(), setInterval: () => null, clearInterval: () => {} },
  });
  assert.equal((await runtime.start({ targetUrl: 'https://www.tiktok.com/@creator/video/123', page: {} })).ok, true);
  const result = await runtime.executeCandidate(record);
  assert.equal(result.ok, false);
  assert.equal(runtime.session.stats.deleted, 0);
  assert.deepEqual([...runtime.session.processedIds], []);
});
