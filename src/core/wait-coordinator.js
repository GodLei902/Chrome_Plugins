(function (global) {
  'use strict';

  class WaitCoordinator {
    constructor({ signal, onWaiting } = {}) {
      this.signal = signal || null;
      this.onWaiting = typeof onWaiting === 'function' ? onWaiting : () => {};
      this.pending = new Set();
    }

    isCancelled() { return Boolean(this.signal?.aborted); }
    cancelAll() {
      for (const pending of this.pending) pending.finish(false);
      this.pending.clear();
    }

    delay(ms, reason = '') {
      if (this.isCancelled()) return Promise.resolve(false);
      this.onWaiting(reason);
      return new Promise((resolve) => {
        let settled = false;
        let abortHandler = null;
        const pending = {
          finish: (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            this.signal?.removeEventListener?.('abort', abortHandler);
            this.pending.delete(pending);
            resolve(Boolean(value));
          },
        };
        const timer = setTimeout(() => pending.finish(!this.isCancelled()), Math.max(0, Number(ms) || 0));
        this.pending.add(pending);
        abortHandler = () => pending.finish(false);
        this.signal?.addEventListener?.('abort', abortHandler, { once: true });
      });
    }

    until(predicate, { timeoutMs, intervalMs = 120, reason = '' } = {}) {
      if (this.isCancelled()) return Promise.resolve(false);
      this.onWaiting(reason);
      return new Promise((resolve) => {
        const startedAt = Date.now();
        let timer = null;
        let settled = false;
        let abortHandler = null;
        const pending = {
          finish: (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            this.signal?.removeEventListener?.('abort', abortHandler);
            this.pending.delete(pending);
            resolve(Boolean(value));
          },
        };
        const check = () => {
          if (this.isCancelled()) return pending.finish(false);
          let matched = false;
          try { matched = Boolean(predicate()); } catch { matched = false; }
          if (matched || Date.now() - startedAt >= Math.max(0, Number(timeoutMs) || 0)) return pending.finish(matched);
          timer = setTimeout(check, Math.max(1, Number(intervalMs) || 120));
        };
        this.pending.add(pending);
        abortHandler = () => pending.finish(false);
        this.signal?.addEventListener?.('abort', abortHandler, { once: true });
        check();
      });
    }

    frame(count = 1, reason = '') {
      if (this.isCancelled()) return Promise.resolve(false);
      this.onWaiting(reason);
      const required = Math.max(1, Math.floor(Number(count) || 1));
      // 部分浏览器会校验 requestAnimationFrame 的 Window 接收者，不能提取后以普通函数调用。
      const requestFrame = (callback) => (typeof global.requestAnimationFrame === 'function'
        ? global.requestAnimationFrame(callback)
        : global.setTimeout(() => callback(Date.now()), 16));
      const cancelFrame = (frameId) => (typeof global.cancelAnimationFrame === 'function'
        ? global.cancelAnimationFrame(frameId)
        : global.clearTimeout(frameId));
      return new Promise((resolve) => {
        let settled = false;
        let completed = 0;
        let frameId = null;
        let timeoutId = null;
        let abortHandler = null;
        const pending = {
          finish: (value) => {
            if (settled) return;
            settled = true;
            if (frameId !== null) cancelFrame(frameId);
            clearTimeout(timeoutId);
            this.signal?.removeEventListener?.('abort', abortHandler);
            this.pending.delete(pending);
            resolve(Boolean(value));
          },
        };
        const next = () => {
          if (this.isCancelled()) return pending.finish(false);
          completed += 1;
          if (completed >= required) return pending.finish(true);
          frameId = requestFrame(next);
        };
        timeoutId = setTimeout(() => pending.finish(!this.isCancelled()), Math.max(120, required * 120));
        this.pending.add(pending);
        abortHandler = () => pending.finish(false);
        this.signal?.addEventListener?.('abort', abortHandler, { once: true });
        frameId = requestFrame(next);
      });
    }
  }

  global.SocialCommentWaitCoordinator = Object.freeze({ WaitCoordinator, create: (options) => new WaitCoordinator(options) });
})(globalThis);
