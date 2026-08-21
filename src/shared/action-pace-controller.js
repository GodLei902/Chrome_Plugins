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
  }
  global.InstagramCommentPaceController = ActionPaceController;
})(globalThis);
