(function (global) {
  'use strict';

  const STATUS = Object.freeze(['idle', 'preflight', 'scanning', 'running', 'cooling-down', 'scheduled-rest', 'refreshing', 'paused', 'completed', 'error', 'stopped']);
  const terminal = new Set(['completed', 'error', 'stopped']);

  function cloneStats(stats = {}) {
    return {
      scanned: Number(stats.scanned) || 0,
      loaded: Number(stats.loaded) || 0,
      matched: Number(stats.matched) || 0,
      deleted: Number(stats.deleted) || 0,
      skipped: Number(stats.skipped) || 0,
      discovered: Number(stats.discovered) || 0,
      topLevel: Number(stats.topLevel) || 0,
      replies: Number(stats.replies) || 0,
      batches: Number(stats.batches) || 0,
      newComments: Number(stats.newComments) || 0,
    };
  }

  class TaskSession {
    constructor(options = {}) {
      this.id = String(options.id || global.SocialCommentTaskSession?.createId?.() || `session-${Date.now()}`);
      this.mode = options.mode === 'preview' ? 'preview' : 'run';
      this.status = STATUS.includes(options.status) ? options.status : 'idle';
      this.target = Object.freeze({
        platformId: String(options.target?.platformId || options.target?.platform || options.platformId || ''),
        canonicalUrl: String(options.target?.canonicalUrl || options.target?.url || options.targetUrl || ''),
      });
      this.startedAt = Number(options.startedAt) || 0;
      this.stats = cloneStats(options.stats);
      this.candidates = [...(options.candidates || [])];
      this.seenIds = new Set((options.seenIds || []).map(String));
      this.matchedIds = new Set((options.matchedIds || []).map(String));
      this.skippedIds = new Set((options.skippedIds || []).map(String));
      this.processedIds = new Set((options.processedIds || []).map(String));
      this.limits = { ...(options.limits || {}) };
      this.pauseReason = String(options.pauseReason || '');
      this.lastError = String(options.lastError || '');
      this.abortController = new AbortController();
    }

    isActive() { return !terminal.has(this.status) && this.status !== 'paused' && this.status !== 'idle'; }
    setStatus(status) {
      if (!STATUS.includes(status)) throw new TypeError(`未知会话状态：${status}`);
      this.status = status;
      return this.getSnapshot();
    }
    begin(status = 'preflight') {
      if (this.abortController.signal.aborted) this.abortController = new AbortController();
      this.startedAt = this.startedAt || Date.now();
      this.pauseReason = '';
      this.lastError = '';
      return this.setStatus(status);
    }
    pause(reason = '') {
      this.pauseReason = String(reason || this.pauseReason || '任务已暂停。');
      if (!this.abortController.signal.aborted) this.abortController.abort('paused');
      return this.setStatus('paused');
    }
    stop(reason = '') {
      this.pauseReason = String(reason || '任务已停止。');
      if (!this.abortController.signal.aborted) this.abortController.abort('stopped');
      return this.setStatus('stopped');
    }
    complete(reason = '') {
      this.pauseReason = String(reason || '');
      return this.setStatus('completed');
    }
    fail(error) {
      this.lastError = String(error?.message || error || '未知错误');
      if (!this.abortController.signal.aborted) this.abortController.abort('error');
      return this.setStatus('error');
    }
    addProcessed(record) {
      const id = String(record?.id || record || '');
      if (!id || this.processedIds.has(id)) return false;
      this.processedIds.add(id);
      this.stats.deleted += 1;
      return true;
    }
    getSnapshot() {
      return Object.freeze({
        id: this.id,
        mode: this.mode,
        status: this.status,
        target: this.target,
        startedAt: this.startedAt,
        stats: Object.freeze({ ...this.stats }),
        candidates: Object.freeze([...this.candidates]),
        seenIds: Object.freeze([...this.seenIds]),
        matchedIds: Object.freeze([...this.matchedIds]),
        skippedIds: Object.freeze([...this.skippedIds]),
        processedIds: Object.freeze([...this.processedIds]),
        limits: Object.freeze({ ...this.limits }),
        pauseReason: this.pauseReason,
        lastError: this.lastError,
      });
    }
  }

  global.SocialCommentCoreTaskSession = Object.freeze({ STATUS, TaskSession, create: (options) => new TaskSession(options) });
})(globalThis);
