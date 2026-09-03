const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = process.cwd();

function createContext(extra = {}) {
  const context = {
    URL,
    Map,
    Set,
    Array,
    Object,
    String,
    Boolean,
    Number,
    Error,
    TypeError,
    JSON,
    Date,
    Math,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    ...extra,
  };
  context.globalThis = context;
  vm.createContext(context);
  return context;
}

function load(context, files) {
  for (const file of files) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
  }
}

function loadTikTokPlugin({ pageModules = true } = {}) {
  const context = createContext();
  load(context, [
    'src/platform/contract.js',
    'src/platform/registry.js',
    'src/platform/tiktok/identity.js',
    ...(pageModules ? ['src/platform/tiktok/preflight.js', 'src/platform/tiktok/errors.js'] : []),
    'src/platform/tiktok/plugin.js',
  ]);
  return context;
}

test('TikTok 身份模块只接受完整 www 作品 URL 并清除查询参数', () => {
  const context = loadTikTokPlugin();
  const identity = context.SocialCommentTikTokIdentity;
  const raw = 'https://www.tiktok.com/@Creator_1/video/1234567890123456789?lang=zh-Hans#comment';
  const canonical = 'https://www.tiktok.com/@Creator_1/video/1234567890123456789';

  assert.equal(identity.normalizeTargetUrl(raw), canonical);
  assert.equal(identity.matchesPage({ href: raw }), true);
  assert.deepEqual(
    { ...identity.getTargetContext(raw) },
    {
      platformId: 'tiktok',
      canonicalUrl: canonical,
      contentId: '1234567890123456789',
      contentType: 'video',
      creatorHandle: 'Creator_1',
      host: 'www.tiktok.com',
    },
  );
  for (const invalid of [
    'http://www.tiktok.com/@creator/video/1234567890123456789',
    'https://tiktok.com/@creator/video/1234567890123456789',
    'https://vm.tiktok.com/abc123/',
    'https://www.tiktok.com/@creator',
    'https://www.tiktok.com/@creator/video/not-a-video-id',
  ]) assert.equal(identity.normalizeTargetUrl(invalid), '', invalid);
});

test('TikTok 插件完整注册，阶段 1 未实现能力统一返回 unsupported', () => {
  const context = loadTikTokPlugin();
  const plugin = context.SocialCommentPlatformRegistry.get('tiktok');
  const required = context.SocialCommentPlatformContract.REQUIRED_METHODS;

  assert.ok(plugin);
  assert.equal(context.SocialCommentPlatformRegistry.resolve('https://www.tiktok.com/@creator/video/1234567890123456789').id, 'tiktok');
  assert.equal(plugin.displayName, 'TikTok');
  assert.equal(plugin.targetPlaceholder, 'https://www.tiktok.com/@creator/video/1234567890123456789');
  assert.equal(plugin.capabilities.supportsCommentDelete, false);
  assert.equal(plugin.capabilities.supportsPreview, false);
  Object.entries(required).forEach(([groupName, methods]) => {
    methods.forEach((methodName) => assert.equal(typeof plugin[groupName][methodName], 'function', `${groupName}.${methodName}`));
  });
  for (const result of [
    plugin.surface.findCommentSurface(),
    plugin.loader.expandParent(),
    plugin.comments.collect(),
    plugin.actions.confirmDelete(),
    plugin.preflight.checkDeletePermission(),
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'unsupported');
  }
});

test('TikTok 预检严格匹配目标并分类登录、挑战、限流和错误页', () => {
  const context = loadTikTokPlugin();
  const plugin = context.SocialCommentPlatformRegistry.get('tiktok');
  const canonical = 'https://www.tiktok.com/@creator/video/1234567890123456789';
  const page = { location: { href: canonical }, body: { innerText: '' } };

  assert.equal(plugin.preflight.checkTarget(page, { canonicalUrl: canonical }).ok, true);
  assert.equal(plugin.preflight.checkTarget(page, { canonicalUrl: 'https://www.tiktok.com/@other/video/1234567890123456789' }).error.code, 'ambiguous');
  assert.equal(plugin.preflight.detectPageState({ body: { innerText: 'Log in to TikTok' } }).error.code, 'permission');
  assert.equal(plugin.preflight.detectPageState({ body: { innerText: 'Complete the security check' } }).error.code, 'challenge');
  assert.equal(plugin.preflight.detectPageState({ body: { innerText: 'Too many requests, try again later' } }).error.code, 'rate-limited');
  assert.equal(plugin.preflight.detectPageState({ body: { innerText: 'Video unavailable' } }).error.code, 'not-found');
  assert.equal(plugin.errors.classify({ code: 'challenge', message: '需要验证' }).code, 'challenge');
  assert.equal(plugin.errors.toUserMessage({ code: 'unsupported' }), '当前 TikTok 能力尚未实现，任务已暂停。');
});

test('后台和设置页只加载 TikTok identity/plugin，且对同一目标作一致路由', async () => {
  let messageHandler;
  const createdTabs = [];
  const sentMessages = [];
  const chrome = {
    runtime: {
      lastError: null,
      onInstalled: { addListener() {} },
      onMessage: { addListener(handler) { messageHandler = handler; } },
    },
    alarms: { onAlarm: { addListener() {} } },
    tabs: {
      query: async () => [],
      create: async (options) => { createdTabs.push(options); return { id: 1, status: 'complete', url: options.url }; },
      get: async () => ({ id: 1, status: 'complete' }),
      sendMessage: async (tabId, message) => { sentMessages.push({ tabId, message }); return { ok: true }; },
    },
  };
  const context = createContext({ chrome });
  context.importScripts = (...files) => load(context, files.map((file) => path.normalize(path.join('src/background', file))));
  load(context, ['src/background/service-worker.js', 'src/core/platform-settings.js', 'src/options/platform-form.js']);
  const raw = 'https://www.tiktok.com/@creator/video/1234567890123456789?is_copy_url=1';
  const canonical = 'https://www.tiktok.com/@creator/video/1234567890123456789';
  const settings = context.SocialCommentPlatformForm.normalize({ platformId: 'instagram', targetUrl: raw });

  assert.equal(context.SocialCommentPlatformRegistry.resolve(raw).id, 'tiktok');
  assert.equal(settings.platformId, 'tiktok');
  assert.equal(settings.targetUrl, canonical);
  assert.equal(context.SocialCommentPlatformForm.applyMetadata(null, settings).placeholder, 'https://www.tiktok.com/@creator/video/1234567890123456789');
  const response = await new Promise((resolve) => {
    assert.equal(messageHandler({ type: 'SC_LAUNCH', platformId: 'tiktok', canonicalTargetUrl: raw, mode: 'preview' }, {}, resolve), true);
  });
  assert.equal(response.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(createdTabs)), [{ active: true, url: canonical }]);
  assert.deepEqual(JSON.parse(JSON.stringify(sentMessages)), [{ tabId: 1, message: { type: 'SC_PREVIEW', platformId: 'tiktok', canonicalTargetUrl: canonical } }]);
});

test('TikTok 内容脚本链不加载 Instagram 页面模块，Preview 与 Start 均安全暂停', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const tiktokScript = manifest.content_scripts.find((entry) => entry.matches.length === 1 && entry.matches[0] === 'https://www.tiktok.com/*');
  assert.ok(manifest.host_permissions.includes('https://www.tiktok.com/*'));
  assert.ok(tiktokScript);
  assert.equal(tiktokScript.js.some((file) => file.includes('/instagram/')), false);
  for (const file of ['src/platform/tiktok/identity.js', 'src/platform/tiktok/preflight.js', 'src/platform/tiktok/errors.js', 'src/platform/tiktok/plugin.js', 'src/core/content-entry.js', 'src/content/cleaner-panel.js']) assert.ok(tiktokScript.js.includes(file), file);
  assert.ok(tiktokScript.js.indexOf('src/platform/tiktok/identity.js') < tiktokScript.js.indexOf('src/platform/tiktok/preflight.js'));
  assert.ok(tiktokScript.js.indexOf('src/platform/tiktok/preflight.js') < tiktokScript.js.indexOf('src/platform/tiktok/plugin.js'));
  assert.ok(tiktokScript.js.indexOf('src/platform/tiktok/plugin.js') < tiktokScript.js.indexOf('src/core/content-entry.js'));
  const background = fs.readFileSync(path.join(ROOT, 'src/background/service-worker.js'), 'utf8');
  const options = fs.readFileSync(path.join(ROOT, 'src/options/options.html'), 'utf8');
  assert.match(background, /platform\/tiktok\/identity\.js/);
  assert.match(background, /platform\/tiktok\/plugin\.js/);
  assert.equal(/platform\/tiktok\/(?:preflight|errors|surface|comments|loader|actions)\.js/.test(background), false);
  assert.match(options, /platform\/tiktok\/identity\.js/);
  assert.match(options, /platform\/tiktok\/plugin\.js/);

  const context = createContext();
  load(context, [
    'src/shared/delay-generator.js',
    'src/shared/scheduled-rest.js',
    'src/shared/action-pace-controller.js',
    'src/platform/contract.js',
    'src/platform/registry.js',
    'src/platform/tiktok/identity.js',
    'src/platform/tiktok/preflight.js',
    'src/platform/tiktok/errors.js',
    'src/platform/tiktok/plugin.js',
    'src/core/candidate-policy.js',
    'src/core/task-session.js',
    'src/core/wait-coordinator.js',
    'src/core/ui-model.js',
    'src/core/cleaner-runtime.js',
  ]);
  const plugin = context.SocialCommentPlatformRegistry.get('tiktok');
  const page = { location: { href: 'https://www.tiktok.com/@creator/video/1234567890123456789' }, body: { innerText: '' } };

  for (const mode of ['preview', 'run']) {
    const sent = [];
    const runtime = context.SocialCommentCleanerRuntime.create({
      platform: plugin,
      settings: { deleteKeywords: 'spam', pace: { rateLimit: { perMinute: 5, perHour: 60 } } },
      transport: { send: async (type) => { sent.push(type); return { ok: true }; } },
      clock: { now: () => Date.now(), setInterval: () => null, clearInterval: () => {} },
    });
    assert.equal((await runtime.start({ mode, targetUrl: page.location.href, page })).ok, true);
    const result = await runtime.run();
    assert.equal(result.ok, false);
    assert.equal(runtime.snapshot().status, 'paused');
    assert.match(runtime.snapshot().error, /TikTok 能力尚未实现：waitUntilStable/);
    assert.equal(sent.includes('SC_RATE_ACQUIRE'), false);
  }
});

test('设置页平台选择由注册中心生成，并按显式选择更新目标字段元数据', () => {
  const options = [];
  const select = {
    value: '',
    replaceChildren() { options.splice(0); },
    append(option) { options.push(option); },
  };
  const documentLike = { createElement() { return { value: '', textContent: '' }; } };
  const context = createContext({ document: documentLike });
  load(context, [
    'src/platform/contract.js',
    'src/platform/registry.js',
    'src/platform/instagram/identity.js',
    'src/platform/instagram/plugin.js',
    'src/platform/tiktok/identity.js',
    'src/platform/tiktok/plugin.js',
    'src/core/platform-settings.js',
    'src/options/platform-form.js',
  ]);

  context.SocialCommentPlatformForm.renderPlatformOptions(select, 'tiktok');
  assert.deepEqual(options.map((option) => ({ value: option.value, textContent: option.textContent })), [
    { value: 'instagram', textContent: 'Instagram' },
    { value: 'tiktok', textContent: 'TikTok' },
  ]);
  assert.equal(select.value, 'tiktok');
  assert.equal(context.SocialCommentPlatformForm.applyMetadata(null, { platformId: 'tiktok' }).placeholder, 'https://www.tiktok.com/@creator/video/1234567890123456789');

  const oldInstagramUrl = 'https://www.instagram.com/p/example/';
  const selectedTikTok = context.SocialCommentPlatformSettings.normalize(
    { platformId: 'tiktok', targetUrl: oldInstagramUrl },
    { preferPlatformId: true },
  );
  assert.equal(selectedTikTok.platformId, 'tiktok');
  assert.equal(selectedTikTok.targetUrl, oldInstagramUrl);
  assert.throws(
    () => context.SocialCommentPlatformSettings.validateTarget(selectedTikTok, { required: true, preferPlatformId: true }),
    /请输入 TikTok 目标页面的完整 URL/,
  );
});
