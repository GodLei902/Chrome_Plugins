(function (global) {
  'use strict';

  const contract = global.SocialCommentPlatformContract;
  const surfaceApi = global.SocialCommentInstagramSurface;
  const locator = global.InstagramControlLocator;

  function sleep(ms, signal) {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(!signal?.aborted), Math.max(0, Number(ms) || 0));
      signal?.addEventListener?.('abort', () => { clearTimeout(timer); resolve(false); }, { once: true });
    });
  }

  function rootsFor(surface) {
    const documentRef = surface?.ownerDocument || global.document;
    const roots = [];
    for (let node = surface; node && node !== documentRef.body && roots.length < 6; node = node.parentElement) roots.push(node);
    roots.push(documentRef);
    return [...new Set(roots.filter(Boolean))];
  }

  function replyControls(surface, scope) {
    const roots = rootsFor(scope || surface);
    const controls = roots.flatMap((root) => locator?.findReplyDisclosureControls?.(root, scope || null) || []);
    return [...new Set(controls)].filter((node) => surfaceApi.visible(node) && !locator?.isExpandedReplyDisclosure?.(node));
  }

  function findLoadingIndicator(root) {
    return [...root?.querySelectorAll?.('[role="progressbar"],[aria-busy="true"]') || []].some(surfaceApi.visible);
  }

  async function waitForExpansion(control, beforeIds, surface, options = {}) {
    const signal = options.signal;
    const startedAt = Date.now();
    const before = locator?.captureExpansionState?.(control, beforeIds) || { control, ids: beforeIds };
    const hasExpanded = () => {
      const ids = new Set(surfaceApi.commentLinksIn(surface?.ownerDocument || global.document).map((link) => surfaceApi.commentIdFromUrl(link.getAttribute('href'))));
      const result = locator?.waitForExpansionResult?.(before, {
        control,
        commentIds: ids,
        containerSignature: locator?.elementSignature?.(before.container),
        stable: true,
      });
      return Boolean(result?.ok || [...ids].some((id) => !beforeIds.has(id)) || !control.isConnected || !surfaceApi.visible(control));
    };
    if (options.wait?.until) return options.wait.until(hasExpanded, { timeoutMs: 8000, intervalMs: 120, reason: '正在展开回复入口并等待页面稳定...' });
    while (!signal?.aborted && Date.now() - startedAt < 8000) {
      if (hasExpanded()) return true;
      if (!(await sleep(120, signal))) return false;
    }
    return false;
  }

  async function expandAll(surface, target, options = {}) {
    const runnerFactory = global.InstagramCommentReplyExpansion;
    if (runnerFactory && locator) {
      const documentRef = surface?.ownerDocument || global.document;
      const runner = runnerFactory.create({
        locator,
        isActive: () => !options.signal?.aborted,
        resolveScope: (scope, settings) => {
          if (!settings.parentId) return scope;
          return global.SocialCommentInstagramActions?.locateElement?.({ id: settings.parentId }, { page: documentRef }) || (scope?.isConnected ? scope : null);
        },
        getRoots: (scope) => rootsFor(scope || surface),
        getControls: (roots, scope) => [...new Set(roots.flatMap((root) => locator.findReplyDisclosureControls?.(root, scope || null) || []))]
          .filter((node) => surfaceApi.visible(node) && !locator.isExpandedReplyDisclosure?.(node)),
        isExpandedControl: (control) => locator.isExpandedReplyDisclosure?.(control),
        getCommentIds: () => new Set(surfaceApi.commentLinksIn(documentRef).map((link) => surfaceApi.commentIdFromUrl(link.getAttribute('href')))),
        captureState: (control, ids) => locator.captureExpansionState?.(control, ids) || { control, ids },
        coordinateAction: options.coordinateAction,
        waitForExpansion: async ({ control, beforeIds, beforeState, timeoutMs }) => {
          const predicate = () => {
            const ids = new Set(surfaceApi.commentLinksIn(documentRef).map((link) => surfaceApi.commentIdFromUrl(link.getAttribute('href'))));
            const loadingRoot = beforeState.container || control?.parentElement || surface || documentRef;
            const result = locator.waitForExpansionResult?.(beforeState, {
              control,
              commentIds: ids,
              containerSignature: locator.elementSignature?.(beforeState.container),
              stable: !findLoadingIndicator(loadingRoot),
            });
            return Boolean(result?.ok || [...ids].some((id) => !beforeIds.has(id)) || !control?.isConnected || !surfaceApi.visible(control));
          };
          return options.wait?.until
            ? options.wait.until(predicate, { timeoutMs, intervalMs: 120, reason: '正在展开回复入口并等待页面稳定...' })
            : waitForExpansion(control, beforeIds, surface, options);
        },
      });
      const result = await runner.expand(surface, { parentId: options.parentId, maxControls: options.maxControls });
      return result.ok
        ? contract.createActionResult(true, { count: result.count })
        : contract.createActionResult(false, { code: result.status === 'cancelled' ? 'cancelled' : 'ambiguous', message: result.reason || '回复展开结果无法确认，已暂停。' });
    }
    const maxControls = Number(options.maxControls) > 0 ? Number(options.maxControls) : 40;
    let count = 0;
    for (let pass = 0; pass < maxControls && !options.signal?.aborted; pass += 1) {
      const control = replyControls(surface)[0];
      if (!control) return contract.createActionResult(true, { count });
      const beforeIds = new Set(surfaceApi.commentLinksIn(surface?.ownerDocument || global.document).map((link) => surfaceApi.commentIdFromUrl(link.getAttribute('href'))));
      const action = options.coordinateAction
        ? await options.coordinateAction('expand-replies', async () => { control.click?.(); return true; })
        : { ok: true };
      if (!action?.ok) return contract.createActionResult(false, { code: 'cancelled', message: '回复展开动作已取消。' });
      count += 1;
      if (!(await waitForExpansion(control, beforeIds, surface, options))) {
        return contract.createActionResult(false, { code: options.signal?.aborted ? 'cancelled' : 'ambiguous', message: '回复展开结果无法确认，已暂停。' });
      }
    }
    return replyControls(surface).length
      ? contract.createActionResult(false, { code: 'ambiguous', message: '回复展开入口超过安全上限，已暂停。' })
      : contract.createActionResult(true, { count });
  }

  async function expandParent(surface, parentElement, target, options = {}) {
    return expandAll(parentElement || surface, target, options);
  }

  function createPagination(surface, settings, options = {}) {
    const factory = global.InstagramCommentPaginationLoader;
    const surfaceFactory = global.InstagramCommentPaginationSurface;
    const controlsFactory = global.InstagramCommentPaginationControls;
    if (!factory || !surfaceFactory || !controlsFactory) return null;
    const documentRef = surface?.ownerDocument || global.document;
    const pageSurface = surfaceFactory.create({
      getRoot: () => surfaceApi.discover(documentRef) || (surface?.isConnected ? surface : documentRef),
      getCommentIds: (root) => surfaceApi.commentLinksIn(root).map((link) => surfaceApi.commentIdFromUrl(link.getAttribute('href'))),
    });
    const controls = controlsFactory.create({
      getRoot: () => pageSurface.resolveRoot(),
      rootsFor: pageSurface.rootsFor,
      getControlLabel: (node) => locator?.getAccessibleLabels?.(node).join(' ') || '',
      isLoadMoreControl: (node) => locator?.findLoadMoreControls?.(node?.parentElement || documentRef).includes(node),
      findLoadingIndicator: (root) => [...root?.querySelectorAll?.('[role="progressbar"],[aria-busy="true"]') || []].some(surfaceApi.visible),
    });
    return factory.create({
      settings,
      surface: pageSurface,
      controls,
      isActive: () => !options.signal?.aborted,
      coordinateAction: options.coordinateAction,
      waiter: { untilStable: async (waitOptions) => {
        if (options.signal?.aborted) return false;
        if (options.waitUntilStable) return Boolean(await options.waitUntilStable(waitOptions));
        return true;
      } },
      hasPendingReplyExpansion: () => replyControls(surface).length > 0,
      onProgress: options.onProgress,
    });
  }

  async function loadNextBatch(surface, target, options = {}) {
    const pagination = options.pagination || createPagination(surface, options.settings?.pagination || options.settings || {}, options);
    if (!pagination) return contract.createActionResult(false, { code: 'unsupported', message: '分页模块未加载。' });
    const result = await pagination.nextBatch();
    return result.status === 'paused' || result.status === 'cancelled'
      ? contract.createActionResult(false, { code: result.status === 'cancelled' ? 'cancelled' : 'ambiguous', message: result.terminalReason || '评论加载已暂停。', progress: result })
      : contract.createActionResult(true, { progress: result, pagination });
  }

  function getProgress(pagination) { return pagination?.getSnapshot?.() || null; }
  function hasReachedEnd(pagination) { return pagination?.getSnapshot?.()?.phase === 'completed'; }
  function cancel(context = {}) { context.pagination?.cancel?.('用户已取消自动加载。'); return contract.createActionResult(true); }

  global.SocialCommentInstagramLoader = Object.freeze({
    findExpansionControls: (surface) => replyControls(surface),
    expand: expandAll,
    expandAll,
    expandParent,
    findLoadMoreControls: (surface) => locator?.findLoadMoreControls?.(surface) || [],
    loadNextBatch,
    getProgress,
    hasReachedEnd,
    createPagination,
    cancel,
  });
})(globalThis);
