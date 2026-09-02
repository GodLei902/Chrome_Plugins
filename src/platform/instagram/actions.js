(function (global) {
  'use strict';

  const contract = global.SocialCommentPlatformContract;
  const surfaceApi = global.SocialCommentInstagramSurface;
  const loader = global.SocialCommentInstagramLoader;
  const locator = global.InstagramControlLocator;

  function documentFor(context) { return context?.page?.document || context?.page || global.document; }
  function normalizedText(node) { return String(node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim(); }
  function controlLabels(node) { return locator?.getAccessibleLabels?.(node) || [normalizedText(node), node?.getAttribute?.('aria-label'), node?.getAttribute?.('title')].filter(Boolean); }

  function waitUntil(predicate, timeoutMs, context = {}, reason = '') {
    if (context.wait?.until) return context.wait.until(predicate, { timeoutMs, intervalMs: 120, reason });
    const signal = context.signal;
    return new Promise((resolve) => {
      const startedAt = Date.now();
      let timer = null;
      const finish = (value) => { clearTimeout(timer); resolve(Boolean(value)); };
      const check = () => {
        if (signal?.aborted) return finish(false);
        let matched = false;
        try { matched = Boolean(predicate()); } catch { matched = false; }
        if (matched || Date.now() - startedAt >= timeoutMs) return finish(matched);
        timer = setTimeout(check, 120);
      };
      signal?.addEventListener?.('abort', () => finish(false), { once: true });
      check();
    });
  }

  function locate(record, context = {}) {
    const documentRef = documentFor(context);
    const expectedId = String(record?.id || '');
    const expectedText = String(record?.text || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
    const expectedUsername = String(record?.username || '').replace(/^@+/, '').toLocaleLowerCase();
    if (expectedId) {
      const links = surfaceApi.commentLinksIn(documentRef).filter((link) => surfaceApi.commentIdFromUrl(link.getAttribute('href')) === expectedId);
      for (const link of links) {
        for (let depth = 0, node = link; node && depth < 8; depth += 1, node = node.parentElement) {
          if (!surfaceApi.visible(node)) continue;
          const body = normalizedText(node).toLocaleLowerCase();
          if ((!expectedUsername || body.includes(expectedUsername)) && (!expectedText || body.includes(expectedText))
            && (node.matches?.('li,article,ul') || node.querySelector?.('button,[role="button"]'))) return node;
        }
      }
      return null;
    }
    if (record?.element?.isConnected && surfaceApi.visible(record.element)) return record.element;
    const spans = [...documentRef.querySelectorAll?.('span') || []].filter((node) => surfaceApi.visible(node) && normalizedText(node) === String(record?.text || '').trim());
    return spans.map((node) => node.closest?.('li,article,div')).find(surfaceApi.visible) || null;
  }

  function hover(element) {
    if (!element?.dispatchEvent) return;
    const view = element.ownerDocument?.defaultView || global;
    const rect = element.getBoundingClientRect?.();
    const point = rect ? { clientX: Math.round(rect.left + Math.max(1, rect.width / 2)), clientY: Math.round(rect.top + Math.max(1, rect.height / 2)) } : {};
    const dispatch = (type, Constructor) => {
      try {
        const EventConstructor = view?.[Constructor] || global?.[Constructor] || global.Event;
        if (typeof EventConstructor === 'function') element.dispatchEvent(new EventConstructor(type, {
          bubbles: true,
          cancelable: true,
          view,
          ...point,
          ...(Constructor === 'PointerEvent' ? { pointerType: 'mouse' } : {}),
        }));
      } catch { /* 测试环境可能没有 PointerEvent 或 MouseEvent。 */ }
    };
    dispatch('pointerover', 'PointerEvent');
    dispatch('pointerenter', 'PointerEvent');
    dispatch('mouseover', 'MouseEvent');
    dispatch('mouseenter', 'MouseEvent');
    dispatch('mousemove', 'MouseEvent');
  }

  function menuFor(element) {
    return locator?.findCommentMenu?.(element)
      || [...element?.querySelectorAll?.('button,[role="button"]') || []].filter(surfaceApi.visible).find((node) => {
        const row = node?.closest?.('li,article') || node?.parentElement;
        return locator?.findCommentMenu?.(row) === node
          || (global.InstagramControlLabels?.matchControlLabel?.('commentOptions', controlLabels(node))?.matched && !locator?.isExpansionControl?.(node));
      }) || null;
  }

  function actionSurface(beforeState, documentRef) {
    return locator?.findActionSurface?.(beforeState, documentRef)
      || [...documentRef.querySelectorAll?.('[role="dialog"][aria-modal="true"],[role="dialog"],[role="menu"],[role="listbox"]') || []]
        .filter(surfaceApi.visible)
        .reverse()
        .find((surface) => locator?.findDeleteAction?.(surface)) || null;
  }

  async function resolveElement(record, context = {}) {
    const element = locate(record, context);
    return element
      ? contract.createActionResult(true, { element })
      : contract.createActionResult(false, { code: 'not-found', message: '目标回复尚未渲染到页面。' });
  }

  async function ensureReplyVisible(record, context = {}) {
    const documentRef = documentFor(context);
    const exists = surfaceApi.commentLinksIn(documentRef).some((link) => surfaceApi.commentIdFromUrl(link.getAttribute('href')) === String(record?.id || ''));
    if (exists) return contract.createActionResult(true, { visible: true });
    const parentId = String(record?.parentId || record?.parent?.id || '');
    if (!parentId) return contract.createActionResult(false, { code: 'not-found', message: '目标回复缺少父级关系。' });
    const parent = locate({ id: parentId }, context);
    const expanded = await loader.expandParent(context.surface || parent, parent, context.target, context);
    if (!expanded.ok) return expanded;
    const nowVisible = surfaceApi.commentLinksIn(documentRef).some((link) => surfaceApi.commentIdFromUrl(link.getAttribute('href')) === String(record?.id || ''));
    return nowVisible
      ? contract.createActionResult(true, { visible: true })
      : contract.createActionResult(false, { code: 'not-found', message: '目标一级评论的子级内容尚未渲染。' });
  }

  async function revealMenu(element) {
    hover(element);
    element?.scrollIntoView?.({ block: 'center', behavior: 'auto' });
    element?.focus?.();
    return contract.createActionResult(true, { element });
  }

  async function getMenu(element, context = {}) {
    let result = null;
    const ready = await waitUntil(() => {
      const refreshed = context.record ? locate(context.record, context) : element;
      result = locator?.findCommentMenuResult?.(refreshed) || { status: 'ok', action: menuFor(refreshed) };
      return result.status === 'ok' && Boolean(result.action);
    }, 1800, context, '正在显示评论菜单...');
    if (!ready || result?.status !== 'ok' || !result?.action) {
      return contract.createActionResult(false, { code: result?.status === 'ambiguous' ? 'ambiguous' : 'not-found', message: result?.reason || '未找到可靠的评论菜单。' });
    }
    const documentRef = documentFor(context);
    const before = locator?.captureActionSurfaceState?.(documentRef) || null;
    const openedAction = context.coordinateAction
      ? await context.coordinateAction('open-comment-menu', async () => { result.action.focus?.(); result.action.click?.(); return true; })
      : { ok: true, value: (result.action.focus?.(), result.action.click?.(), true) };
    if (!openedAction?.ok) return contract.createActionResult(false, { code: 'cancelled', message: '评论菜单动作已取消。' });
    let surface = null;
    const opened = await waitUntil(() => {
      surface = actionSurface(before, documentRef);
      return Boolean(surface);
    }, 5000, context, '正在打开删除菜单...');
    return opened && surface
      ? contract.createActionResult(true, { menu: surface })
      : contract.createActionResult(false, { code: 'not-ready', message: '删除菜单未出现。' });
  }

  async function findDeleteAction(menu, context = {}) {
    const action = locator?.findDeleteAction?.(menu) || null;
    if (action) return contract.createActionResult(true, { action });
    const reason = locator?.describeDeleteAction?.(menu)?.reason;
    return contract.createActionResult(false, {
      code: reason === 'permission' ? 'permission' : (reason === 'ambiguous' ? 'ambiguous' : 'not-found'),
      message: reason === 'permission' ? '当前评论菜单没有删除权限。' : '没有可靠的删除项，可能缺少权限。',
    });
  }

  async function confirmDelete(action, context = {}) {
    const documentRef = documentFor(context);
    const record = context.record || {};
    let deleteAction = action;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!deleteAction?.isConnected) return contract.createActionResult(false, { code: 'ambiguous', message: '删除确认弹层不明确。' });
      const actionType = attempt === 0 ? 'delete-reply' : 'confirm-delete';
      const clicked = context.coordinateAction
        ? await context.coordinateAction(actionType, async () => { deleteAction.click?.(); return true; }, { extraDelay: context.settings?.pace?.deleteDialogDelay })
        : { ok: true, value: (deleteAction.click?.(), true) };
      if (!clicked?.ok) return contract.createActionResult(false, { code: 'cancelled', message: '删除动作已取消。' });
      const afterClick = locator?.captureActionSurfaceState?.(documentRef) || null;
      let confirmation = null;
      let permissionFailure = false;
      const outcome = await waitUntil(() => {
        const ids = new Set(surfaceApi.commentLinksIn(documentRef).map((link) => surfaceApi.commentIdFromUrl(link.getAttribute('href'))));
        if (!ids.has(String(record.id || ''))) return true;
        confirmation = actionSurface(afterClick, documentRef);
        if (confirmation) {
          const described = locator?.describeDeleteAction?.(confirmation);
          deleteAction = described?.action || null;
          permissionFailure = described?.reason === 'permission';
          return Boolean(deleteAction || permissionFailure);
        }
        return false;
      }, 7000, context, '正在确认删除结果...');
      if (!outcome) return contract.createActionResult(false, { code: 'ambiguous', message: '未确认回复已删除。' });
      const stillPresent = surfaceApi.commentLinksIn(documentRef).some((link) => surfaceApi.commentIdFromUrl(link.getAttribute('href')) === String(record.id || ''));
      if (!stillPresent) return contract.createActionResult(true, { confirmed: true });
      if (permissionFailure) return contract.createActionResult(false, { code: 'permission', message: '删除确认弹层没有删除权限。' });
      if (!deleteAction || !confirmation) return contract.createActionResult(false, { code: 'ambiguous', message: '删除确认弹层不明确。' });
    }
    return contract.createActionResult(false, { code: 'ambiguous', message: '删除确认未完成。' });
  }

  async function verifyDeleted(record, context = {}) {
    const documentRef = documentFor(context);
    const expectedText = String(record?.text || '').replace(/\s+/g, ' ').trim();
    const removed = await waitUntil(() => {
      const link = surfaceApi.commentLinksIn(documentRef).find((node) => surfaceApi.commentIdFromUrl(node.getAttribute('href')) === String(record?.id || ''));
      if (!link) return true;
      return Boolean(expectedText) && !normalizedText(link.closest?.('li,article,div') || link).includes(expectedText);
    }, 7000, context, '正在确认回复已删除...');
    if (!removed) return contract.createActionResult(false, { code: 'ambiguous', message: '删除结果无法确认。' });
    const stable = context.waitUntilStable
      ? await context.waitUntilStable({ timeoutMs: 10000, requireData: false, reason: '正在等待删除后的评论区稳定...' })
      : await surfaceApi.waitUntilStable(documentRef, context.target, { timeoutMs: 10000, signal: context.signal, wait: context.wait });
    return stable.ok
      ? contract.createActionResult(true, { deleted: true })
      : contract.createActionResult(false, { code: stable.error?.code || 'ambiguous', message: stable.error?.message || '删除后的评论区未稳定。' });
  }

  function getHoverPoint(element) {
    const rect = element?.getBoundingClientRect?.();
    return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null;
  }

  global.SocialCommentInstagramActions = Object.freeze({
    locateElement: locate,
    resolveElement,
    ensureReplyVisible,
    revealMenu,
    getMenu,
    findDeleteAction,
    confirmDelete,
    verifyDeleted,
    getHoverPoint,
  });
})(globalThis);
