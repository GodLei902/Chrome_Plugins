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
      if (!scroller) return false;
      const targetTop = Math.max(0, Number(scroller.scrollHeight) - Number(scroller.clientHeight));
      if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ top: targetTop, behavior: 'auto' });
      else scroller.scrollTop = targetTop;
      return true;
    }

    function isAtEnd(scroller) {
      if (!scroller) return true;
      return Number(scroller.scrollTop) >= Math.max(0, Number(scroller.scrollHeight) - Number(scroller.clientHeight) - 2);
    }

    return { resolveRoot, getCommentIds, rootsFor, findScrollableElement, scrollToEnd, isAtEnd };
  }

  global.InstagramCommentPaginationSurface = { create, isVisible, isScrollable };
})(globalThis);
