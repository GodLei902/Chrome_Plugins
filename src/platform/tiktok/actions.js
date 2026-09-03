(function (global) {
  'use strict';

  const contract = global.SocialCommentPlatformContract;
  const dom = global.SocialCommentTikTokDom;
  const comments = global.SocialCommentTikTokComments;
  if (!contract || !dom || !comments) throw new Error('TikTok 动作模块依赖评论解析基础模块未加载。');

  const MENU_TRIGGER = '[aria-haspopup="dialog"]';
  const DELETE_ACTION = 'button[data-e2e="comment-delete"]';
  const ACTION_SURFACE = '[role="dialog"], [role="menu"], [role="listbox"]';
  const success = (details = {}) => contract.createActionResult(true, details);
  const failure = (code, message) => contract.createActionResult(false, { code, message });

  function documentFor(context = {}) {
    return context?.page?.document || context?.page || context?.document || global.document || null;
  }

  function visible(element) {
    return dom.isVisible(element);
  }

  function controls(root, selector) {
    const found = [];
    if (root?.matches?.(selector) && visible(root)) found.push(root);
    root?.querySelectorAll?.(selector)?.forEach((element) => {
      if (visible(element)) found.push(element);
    });
    return [...new Set(found)];
  }

  function rowFor(element) {
    const body = dom.locateBody(element);
    return body ? dom.locateRow(body) : null;
  }

  function recordContext(context = {}) {
    return context.target || context;
  }

  function resolveElement(record, context = {}) {
    const documentRef = documentFor(context);
    const expectedId = String(record?.id || '');
    if (!expectedId || !documentRef) return failure('ambiguous', 'TikTok 评论缺少可重定位的短期稳定键。');
    const matches = [];
    for (const body of dom.findBodies(documentRef).filter(visible)) {
      const parsed = comments.toRecord(body, recordContext(context));
      if (!parsed.ok || String(parsed.record?.id || '') !== expectedId) continue;
      if (parsed.record.kind !== record.kind || String(parsed.record.parentId || '') !== String(record.parentId || '')
        || parsed.record.username !== String(record.username || '') || parsed.record.text !== String(record.text || '')) {
        return failure('ambiguous', 'TikTok 目标评论语境已变化，停止本次动作。');
      }
      matches.push(parsed.record.element);
    }
    if (matches.length !== 1) return failure(matches.length > 1 ? 'ambiguous' : 'not-found', matches.length > 1 ? 'TikTok 目标评论稳定键重复，无法安全定位。' : 'TikTok 目标评论尚未渲染到页面。');
    return success({ element: matches[0] });
  }

  function ensureReplyVisible(record, context = {}) {
    if (context.signal?.aborted) return failure('cancelled', 'TikTok 回复操作已取消。');
    if (record?.kind !== 'reply' && !record?.parentId) return failure('unsupported', 'TikTok 删除动作仅授权处理回复。');
    const resolved = resolveElement(record, context);
    if (!resolved.ok) return resolved;
    const element = resolved.element;
    const rect = element?.getBoundingClientRect?.();
    if (!visible(element) || (rect && (rect.width <= 0 || rect.height <= 0))) return failure('not-ready', 'TikTok 回复当前不可见。');
    element.scrollIntoView?.({ block: 'center', behavior: 'auto' });
    return success({ element, visible: true });
  }

  function hover(element) {
    if (!element?.dispatchEvent) return;
    const view = element.ownerDocument?.defaultView || global;
    const rect = element.getBoundingClientRect?.();
    const point = rect ? { clientX: Math.round(rect.left + rect.width / 2), clientY: Math.round(rect.top + rect.height / 2) } : {};
    for (const [type, constructorName] of [['pointerover', 'PointerEvent'], ['pointerenter', 'PointerEvent'], ['mouseover', 'MouseEvent'], ['mouseenter', 'MouseEvent'], ['mousemove', 'MouseEvent']]) {
      try {
        const Constructor = view?.[constructorName] || global?.[constructorName] || global.Event;
        if (typeof Constructor === 'function') element.dispatchEvent(new Constructor(type, { bubbles: true, cancelable: true, view, ...point, ...(constructorName === 'PointerEvent' ? { pointerType: 'mouse' } : {}) }));
      } catch { /* 测试环境可能没有 PointerEvent 或 MouseEvent。 */ }
    }
  }

  async function revealMenu(element, context = {}) {
    if (context.mode === 'preview') return failure('unsupported', 'Preview 模式禁止打开 TikTok 评论菜单。');
    if (context.signal?.aborted) return failure('cancelled', 'TikTok 菜单操作已取消。');
    const row = rowFor(element);
    if (!row) return failure('ambiguous', 'TikTok 目标评论行无法唯一定位。');
    const initialTriggers = controls(row, MENU_TRIGGER);
    if (initialTriggers.length > 1) return failure('ambiguous', 'TikTok 评论行的更多入口不唯一。');
    hover(row);
    row.scrollIntoView?.({ block: 'center', behavior: 'auto' });
    let trigger = initialTriggers[0] || null;
    const revealed = await waitUntil(() => {
      const triggers = controls(row, MENU_TRIGGER);
      if (triggers.length === 1) { trigger = triggers[0]; return true; }
      return false;
    }, context, 1800, '正在显示 TikTok 评论更多入口...');
    if (!revealed || !trigger) {
      const triggers = controls(row, MENU_TRIGGER);
      return failure(triggers.length > 1 ? 'ambiguous' : (context.signal?.aborted ? 'cancelled' : 'not-ready'), triggers.length > 1 ? 'TikTok 评论行的更多入口不唯一。' : 'TikTok 评论行的更多入口未显示。');
    }
    trigger.focus?.();
    return success({ trigger, element: row });
  }

  function visibleSurfaces(documentRef) {
    return controls(documentRef, ACTION_SURFACE);
  }

  function waitUntil(predicate, context = {}, timeoutMs = 5000, reason = '') {
    if (context.wait?.until) return context.wait.until(predicate, { signal: context.signal, timeoutMs, intervalMs: 120, reason });
    // 页面运行时始终由 CleanerRuntime 注入 WaitCoordinator；无等待器的独立调用只能做一次无副作用检查。
    try { return Promise.resolve(!context.signal?.aborted && Boolean(predicate())); } catch { return Promise.resolve(false); }
  }

  async function getMenu(element, context = {}) {
    if (context.mode === 'preview') return failure('unsupported', 'Preview 模式禁止打开 TikTok 评论菜单。');
    const documentRef = documentFor(context);
    const row = rowFor(element);
    if (!row || !documentRef) return failure('ambiguous', 'TikTok 目标评论行或页面文档不可用。');
    const triggers = controls(row, MENU_TRIGGER);
    if (triggers.length !== 1) return failure('ambiguous', 'TikTok 评论行的更多入口不唯一。');
    const before = new Set(visibleSurfaces(documentRef));
    const clicked = context.coordinateAction
      ? await context.coordinateAction('open-comment-menu', () => { triggers[0].click?.(); return true; })
      : { ok: (triggers[0].click?.(), true) };
    if (clicked?.ok === false) return failure(clicked.error?.code || 'cancelled', clicked.error?.message || 'TikTok 评论菜单动作已取消。');
    let menu = null;
    const opened = await waitUntil(() => {
      const current = visibleSurfaces(documentRef).filter((surface) => !before.has(surface));
      if (current.length !== 1) return false;
      menu = current[0];
      return true;
    }, context, 5000, '正在打开 TikTok 评论菜单...');
    if (!opened || !menu) {
      const current = visibleSurfaces(documentRef).filter((surface) => !before.has(surface));
      return failure(current.length > 1 ? 'ambiguous' : (context.signal?.aborted ? 'cancelled' : 'not-ready'), current.length > 1 ? 'TikTok 评论菜单出现多个弹层。' : 'TikTok 评论菜单未出现。');
    }
    return success({ menu });
  }

  function findDeleteAction(menu) {
    if (!menu || !visible(menu)) return failure('not-ready', 'TikTok 评论菜单不可见。');
    const actions = controls(menu, DELETE_ACTION);
    if (actions.length === 1) return success({ action: actions[0] });
    return failure(actions.length > 1 ? 'ambiguous' : 'not-found', actions.length > 1 ? 'TikTok 评论菜单存在多个删除动作。' : '当前 TikTok 评论菜单没有可靠的删除动作。');
  }

  async function confirmDelete(action, context = {}) {
    if (context.mode === 'preview') return failure('unsupported', 'Preview 模式禁止执行 TikTok 删除动作。');
    if (context.signal?.aborted) return failure('cancelled', 'TikTok 删除操作已取消。');
    if (!action?.matches?.(DELETE_ACTION) || !visible(action)) return failure('ambiguous', 'TikTok 删除动作不是已确认的菜单按钮。');
    const documentRef = documentFor(context);
    const before = new Set(visibleSurfaces(documentRef));
    const clicked = context.coordinateAction
      ? await context.coordinateAction('delete-reply', () => { action.click?.(); return true; }, { extraDelay: context.settings?.pace?.deleteDialogDelay })
      : { ok: (action.click?.(), true) };
    if (clicked?.ok === false) return failure(clicked.error?.code || 'cancelled', clicked.error?.message || 'TikTok 删除动作已取消。');
    // TikTok 当前页面通常直接删除；若出现二次确认，只接受本次点击后新出现的唯一删除按钮。
    let confirmation = null;
    let directDeletion = false;
    let ambiguousConfirmation = false;
    const surfaced = await waitUntil(() => {
      const current = visibleSurfaces(documentRef).filter((surface) => !before.has(surface));
      const candidates = current.flatMap((surface) => controls(surface, DELETE_ACTION));
      if (current.length > 1 || candidates.length > 1) { ambiguousConfirmation = true; return true; }
      if (candidates.length === 1) { confirmation = candidates[0]; return true; }
      // 新弹层已经出现但没有唯一删除动作，不能猜测其它确认按钮。
      if (current.length === 1) { ambiguousConfirmation = true; return true; }
      const resolved = context.record ? resolveElement(context.record, context) : null;
      if (resolved?.ok === false && resolved.error?.code === 'not-found') { directDeletion = true; return true; }
      return false;
    }, context, 1500, '正在检查 TikTok 删除确认弹层...');
    if (!surfaced) {
      const current = visibleSurfaces(documentRef).filter((surface) => !before.has(surface));
      // 没有新弹层时把最终消失交给 verifyDeleted()，避免删除动画稍慢导致误判。
      if (!current.length) return success({ confirmed: true, secondConfirmation: false, pendingVerification: true });
      return failure(context.signal?.aborted ? 'cancelled' : 'ambiguous', context.signal?.aborted ? 'TikTok 删除确认已取消。' : 'TikTok 删除确认弹层不明确。');
    }
    if (ambiguousConfirmation) return failure('ambiguous', 'TikTok 删除确认弹层存在多个删除动作。');
    if (confirmation) {
      const confirmed = context.coordinateAction
        ? await context.coordinateAction('confirm-delete', () => { confirmation.click?.(); return true; })
        : { ok: (confirmation.click?.(), true) };
      if (confirmed?.ok === false) return failure(confirmed.error?.code || 'cancelled', confirmed.error?.message || 'TikTok 删除确认已取消。');
      return success({ confirmed: true, secondConfirmation: true });
    }
    return directDeletion
      ? success({ confirmed: true, secondConfirmation: false })
      : failure('ambiguous', 'TikTok 删除后未出现可确认结果。');
  }

  function recordsFor(context = {}) {
    const documentRef = documentFor(context);
    const surface = context.surface?.isConnected ? context.surface : documentRef;
    const parsed = [];
    for (const body of dom.findBodies(surface).filter(visible)) {
      const result = comments.toRecord(body, recordContext(context));
      if (!result.ok) return failure(result.error?.code || 'ambiguous', result.error?.message || 'TikTok 评论面无法稳定解析。');
      parsed.push(result.record);
    }
    return success({ records: parsed });
  }

  async function verifyDeleted(record, context = {}) {
    if (context.signal?.aborted) return failure('cancelled', 'TikTok 删除验证已取消。');
    const expectedId = String(record?.id || '');
    if (!expectedId) return failure('ambiguous', 'TikTok 删除验证缺少稳定键。');
    let duplicate = false;
    const gone = () => {
      const result = recordsFor(context);
      if (!result.ok) return false;
      const matches = result.records.filter((item) => String(item.id) === expectedId);
      duplicate = matches.length > 1;
      return matches.length === 0;
    };
    const removed = await waitUntil(gone, context, Number(context.deleteVerifyTimeoutMs) || 7000, '正在确认 TikTok 回复已删除...');
    if (!removed) return failure(context.signal?.aborted ? 'cancelled' : (duplicate ? 'ambiguous' : 'ambiguous'), context.signal?.aborted ? 'TikTok 删除验证已取消。' : 'TikTok 删除结果无法确认。');
    const stable = context.waitUntilStable
      ? await context.waitUntilStable({ timeoutMs: 10000, requireData: false, reason: '正在等待删除后的 TikTok 评论区稳定...' })
      : await global.SocialCommentTikTokSurface?.waitUntilStable?.(documentFor(context), context.target, { signal: context.signal, wait: context.wait, timeoutMs: 10000 });
    if (!stable?.ok) return failure(stable?.error?.code || 'ambiguous', stable?.error?.message || '删除后的 TikTok 评论区未稳定。');
    return success({ deleted: true });
  }

  function getHoverPoint(element) {
    const row = rowFor(element) || element;
    hover(row);
    const triggers = controls(row, MENU_TRIGGER);
    if (triggers.length !== 1) return failure(triggers.length > 1 ? 'ambiguous' : 'not-ready', triggers.length > 1 ? 'TikTok 评论行的更多入口不唯一。' : 'TikTok 评论行的更多入口未显示。');
    const rect = triggers[0].getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return failure('not-ready', 'TikTok 评论行的更多入口不可见。');
    return success({ point: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }, trigger: triggers[0] });
  }

  global.SocialCommentTikTokActions = Object.freeze({
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
