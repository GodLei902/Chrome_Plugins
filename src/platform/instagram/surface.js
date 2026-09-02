(function (global) {
  'use strict';

  const contract = global.SocialCommentPlatformContract;
  const stability = global.SocialCommentSurfaceStability;
  const mutationVersions = new WeakMap();

  function documentFor(value) {
    return value?.document || value?.ownerDocument || value || global.document;
  }

  function visible(node) {
    if (!node || node.isConnected === false) return false;
    if (typeof node.getBoundingClientRect !== 'function') return true;
    const rect = node.getBoundingClientRect();
    return Boolean(rect && rect.width > 0 && rect.height > 0);
  }

  function commentIdFromUrl(value) {
    return String(value || '').match(/\/c\/(\d+)(?:\/|$)/)?.[1] || '';
  }

  function commentLinksIn(root) {
    if (!root?.querySelectorAll) return [];
    const links = [...root.querySelectorAll('a[href*="/c/"]')];
    if (root.matches?.('a[href*="/c/"]')) links.push(root);
    return [...new Set(links)].filter((link) => visible(link) && commentIdFromUrl(link.getAttribute?.('href')));
  }

  function surfaceScore(node) {
    const links = commentLinksIn(node);
    if (!links.length || !node?.isConnected || !visible(node)) return -1;
    const controls = [...node.querySelectorAll?.('button,[role="button"]') || []].filter(visible).length;
    const authors = [...node.querySelectorAll?.('a[href]') || []].filter((link) => /^\/[^/?#]+\/?$/.test(link.getAttribute?.('href') || '') && visible(link)).length;
    return Math.min(links.length, 12) * 20 + Math.min(authors, 8) * 3 + Math.min(controls, 8) - Math.min(node.querySelectorAll?.('*').length || 0, 20000) / 20000;
  }

  function discover(documentRef = global.document) {
    const links = commentLinksIn(documentRef);
    if (!links.length) return null;
    const candidates = new Set();
    links.forEach((link) => {
      for (let depth = 0, node = link; node && depth < 20; depth += 1, node = node.parentElement) {
        if (node !== documentRef.body && node !== documentRef.documentElement) candidates.add(node);
      }
    });
    const scored = [...candidates].map((node) => ({
      node,
      commentCount: commentLinksIn(node).length,
      controls: [...node.querySelectorAll?.('button,[role="button"]') || []].filter(visible).length,
      descendants: node.querySelectorAll?.('*').length || 0,
      score: surfaceScore(node),
    })).filter((item) => item.commentCount > 0 && item.score >= 0);
    const maxCommentCount = Math.max(...scored.map((item) => item.commentCount), 0);
    return scored
      .filter((item) => item.commentCount === maxCommentCount)
      .sort((left, right) => {
        if (maxCommentCount === 1 && left.controls !== right.controls) return right.controls - left.controls;
        return left.descendants - right.descendants || right.score - left.score;
      })[0]?.node || null;
  }

  function observe(surface, callbacks = {}) {
    if (!surface || typeof global.MutationObserver !== 'function') return null;
    const state = { version: 0, observer: null, surface, lastMutationAt: Date.now() };
    mutationVersions.set(surface, state);
    state.observer = new global.MutationObserver(() => {
      state.version += 1;
      state.lastMutationAt = Date.now();
      callbacks.onMutation?.(state.version);
    });
    state.observer.observe(surface, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-expanded', 'hidden', 'style', 'class'],
    });
    return state;
  }

  function disconnect(handle) {
    handle?.observer?.disconnect?.();
    if (handle?.surface) mutationVersions.delete(handle.surface);
  }

  function getMutationVersion(handle) {
    return Number(handle?.version || mutationVersions.get(handle?.surface || handle)?.version || 0);
  }

  function snapshot(surface, context = {}) {
    const commentIds = commentLinksIn(surface).map((link) => commentIdFromUrl(link.getAttribute('href'))).sort();
    const raw = {
      connected: Boolean(surface?.isConnected),
      surfaceId: String(context.surfaceId || ''),
      commentIds,
      data: [],
      mutationVersion: Number(context.mutationVersion || 0),
    };
    const signature = stability?.snapshotSignature ? stability.snapshotSignature(raw) : JSON.stringify(raw);
    return contract.createActionResult(true, { snapshot: { ...raw, signature } });
  }

  function isVisible(node) { return visible(node); }

  function findScrollableSurface(surface) {
    let candidate = surface;
    while (candidate && candidate !== candidate.ownerDocument?.body) {
      const style = global.getComputedStyle?.(candidate);
      if (candidate.scrollHeight > candidate.clientHeight && /(auto|scroll)/.test(`${style?.overflowY || candidate.style?.overflowY || ''}`)) return candidate;
      candidate = candidate.parentElement;
    }
    return surface || null;
  }

  function getScrollState(node) {
    return Object.freeze({
      top: Number(node?.scrollTop || 0),
      height: Number(node?.scrollHeight || 0),
      clientHeight: Number(node?.clientHeight || 0),
    });
  }

  function waitForDelay(ms, options, reason) {
    if (options.wait?.delay) return options.wait.delay(ms, reason);
    return new Promise((done) => setTimeout(() => done(!options.signal?.aborted), ms));
  }

  async function waitForFrames(count, options) {
    if (options.wait?.frame) return options.wait.frame(count, '正在等待评论区稳定...');
    // 保持 Window 接收者，避免在页面首轮稳定采样时触发 Illegal invocation。
    const requestFrame = (callback) => (typeof global.requestAnimationFrame === 'function'
      ? global.requestAnimationFrame(callback)
      : global.setTimeout(() => callback(Date.now()), 16));
    for (let index = 0; index < Math.max(1, Number(count) || 1); index += 1) {
      if (options.signal?.aborted) return false;
      await new Promise((done) => requestFrame(() => done()));
    }
    return !options.signal?.aborted;
  }

  async function waitUntilStable(page, target, options = {}) {
    const documentRef = documentFor(page);
    const timeoutMs = Number(options.timeoutMs) || 15000;
    const debounceMs = stability?.DEFAULTS?.mutationDebounceMs || 250;
    const stablePasses = stability?.DEFAULTS?.stablePasses || 2;
    const rafConfirmCount = stability?.DEFAULTS?.rafConfirmCount || 2;
    const startedAt = Date.now();
    let surface = discover(documentRef);
    let observer = surface ? observe(surface) : null;
    let surfaceGeneration = 0;
    try {
      while (!options.signal?.aborted && Date.now() - startedAt < timeoutMs) {
        options.onWaiting?.('正在等待评论区稳定...');
        const discovered = discover(documentRef);
        if (!surface?.isConnected || (discovered && discovered !== surface)) {
          disconnect(observer);
          surface = discovered;
          observer = surface ? observe(surface) : null;
          surfaceGeneration += 1;
          if (!surface) { await waitForDelay(120, options, '正在等待评论区出现...'); continue; }
        }
        const elapsed = Date.now() - Number(observer?.lastMutationAt || Date.now());
        if (elapsed < debounceMs) { await waitForDelay(debounceMs - elapsed, options, '正在等待评论区稳定...'); continue; }
        if (!(await waitForFrames(rafConfirmCount, options))) return contract.createActionResult(false, { code: 'cancelled', message: '等待评论区已取消。' });
        const first = snapshot(surface, { surfaceId: String(surfaceGeneration), mutationVersion: getMutationVersion(observer) }).snapshot;
        if (!first.connected || !first.commentIds.length) { await waitForDelay(120, options, '正在等待评论区出现...'); continue; }
        let previous = first;
        let stable = true;
        for (let pass = 1; pass < Math.max(1, stablePasses); pass += 1) {
          if (!(await waitForDelay(debounceMs, options, '正在等待评论区稳定...'))) return contract.createActionResult(false, { code: 'cancelled', message: '等待评论区已取消。' });
          if (!(await waitForFrames(rafConfirmCount, options))) return contract.createActionResult(false, { code: 'cancelled', message: '等待评论区已取消。' });
          const replacement = discover(documentRef);
          if (!surface?.isConnected || (replacement && replacement !== surface)) { stable = false; break; }
          const next = snapshot(surface, { surfaceId: String(surfaceGeneration), mutationVersion: getMutationVersion(observer) }).snapshot;
          const same = stability?.samplesAreStable ? stability.samplesAreStable(previous, next)
            : previous.signature === next.signature && previous.mutationVersion === next.mutationVersion;
          if (!same) { stable = false; break; }
          previous = next;
        }
        if (stable) return contract.createActionResult(true, { surface, snapshot: previous });
      }
      return contract.createActionResult(false, {
        code: options.signal?.aborted ? 'cancelled' : 'not-ready',
        message: options.signal?.aborted ? '等待评论区已取消。' : '评论区在规定时间内未完成渲染。',
      });
    } finally {
      disconnect(observer);
    }
  }

  global.SocialCommentInstagramSurface = Object.freeze({
    visible,
    commentIdFromUrl,
    commentLinksIn,
      findCommentSurface: (page) => {
        const surface = discover(documentFor(page));
        return surface
          ? contract.createActionResult(true, { surface })
          : contract.createActionResult(false, { code: 'not-found', message: '未找到当前帖子中已渲染的评论 DOM。' });
      },
    discover,
    observe,
    disconnect,
    getMutationVersion,
    snapshot,
    isVisible,
    findScrollableSurface,
    getScrollState,
    waitUntilStable,
  });
})(globalThis);
