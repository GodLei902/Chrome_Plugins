const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadCore() {
  const context = { globalThis: null, console, Object, Array, Set, Map, String, Number, Boolean, Error, TypeError, JSON, Date, Math, AbortController, setTimeout, clearTimeout, setInterval, clearInterval };
  context.globalThis = context;
  vm.createContext(context);
  for (const file of [
    'src/shared/delay-generator.js',
    'src/shared/scheduled-rest.js',
    'src/shared/action-pace-controller.js',
    'src/platform/contract.js',
    'src/core/candidate-policy.js',
    'src/core/task-session.js',
    'src/core/wait-coordinator.js',
    'src/core/ui-model.js',
    'src/core/cleaner-runtime.js',
  ]) vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return context;
}

test('核心候选策略保持一级评论保护和回复优先', () => {
  const context = loadCore();
  const policy = context.SocialCommentCandidatePolicy;
  const result = policy.selectCandidates([{ id: 'root', username: 'visitor', text: 'spam', replies: [
    { id: 'reply-author', username: 'owner', text: 'spam', isPostAuthor: true },
    { id: 'reply-match', username: 'guest', text: 'spam' },
  ] }], policy.prepareRules({ deleteKeywords: 'spam', whitelist: '' }), { supportsReplies: true });
  assert.deepEqual(Array.from(result.candidates, (record) => record.id), ['reply-match']);
  assert.deepEqual(Array.from(result.skippedIds), ['reply-author']);
});

test('通用运行时保持父级展开、菜单、删除确认的既有节奏顺序', async () => {
  const context = loadCore();
  const events = [];
  const reply = { id: 'reply', parentId: 'root', kind: 'reply', username: 'guest', text: 'spam' };
  const root = { id: 'root', kind: 'root', username: 'owner', text: 'normal', replies: [reply] };
  const plugin = {
    id: 'fixture', displayName: 'Fixture', capabilities: { supportsReplies: true },
    identity: { normalizeTargetUrl: (value) => value, getTargetContext: (canonicalUrl) => ({ platformId: 'fixture', canonicalUrl }) },
    preflight: { detectLogin: () => ({ ok: true }), detectPageState: () => ({ ok: true }), checkTarget: () => ({ ok: true }), checkDeletePermission: () => ({ ok: true }) },
    surface: { waitUntilStable: () => ({ ok: true, surface: {} }) },
    loader: {
      expandAll: () => ({ ok: true }),
      expandParent: async (surface, element, target, actionContext) => {
        const result = await actionContext.coordinateAction('expand-replies', async () => { events.push('expand'); return true; });
        return result.ok ? { ok: true } : { ok: false, code: 'cancelled' };
      },
      createPagination: () => ({ getSnapshot: () => ({ phase: 'completed', terminalReason: 'fixture complete' }), cancel: () => {} }),
      loadNextBatch: () => ({ ok: true, progress: { status: 'completed', newIds: 0 } }),
      cancel: () => ({ ok: true }),
    },
    comments: {
      collect: () => ({ ok: true, records: [root, reply] }),
      buildThreads: () => ({ ok: true, threads: [root] }),
      nextParent: (threads, completed) => threads.find((item) => !completed.has(item.id)) || null,
      findParent: (threads) => threads[0],
    },
    actions: {
      resolveElement: () => ({ ok: true, element: {} }),
      ensureReplyVisible: () => ({ ok: true }),
      revealMenu: () => ({ ok: true }),
      getMenu: async (element, actionContext) => {
        const result = await actionContext.coordinateAction('open-comment-menu', async () => { events.push('menu'); return true; });
        return result.ok ? { ok: true, menu: {} } : { ok: false, code: 'cancelled' };
      },
      findDeleteAction: () => ({ ok: true, action: {} }),
      confirmDelete: async (action, actionContext) => {
        const result = await actionContext.coordinateAction('delete-reply', async () => { events.push('delete'); return true; });
        return result.ok ? { ok: true } : { ok: false, code: 'cancelled' };
      },
      verifyDeleted: () => ({ ok: true, deleted: true }),
    },
    errors: { classify: (error) => ({ code: 'unknown', message: error.message }), toUserMessage: (error) => error.message },
  };
  const messages = [];
  const runtime = context.SocialCommentCleanerRuntime.create({
    platform: plugin,
    settings: { deleteKeywords: 'spam', sessionLimit: 1, pace: { maxConsecutive: 20, rateLimit: { perMinute: 5, perHour: 60 } } },
    transport: { send: async (type) => { messages.push(type); return { ok: true }; } },
    delayGenerator: () => 0,
    clock: { now: () => Date.now(), setInterval: () => null, clearInterval: () => {} },
  });
  assert.equal((await runtime.start({ targetUrl: 'https://fixture.test/item/1', page: {} })).ok, true);
  await runtime.run();
  assert.deepEqual(events, ['expand', 'menu', 'delete', 'expand']);
  assert.equal(runtime.session.stats.deleted, 1);
  assert.deepEqual(messages.filter((type) => type === 'SC_RATE_ACQUIRE'), ['SC_RATE_ACQUIRE', 'SC_RATE_ACQUIRE', 'SC_RATE_ACQUIRE', 'SC_RATE_ACQUIRE']);
  assert.equal(runtime.snapshot().status, 'paused');
});

test('TaskSession 暂停会取消等待并且删除只在明确成功后计数', () => {
  const context = loadCore();
  const session = context.SocialCommentCoreTaskSession.create({ target: { platformId: 'fixture', canonicalUrl: 'https://fixture.test/item/1' } });
  session.begin('running');
  assert.equal(session.addProcessed({ id: 'reply-1' }), true);
  assert.equal(session.addProcessed({ id: 'reply-1' }), false);
  assert.equal(session.stats.deleted, 1);
  session.pause('测试暂停');
  assert.equal(session.abortController.signal.aborted, true);
  assert.equal(session.getSnapshot().status, 'paused');
});

test('WaitCoordinator 通过页面对象调用 requestAnimationFrame', async () => {
  const context = loadCore();
  vm.runInContext(`
    globalThis.frameReceiver = null;
    globalThis.requestAnimationFrame = function requestAnimationFrame(callback) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      globalThis.frameReceiver = this;
      return setTimeout(() => callback(Date.now()), 0);
    };
    globalThis.cancelAnimationFrame = function cancelAnimationFrame(frameId) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      clearTimeout(frameId);
    };
  `, context);

  const result = await context.SocialCommentWaitCoordinator.create().frame(1);
  assert.equal(result, true);
  assert.ok(context.frameReceiver);
});

test('WaitCoordinator 在等待结束后释放 AbortSignal 监听器', async () => {
  const c = loadCore();
  const controller = new AbortController();
  let added = 0;
  let removed = 0;
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => { added += 1; return add(...args); };
  controller.signal.removeEventListener = (...args) => { removed += 1; return remove(...args); };
  const wait = c.SocialCommentWaitCoordinator.create({ signal: controller.signal });
  assert.equal(await wait.delay(0), true);
  assert.equal(await wait.until(() => true, { timeoutMs: 10 }), true);
  assert.equal(added, 2);
  assert.equal(removed, 2);
});

test('CleanerRuntime 默认时钟通过页面对象续租和清理锁', () => {
  const context = loadCore();
  vm.runInContext(`
    globalThis.intervalCalls = [];
    globalThis.clearIntervalCalls = [];
    globalThis.setInterval = function setInterval(callback, delay) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      const timer = { callback, delay };
      globalThis.intervalCalls.push(timer);
      return timer;
    };
    globalThis.clearInterval = function clearInterval(timer) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      globalThis.clearIntervalCalls.push(timer);
    };
  `, context);
  const runtime = context.SocialCommentCleanerRuntime.create({
    platform: { id: 'fixture' },
    settings: {},
  });

  runtime.startLease();
  runtime.stopLease();

  assert.equal(context.intervalCalls.length, 1);
  assert.equal(context.intervalCalls[0].delay, 30000);
  assert.deepEqual(Array.from(context.clearIntervalCalls), Array.from(context.intervalCalls));
});

test('CleanerRuntime 只经插件结果更新删除统计', async () => {
  const context = loadCore();
  const calls = [];
  const plugin = {
    id: 'fixture',
    displayName: 'Fixture',
    capabilities: { supportsReplies: true, supportsPreview: true },
    identity: {
      normalizeTargetUrl: (value) => value === 'https://fixture.test/item/1' ? value : '',
      getTargetContext: (canonicalUrl) => ({ platformId: 'fixture', canonicalUrl }),
    },
    preflight: {
      detectLogin: () => ({ ok: true }),
      detectPageState: () => ({ ok: true }),
      checkTarget: () => ({ ok: true }),
      checkDeletePermission: () => ({ ok: true }),
    },
    surface: { waitUntilStable: () => ({ ok: true, surface: {} }) },
    loader: { expandAll: () => ({ ok: true }) },
    comments: {
      collect: () => ({ ok: true, records: [{ id: 'root', kind: 'root', username: 'root', text: '', replies: [] }, { id: 'reply', parentId: 'root', kind: 'reply', username: 'guest', text: 'spam' }] }),
      buildThreads: () => ({ ok: true, threads: [{ id: 'root', kind: 'root', username: 'root', replies: [{ id: 'reply', parentId: 'root', kind: 'reply', username: 'guest', text: 'spam' }] }] }),
    },
    actions: {
      resolveElement: () => ({ ok: true, element: {} }),
      ensureReplyVisible: () => ({ ok: true }),
      revealMenu: () => ({ ok: true }),
      getMenu: () => ({ ok: true, menu: {} }),
      findDeleteAction: () => ({ ok: true, action: {} }),
      confirmDelete: () => ({ ok: true }),
      verifyDeleted: () => ({ ok: true, deleted: true }),
    },
    errors: { classify: (error) => ({ code: 'unknown', message: error.message }), toUserMessage: (error) => error.message },
  };
  const runtime = context.SocialCommentCleanerRuntime.create({
    platform: plugin,
    settings: { deleteKeywords: 'spam', pace: { rateLimit: { perMinute: 5, perHour: 60 } } },
    transport: { send: async (type) => { calls.push(type); return { ok: true }; } },
  });
  assert.equal((await runtime.start({ targetUrl: 'https://fixture.test/item/1' })).ok, true);
  const scan = await runtime.scan({}, { canonicalUrl: 'https://fixture.test/item/1' });
  assert.deepEqual(Array.from(scan.candidates, (record) => record.id), ['reply']);
  assert.equal((await runtime.executeCandidate(scan.candidates[0], {}, { canonicalUrl: 'https://fixture.test/item/1' })).deleted, true);
  assert.equal(runtime.session.stats.deleted, 1);
  assert.deepEqual(calls, ['SC_ACQUIRE_LOCK', 'SC_SAVE_SESSION']);
  await runtime.stop();
});
