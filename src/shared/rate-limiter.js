(function (global) {
  'use strict';
  class SlidingWindowRateLimiter {
    constructor(state = {}) { this.timestamps = Array.isArray(state.timestamps) ? state.timestamps.filter(Number.isFinite) : []; }
    prune(now) { this.timestamps = this.timestamps.filter((time) => time > now - 60 * 60 * 1000); }
    acquire(limits, now = Date.now()) {
      this.prune(now);
      const minute = this.timestamps.filter((time) => time > now - 60 * 1000);
      const hour = this.timestamps;
      const waits = [];
      if (minute.length >= limits.perMinute) waits.push(minute[0] + 60 * 1000 - now);
      if (hour.length >= limits.perHour) waits.push(hour[0] + 60 * 60 * 1000 - now);
      if (waits.length) return { ok: false, retryAfterMs: Math.max(1, Math.max(...waits)) };
      this.timestamps.push(now);
      return { ok: true, retryAfterMs: 0 };
    }
    snapshot() { return { timestamps: [...this.timestamps] }; }
  }
  global.InstagramCommentRateLimiter = SlidingWindowRateLimiter;
})(globalThis);
