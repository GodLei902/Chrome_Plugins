const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load() {
  const context = { globalThis: {}, Set, String, Number, Math, Object, Array };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('src/platform/instagram/reply-expansion.js', 'utf8'), context);
  return context.InstagramCommentReplyExpansion;
}

test('多个回复展开入口严格按点击后确认的顺序串行执行', async () => {
  const expansion = load();
  const events = [];
  const controls = [
    { id: 'first', isConnected: true, expanded: false, click() { events.push('click:first'); this.expanded = true; } },
    { id: 'second', isConnected: true, expanded: false, click() { events.push('click:second'); this.expanded = true; } },
  ];
  const ids = new Set();
  const runner = expansion.create({
    locator: { isExpandedReplyDisclosure: (control) => control.expanded },
    isActive: () => true,
    getRoots: () => [controls],
    getControls: () => controls,
    getCommentIds: () => ids,
    captureState: (control, beforeIds) => ({ control, ids: new Set(beforeIds) }),
    coordinateAction: async (type, action) => {
      events.push(`before:${type}`);
      const value = await action();
      events.push(`after:${type}`);
      return { ok: true, value };
    },
    waitForExpansion: async ({ control, count }) => {
      events.push(`wait:${count}`);
      ids.add(`reply-${control.id}`);
      return true;
    },
  });

  const result = await runner.expand();
  assert.deepEqual(events, [
    'before:expand-replies', 'click:first', 'after:expand-replies', 'wait:1',
    'before:expand-replies', 'click:second', 'after:expand-replies', 'wait:2',
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
});

test('展开期间页面重绘后按新的控件继续处理', async () => {
  const expansion = load();
  const events = [];
  const first = { id: 'first', isConnected: true, expanded: false, click() { events.push('click:first'); this.isConnected = false; } };
  const replacement = { id: 'replacement', isConnected: true, expanded: false, click() { events.push('click:replacement'); this.expanded = true; } };
  let controls = [first];
  const runner = expansion.create({
    locator: { isExpandedReplyDisclosure: (control) => control.expanded },
    isActive: () => true,
    getRoots: () => [controls],
    getControls: () => controls,
    getCommentIds: () => new Set(),
    captureState: (control, ids) => ({ control, ids: new Set(ids) }),
    coordinateAction: async (type, action) => ({ ok: true, value: await action() }),
    waitForExpansion: async () => { controls = [replacement]; return true; },
  });
  const result = await runner.expand();
  assert.deepEqual(events, ['click:first', 'click:replacement']);
  assert.equal(result.count, 2);
});

test('调用方可用独立状态判定保留明确的待展开入口', async () => {
  const expansion = load();
  const controls = [
    { id: 'pending', isConnected: true, click() { this.clicked = true; } },
    { id: 'expanded', isConnected: true, click() { throw new Error('不应点击已展开入口'); } },
  ];
  const runner = expansion.create({
    locator: {},
    isActive: () => true,
    getRoots: () => [controls],
    getControls: () => controls,
    isExpandedControl: (control) => control.id === 'expanded' || control.clicked === true,
    getCommentIds: () => new Set(['reply']),
    captureState: (control, ids) => ({ control, ids: new Set(ids) }),
    coordinateAction: async (type, action) => ({ ok: true, value: await action(type) }),
    waitForExpansion: async () => true,
  });

  const result = await runner.expand();
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.equal(controls[0].clicked, true);
});
