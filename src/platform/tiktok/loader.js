(function (global) {
  'use strict';

  const contract = global.SocialCommentPlatformContract;
  const dom = global.SocialCommentTikTokDom;
  if (!contract || !dom) throw new Error('TikTok 回复展开依赖的平台基础模块未加载。');

  const success = (details = {}) => contract.createActionResult(true, details);
  const failure = (code, message) => contract.createActionResult(false, { code, message });

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

  async function expandParent(surface, parentElement, target, options = {}) {
    const signal = options.signal;
    if (signal?.aborted) return failure('cancelled', 'TikTok 回复展开已取消。');
    const context = { parentElement };
    const found = findExpansionControls(surface, context);
    if (!found.ok) return found;
    if (!found.controls.length) return success({ expanded: false, count: 0, complete: true });
    const control = found.controls[0];
    const scope = parentElement?.parentElement || surface;
    const beforeCount = dom.findBodies(scope).filter(dom.isVisible).length;
    const beforeExpanded = control.getAttribute?.('aria-expanded');
    const action = () => { control.click?.(); return true; };
    const coordinated = options.coordinateAction
      ? await options.coordinateAction('expand-replies', action)
      : { ok: true, value: action() };
    if (coordinated?.ok === false) return failure(coordinated.error?.code || 'cancelled', coordinated.error?.message || 'TikTok 回复展开已取消。');
    const progressed = () => signal?.aborted !== true && (
      dom.findBodies(scope).filter(dom.isVisible).length > beforeCount
      || control.isConnected === false
      || (beforeExpanded !== 'true' && control.getAttribute?.('aria-expanded') === 'true')
    );
    const wait = options.wait;
    const confirmed = wait?.until
      ? await wait.until(progressed, { signal, timeoutMs: 8000, intervalMs: 120, reason: '正在等待回复展开结果...' })
      : progressed();
    if (signal?.aborted) return failure('cancelled', 'TikTok 回复展开已取消。');
    if (!confirmed) return failure('ambiguous', 'TikTok 回复展开后未检测到新增回复，已暂停。');
    if (options.waitUntilStable) {
      const stable = await options.waitUntilStable({ timeoutMs: 10000, reason: '正在等待展开后的评论区稳定...' });
      if (stable?.ok === false) return stable;
    }
    return success({ expanded: true, count: 1, complete: false });
  }

  function expandAll(surface, target, options = {}) {
    return expandParent(surface, null, target, options);
  }

  function unsupported(name) { return failure('unsupported', `TikTok 能力尚未实现：${name}`); }

  global.SocialCommentTikTokLoader = Object.freeze({
    findExpansionControls,
    expand: expandParent,
    // 核心负责“一级评论 -> 展开 -> 扫描”的串行顺序；这里不提前批量点击。
    expandAll: () => success({ expanded: false, count: 0, complete: true }),
    expandParent,
    findLoadMoreControls: () => [],
    loadNextBatch: () => unsupported('loadNextBatch'),
    createPagination: () => null,
    getProgress: () => null,
    hasReachedEnd: () => false,
    cancel: () => success({ cancelled: true }),
  });
})(globalThis);
