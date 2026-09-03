const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = process.cwd();
const INSTAGRAM_SCRIPTS = [
  'src/shared/url.js', 'src/shared/delay-generator.js', 'src/shared/scheduled-rest.js', 'src/shared/task-session.js',
  'src/shared/action-pace-config.js', 'src/shared/backoff.js', 'src/shared/action-pace-controller.js', 'src/shared/rate-limiter.js',
  'src/shared/comment-types.js', 'src/shared/comment-surface-stability.js', 'src/platform/contract.js', 'src/platform/registry.js',
  'src/platform/instagram/identity.js', 'src/core/candidate-policy.js', 'src/core/task-session.js', 'src/core/wait-coordinator.js',
  'src/core/ui-model.js', 'src/core/runtime-transport.js', 'src/core/cleaner-runtime.js', 'src/core/platform-settings.js',
  'src/platform/instagram/pagination-surface.js', 'src/platform/instagram/control-labels.js', 'src/platform/instagram/control-locator.js',
  'src/platform/instagram/pagination-controls.js', 'src/platform/instagram/pagination-loader.js', 'src/platform/instagram/reply-expansion.js',
  'src/platform/instagram/surface.js', 'src/platform/instagram/comments.js', 'src/platform/instagram/loader.js',
  'src/platform/instagram/preflight.js', 'src/platform/instagram/errors.js', 'src/platform/instagram/actions.js',
  'src/platform/instagram/plugin.js', 'src/core/content-entry.js', 'src/content/floating-panel-state.js', 'src/content/cleaner-panel.js',
];

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
    console,
    ...extra,
  };
  context.globalThis = context;
  vm.createContext(context);
  return context;
}

function load(context, files) {
  files.forEach((file) => vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file }));
}

function registeredPlatform(targetUrl) {
  const context = createContext();
  load(context, ['src/platform/contract.js', 'src/platform/registry.js', 'src/platform/instagram/identity.js', 'src/platform/instagram/plugin.js', 'src/platform/tiktok/identity.js', 'src/platform/tiktok/plugin.js']);
  return {
    platform: context.SocialCommentPlatformRegistry.resolve(targetUrl),
    registry: context.SocialCommentPlatformRegistry,
  };
}

test('Manifest 保持 MV3、TikTok 最小权限和独立内容脚本链', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['storage', 'tabs', 'alarms']);
  assert.deepEqual(manifest.host_permissions, [
    'https://www.instagram.com/*',
    'https://instagram.com/*',
    'https://www.tiktok.com/*',
  ]);

  const instagram = manifest.content_scripts.find((entry) => entry.matches.includes('https://www.instagram.com/*'));
  const tiktok = manifest.content_scripts.find((entry) => entry.matches.length === 1 && entry.matches[0] === 'https://www.tiktok.com/*');
  assert.deepEqual(instagram.matches, ['https://www.instagram.com/*', 'https://instagram.com/*']);
  assert.deepEqual(instagram.js, INSTAGRAM_SCRIPTS);
  assert.equal(instagram.run_at, 'document_idle');
  assert.ok(tiktok);
  assert.equal(tiktok.js.some((file) => file.includes('/instagram/')), false);
  const pageModules = [
    'src/platform/tiktok/preflight.js',
    'src/platform/tiktok/errors.js',
    'src/platform/tiktok/dom.js',
    'src/platform/tiktok/surface.js',
    'src/platform/tiktok/comments.js',
    'src/platform/tiktok/loader.js',
    'src/platform/tiktok/actions.js',
  ];
  pageModules.forEach((file) => {
    assert.ok(tiktok.js.includes(file), file);
    assert.ok(tiktok.js.indexOf(file) < tiktok.js.indexOf('src/platform/tiktok/plugin.js'), file);
  });
  assert.ok(tiktok.js.indexOf('src/platform/tiktok/plugin.js') < tiktok.js.indexOf('src/core/content-entry.js'));
  assert.ok(tiktok.js.indexOf('src/platform/registry.js') < tiktok.js.indexOf('src/platform/tiktok/identity.js'));
});

test('后台与设置页只加载 TikTok identity/plugin，不加载页面 DOM 模块', () => {
  const background = fs.readFileSync(path.join(ROOT, 'src/background/service-worker.js'), 'utf8');
  const options = fs.readFileSync(path.join(ROOT, 'src/options/options.html'), 'utf8');
  for (const source of [background, options]) {
    assert.match(source, /platform\/tiktok\/identity\.js/);
    assert.match(source, /platform\/tiktok\/plugin\.js/);
    assert.equal(/platform\/tiktok\/(?:preflight|errors|dom|surface|comments|loader|actions)\.js/.test(source), false);
  }
});

test('后台、设置页和内容页注册中心对同一 TikTok 目标 URL 判定一致', () => {
  const targetUrl = 'https://www.tiktok.com/@Creator_1/video/1234567890123456789?lang=zh-Hans';
  const { platform, registry } = registeredPlatform(targetUrl);
  assert.equal(platform?.id, 'tiktok');
  assert.equal(platform.identity.normalizeTargetUrl(targetUrl), 'https://www.tiktok.com/@Creator_1/video/1234567890123456789');
  assert.deepEqual(JSON.parse(JSON.stringify(registry.all().map((item) => item.id))), ['instagram', 'tiktok']);
});

test('设置页保留通用节奏、关键词、白名单、限频和会话字段，并按平台规范化 URL', () => {
  const context = createContext();
  load(context, [
    'src/platform/contract.js',
    'src/platform/registry.js',
    'src/platform/instagram/identity.js',
    'src/platform/instagram/plugin.js',
    'src/platform/tiktok/identity.js',
    'src/platform/tiktok/plugin.js',
    'src/core/platform-settings.js',
  ]);
  const raw = {
    platformId: 'tiktok',
    targetUrl: 'https://www.tiktok.com/@creator/video/1234567890123456789?from=copy',
    whitelist: '@safe',
    deleteKeywords: 'spam',
    sessionLimit: '30',
    sessionMaxMinutes: '15',
    pace: { operation: { meanSeconds: 18 }, rateLimit: { perMinute: 5, perHour: 60 } },
    platformOptions: { keep: true },
  };
  const settings = context.SocialCommentPlatformSettings.normalize(raw, { preferPlatformId: true });
  assert.equal(settings.platformId, 'tiktok');
  assert.equal(settings.targetUrl, 'https://www.tiktok.com/@creator/video/1234567890123456789');
  assert.equal(settings.whitelist, '@safe');
  assert.equal(settings.deleteKeywords, 'spam');
  assert.equal(settings.sessionLimit, '30');
  assert.equal(settings.sessionMaxMinutes, '15');
  assert.deepEqual(JSON.parse(JSON.stringify(settings.platformOptions)), { keep: true });
});

test('用户可见文案使用双平台中性说明，并明确 Preview、权限和测试账号边界', () => {
  const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
  const readme = read('README.md');
  const handbook = read('doc/运营人员操作手册.md');
  const options = read('src/options/options.html');
  assert.match(readme, /Instagram、TikTok/);
  assert.match(readme, /Preview/);
  assert.match(readme, /测试账号/);
  assert.match(readme, /https:\/\/www\.tiktok\.com\/@<creator>\/video\/<id>/);
  assert.match(handbook, /Instagram 或 TikTok/);
  assert.match(handbook, /测试账号和本人可管理的作品/);
  assert.match(options, /请先选择平台/);
  assert.match(options, /所选平台/);
  assert.doesNotMatch(readme, /当前支持：Instagram/);
  assert.doesNotMatch(readme, /当前仍只支持 Instagram/);
});
