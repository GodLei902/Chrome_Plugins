(function (global) {
  'use strict';
  class ActionPaceController {
    constructor(config) { this.config = config; this.reset(); }
    reset() { this.state = 'NORMAL'; this.consecutive = 0; this.failures = 0; }
    begin() { if (this.state === 'PAUSED') return false; this.state = 'BUSY'; return true; }
    success() { this.consecutive += 1; this.failures = 0; this.state = this.consecutive >= this.config.maxConsecutive ? 'REST' : 'NORMAL'; return this.state; }
    restComplete() { this.consecutive = 0; this.state = 'NORMAL'; return this.state; }
    failure() { this.consecutive = 0; this.failures += 1; this.state = this.failures >= this.config.backoff.maxFailures ? 'PAUSED' : 'BACKOFF'; return this.state; }
    backoffComplete() { if (this.state === 'BACKOFF') this.state = 'NORMAL'; return this.state; }
    pause() { this.state = 'PAUSED'; }

    // 所有页面动作统一从这里进入：先确认会话、申请额度、等待节奏，再执行动作。
    // 等待由调用方注入，以便绑定 TaskSession 的取消信号；协调器本身不持有 DOM 或定时器。
    async coordinate(type, action, options = {}) {
      const isActive = options.isActive || (() => true);
      const acquire = options.acquire || (() => true);
      const wait = options.wait || (async () => true);
      const delayMs = typeof options.delayMs === 'function' ? options.delayMs(type) : Number(options.delayMs || 0);
      if (!isActive() || !this.begin()) return { ok: false, status: 'cancelled', type };
      try {
        const quota = await acquire(type);
        if (quota === false || quota?.ok === false || !isActive()) return { ok: false, status: 'cancelled', type, quota };
        if (delayMs > 0 && !(await wait(delayMs, type))) return { ok: false, status: 'cancelled', type };
        if (!isActive()) return { ok: false, status: 'cancelled', type };
        const value = await action(type);
        return { ok: true, status: 'completed', type, value };
      } catch (error) {
        this.failure();
        throw error;
      } finally {
        if (this.state === 'BUSY') this.state = 'NORMAL';
      }
    }
  }
  global.InstagramCommentPaceController = ActionPaceController;
})(globalThis);
