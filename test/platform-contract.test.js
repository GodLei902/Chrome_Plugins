const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const context = { URL, Map, Set, Array, Object, String, Boolean, Number, Error, TypeError, console };
context.globalThis = context;
vm.createContext(context);
for (const file of [
  'src/platform/contract.js',
  'src/platform/registry.js',
  'src/platform/instagram/identity.js',
  'src/platform/instagram/plugin.js',
]) vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });

test('Instagram 插件通过契约注册并规范化目标 URL', () => {
  const registry = context.SocialCommentPlatformRegistry;
  const plugin = registry.get('instagram');
  assert.ok(plugin);
  assert.equal(plugin.identity.normalizeTargetUrl('https://instagram.com/reel/AbC/?x=1'), 'https://www.instagram.com/reel/AbC/');
  assert.equal(registry.resolve('https://www.instagram.com/p/shortcode/').id, 'instagram');
  assert.equal(registry.resolve('https://example.com/p/shortcode/'), null);
});

test('插件能力和标准错误结果可被核心消费', () => {
  const plugin = context.SocialCommentPlatformRegistry.get('instagram');
  assert.equal(plugin.capabilities.supportsReplies, true);
  assert.equal(plugin.comments.isReply({ parentId: 'parent' }), true);
  const result = plugin.actions.confirmDelete();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'unsupported');
  assert.equal(plugin.errors.classify({ code: 'challenge', message: '需要验证' }).code, 'challenge');
  assert.equal(context.SocialCommentPlatformContract.createPlatformError('future-code', '未知错误').code, 'unknown');
});

test('Instagram 插件页面能力由独立模块提供，后台环境仍安全返回 unsupported', () => {
  const plugin = context.SocialCommentPlatformRegistry.get('instagram');
  const result = plugin.actions.confirmDelete();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'unsupported');
  assert.equal(typeof plugin.surface.waitUntilStable, 'function');
  assert.equal(typeof plugin.loader.expandAll, 'function');
});

test('已注册插件完整实现运行时所需的方法组', () => {
  const plugin = context.SocialCommentPlatformRegistry.get('instagram');
  const required = context.SocialCommentPlatformContract.REQUIRED_METHODS;
  Object.entries(required).forEach(([groupName, methods]) => {
    methods.forEach((methodName) => assert.equal(typeof plugin[groupName][methodName], 'function', `${groupName}.${methodName}`));
  });
});

test('注册中心拒绝缺少契约方法的插件', () => {
  assert.throws(() => context.SocialCommentPlatformRegistry.register({ id: 'broken', displayName: 'Broken', matches: ['https://example.com/*'] }), /缺少方法组/);
});

test('核心文件不包含平台 URL、DOM 选择器或菜单文案', () => {
  for (const file of ['src/core/cleaner-runtime.js', 'src/core/candidate-policy.js', 'src/core/task-session.js', 'src/core/wait-coordinator.js', 'src/core/ui-model.js']) {
    const source = fs.readFileSync(file, 'utf8');
    assert.equal(/instagram|tiktok|querySelector|\/c\//i.test(source), false, file);
  }
});
