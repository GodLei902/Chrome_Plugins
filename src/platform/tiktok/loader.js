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
