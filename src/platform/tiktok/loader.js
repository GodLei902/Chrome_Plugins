(function (global) {
  'use strict';

  const contract = global.SocialCommentPlatformContract;
  const dom = global.SocialCommentTikTokDom;
  if (!contract || !dom) throw new Error('TikTok 回复展开依赖的平台基础模块未加载。');

  const success = (details = {}) => contract.createActionResult(true, details);
  const failure = (code, message) => contract.createActionResult(false, { code, message });

  function resolveParent(surface, parentElement, target, context = {}) {
    const expectedId = String(context.parentId || '');
    const comments = global.SocialCommentTikTokComments;
    if (!surface?.isConnected) return failure('not-ready', 'TikTok 评论面已失效，需要重新发现。');
    if (!expectedId) {
      const body = dom.locateBody(parentElement);
      return body && body.matches?.(dom.LEVEL_1) && surface.contains?.(body)
        ? success({ parent: body })
        : failure('ambiguous', 'TikTok 当前一级评论无法唯一定位，已暂停。');
    }
    if (typeof comments?.toRecord !== 'function') return failure('unsupported', 'TikTok 评论解析模块未加载。');
    const matches = dom.findBodies(surface)
      .filter((body) => dom.isVisible(body) && body.matches?.(dom.LEVEL_1))
      .filter((body) => {
        const record = comments.toRecord(body, target);
        return record.ok && String(record.record?.id || '') === expectedId;
      });
    return matches.length === 1
      ? success({ parent: matches[0] })
      : failure('ambiguous', 'TikTok 当前一级评论已重绘且无法唯一重新定位，已暂停。');
  }

  function findExpansionControls(surface, context = {}) {
    if (!surface?.isConnected) return failure('not-ready', 'TikTok 评论面已失效，需要重新发现。');
    const controls = dom.findReplyExpansionControls(surface).filter((control) => {
      const parent = dom.getThreadParentBody(control);
      return !context.parentElement || parent === dom.locateBody(context.parentElement);
    });
    const parents = new Set();
    for (const control of controls) {
      const parent = dom.getThreadParentBody(control);
      if (!parent) return failure('ambiguous', 'TikTok 回复展开入口无法映射到唯一一级评论线程。');
      if (parents.has(parent)) return failure('ambiguous', 'TikTok 同一评论线程存在多个回复展开入口。');
      parents.add(parent);
    }
    return success({ controls });
  }

  function replyKeys(container, target) {
    const comments = global.SocialCommentTikTokComments;
    if (!container) return new Set();
    const keys = new Set();
    for (const body of dom.findBodies(container).filter((item) => dom.isVisible(item) && item.matches?.(dom.LEVEL_2))) {
      const record = comments?.toRecord?.(body, target);
      // 页面模块完整加载时使用回复稳定键；测试或降级环境以节点身份保留同一语义。
      if (record?.ok && record.record?.id) keys.add(String(record.record.id));
      else keys.add(body);
    }
    return keys;
  }

  function hasTerminalLabel(container) {
    return [...(container?.querySelectorAll?.('button,[role="button"],p,span,div') || [])]
      .some((element) => dom.isVisible(element) && dom.normalizeText(element.textContent) === '非表示');
  }

  async function expandParent(surface, parentElement, target, options = {}) {
    const signal = options.signal;
    if (signal?.aborted) return failure('cancelled', 'TikTok 回复展开已取消。');
    // 每次动作前以稳定键重新定位父评论，避免虚拟列表或重绘后点击旧节点。
    const resolved = resolveParent(surface, parentElement, target, options);
    if (!resolved.ok) return resolved;
    const context = { parentElement: resolved.parent };
    const found = findExpansionControls(surface, context);
    if (!found.ok) return found;
    if (!found.controls.length) return success({ expanded: false, count: 0, complete: true });
    const control = found.controls[0];
    const scope = dom.getThreadContainer(resolved.parent) || surface;
    const beforeKeys = replyKeys(scope, target);
    const action = () => { control.click?.(); return true; };
    const coordinated = options.coordinateAction
      ? await options.coordinateAction('expand-replies', action)
      : { ok: true, value: action() };
    if (coordinated?.ok === false) return failure(coordinated.error?.code || 'cancelled', coordinated.error?.message || 'TikTok 回复展开已取消。');
    const currentThread = () => {
      const relocated = options.parentId
        ? resolveParent(surface, null, target, options)
        : success({ parent: resolved.parent });
      return relocated.ok ? (dom.getThreadContainer(relocated.parent) || surface) : scope;
    };
    const progressed = () => {
      if (signal?.aborted) return false;
      const afterKeys = replyKeys(currentThread(), target);
      // 只有确认出现新的可解析回复，才认为本次点击成功；不能以 100ms 或控件消失代替。
      return [...afterKeys].some((key) => !beforeKeys.has(key));
    };
    const wait = options.wait;
    const confirmed = wait?.until
      ? await wait.until(progressed, { signal, timeoutMs: Number(options.expandTimeoutMs) || 30000, intervalMs: 120, reason: '正在等待回复展开结果...' })
      : progressed();
    if (signal?.aborted) return failure('cancelled', 'TikTok 回复展开已取消。');
    if (!confirmed) return failure('ambiguous', 'TikTok 回复展开后未检测到可确认的新回复，已暂停当前一级评论。');
    if (options.waitUntilStable) {
      const stable = await options.waitUntilStable({ timeoutMs: 10000, reason: '正在等待展开后的评论区稳定...' });
      if (stable?.ok === false) return stable;
    }
    // 仍存在“あと N 件表示”时由核心继续处理同一父评论；“非表示”仅作为终态证据。
    const finalThread = currentThread();
    const finalResolved = options.parentId ? resolveParent(surface, null, target, options) : resolved;
    if (!finalResolved.ok) return finalResolved;
    const finalParent = finalResolved.parent;
    const remaining = findExpansionControls(finalThread, { parentElement: finalParent });
    if (!remaining.ok) return remaining;
    return success({ expanded: true, count: 1, complete: !remaining.controls.length && hasTerminalLabel(finalThread) });
  }

  function expandAll(surface, target, options = {}) {
    return expandParent(surface, null, target, options);
  }

  const PAGINATION_DEFAULTS = Object.freeze({
    maxBatches: 20,
    noGrowthAttempts: 3,
    stableWaitMs: 800,
    waitTimeoutMs: 8000,
  });

  function positive(value, fallback) {
    return Number(value) > 0 ? Math.floor(Number(value)) : fallback;
  }

  function paginationSettings(raw = {}) {
    return Object.freeze({
      maxBatches: positive(raw.maxBatches, PAGINATION_DEFAULTS.maxBatches),
      noGrowthAttempts: positive(raw.noGrowthAttempts, PAGINATION_DEFAULTS.noGrowthAttempts),
      stableWaitMs: positive(raw.stableWaitMs, PAGINATION_DEFAULTS.stableWaitMs),
      waitTimeoutMs: positive(raw.waitTimeoutMs, PAGINATION_DEFAULTS.waitTimeoutMs),
    });
  }

  function documentFor(surface, options = {}) {
    return dom.documentFor(options.page || surface?.ownerDocument || global.document);
  }

  function resolvePaginationSurface(surface, options = {}) {
    if (surface?.isConnected && dom.findBodies(surface).some(dom.isVisible)) return success({ surface });
    const pageSurface = global.SocialCommentTikTokSurface?.findCommentSurface?.(documentFor(surface, options));
    if (!pageSurface?.ok || !pageSurface.surface) {
      return failure(pageSurface?.error?.code || 'not-ready', pageSurface?.error?.message || 'TikTok 评论面已被替换，无法重新发现。');
    }
    return success({ surface: pageSurface.surface, replaced: Boolean(surface && surface !== pageSurface.surface) });
  }

  function collectCommentIds(surface, target) {
    const comments = global.SocialCommentTikTokComments;
    if (typeof comments?.collect !== 'function') return failure('unsupported', 'TikTok 评论解析模块未加载。');
    const result = comments.collect(surface, target);
    if (!result?.ok) return failure(result?.error?.code || 'ambiguous', result?.error?.message || 'TikTok 评论稳定键无法确认。');
    return success({ ids: new Set((result.records || []).map((record) => String(record?.id || '')).filter(Boolean)) });
  }

  function idsAdded(before, after) {
    return [...after].filter((id) => !before.has(id));
  }

  function atEnd(scroller) {
    if (!scroller) return true;
    return Number(scroller.scrollTop || 0) >= Math.max(0, Number(scroller.scrollHeight || 0) - Number(scroller.clientHeight || 0) - 2);
  }

  function controlSignature(control) {
    return dom.normalizeText(control?.textContent || control?.getAttribute?.('aria-label') || control?.getAttribute?.('title'));
  }

  function scrollToLoadPosition(scroller) {
    if (!scroller || !dom.isScrollable(scroller)) return false;
    const targetTop = Math.max(Number(scroller.scrollTop || 0), Number(scroller.scrollHeight || 0) - Number(scroller.clientHeight || 0));
    if (targetTop <= Number(scroller.scrollTop || 0) + 1) return false;
    if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ top: targetTop, behavior: 'auto' });
    else scroller.scrollTop = targetTop;
    return true;
  }

  function createPagination(surface, settings = {}, options = {}) {
    const config = paginationSettings(settings);
    const seenIds = new Set();
    let cancelled = false;
    let pendingCancel = null;
    const paginationAbort = typeof global.AbortController === 'function' ? new global.AbortController() : null;
    const externalAbort = () => {
      paginationAbort?.abort?.();
      pendingCancel?.();
    };
    options.signal?.addEventListener?.('abort', externalAbort, { once: true });
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

    const isActive = () => !cancelled && !options.signal?.aborted;
    const snapshot = () => Object.freeze({ ...state });
    const notify = () => options.onProgress?.(snapshot());
    const result = (status, extra = {}) => ({
      ok: status === 'loaded' || status === 'no-growth',
      done: ['completed', 'cancelled', 'paused'].includes(status),
      status,
      ...snapshot(),
      ...extra,
    });
    const mergeIds = (ids) => {
      ids.forEach((id) => seenIds.add(String(id)));
      state.totalSeen = seenIds.size;
    };
    const stop = (phase, reason, errorCode = '') => {
      state.phase = phase;
      state.terminalReason = reason;
      notify();
      return result(phase, { errorCode });
    };

    async function waitUntil(predicate, waitOptions = {}) {
      if (!isActive()) return false;
      if (!options.wait?.until) {
        try { return Boolean(await predicate()); } catch { return false; }
      }
      return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          if (pendingCancel === cancelPending) pendingCancel = null;
          resolve(Boolean(value));
        };
        const cancelPending = () => finish(false);
        pendingCancel = cancelPending;
        Promise.resolve(options.wait.until(predicate, {
          ...waitOptions,
          signal: paginationAbort?.signal || options.signal,
        })).then(finish, () => finish(false));
      });
    }

    async function waitForStable(currentSurface) {
      if (!isActive()) return failure('cancelled', 'TikTok 评论加载已取消。');
      if (!options.waitUntilStable) return resolvePaginationSurface(currentSurface, options);
      const stable = await options.waitUntilStable({
        timeoutMs: config.waitTimeoutMs,
        requireData: false,
        reason: '正在等待下一批 TikTok 评论稳定...',
      });
      if (stable?.ok === false) return failure(stable.error?.code || 'not-ready', stable.error?.message || 'TikTok 下一批评论未稳定。');
      const resolved = resolvePaginationSurface(stable?.surface || currentSurface, options);
      if (!resolved.ok) return resolved;
      // 稳定快照通过后再保留现有的短暂静置窗口，避免虚拟列表在最后一帧替换时
      // 立即读取旧节点。该等待由 WaitCoordinator 绑定会话取消信号。
      if (config.stableWaitMs > 0 && options.wait?.delay) {
        const settled = await options.wait.delay(config.stableWaitMs, '正在确认 TikTok 评论列表稳定...');
        if (!settled) return failure('cancelled', 'TikTok 评论加载已取消。');
      }
      return resolvePaginationSurface(resolved.surface, options);
    }

    async function waitForChange(beforeIds, initialSurface, target, control, beforeControlSignature) {
      const wait = options.wait;
      return waitUntil(() => {
        if (!isActive()) return false;
        const resolved = resolvePaginationSurface(initialSurface, options);
        if (!resolved.ok) return false;
        const collected = collectCommentIds(resolved.surface, target);
        if (!collected.ok) return false;
        return idsAdded(beforeIds, collected.ids).length > 0
          || Boolean(control && (!control.isConnected || controlSignature(control) !== beforeControlSignature));
      }, {
        timeoutMs: config.waitTimeoutMs,
        intervalMs: 120,
        reason: '正在等待 TikTok 下一批评论出现...',
      });
    }

    function pendingReplies(currentSurface) {
      return dom.findReplyExpansionControls(currentSurface).length > 0;
    }

    function completeIfSafe(currentSurface, scroller, controls) {
      if (state.noGrowthAttempts < config.noGrowthAttempts || controls.length || pendingReplies(currentSurface) || !atEnd(scroller)) return null;
      state.phase = 'completed';
      state.terminalReason = `连续 ${config.noGrowthAttempts} 次没有新增评论，评论面已稳定且没有可继续加载的入口。`;
      notify();
      return result('completed');
    }

    async function nextBatch(currentSurface = surface, target = options.target) {
      const paginationTarget = target || options.target;
      if (!isActive()) return stop('cancelled', 'TikTok 评论加载已取消。');
      if (state.batchIndex >= config.maxBatches) {
        return stop('paused', `已达到 TikTok 自动加载批次上限（${config.maxBatches} 轮），无法确认页面已结束。`, 'ambiguous');
      }
      const resolved = resolvePaginationSurface(currentSurface, options);
      if (!resolved.ok) return stop('paused', resolved.error.message, resolved.error.code);
      const initialSurface = resolved.surface;
      const before = collectCommentIds(initialSurface, paginationTarget);
      if (!before.ok) return stop('paused', before.error.message, before.error.code);
      mergeIds(before.ids);

      const controls = dom.findLoadMoreControls(initialSurface);
      if (controls.length > 1) return stop('paused', 'TikTok 评论面存在多个可见加载更多入口，已暂停。', 'ambiguous');
      const control = controls[0] || null;
      const scroller = dom.findScrollableElement(initialSurface);
      const currentlyAtEnd = atEnd(scroller);
      state.newIds = 0;
      state.lastScrollTop = Number(scroller?.scrollTop || 0);
      state.lastScrollHeight = Number(scroller?.scrollHeight || 0);

      if (!control && (!scroller || currentlyAtEnd)) {
        const stable = await waitForStable(initialSurface);
        if (!stable.ok) return stop('paused', stable.error.message, stable.error.code);
        const after = collectCommentIds(stable.surface, paginationTarget);
        if (!after.ok) return stop('paused', after.error.message, after.error.code);
        const newIds = idsAdded(before.ids, after.ids);
        mergeIds(after.ids);
        state.newIds = newIds.length;
        if (newIds.length) {
          state.batchIndex += 1;
          state.noGrowthAttempts = 0;
          state.phase = 'loaded';
          notify();
          return result('loaded', { ids: new Set(after.ids) });
        }
        if (pendingReplies(stable.surface)) return stop('paused', 'TikTok 仍有未展开的回复入口，不能确认评论分页结束。', 'not-ready');
        state.noGrowthAttempts += 1;
        state.phase = 'no-growth';
        const complete = completeIfSafe(stable.surface, dom.findScrollableElement(stable.surface), dom.findLoadMoreControls(stable.surface));
        if (complete) return complete;
        notify();
        return result('no-growth', { ids: new Set(after.ids) });
      }

      state.phase = control ? 'clicking-control' : 'scrolling';
      notify();
      const beforeControlSignature = controlSignature(control);
      const action = () => {
        if (!control) return scrollToLoadPosition(scroller);
        if (typeof control.click !== 'function') return false;
        control.click();
        return true;
      };
      const coordinated = options.coordinateAction
        ? await options.coordinateAction(control ? 'load-more-comments' : 'scroll-comment-surface', action)
        : { ok: true, value: action() };
      if (coordinated?.ok === false || !isActive()) {
        return stop('cancelled', coordinated?.error?.message || 'TikTok 评论加载已取消。', coordinated?.error?.code || 'cancelled');
      }
      if (coordinated?.value === false) {
        return stop('paused', control ? 'TikTok 加载更多入口不可操作。' : 'TikTok 评论滚动容器未发生可确认滚动。', 'not-ready');
      }
      await waitForChange(before.ids, initialSurface, paginationTarget, control, beforeControlSignature);
      if (!isActive()) return stop('cancelled', 'TikTok 评论加载已取消。', 'cancelled');
      const stable = await waitForStable(initialSurface);
      if (!stable.ok) return stop('paused', stable.error.message, stable.error.code);
      const after = collectCommentIds(stable.surface, paginationTarget);
      if (!after.ok) return stop('paused', after.error.message, after.error.code);
      const newIds = idsAdded(before.ids, after.ids);
      const afterScroller = dom.findScrollableElement(stable.surface);
      mergeIds(after.ids);
      state.lastScrollTop = Number(afterScroller?.scrollTop || 0);
      state.lastScrollHeight = Number(afterScroller?.scrollHeight || 0);
      state.newIds = newIds.length;
      if (newIds.length) {
        state.batchIndex += 1;
        state.noGrowthAttempts = 0;
        state.phase = 'loaded';
        notify();
        return result('loaded', { ids: new Set(after.ids) });
      }

      state.noGrowthAttempts += 1;
      state.phase = 'no-growth';
      const nextControls = dom.findLoadMoreControls(stable.surface);
      const complete = completeIfSafe(stable.surface, afterScroller, nextControls);
      if (complete) return complete;
      if (state.noGrowthAttempts >= config.noGrowthAttempts) {
        return stop('paused', 'TikTok 加载动作连续未产生新评论，但页面仍存在可操作入口或未到达末尾。', 'ambiguous');
      }
      notify();
      return result('no-growth', { ids: new Set(after.ids) });
    }

    function cancel(reason = '用户已取消 TikTok 自动加载。', phase = 'cancelled') {
      cancelled = true;
      paginationAbort?.abort?.();
      pendingCancel?.();
      pendingCancel = null;
      options.signal?.removeEventListener?.('abort', externalAbort);
      state.phase = phase;
      state.terminalReason = reason;
      notify();
    }

    return Object.freeze({
      config,
      getSnapshot: snapshot,
      nextBatch,
      cancel,
      findScrollableSurface: (root) => dom.findScrollableElement(root),
      findLoadMoreControls: (root) => dom.findLoadMoreControls(root),
    });
  }

  async function loadNextBatch(surface, target, options = {}) {
    const pagination = options.pagination || createPagination(surface, options.settings?.pagination || options.settings || {}, options);
    if (!pagination) return failure('unsupported', 'TikTok 分页模块未加载。');
    const progress = await pagination.nextBatch(surface, target);
    if (progress.status === 'paused' || progress.status === 'cancelled') {
      return failure(progress.errorCode || (progress.status === 'cancelled' ? 'cancelled' : 'ambiguous'), progress.terminalReason || 'TikTok 评论加载已暂停。');
    }
    return success({ progress, pagination });
  }

  function getProgress(pagination) { return pagination?.getSnapshot?.() || null; }
  function hasReachedEnd(pagination) { return pagination?.getSnapshot?.()?.phase === 'completed'; }
  function cancel(context = {}) {
    context.pagination?.cancel?.('用户已取消 TikTok 自动加载。');
    return success({ cancelled: true });
  }

  global.SocialCommentTikTokLoader = Object.freeze({
    findExpansionControls,
    expand: expandParent,
    // 核心负责“一级评论 -> 展开 -> 扫描”的串行顺序；这里不提前批量点击。
    expandAll: () => success({ expanded: false, count: 0, complete: true }),
    expandParent,
    findLoadMoreControls: (surface) => dom.findLoadMoreControls(surface),
    loadNextBatch,
    createPagination,
    getProgress,
    hasReachedEnd,
    cancel,
  });
})(globalThis);
