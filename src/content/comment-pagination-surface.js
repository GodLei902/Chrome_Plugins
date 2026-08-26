(function (global) {
  'use strict';

  // 评论面适配器只负责发现当前页面的评论根节点、滚动容器和可见评论 ID。
  // 加载器不直接了解 Instagram 的 DOM 层级，容器被 SPA 替换后也能重新解析。
  const ROOT_SCAN_LIMIT = 2000;

  function isVisible(node) {
    if (!node || !node.isConnected) return false;
    if (typeof node.getBoundingClientRect !== 'function') return true;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function overflowY(node) {
    try {
      return global.getComputedStyle?.(node)?.overflowY || node.style?.overflowY || '';
    } catch {
      return node.style?.overflowY || '';
    }
  }

  function isScrollable(node) {
    const documentRef = global.document;
    if (!node || node === documentRef?.body || node === documentRef?.documentElement || !isVisible(node)) return false;
    const overflow = overflowY(node).toLocaleLowerCase();
    const scrollableOverflow = overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay';
    return scrollableOverflow && Number(node.scrollHeight) > Number(node.clientHeight) + 1;
  }

  function uniqueNodes(nodes) {
    return [...new Set(nodes.filter(Boolean))];
  }

  function create(options = {}) {
    const documentRef = global.document;
    const getRoot = options.getRoot || options.getSurface || (() => documentRef);
    const readIds = options.getCommentIds || (() => []);

    function resolveRoot() {
      return getRoot() || documentRef;
    }

    function getCommentIds(root = resolveRoot()) {
      return new Set((readIds(root) || []).map(String).filter(Boolean));
    }

    function rootsFor(root = resolveRoot()) {
      const roots = [root];
      for (let node = root; node && node !== documentRef?.body && node !== documentRef?.documentElement; node = node.parentElement) {
        roots.push(node.parentElement);
      }
      if (root?.querySelectorAll) {
        // 评论面通常是祖先的一个子级滚动元素，限制遍历数量避免大页面卡顿。
        roots.push(...[...root.querySelectorAll('*')].slice(0, ROOT_SCAN_LIMIT));
      }
      roots.push(documentRef);
      return uniqueNodes(roots);
    }

    function findScrollableElement(root = resolveRoot()) {
      const candidates = rootsFor(root).filter(isScrollable);
      if (!candidates.length) return null;
      const count = (node) => getCommentIds(node).size;
      return candidates.sort((left, right) => count(right) - count(left) || Number(right.scrollHeight) - Number(left.scrollHeight))[0];
    }

    function scrollToEnd(scroller) {
      return scrollToLoadPosition(scroller);
    }

    function progressAt(t, ramp = 0.18) {
      const normalized = Math.max(0, Math.min(1, Number(t) || 0));
      if (normalized <= ramp) return normalized * normalized / (2 * ramp * (1 - ramp));
      if (normalized >= 1 - ramp) {
        const remaining = 1 - normalized;
        return 1 - remaining * remaining / (2 * ramp * (1 - ramp));
      }
      return (normalized - ramp / 2) / (1 - ramp);
    }

    // 只对确认过的评论滚动容器分帧写入 scrollTop；目标在动作开始时固定，
    // 页面追加内容不会让本次动画追逐新的底部。
    function scrollToLoadPosition(scroller, options = {}) {
      if (!scroller || (!isScrollable(scroller) && Number(scroller.scrollHeight) <= Number(scroller.clientHeight))) return Promise.resolve({ ok: false, reason: '评论滚动容器不可用。' });
      const isActive = options.isActive || (() => true);
      const isCurrent = options.isCurrent || (() => true);
      const startTop = Number(scroller.scrollTop) || 0;
      const initialMaxTop = Math.max(0, Number(scroller.scrollHeight) - Number(scroller.clientHeight));
      const targetTop = Math.max(startTop, initialMaxTop);
      if (targetTop <= startTop + 1) return Promise.resolve({ ok: true, cancelled: false, startTop, targetTop, initialMaxTop, frames: 0 });
      const distance = targetTop - startTop;
      const speedPxPerSecond = Math.max(420, Math.min(720, Number(scroller.clientHeight) * 1.6));
      const durationMs = Math.max(360, Math.min(1400, distance / speedPxPerSecond * 1000));
      const frame = global.requestAnimationFrame || ((callback) => global.setTimeout(() => callback(Date.now()), 16));
      const cancelFrame = global.cancelAnimationFrame || global.clearTimeout;
      // requestAnimationFrame 的时间戳使用 performance 时间基准，不能与 Date.now() 混用。
      let startedAt = null;
      let frameId = null;
      let frames = 0;
      return new Promise((resolve) => {
        const finish = (ok, cancelled = false) => { if (frameId !== null) cancelFrame(frameId); resolve({ ok, cancelled, startTop, targetTop, initialMaxTop, durationMs, frames, actualTop: Number(scroller.scrollTop) || 0 }); };
        const tick = (timestamp) => {
          if (!isActive() || !scroller.isConnected || !isCurrent(scroller)) return finish(false, true);
          const frameTime = Number(timestamp);
          if (!Number.isFinite(startedAt)) startedAt = Number.isFinite(frameTime) ? frameTime : Date.now();
          const elapsed = Math.max(0, (Number.isFinite(frameTime) ? frameTime : Date.now()) - startedAt);
          const progress = Math.min(1, elapsed / durationMs);
          scroller.scrollTop = startTop + distance * progressAt(progress);
          frames += 1;
          if (progress >= 1) return finish(true);
          frameId = frame(tick);
        };
        frameId = frame(tick);
      });
    }

    function isAtEnd(scroller) {
      if (!scroller) return true;
      return Number(scroller.scrollTop) >= Math.max(0, Number(scroller.scrollHeight) - Number(scroller.clientHeight) - 2);
    }

    return { resolveRoot, getCommentIds, rootsFor, findScrollableElement, scrollToEnd, scrollToLoadPosition, progressAt, isAtEnd };
  }

  global.InstagramCommentPaginationSurface = { create, isVisible, isScrollable };
})(globalThis);
