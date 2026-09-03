(function (global) {
  'use strict';

  const contract = global.SocialCommentPlatformContract;
  const dom = global.SocialCommentTikTokDom;
  const stability = global.SocialCommentSurfaceStability;
  if (!contract || !dom) throw new Error('TikTok 评论面依赖的平台基础模块未加载。');

  const observers = new WeakMap();
  let generation = 0;
  const success = (details = {}) => contract.createActionResult(true, details);
  const failure = (code, message) => contract.createActionResult(false, { code, message });

  function ancestors(node) {
    const result = [];
    for (let current = node?.parentElement; current; current = current.parentElement) result.push(current);
    return result;
  }

  function discover(documentLike) {
    const documentRef = dom.documentFor(documentLike);
    const bodies = dom.findBodies(documentRef).filter(dom.isVisible);
    if (!bodies.length) return null;
    const tab = dom.commentTabState(documentRef);
    if (tab.ok) {
      const candidates = ancestors(tab.group).filter((candidate) => candidate !== documentRef && candidate !== documentRef.body && bodies.every((body) => candidate.contains?.(body)));
      if (candidates.length) return candidates[0];
    }
    const firstAncestors = ancestors(bodies[0]);
    const common = firstAncestors.find((candidate) => bodies.every((body) => candidate.contains?.(body)));
    if (!common || common === documentRef || common === documentRef.body || !dom.isVisible(common)) return null;
    return common;
  }

  function findCommentSurface(documentLike) {
    const surface = discover(documentLike);
    return surface ? success({ surface }) : failure('not-found', '当前 TikTok 页面没有唯一且可见的评论面。');
  }

  function findScrollableSurface(surface) {
    if (!surface) return null;
    // TikTok 的评论滚动容器通常是评论面后代而非祖先；优先复用 DOM 适配器的
    // 唯一候选判定，容器被虚拟列表替换后由 loader 再次调用重新发现。
    const descendant = dom.findScrollableElement?.(surface);
    if (descendant) return descendant;
    let current = surface;
    while (current && current !== current.ownerDocument?.body) {
      const style = current.ownerDocument?.defaultView?.getComputedStyle?.(current);
      if (Number(current.scrollHeight) > Number(current.clientHeight) + 1 && /(auto|scroll|overlay)/i.test(`${style?.overflowY || current.style?.overflowY || ''}`)) return current;
      current = current.parentElement;
    }
    return surface || null;
  }

  function getScrollState(node) {
    return Object.freeze({ top: Number(node?.scrollTop || 0), height: Number(node?.scrollHeight || 0), clientHeight: Number(node?.clientHeight || 0) });
  }

  function observe(surface, options = {}) {
    const Observer = options.MutationObserver || global.MutationObserver;
    if (!surface || typeof Observer !== 'function') return failure('unsupported', '当前环境不支持评论面变更观察。');
    observers.get(surface)?.disconnect?.();
    const state = { generation: ++generation, mutationVersion: 0, observer: null, listeners: new Set(), disconnected: false, surface };
    state.observer = new Observer((mutations) => {
      if (state.disconnected) return;
      state.mutationVersion += 1;
      const event = { mutations: mutations || [], mutationVersion: state.mutationVersion, generation: state.generation };
      for (const listener of [...state.listeners]) { try { listener(event); } catch { /* 回调异常不能阻断页面动作。 */ } }
      options.onMutation?.(event);
    });
    state.observer.observe(surface, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-selected', 'aria-current', 'hidden', 'style', 'class'] });
    state.subscribe = (listener) => {
      if (typeof listener !== 'function' || state.disconnected) return () => {};
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    };
    state.disconnect = () => {
      if (state.disconnected) return;
      state.disconnected = true;
      state.listeners.clear();
      state.observer?.disconnect?.();
      if (observers.get(surface) === state) observers.delete(surface);
    };
    observers.set(surface, state);
    options.signal?.addEventListener?.('abort', state.disconnect, { once: true });
    return success({ generation: state.generation, getMutationVersion: () => state.mutationVersion, subscribe: state.subscribe, disconnect: state.disconnect });
  }

  function disconnect(handle) { handle?.disconnect?.(); }
  function getMutationVersion(handle) { return Number(handle?.mutationVersion || observers.get(handle?.surface)?.mutationVersion || 0); }

  function snapshot(surface) {
    if (!surface?.isConnected) return failure('not-ready', 'TikTok 评论面已失效，需要重新发现。');
    const rows = dom.findBodies(surface).filter(dom.isVisible);
    const data = rows.map((row) => `${row.getAttribute?.('data-e2e') || ''}:${dom.getAuthor(row)}:${dom.getText(row)}`);
    const state = observers.get(surface);
    const raw = { connected: true, count: rows.length, commentIds: data, data, mutationVersion: state?.mutationVersion || 0, surfaceGeneration: state?.generation || 0, scrollTop: Number(surface.scrollTop || 0), scrollHeight: Number(surface.scrollHeight || 0) };
    raw.signature = stability?.snapshotSignature ? stability.snapshotSignature(raw) : JSON.stringify(raw);
    return success({ snapshot: raw });
  }

  function waitDelay(options, ms, reason) {
    if (options.wait?.delay) return options.wait.delay(ms, reason);
    return new Promise((resolve) => setTimeout(() => resolve(!options.signal?.aborted), Math.max(0, ms)));
  }

  async function waitStableSamples(surface, options) {
    const passes = Math.max(2, Number(options.stablePasses) || stability?.DEFAULTS?.stablePasses || 2);
    let previous = snapshot(surface).snapshot;
    if (!previous) return false;
    for (let index = 1; index < passes; index += 1) {
      if (!(await waitDelay(options, Number(options.intervalMs) || stability?.DEFAULTS?.mutationDebounceMs || 250, '正在等待评论区稳定...'))) return false;
      const next = snapshot(surface).snapshot;
      if (!next) return false;
      const same = stability?.samplesAreStable ? stability.samplesAreStable(previous, next) : previous.signature === next.signature;
      if (!same) return false;
      previous = next;
    }
    return true;
  }

  async function waitUntilStable(page, target, options = {}) {
    const documentRef = dom.documentFor(page);
    const tab = dom.commentTabState(documentRef);
    if (!tab.ok) return failure(tab.code === 'ambiguous' ? 'ambiguous' : 'not-ready', 'TikTok 评论页签尚未唯一且可见。');
    if (!tab.active) {
      if (options.signal?.aborted) return failure('cancelled', 'TikTok 评论页签准备已取消。');
      tab.button.click();
    }
    const wait = options.wait;
    const ready = wait?.until
      ? await wait.until(() => dom.commentTabState(documentRef).active && dom.hasVisibleBodies(documentRef), { signal: options.signal, timeoutMs: 5000, intervalMs: 100, reason: '正在等待 TikTok 评论页签和评论面...' })
      : dom.commentTabState(documentRef).active && dom.hasVisibleBodies(documentRef);
    if (!ready) return failure(options.signal?.aborted ? 'cancelled' : 'not-ready', 'TikTok 评论页签已切换，但评论面未完成渲染。');
    let surface = discover(documentRef);
    if (!surface) return failure('ambiguous', 'TikTok 页面存在多个或不明确的评论面。');
    let handle = observe(surface, { signal: options.signal });
    try {
      const startedAt = Date.now();
      const timeoutMs = Number(options.timeoutMs) || 15000;
      while (!options.signal?.aborted && Date.now() - startedAt < timeoutMs) {
        const current = discover(documentRef);
        if (current && current !== surface) {
          handle?.disconnect?.();
          surface = current;
          handle = observe(surface, { signal: options.signal });
        }
        if (await waitStableSamples(surface, options)) {
          const stable = snapshot(surface).snapshot;
          return success({ surface, snapshot: stable });
        }
        await waitDelay(options, 100, '正在等待评论区重新渲染...');
      }
      return failure(options.signal?.aborted ? 'cancelled' : 'not-ready', options.signal?.aborted ? '等待评论区已取消。' : 'TikTok 评论区在规定时间内未完成稳定渲染。');
    } finally {
      handle?.disconnect?.();
    }
  }

  global.SocialCommentTikTokSurface = Object.freeze({ findCommentSurface, discover, findScrollableSurface, observe, disconnect, getMutationVersion, snapshot, isVisible: dom.isVisible, getScrollState, waitUntilStable });
})(globalThis);
