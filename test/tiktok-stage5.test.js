const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(tag = 'div', attrs = {}, text = '') { this.tagName = tag.toUpperCase(); this.attrs = { ...attrs }; this.children = []; this.parentElement = null; this.ownerDocument = null; this.isConnected = true; this.text = text; this.style = {}; this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0; this.onClick = null; this.clickCount = 0; }
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
  getBoundingClientRect() { return this.isConnected ? { width: 20, height: 12, left: 0, top: 0 } : { width: 0, height: 0 }; }
  click() { this.clickCount += 1; this.onClick?.(); }
  scrollTo({ top } = {}) { this.scrollTop = Number(top) || 0; this.onScroll?.(); }
}

class FixtureDocument extends Element {
  constructor() { super('document'); this.ownerDocument = this; this.location = { href: 'https://www.tiktok.com/@creator/video/123' }; this.defaultView = { getComputedStyle: () => ({ display: 'block', visibility: 'visible', overflowY: 'visible' }) }; }
}

function node(tag, attrs = {}, text = '') { return new Element(tag, attrs, text); }
function comment(level, author, text) { const row = node('div'); const user = node('div', { 'data-e2e': `comment-username-${level}` }); user.append(node('a', { href: `/@${author}` }, author)); const body = node('span', { 'data-e2e': `comment-level-${level}` }, text); row.append(user, body); return row; }
function load(files) { const context = { URL, Map, Set, Array, Object, String, Boolean, Number, Error, TypeError, Date, Math, Promise, AbortController, setTimeout, clearTimeout, console }; context.globalThis = context; vm.createContext(context); files.forEach((file) => vm.runInContext(fs.readFileSync(path.join(process.cwd(), file), 'utf8'), context, { filename: file })); return context; }
function loaderContext() { return load(['src/shared/comment-types.js', 'src/platform/contract.js', 'src/platform/tiktok/dom.js', 'src/platform/tiktok/comments.js', 'src/platform/tiktok/surface.js', 'src/platform/tiktok/loader.js']); }
function runtimeContext() { return load(['src/shared/delay-generator.js', 'src/shared/scheduled-rest.js', 'src/shared/task-session.js', 'src/shared/action-pace-controller.js', 'src/platform/contract.js', 'src/core/candidate-policy.js', 'src/core/task-session.js', 'src/core/wait-coordinator.js', 'src/core/ui-model.js', 'src/core/cleaner-runtime.js']); }

function makeSurface(documentLike, rows = []) {
  const surface = node('div');
  rows.forEach((row) => surface.append(row));
  surface.style.overflowY = 'auto';
  surface.scrollHeight = 1000;
  surface.clientHeight = 200;
  documentLike.append(surface);
  return surface;
}

test('TikTok 分页优先点击唯一页面级加载入口，并只以新增稳定键报告 loaded', async () => {
  const c = loaderContext();
  const page = new FixtureDocument();
  const surface = makeSurface(page, [comment(1, 'guest', 'first')]);
  const control = node('button', {}, '加载更多评论');
  surface.append(control);
  control.onClick = () => { surface.append(comment(1, 'guest', 'second')); control.remove(); };
  const pagination = c.SocialCommentTikTokLoader.createPagination(surface, { waitTimeoutMs: 50 }, { page, wait: { until: async (predicate) => Boolean(await predicate()) }, waitUntilStable: async ({ surface: current } = {}) => ({ ok: true, surface: current || surface }) });
  const result = await pagination.nextBatch(surface, { contentId: '123' });
  assert.equal(result.status, 'loaded');
  assert.equal(result.newIds, 1);
  assert.equal(control.clickCount, 1);
});

test('TikTok 分页识别评论滚动容器并在容器替换后重新发现', async () => {
  const c = loaderContext();
  const page = new FixtureDocument();
  const first = makeSurface(page, [comment(1, 'guest', 'first')]);
  first.onScroll = () => { const replacement = makeSurface(page, [comment(1, 'guest', 'first'), comment(1, 'guest', 'second')]); first.remove(); replacement.style.overflowY = 'auto'; replacement.scrollHeight = 1200; replacement.clientHeight = 200; };
  const wait = { until: async (predicate) => Boolean(await predicate()), delay: async () => true };
  const pagination = c.SocialCommentTikTokLoader.createPagination(first, { waitTimeoutMs: 50 }, { page, wait, waitUntilStable: async ({ surface } = {}) => ({ ok: true, surface: surface || c.SocialCommentTikTokSurface.findCommentSurface(page).surface }) });
  const result = await pagination.nextBatch(first, { contentId: '123' });
  assert.equal(result.status, 'loaded');
  assert.equal(result.newIds, 1);
});

test('TikTok 分页连续无增长且无入口、已到末尾并且没有待展开回复时完成', async () => {
  const c = loaderContext();
  const page = new FixtureDocument();
  const surface = makeSurface(page, [comment(1, 'guest', 'first')]);
  surface.scrollTop = 0;
  surface.scrollHeight = 1000;
  surface.clientHeight = 200;
  const wait = { until: async (predicate) => Boolean(await predicate()), delay: async () => true };
  const pagination = c.SocialCommentTikTokLoader.createPagination(surface, { noGrowthAttempts: 2, waitTimeoutMs: 20 }, { page, wait, waitUntilStable: async ({ surface: current } = {}) => ({ ok: true, surface: current || surface }) });
  const first = await pagination.nextBatch(surface, { contentId: '123' });
  assert.equal(first.status, 'no-growth');
  const second = await pagination.nextBatch(surface, { contentId: '123' });
  assert.equal(second.status, 'completed');
  assert.match(second.terminalReason, /没有新增评论/);
});

test('TikTok 分页存在未展开回复时不提前完成，取消会立即结束等待', async () => {
  const c = loaderContext();
  const page = new FixtureDocument();
  const surface = makeSurface(page, [comment(1, 'guest', 'first')]);
  surface.scrollTop = 0;
  surface.scrollHeight = 1000;
  surface.clientHeight = 200;
  surface.append(node('button', {}, '1件の回复を显示'));
  const controller = new AbortController();
  let resolveWait;
  const wait = { until: () => new Promise((resolve) => { resolveWait = resolve; }), delay: async () => true };
  const pagination = c.SocialCommentTikTokLoader.createPagination(surface, {}, { page, signal: controller.signal, wait, waitUntilStable: async ({ surface: current } = {}) => ({ ok: true, surface: current || surface }) });
  const pending = pagination.nextBatch(surface, { contentId: '123' });
  controller.abort();
  resolveWait?.(false);
  const result = await pending;
  assert.equal(result.status, 'cancelled');
});

test('TikTok 分页拒绝重复入口，插件声明自动加载并保留页面模块加载顺序', async () => {
  const c = loaderContext();
  const page = new FixtureDocument();
  const surface = makeSurface(page, [comment(1, 'guest', 'first')]);
  surface.append(node('button', {}, '加载更多评论'), node('button', {}, '加载更多评论'));
  const pagination = c.SocialCommentTikTokLoader.createPagination(surface, {}, { page });
  const result = await pagination.nextBatch(surface, { contentId: '123' });
  assert.equal(result.status, 'paused');
  assert.equal(result.errorCode, 'ambiguous');
  const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'manifest.json'), 'utf8'));
  const scripts = manifest.content_scripts.find((entry) => entry.matches.includes('https://www.tiktok.com/*')).js;
  assert.ok(scripts.indexOf('src/platform/tiktok/loader.js') < scripts.indexOf('src/platform/tiktok/plugin.js'));
});

test('TikTok 分页不会把普通“加载”文案或评论正文误识别为分页入口', () => {
  const c = loaderContext();
  const page = new FixtureDocument();
  const surface = makeSurface(page, [comment(1, 'guest', '查看更多')]);
  surface.append(node('button', {}, '加载'), node('button', {}, '查看更多评论'));
  const controls = c.SocialCommentTikTokLoader.findLoadMoreControls(surface);
  assert.equal(controls.length, 1);
  assert.equal(controls[0].textContent, '查看更多评论');
});

test('TikTok 分页不会把单个评论线程内的“查看更多评论”作为页面级入口', () => {
  const c = loaderContext();
  const page = new FixtureDocument();
  const thread = node('div');
  thread.append(comment(1, 'guest', 'root'), comment(2, 'reply', 'nested'), node('button', {}, '查看更多评论'));
  const surface = makeSurface(page, [thread]);
  assert.equal(c.SocialCommentTikTokLoader.findLoadMoreControls(surface).length, 0);
});

test('TikTok 分页 cancel 会释放本地等待并立即返回 cancelled', async () => {
  const c = loaderContext();
  const page = new FixtureDocument();
  const surface = makeSurface(page, [comment(1, 'guest', 'first')]);
  surface.style.overflowY = 'auto';
  surface.scrollHeight = 1000;
  surface.clientHeight = 200;
  let waiting;
  const pagination = c.SocialCommentTikTokLoader.createPagination(surface, {}, { page, wait: { until: () => new Promise((resolve) => { waiting = resolve; }) } });
  const pending = pagination.nextBatch(surface, { contentId: '123' });
  pagination.cancel('测试取消');
  waiting?.(false);
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.match(pagination.getSnapshot().terminalReason, /已取消|测试取消/);
});

test('TikTok 分页完成由通用运行时安排休息、保存检查点和刷新，不由插件调度', async () => {
  const c = runtimeContext();
  const refreshMessages = [];
  const plugin = {
    id: 'tiktok', displayName: 'TikTok', capabilities: { supportsReplies: true, supportsAutoLoad: true, supportsCommentDelete: true },
    identity: { normalizeTargetUrl: (value) => value, getTargetContext: (canonicalUrl) => ({ platformId: 'tiktok', canonicalUrl }) },
    preflight: { checkTarget: () => ({ ok: true }), detectPageState: () => ({ ok: true }) },
    surface: { waitUntilStable: () => ({ ok: true, surface: {} }) },
    loader: {
      createPagination: () => ({ getSnapshot: () => ({ phase: 'completed', newIds: 0, terminalReason: 'fixture complete' }), cancel: () => {} }),
      loadNextBatch: () => ({ ok: true, progress: { status: 'completed', newIds: 0 } }),
      cancel: () => ({ ok: true }),
    },
    comments: { collect: () => ({ ok: true, records: [] }), buildThreads: () => ({ ok: true, threads: [] }), nextParent: () => null },
    actions: {},
    errors: { classify: (error) => error.platformError || { code: 'unknown', message: error.message }, toUserMessage: (error) => error.message || '未知错误' },
  };
  const runtime = c.SocialCommentCleanerRuntime.create({
    platform: plugin,
    settings: { deleteKeywords: 'spam', pace: { refreshRest: { minMinutes: 10, maxMinutes: 10 } } },
    transport: { send: async (type, payload) => { refreshMessages.push({ type, payload }); return { ok: true }; } },
    clock: { now: () => 1000, setInterval: () => null, clearInterval: () => {} },
  });
  assert.equal((await runtime.start({ targetUrl: 'https://www.tiktok.com/@creator/video/123', page: {} })).ok, true);
  const result = await runtime.run();
  assert.equal(result.ok, true);
  assert.equal(runtime.snapshot().status, 'scheduled-rest');
  assert.ok(refreshMessages.some((message) => message.type === 'SC_SAVE_SESSION' && message.payload.snapshot.status === 'scheduled-rest'));
  assert.ok(refreshMessages.some((message) => message.type === 'SC_SCHEDULE_REFRESH' && message.payload.platformId === 'tiktok'));
});
