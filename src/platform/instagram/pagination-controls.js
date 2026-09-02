(function (global) {
  'use strict';

  // 控件适配器负责查找和操作“加载更多”入口；语言匹配规则由平台实现注入。
  function defaultLabel(node) {
    if (global.InstagramControlLocator?.getAccessibleLabels) return global.InstagramControlLocator.getAccessibleLabels(node).join(' ');
    const values = [node?.innerText, node?.textContent, node?.getAttribute?.('aria-label'), node?.getAttribute?.('title')];
    node?.querySelectorAll?.('[aria-label],[title]').forEach((child) => values.push(child.getAttribute('aria-label'), child.getAttribute('title')));
    return [...new Set(values.map((value) => String(value || '').replace(/\s+/g, ' ').trim()).filter(Boolean))].join(' ');
  }

  function create(options = {}) {
    const documentRef = global.document;
    const rootsFor = options.rootsFor || ((root) => [root, documentRef]);
    const getRoot = options.getRoot || options.getSurface || (() => documentRef);
    const getLabel = options.getControlLabel || defaultLabel;
    const matchesLoadMore = options.isLoadMoreControl || (() => false);
    const isVisible = options.isVisible || ((node) => {
      if (!node || !node.isConnected) return false;
      if (typeof node.getBoundingClientRect !== 'function') return true;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });

    function resolveRoot() {
      return getRoot() || documentRef;
    }

    function findLoadMore(root = resolveRoot()) {
      const controls = rootsFor(root).flatMap((candidate) => candidate?.querySelectorAll
        ? [...candidate.querySelectorAll('button,[role="button"],[aria-label],[title]')]
        : []);
      return [...new Set(controls.map((node) => node.closest?.('button,[role="button"]') || node))]
        .filter((node) => isVisible(node) && matchesLoadMore(node));
    }

    function isLoading(root = resolveRoot()) {
      if (options.findLoadingIndicator) return Boolean(options.findLoadingIndicator(root));
      const nodes = root?.querySelectorAll ? [...root.querySelectorAll('[role="progressbar"],[aria-busy="true"]')] : [];
      return nodes.some(isVisible);
    }

    function click(control) {
      if (!control || typeof control.click !== 'function') return false;
      control.click();
      return true;
    }

    return { resolveRoot, getLabel, findLoadMore, isLoading, click };
  }

  global.InstagramCommentPaginationControls = { create };
})(globalThis);
