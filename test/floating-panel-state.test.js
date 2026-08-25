const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const context = { Math, Number, String, Boolean, Object, Array, Set, globalThis: null };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync('src/content/floating-panel-state.js', 'utf8'), context);
const panel = context.SocialCommentFloatingPanel;

test('面板初始为 launcher，打开和最小化只改变 UI 状态', () => {
  const initial = panel.createState();
  assert.equal(initial.uiMode, 'launcher');
  assert.equal(panel.transition(initial, 'open').uiMode, 'expanded');
  const minimized = panel.transition(panel.transition(initial, 'open'), 'minimize');
  assert.equal(minimized.uiMode, 'launcher');
  assert.deepEqual(minimized.launcherPosition, initial.launcherPosition);
});

test('运行中关闭需要确认，空闲关闭可直接结束', () => {
  const initial = panel.createState();
  assert.equal(panel.transition(initial, 'request-close', { taskState: 'running' }).uiMode, 'confirming-close');
  assert.equal(panel.transition(initial, 'request-close', { taskState: 'idle' }).uiMode, 'closed');
  assert.equal(panel.transition(initial, 'request-close', { taskState: 'paused' }).uiMode, 'closed');
  assert.equal(panel.transition(initial, 'cancel-close').uiMode, 'expanded');
});

test('短按不会拖动，长按位移会进入 dragging，结束后吸附到边缘且坐标受限', () => {
  assert.equal(panel.hasMoved(10, 10, 14, 14), false);
  assert.equal(panel.hasMoved(10, 10, 20, 10), true);
  const drag = panel.transition(panel.createState(), 'begin-drag', { pointerId: 3, startX: 10, startY: 10 });
  assert.equal(drag.uiMode, 'dragging');
  const position = panel.nearestEdgePosition({ centerX: 3, centerY: 300, viewportWidth: 800, viewportHeight: 600 });
  assert.equal(position.edge, 'left');
  assert.ok(position.offset >= 12);
  assert.equal(panel.nearestEdgePosition({ centerX: 797, centerY: 300, viewportWidth: 800, viewportHeight: 600 }).edge, 'right');
  assert.equal(panel.nearestEdgePosition({ centerX: 400, centerY: 3, viewportWidth: 800, viewportHeight: 600 }).edge, 'top');
  assert.equal(panel.nearestEdgePosition({ centerX: 400, centerY: 597, viewportWidth: 800, viewportHeight: 600 }).edge, 'bottom');
  const finished = panel.transition(drag, 'finish-drag', { position });
  assert.equal(finished.uiMode, 'launcher');
  assert.equal(finished.launcherPosition.edge, 'left');
  const clamped = panel.clampPosition({ edge: 'bottom', offset: 9999 }, { viewportWidth: 800, viewportHeight: 600 });
  assert.equal(clamped.edge, 'bottom');
  assert.ok(clamped.offset <= 744);
});
