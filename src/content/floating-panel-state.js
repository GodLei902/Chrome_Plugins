(function (global) {
  'use strict';

  // 面板状态只描述控件本身，不进入任务检查点，也不读取页面 DOM。
  const UI_MODES = Object.freeze(['launcher', 'expanded', 'dragging', 'confirming-close', 'closed']);
  const TASK_RUNNING_STATES = Object.freeze([
    'expanding', 'stabilizing', 'scanning', 'loading', 'waiting-load', 'running',
    'waiting-delete', 'cooling-down', 'scheduled-rest',
  ]);
  const EDGES = Object.freeze(['left', 'right', 'top', 'bottom']);

  function clamp(value, min, max) {
    return Math.min(Math.max(Number(value) || 0, min), Math.max(min, Number(max) || 0));
  }

  function createState(defaultOffset = 64) {
    return {
      uiMode: 'launcher',
      launcherPosition: { edge: 'right', offset: Math.max(0, Number(defaultOffset) || 0) },
      drag: {
        pointerId: null,
        startX: 0,
        startY: 0,
        startAt: 0,
        moved: false,
        timer: null,
        previousPosition: { edge: 'right', offset: Math.max(0, Number(defaultOffset) || 0) },
      },
    };
  }

  function isTaskRunningState(state) {
    return TASK_RUNNING_STATES.includes(String(state || ''));
  }

  function shouldConfirmClose(taskState) {
    return isTaskRunningState(taskState);
  }

  function transition(state, event, payload = {}) {
    const next = {
      ...state,
      launcherPosition: { ...(state.launcherPosition || {}) },
      drag: { ...(state.drag || {}) },
    };
    switch (event) {
      case 'open': next.uiMode = 'expanded'; break;
      case 'minimize': next.uiMode = 'launcher'; break;
      case 'request-close': next.uiMode = shouldConfirmClose(payload.taskState) ? 'confirming-close' : 'closed'; break;
      case 'cancel-close': next.uiMode = 'expanded'; break;
      case 'confirm-close': next.uiMode = 'closed'; break;
      case 'begin-drag':
        next.uiMode = 'dragging';
        next.drag = { ...next.drag, ...payload, moved: true };
        break;
      case 'cancel-drag':
        next.uiMode = 'launcher';
        next.drag = { ...next.drag, pointerId: null, timer: null, moved: false };
        break;
      case 'finish-drag':
        next.uiMode = 'launcher';
        next.launcherPosition = { ...payload.position };
        next.drag = { ...next.drag, pointerId: null, timer: null, moved: false, previousPosition: { ...next.launcherPosition } };
        break;
      default: break;
    }
    return next;
  }

  function hasMoved(startX, startY, x, y, threshold = 6) {
    return Math.hypot(Number(x) - Number(startX), Number(y) - Number(startY)) > Number(threshold);
  }

  function nearestEdgePosition({
    centerX, centerY, viewportWidth, viewportHeight, launcherWidth = 44, launcherHeight = 44, safeMargin = 12,
  }) {
    const width = Math.max(0, Number(viewportWidth) || 0);
    const height = Math.max(0, Number(viewportHeight) || 0);
    const x = clamp(centerX, 0, width);
    const y = clamp(centerY, 0, height);
    const distances = { left: x, right: Math.max(0, width - x), top: y, bottom: Math.max(0, height - y) };
    const edge = EDGES.reduce((nearest, candidate) => distances[candidate] < distances[nearest] ? candidate : nearest, 'right');
    const margin = Math.max(0, Number(safeMargin) || 0);
    const maxX = Math.max(margin, width - Math.max(0, Number(launcherWidth) || 0) - margin);
    const maxY = Math.max(margin, height - Math.max(0, Number(launcherHeight) || 0) - margin);
    const offset = edge === 'left' || edge === 'right'
      ? clamp(y - (Number(launcherHeight) || 0) / 2, margin, maxY)
      : clamp(x - (Number(launcherWidth) || 0) / 2, margin, maxX);
    return { edge, offset };
  }

  function clampPosition(position, { viewportWidth, viewportHeight, launcherWidth = 44, launcherHeight = 44, safeMargin = 12 } = {}) {
    const edge = EDGES.includes(position?.edge) ? position.edge : 'right';
    const width = Math.max(0, Number(viewportWidth) || 0);
    const height = Math.max(0, Number(viewportHeight) || 0);
    const margin = Math.max(0, Number(safeMargin) || 0);
    const max = edge === 'left' || edge === 'right'
      ? Math.max(margin, height - (Number(launcherHeight) || 0) - margin)
      : Math.max(margin, width - (Number(launcherWidth) || 0) - margin);
    return { edge, offset: clamp(position?.offset, margin, max) };
  }

  global.SocialCommentFloatingPanel = {
    UI_MODES,
    TASK_RUNNING_STATES,
    createState,
    transition,
    isTaskRunningState,
    shouldConfirmClose,
    hasMoved,
    nearestEdgePosition,
    clampPosition,
  };
})(globalThis);
