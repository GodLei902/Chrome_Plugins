const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = { globalThis: {}, Math, JSON, Number, Array, Set, String, Object };
context.globalThis = context;
for (const file of ['src/shared/action-pace-config.js', 'src/shared/delay-generator.js', 'src/shared/backoff.js', 'src/shared/action-pace-controller.js', 'src/shared/rate-limiter.js', 'src/content/comment-surface-stability.js']) vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
test('延迟始终在配置范围内', () => { const config = { distribution: 'log-normal', meanSeconds: 18, minSeconds: 12, maxSeconds: 30, variability: 'high' }; for (let i = 0; i < 100; i += 1) { const value = context.InstagramCommentDelay.generateDelayMs(config); assert.ok(value >= 12000 && value <= 30000); } });
test('状态机在连续上限后休息并重置', () => { const pace = new context.InstagramCommentPaceController({ maxConsecutive: 2, backoff: { maxFailures: 3 } }); pace.begin(); assert.equal(pace.success(), 'NORMAL'); pace.begin(); assert.equal(pace.success(), 'REST'); pace.restComplete(); assert.equal(pace.consecutive, 0); assert.equal(pace.state, 'NORMAL'); });
test('限频窗口不超额且返回等待时间', () => { const limiter = new context.InstagramCommentRateLimiter(); assert.equal(limiter.acquire({ perMinute: 2, perHour: 3 }, 1000).ok, true); assert.equal(limiter.acquire({ perMinute: 2, perHour: 3 }, 1001).ok, true); const blocked = limiter.acquire({ perMinute: 2, perHour: 3 }, 1002); assert.equal(blocked.ok, false); assert.ok(blocked.retryAfterMs > 0); });
test('旧设置迁移到节奏配置', () => { const settings = context.InstagramCommentPaceConfig.normalizeSettings({ deleteDelayMin: 10, deleteDelayMax: 20, cooldownMin: 40, cooldownMax: 80, batchLimit: 4 }); assert.equal(settings.pace.operation.meanSeconds, 15); assert.equal(settings.pace.rest.meanSeconds, 60); assert.equal(settings.pace.maxConsecutive, 4); });
test('节奏默认值使用新的批次与休息边界', () => { const settings = context.InstagramCommentPaceConfig.normalizeSettings({}); assert.equal(settings.pace.maxConsecutive, 20); assert.equal(settings.pace.rest.meanSeconds, 60); assert.equal(settings.pace.rest.minSeconds, 45); assert.equal(settings.pace.rest.maxSeconds, 90); assert.equal(settings.sessionLimit, 100); });
test('删除前等待默认值使用 5 至 25 秒范围', () => { const settings = context.InstagramCommentPaceConfig.normalizeSettings({}); assert.equal(settings.pace.deleteDialogDelay.meanSeconds, 20); assert.equal(settings.pace.deleteDialogDelay.minSeconds, 5); assert.equal(settings.pace.deleteDialogDelay.maxSeconds, 25); });
test('会话删除上限支持不限', () => { const settings = context.InstagramCommentPaceConfig.validateSettings({ sessionLimit: 'unlimited' }); assert.equal(settings.sessionLimit, 'unlimited'); });
test('评论快照签名与对象遍历顺序无关', () => {
  const stability = context.InstagramCommentSurfaceStability;
  const first = stability.snapshotSignature({ surfaceGeneration: 1, connected: true, commentIds: ['2', '1'], mappedReplies: [{ id: '2', text: 'b', username: 'u' }], data: [{ id: '1', parentId: '', childCount: 0 }] });
  const second = stability.snapshotSignature({ surfaceGeneration: 1, connected: true, commentIds: ['1', '2'], mappedReplies: [{ username: 'u', text: 'b', id: '2' }], data: [{ childCount: 0, parentId: '', id: '1' }] });
  assert.equal(first, second);
});
test('容器替换或 mutation 版本变化会使快照失效', () => {
  const stability = context.InstagramCommentSurfaceStability;
  const base = { surfaceGeneration: 2, mutationVersion: 4, signature: 'same' };
  assert.equal(stability.samplesAreStable(base, { ...base }), true);
  assert.equal(stability.samplesAreStable(base, { ...base, surfaceGeneration: 3 }), false);
  assert.equal(stability.samplesAreStable(base, { ...base, mutationVersion: 5 }), false);
});
test('日文一级评论子级展开入口可被识别', () => {
  const source = fs.readFileSync('src/content/social-comment-cleaner.js', 'utf8');
  const literal = source.match(/const replyExpander = (\/.*?\/i);/s)?.[1];
  const expander = vm.runInNewContext(literal);
  assert.equal(expander.test('1件すべての返信を見る'), true);
  assert.equal(expander.test('返信をすべて見る'), true);
  assert.equal(expander.test('返信'), false);
});
test('多语言加载更多评论入口可被识别', () => {
  const source = fs.readFileSync('src/content/social-comment-cleaner.js', 'utf8');
  const literal = source.match(/const loadMoreExpander = (\/.*?\/i);/s)?.[1];
  const expander = vm.runInNewContext(literal);
  ['加载更多评论', '查看更多回复', 'View more comments', 'Load more replies', 'コメントをさらに読み込む', '返信をもっと見る'].forEach((label) => assert.equal(expander.test(label), true, label));
  assert.equal(expander.test('回复'), false);
});
test('运行时只使用 DOM，不安装接口响应观察器', () => {
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  const runtimeScripts = manifest.content_scripts.flatMap((item) => item.js || []);
  const source = fs.readFileSync('src/content/social-comment-cleaner.js', 'utf8');
  assert.equal(runtimeScripts.some((file) => file.includes('response-observer')), false);
  assert.equal(/\bfetch\b|XMLHttpRequest/.test(source), false);
  assert.match(source, /function domComments\(/);
});
