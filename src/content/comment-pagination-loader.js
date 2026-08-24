(function (global) {
  'use strict';

  // 自动加载器只操作当前页面已经渲染的 DOM，不读取或重放 Instagram 接口。
  const DEFAULTS = {
    enabled: true,
    maxBatches: 20,
    noGrowthAttempts: 3,
    stableWaitMs: 800,
    waitTimeoutMs: 8000,
    allowDeletion: false,
  };

  function positive(value, fallback) {
    return Number(value) > 0 ? Math.floor(Number(value)) : fallback;
  }

  function normalizeSettings(raw) {
    const source = raw || {};
    return {
      enabled: source.enabled === true,
      maxBatches: positive(source.maxBatches, DEFAULTS.maxBatches),
      noGrowthAttempts: positive(source.noGrowthAttempts, DEFAULTS.noGrowthAttempts),
      stableWaitMs: positive(source.stableWaitMs, DEFAULTS.stableWaitMs),
      waitTimeoutMs: positive(source.waitTimeoutMs, DEFAULTS.waitTimeoutMs),
      allowDeletion: source.allowDeletion === true,
    };
  }

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
    if (!node || node === document.body || node === document.documentElement || !isVisible(node)) return false;
    const overflow = overflowY(node).toLocaleLowerCase();
    const hasScrollableOverflow = overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay';
    return hasScrollableOverflow && Number(node.scrollHeight) > Number(node.clientHeight) + 1;
  }

  function uniqueNodes(nodes) {
    return [...new Set(nodes.filter(Boolean))];
  }

  function create(options = {}) {
    const config = normalizeSettings(options.settings);
    let cancelled = false;
    const seenIds = new Set();
    const state = {
      phase: 'idle',
      batchIndex: 0,
      totalSeen: 0,
      newIds: 0,
      noGrowthAttempts: 0,
      lastScrollTop: 0,
      lastScrollHeight: 0,
      terminalReason: '',
    };

    const isActive = options.isActive || (() => !cancelled);
    const notify = () => options.onProgress?.({ ...state });
    const getSurface = () => options.getSurface?.() || document;
    const getIds = (root) => new Set((options.getCommentIds?.(root) || []).map(String).filter(Boolean));

    function rootsFor(root) {
      const roots = [root];
      for (let node = root; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
        roots.push(node.parentElement);
      }
      if (root?.querySelectorAll) {
        // 真实评论面通常是祖先的一个子级滚动元素，限制候选数量避免大页面遍历过久。
        roots.push(...[...root.querySelectorAll('*')].slice(0, 2000));
      }
      roots.push(document);
      return uniqueNodes(roots);
    }

    function findScrollableSurface(root = getSurface()) {
      const candidates = rootsFor(root).filter(isScrollable);
      if (!candidates.length) return null;
      const count = (node) => getIds(node).size;
      return candidates.sort((left, right) => count(right) - count(left) || Number(right.scrollHeight) - Number(left.scrollHeight))[0];
    }

    function controlLabel(node) {
      if (options.getControlLabel) return options.getControlLabel(node);
      const values = [node?.innerText, node?.textContent, node?.getAttribute?.('aria-label'), node?.getAttribute?.('title')];
      node?.querySelectorAll?.('[aria-label],[title]').forEach((child) => values.push(child.getAttribute('aria-label'), child.getAttribute('title')));
      return [...new Set(values.map((value) => String(value || '').replace(/\s+/g, ' ').trim()).filter(Boolean))].join(' ');
    }

    function findLoadMoreControls(root = getSurface()) {
      const controls = rootsFor(root).flatMap((candidate) => candidate?.querySelectorAll
        ? [...candidate.querySelectorAll('button,[role="button"],[aria-label],[title]')]
        : []);
      return uniqueNodes(controls.map((node) => node.closest?.('button,[role="button"]') || node))
        .filter((node) => isVisible(node) && options.isLoadMoreControl?.(node));
    }

    function findLoadingIndicator(root = getSurface()) {
      if (options.findLoadingIndicator) return Boolean(options.findLoadingIndicator(root));
      const nodes = root?.querySelectorAll ? [...root.querySelectorAll('[role="progressbar"],[aria-busy="true"]')] : [];
      return nodes.some(isVisible);
    }

    function scrollToNextBatch(scroller) {
      if (!scroller) return false;
      const targetTop = Math.max(0, Number(scroller.scrollHeight) - Number(scroller.clientHeight));
      if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ top: targetTop, behavior: 'auto' });
      else scroller.scrollTop = targetTop;
      return true;
    }

    function mergeIds(ids) {
      ids.forEach((id) => seenIds.add(String(id)));
      state.totalSeen = seenIds.size;
    }

    function hasReachedEnd(root, scroller, controls, loading) {
      if (state.batchIndex >= config.maxBatches) {
        state.terminalReason = `已达到自动加载批次上限（${config.maxBatches} 轮）。`;
        return true;
      }
      const atBottom = !scroller || Number(scroller.scrollTop) >= Math.max(0, Number(scroller.scrollHeight) - Number(scroller.clientHeight) - 2);
      if (atBottom && state.noGrowthAttempts >= config.noGrowthAttempts && !controls.length && !loading) {
        state.terminalReason = `连续 ${config.noGrowthAttempts} 次没有新增评论 ID，已到达当前页面末尾。`;
        return true;
      }
      if (!root?.isConnected && root !== document) {
        state.terminalReason = '评论容器已被页面替换，无法继续加载。';
        return true;
      }
      return false;
    }

    async function waitForGrowth(beforeIds, control, beforeLabel, root) {
      let loadingObserved = findLoadingIndicator(root);
      const predicate = () => {
        if (!isActive() || cancelled) return true;
        const current = getIds(root);
        const newId = [...current].some((id) => !beforeIds.has(id));
        const changed = control && (!control.isConnected || !isVisible(control) || controlLabel(control) !== beforeLabel);
        const loading = findLoadingIndicator(root);
        loadingObserved = loadingObserved || loading;
        return newId || changed || (loadingObserved && !loading);
      };
      if (options.waitForCondition) await options.waitForCondition(predicate, config.waitTimeoutMs, '正在等待下一批评论出现...');
      else {
        const startedAt = Date.now();
        while (isActive() && !predicate() && Date.now() - startedAt < config.waitTimeoutMs) await new Promise((resolve) => setTimeout(resolve, 120));
      }
      if (options.waitForStableSurface) await options.waitForStableSurface({ timeoutMs: config.waitTimeoutMs, requireData: false, reason: '正在等待下一批评论稳定...' });
      if (config.stableWaitMs > 0) await new Promise((resolve) => setTimeout(resolve, config.stableWaitMs));
    }

    async function nextBatch() {
      if (!config.enabled) {
        state.phase = 'completed';
        state.terminalReason = '自动加载未启用，预览只处理当前已加载评论。';
        notify();
        return { ok: false, done: true, ...state };
      }
      if (!isActive() || cancelled) return { ok: false, done: true, ...state };
      if (state.batchIndex >= config.maxBatches) {
        state.phase = 'completed';
        state.terminalReason = `已达到自动加载批次上限（${config.maxBatches} 轮）。`;
        notify();
        return { ok: false, done: true, ...state };
      }

      const root = getSurface();
      const scroller = findScrollableSurface(root);
      const beforeIds = getIds(root);
      mergeIds(beforeIds);
      const controls = findLoadMoreControls(root);
      const control = controls[0] || null;
      const beforeLabel = control ? controlLabel(control) : '';
      state.phase = control ? 'clicking-control' : 'scrolling';
      state.newIds = 0;
      state.lastScrollTop = Number(scroller?.scrollTop || 0);
      state.lastScrollHeight = Number(scroller?.scrollHeight || 0);
      notify();

      let actionTaken = false;
      if (control) {
        control.click();
        actionTaken = true;
      } else {
        actionTaken = scrollToNextBatch(scroller);
      }
      if (actionTaken) await waitForGrowth(beforeIds, control, beforeLabel, root);

      const currentRoot = getSurface();
      const afterIds = getIds(currentRoot);
      const newIds = [...afterIds].filter((id) => !beforeIds.has(id));
      const controlChanged = Boolean(control && (!control.isConnected || !isVisible(control) || controlLabel(control) !== beforeLabel));
      state.lastScrollTop = Number(scroller?.scrollTop || 0);
      state.lastScrollHeight = Number(scroller?.scrollHeight || 0);
      state.newIds = newIds.length;
      mergeIds(afterIds);
      if (newIds.length > 0) {
        state.batchIndex += 1;
        state.noGrowthAttempts = 0;
        state.phase = 'loaded';
      } else if (controlChanged) {
        // 入口状态发生变化但 DOM 尚未新增时，允许下一轮继续等待，避免把中间态判为完成。
        state.noGrowthAttempts = 0;
        state.phase = 'waiting';
      } else {
        state.noGrowthAttempts += 1;
        state.phase = 'no-growth';
      }
      const nextControls = findLoadMoreControls(currentRoot);
      const loading = findLoadingIndicator(currentRoot);
      const done = hasReachedEnd(currentRoot, scroller, nextControls, loading);
      if (done) state.phase = 'completed';
      notify();
      return { ok: !done, done, ...state, newIds: state.newIds, ids: afterIds };
    }

    function cancel(reason = '用户已取消自动加载。') {
      cancelled = true;
      state.phase = 'cancelled';
      state.terminalReason = reason;
      notify();
    }

    return { config, state, findScrollableSurface, findLoadMoreControls, hasReachedEnd, nextBatch, cancel };
  }

  global.InstagramCommentPaginationLoader = { DEFAULTS, normalizeSettings, create };
})(globalThis);
