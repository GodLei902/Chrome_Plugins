(function (global) {
  'use strict';

  // 加载器只维护批次状态和终止条件，页面 DOM 操作通过 surface/controls 适配器完成。
  const DEFAULTS = global.InstagramCommentPaceConfig?.DEFAULTS?.pagination || {
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
      enabled: source.enabled !== false,
      maxBatches: positive(source.maxBatches, DEFAULTS.maxBatches),
      noGrowthAttempts: positive(source.noGrowthAttempts, DEFAULTS.noGrowthAttempts),
      stableWaitMs: positive(source.stableWaitMs, DEFAULTS.stableWaitMs),
      waitTimeoutMs: positive(source.waitTimeoutMs, DEFAULTS.waitTimeoutMs),
      // 正式删除仍由主流程的独立安全开关控制，加载器不执行删除动作。
      allowDeletion: source.allowDeletion === true,
    };
  }

  function createLegacySurface(options) {
    const documentRef = global.document;
    const getRoot = options.getSurface || (() => documentRef);
    const getCommentIds = (root) => new Set((options.getCommentIds?.(root) || []).map(String).filter(Boolean));
    const rootsFor = (root) => [root, documentRef].filter(Boolean);
    return {
      resolveRoot: () => getRoot() || documentRef,
      getCommentIds,
      rootsFor,
      findScrollableElement: () => null,
      scrollToEnd: () => false,
      isAtEnd: () => true,
    };
  }

  function createLegacyControls(options, surface) {
    return {
      resolveRoot: () => surface.resolveRoot(),
      getLabel: options.getControlLabel || (() => ''),
      findLoadMore: () => [],
      isLoading: (root) => Boolean(options.findLoadingIndicator?.(root)),
      click: (control) => { control?.click?.(); return Boolean(control); },
    };
  }

  function create(options = {}) {
    const config = Object.freeze(normalizeSettings(options.settings));
    const surface = options.surface
      || global.InstagramCommentPaginationSurface?.create({ getRoot: options.getSurface, getCommentIds: options.getCommentIds });
    const resolvedSurface = surface || createLegacySurface(options);
    const controls = options.controls
      || global.InstagramCommentPaginationControls?.create({
        getRoot: () => resolvedSurface.resolveRoot(),
        rootsFor: resolvedSurface.rootsFor,
        getControlLabel: options.getControlLabel,
        isLoadMoreControl: options.isLoadMoreControl,
        findLoadingIndicator: options.findLoadingIndicator,
      });
    const resolvedControls = controls || createLegacyControls(options, resolvedSurface);
    let cancelled = false;
    let pendingWait = null;
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
    const snapshot = () => Object.freeze({ ...state });
    const notify = () => options.onProgress?.(snapshot());

    function result(status, extra = {}) {
      const current = snapshot();
      return {
        ok: status === 'loaded' || status === 'no-growth',
        done: ['completed', 'cancelled', 'paused'].includes(status),
        status,
        ...current,
        ...extra,
      };
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
      if (resolvedSurface.isAtEnd(scroller) && state.noGrowthAttempts >= config.noGrowthAttempts && !controls.length && !loading) {
        state.terminalReason = `连续 ${config.noGrowthAttempts} 次没有新增评论 ID，已到达当前页面末尾。`;
        return true;
      }
      if (!root?.isConnected && root !== global.document) {
        state.terminalReason = '评论容器已被页面替换，无法继续加载。';
        return true;
      }
      return false;
    }

    function waitForValue(executor) {
      return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          if (pendingWait?.finish === finish) pendingWait = null;
          resolve(value);
        };
        pendingWait = { finish };
        executor(finish);
      });
    }

    function waitUntil(predicate, timeoutMs) {
      return waitForValue((finish) => {
        const startedAt = Date.now();
        let timer = null;
        const check = () => {
          if (!isActive() || cancelled) return finish(false);
          let matched = false;
          try { matched = Boolean(predicate()); } catch { matched = false; }
          if (matched || Date.now() - startedAt >= timeoutMs) return finish(matched);
          timer = setTimeout(check, 120);
        };
        // 使用分页自己的计时器，避免覆盖扫描/删除流程的 run.timer。
        pendingWait = { finish: (value) => { clearTimeout(timer); finish(value); } };
        check();
      });
    }

    function sleep(ms) {
      if (ms <= 0 || !isActive() || cancelled) return Promise.resolve(false);
      return waitForValue((finish) => {
        const timer = setTimeout(() => finish(isActive() && !cancelled), ms);
        pendingWait = { finish: (value) => { clearTimeout(timer); finish(value); } };
      });
    }

    async function waitForGrowth(beforeIds, control, beforeLabel) {
      let loadingObserved = resolvedControls.isLoading(resolvedSurface.resolveRoot());
      await waitUntil(() => {
        const currentRoot = resolvedSurface.resolveRoot();
        const currentIds = resolvedSurface.getCommentIds(currentRoot);
        const newId = [...currentIds].some((id) => !beforeIds.has(id));
        const visible = global.InstagramCommentPaginationSurface?.isVisible;
        const changed = control && (!control.isConnected || !(visible ? visible(control) : true) || resolvedControls.getLabel(control) !== beforeLabel);
        const loading = resolvedControls.isLoading(currentRoot);
        loadingObserved = loadingObserved || loading;
        return newId || changed || (loadingObserved && !loading);
      }, config.waitTimeoutMs);
      if (!isActive() || cancelled) return false;
      if (options.waiter?.untilStable) await options.waiter.untilStable({ timeoutMs: config.waitTimeoutMs, reason: '正在等待下一批评论稳定...' });
      else if (options.waitForStableSurface) await options.waitForStableSurface({ timeoutMs: config.waitTimeoutMs, requireData: false, reason: '正在等待下一批评论稳定...' });
      if (!isActive() || cancelled) return false;
      await sleep(config.stableWaitMs);
      return isActive() && !cancelled;
    }

    async function nextBatch() {
      if (!config.enabled) {
        state.phase = 'completed';
        state.terminalReason = '自动加载未启用，预览只处理当前已加载评论。';
        notify();
        return result('completed');
      }
      if (!isActive() || cancelled) return result(state.phase === 'paused' ? 'paused' : 'cancelled');
      if (state.batchIndex >= config.maxBatches) {
        state.phase = 'completed';
        state.terminalReason = `已达到自动加载批次上限（${config.maxBatches} 轮）。`;
        notify();
        return result('completed');
      }

      const root = resolvedSurface.resolveRoot();
      const scroller = resolvedSurface.findScrollableElement(root);
      const beforeIds = resolvedSurface.getCommentIds(root);
      mergeIds(beforeIds);
      const control = resolvedControls.findLoadMore(root)[0] || null;
      const beforeLabel = control ? resolvedControls.getLabel(control) : '';
      state.phase = control ? 'clicking-control' : 'scrolling';
      state.newIds = 0;
      state.lastScrollTop = Number(scroller?.scrollTop || 0);
      state.lastScrollHeight = Number(scroller?.scrollHeight || 0);
      notify();

      const actionTaken = control ? resolvedControls.click(control) : resolvedSurface.scrollToEnd(scroller);
      if (actionTaken) await waitForGrowth(beforeIds, control, beforeLabel);
      if (!isActive() || cancelled) return result(state.phase === 'paused' ? 'paused' : 'cancelled');

      // Instagram 重绘可能替换整个评论容器，加载完成后必须重新解析 root 和 scroller。
      const currentRoot = resolvedSurface.resolveRoot();
      const currentScroller = resolvedSurface.findScrollableElement(currentRoot);
      const afterIds = resolvedSurface.getCommentIds(currentRoot);
      const newIds = [...afterIds].filter((id) => !beforeIds.has(id));
      const controlChanged = Boolean(control && (!control.isConnected || resolvedControls.getLabel(control) !== beforeLabel));
      state.lastScrollTop = Number(currentScroller?.scrollTop || 0);
      state.lastScrollHeight = Number(currentScroller?.scrollHeight || 0);
      state.newIds = newIds.length;
      mergeIds(afterIds);
      if (newIds.length > 0) {
        state.batchIndex += 1;
        state.noGrowthAttempts = 0;
        state.phase = 'loaded';
      } else if (controlChanged) {
        // 入口状态发生变化但 DOM 尚未新增时，允许下一轮继续等待，避免误判完成。
        state.noGrowthAttempts = 0;
        state.phase = 'waiting';
      } else {
        state.noGrowthAttempts += 1;
        state.phase = 'no-growth';
      }
      const nextControls = resolvedControls.findLoadMore(currentRoot);
      const loading = resolvedControls.isLoading(currentRoot);
      const done = hasReachedEnd(currentRoot, currentScroller, nextControls, loading);
      if (done) state.phase = 'completed';
      notify();
      return result(done ? 'completed' : (newIds.length ? 'loaded' : 'no-growth'), { ids: new Set(afterIds) });
    }

    function cancel(reason = '用户已取消自动加载。', phase = 'cancelled') {
      cancelled = true;
      pendingWait?.finish(false);
      pendingWait = null;
      state.phase = phase;
      state.terminalReason = reason;
      notify();
    }

    const api = {
      config,
      getSnapshot: snapshot,
      nextBatch,
      cancel,
      findScrollableSurface: (root) => resolvedSurface.findScrollableElement(root),
      findLoadMoreControls: (root) => resolvedControls.findLoadMore(root),
      hasReachedEnd,
    };
    // 兼容旧面板读取方式，但只返回快照，外部不能修改内部状态对象。
    Object.defineProperty(api, 'state', { enumerable: true, get: snapshot });
    return api;
  }

  global.InstagramCommentPaginationLoader = { DEFAULTS, normalizeSettings, create };
})(globalThis);
