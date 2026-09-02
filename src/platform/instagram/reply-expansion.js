(function (global) {
  'use strict';

  const DEFAULTS = Object.freeze({ maxControls: 40, waitTimeoutMs: 8000 });

  function unique(nodes) {
    return [...new Set((nodes || []).filter(Boolean))];
  }

  function visible(node) {
    if (!node || node.isConnected === false) return false;
    if (typeof node.getBoundingClientRect !== 'function') return true;
    const rect = node.getBoundingClientRect();
    return Boolean(rect && rect.width > 0 && rect.height > 0);
  }

  function create(options = {}) {
    const locator = options.locator || global.InstagramControlLocator;
    const isActive = options.isActive || (() => true);
    const resolveScope = options.resolveScope || ((scope) => scope);
    const getRoots = options.getRoots || ((scope) => [scope].filter(Boolean));
    const getControls = options.getControls || ((roots, scope) => roots.flatMap((root) => locator?.findReplyDisclosureControls?.(root, scope) || []));
    const getCommentIds = options.getCommentIds || (() => new Set());
    const captureState = options.captureState || ((control, ids) => locator?.captureExpansionState?.(control, ids) || { control, ids: new Set(ids) });
    const isExpandedControl = options.isExpandedControl || ((control) => locator?.isExpandedReplyDisclosure?.(control));
    const coordinateAction = options.coordinateAction || (async (type, action) => ({ ok: true, value: await action(type) }));
    const waitForExpansion = options.waitForExpansion || (async ({ control, beforeIds }) => {
      const currentIds = getCommentIds();
      return [...currentIds].some((id) => !beforeIds.has(String(id)))
        || Boolean(control && (!control.isConnected || !visible(control)));
    });
    let inFlight = null;

    async function expand(scope = null, settings = {}) {
      if (inFlight) return inFlight;
      const maxControls = Number(settings.maxControls) > 0 ? Math.floor(Number(settings.maxControls)) : DEFAULTS.maxControls;
      const parentId = String(settings.parentId || '');
      inFlight = (async () => {
        const attempted = new WeakMap();
        let count = 0;
        for (let pass = 0; pass < maxControls && isActive(); pass += 1) {
          const currentScope = resolveScope(scope, { ...settings, parentId });
          const roots = unique(getRoots(currentScope, { ...settings, parentId }));
          const controls = unique(getControls(roots, currentScope, { ...settings, parentId }));
          const pending = controls.filter((node) => visible(node) && !isExpandedControl(node));
          const control = pending.find((node) => {
            const signature = locator?.elementSignature?.(node) || node;
            return attempted.get(node) !== signature;
          });
          if (!control) {
            if (pending.length) return { ok: false, status: 'paused', count, remaining: pending.length, reason: '回复展开入口状态未完成，已暂停。' };
            return { ok: true, count, remaining: 0 };
          }

          const beforeIds = new Set([...getCommentIds()].map(String));
          const beforeState = captureState(control, beforeIds);
          attempted.set(control, locator?.elementSignature?.(control) || control);
          const coordinated = await coordinateAction('expand-replies', async () => {
            control.click?.();
            return true;
          });
          if (coordinated?.ok === false) {
            return { ok: false, status: coordinated.status || 'cancelled', count, remaining: 1, reason: coordinated.reason || '回复展开动作已取消。' };
          }
          count += 1;
          const expanded = await waitForExpansion({
            control,
            beforeIds,
            beforeState,
            count,
            timeoutMs: Number(settings.waitTimeoutMs) > 0 ? Number(settings.waitTimeoutMs) : DEFAULTS.waitTimeoutMs,
          });
          if (!expanded) {
            return { ok: false, status: 'paused', count, remaining: 1, reason: '回复展开结果无法确认，已暂停。' };
          }
        }

        if (!isActive()) return { ok: false, status: 'cancelled', count, remaining: 0, reason: '回复展开已取消。' };
        const currentScope = resolveScope(scope, { ...settings, parentId });
        const roots = unique(getRoots(currentScope, { ...settings, parentId }));
        const remaining = unique(getControls(roots, currentScope, { ...settings, parentId }))
          .filter((node) => visible(node) && !isExpandedControl(node)).length;
        if (remaining) return { ok: false, status: 'paused', count, remaining, reason: '回复展开入口超过安全上限，已暂停。' };
        return { ok: true, count, remaining: 0 };
      })();
      try {
        return await inFlight;
      } finally {
        inFlight = null;
      }
    }

    return { expand, defaults: DEFAULTS };
  }

  global.InstagramCommentReplyExpansion = { DEFAULTS, create };
})(globalThis);
