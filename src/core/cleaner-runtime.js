(function (global) {
  'use strict';

  const contract = global.SocialCommentPlatformContract;
  const candidatePolicy = global.SocialCommentCandidatePolicy;
  const sessions = global.SocialCommentCoreTaskSession;
  const uiModel = global.SocialCommentUiModel;

  if (!contract || !candidatePolicy || !sessions || !uiModel) {
    throw new Error('CleanerRuntime 必须在核心契约、候选策略、会话和 UI 模型之后加载。');
  }

  const DEFAULT_STATS = Object.freeze({ scanned: 0, loaded: 0, matched: 0, deleted: 0, skipped: 0, discovered: 0, topLevel: 0, replies: 0, batches: 0, newComments: 0 });
  const ACTIVE_STATES = new Set(['preflight', 'waiting-surface', 'expanding', 'stabilizing', 'scanning', 'loading', 'running', 'cooling-down', 'scheduled-rest', 'refreshing']);

  function resultError(result, fallback) {
    return result?.error || contract.createPlatformError(result?.code, result?.reason || result?.message || fallback);
  }

  function resultValue(result, field) {
    if (!result || typeof result !== 'object') return result;
    return result[field] ?? result.value ?? result;
  }

  function replyIds(threads, ids = new Set()) {
    for (const thread of threads || []) {
      for (const reply of thread.replies || []) {
        if (reply?.id) ids.add(String(reply.id));
        replyIds([{ replies: reply.replies }], ids);
      }
    }
    return ids;
  }

  function defaultRefresh() {
    return { count: 0, restStartedAt: 0, restDelayMs: 0, nextRefreshAt: 0, lastReason: '' };
  }

  class CleanerRuntime {
    constructor({ platform, settings, transport, waitFactory, onSnapshot, pace, delayGenerator, clock } = {}) {
      if (!platform) throw new TypeError('CleanerRuntime 必须提供平台插件。');
      this.platform = platform;
      this.settings = settings || {};
      this.transport = transport || { send: async () => ({ ok: true }) };
      this.waitFactory = waitFactory || global.SocialCommentWaitCoordinator?.create;
      this.onSnapshot = typeof onSnapshot === 'function' ? onSnapshot : () => {};
      this.pace = pace || null;
      this.delayGenerator = typeof delayGenerator === 'function' ? delayGenerator : () => 0;
      // Chrome 内容脚本会校验 Window 定时器的接收者，默认时钟不能直接保存原生方法引用。
      this.clock = clock || {
        now: () => Date.now(),
        setInterval: (callback, delay) => global.setInterval(callback, delay),
        clearInterval: (timer) => global.clearInterval(timer),
      };
      this.session = null;
      this.page = null;
      this.target = null;
      this.state = 'idle';
      this.waiting = '';
      this.error = '';
      this.pagination = null;
      this.completedParentIds = new Set();
      this.previewCandidateMap = new Map();
      this.seenCommentIds = new Set();
      this.seenReplyIds = new Set();
      this.refresh = defaultRefresh();
      this.lockTimer = null;
      this.restTimer = null;
      this.wait = null;
      this.running = null;
    }

    snapshot() {
      return uiModel.createSnapshot({
        session: this.session,
        platform: this.platform,
        state: this.state,
        waiting: this.waiting,
        error: this.error,
        pagination: this.pagination?.getSnapshot?.() || null,
        refresh: this.refresh,
        actions: {
          canStart: !this.isActive(),
          canPreview: !this.isActive() && this.state !== 'paused',
          canPause: this.isActive() && this.state !== 'scheduled-rest',
          canStop: Boolean(this.session && this.state !== 'idle' && this.state !== 'stopped'),
        },
      });
    }

    emit() { this.onSnapshot(this.snapshot()); }

    isActive() {
      return Boolean(this.session && !this.session.abortController.signal.aborted && ACTIVE_STATES.has(this.state));
    }

    setState(state, waiting = this.waiting) {
      this.state = state;
      this.waiting = String(waiting || '');
      this.emit();
    }

    createWait() {
      this.wait?.cancelAll?.();
      this.wait = this.waitFactory?.({
        signal: this.session?.abortController.signal,
        onWaiting: (reason) => this.setState(this.state, reason),
      }) || null;
      return this.wait;
    }

    fail(error) {
      this.error = String(error?.message || error || '未知错误');
      this.session?.fail(this.error);
      this.state = 'error';
      this.emit();
      return { ok: false, error: contract.createPlatformError('unknown', this.error), reason: this.error };
    }

    async invoke(method, ...args) {
      if (typeof method !== 'function') throw Object.assign(new Error('平台能力未实现。'), { platformError: contract.createPlatformError('unsupported', '平台能力未实现。') });
      const result = await method(...args);
      if (result?.ok === false) {
        const error = resultError(result, '平台操作失败。');
        throw Object.assign(new Error(error.message), { platformError: error });
      }
      return result;
    }

    classify(error, context = {}) {
      return error?.platformError || this.platform.errors.classify(error, context);
    }

    async pauseForError(error, context = {}) {
      const classified = this.classify(error, context);
      this.error = this.platform.errors.toUserMessage(classified);
      const paused = await this.pause(this.error);
      return paused.ok ? { ok: false, error: classified, reason: this.error } : paused;
    }

    initializeSession({ mode, target, checkpoint } = {}) {
      const restored = checkpoint && global.SocialCommentTaskSession?.normalize?.(checkpoint);
      this.session = sessions.create({
        id: restored?.sessionId,
        mode: restored?.mode || mode,
        status: 'idle',
        target: { platformId: this.platform.id, canonicalUrl: target.canonicalUrl },
        startedAt: restored?.startedAt,
        stats: { ...DEFAULT_STATS, ...(restored?.stats || {}) },
        processedIds: restored?.processedIds,
        limits: { sessionLimit: this.settings.sessionLimit, sessionMaxMinutes: this.settings.sessionMaxMinutes },
      });
      this.completedParentIds = new Set();
      this.previewCandidateMap = new Map();
      this.seenCommentIds = new Set();
      this.seenReplyIds = new Set();
      this.refresh = { ...defaultRefresh(), ...(restored?.refresh || {}) };
      if (!this.pace && typeof global.SocialCommentActionPaceController === 'function') {
        this.pace = new global.SocialCommentActionPaceController(this.settings.pace);
      }
      if (restored?.pace && this.pace) {
        this.pace.state = restored.pace.state || this.pace.state;
        this.pace.consecutive = Number(restored.pace.consecutive) || 0;
        this.pace.failures = Number(restored.pace.failures) || 0;
      }
      this.createWait();
      this.session.begin('preflight');
      this.state = restored?.status === 'scheduled-rest' && this.refresh.nextRefreshAt > this.clock.now() ? 'scheduled-rest' : 'preflight';
    }

    async preflight(page, target) {
      const context = { signal: this.session.abortController.signal, page, target };
      // 旧链路只在页面目标和风险页确认后继续；账号/作者/删除权限仍由
      // 插件在首次真实菜单动作前作同一轮 DOM 确认，不能在这里改变等待时机。
      let targetReady = false;
      for (let attempt = 0; attempt < 20 && !targetReady && !context.signal.aborted; attempt += 1) {
        const result = await this.platform.preflight.checkTarget(page, target, context);
        targetReady = Boolean(result?.ok);
        if (!targetReady) await this.wait?.delay?.(300, '');
      }
      await this.invoke(this.platform.preflight.checkTarget, page, target, context);
    }

    startLease() {
      this.stopLease();
      this.lockTimer = this.clock.setInterval?.(() => {
        if (!this.target?.canonicalUrl || !this.isActive()) return;
        this.transport.send('SC_RENEW_LOCK', { platformId: this.platform.id, canonicalTargetUrl: this.target.canonicalUrl });
      }, 30000) || null;
    }

    stopLease() {
      if (this.lockTimer !== null) this.clock.clearInterval?.(this.lockTimer);
      this.lockTimer = null;
    }

    async start({ mode = 'run', targetUrl, page, checkpoint, autoRun = false } = {}) {
      if (this.running || this.isActive()) return { ok: false, reason: '任务正在运行。' };
      const canonicalTargetUrl = this.platform.identity.normalizeTargetUrl(targetUrl);
      if (!canonicalTargetUrl) return this.fail('目标 URL 无效。');
      const target = this.platform.identity.getTargetContext?.(canonicalTargetUrl) || { platformId: this.platform.id, canonicalUrl: canonicalTargetUrl };
      this.page = page;
      this.target = { ...target, canonicalUrl: target.canonicalUrl || canonicalTargetUrl };
      this.error = '';
      this.initializeSession({ mode, target: this.target, checkpoint });
      this.emit();
      try {
        await this.preflight(page, this.target);
        const lock = await this.transport.send('SC_ACQUIRE_LOCK', { platformId: this.platform.id, canonicalTargetUrl: this.target.canonicalUrl });
        if (!lock?.ok) throw new Error(lock?.reason || '无法获取目标任务锁。');
        this.startLease();
        await this.createPagination(null);
        if (this.state === 'scheduled-rest') {
          await this.restoreScheduledRest();
          return { ok: true, target: this.target, snapshot: this.snapshot(), scheduled: true };
        }
        this.setState('running');
        const saved = await this.saveCheckpoint('running');
        if (!saved.ok) throw new Error(saved.reason);
        if (autoRun) this.run();
        return { ok: true, target: this.target, snapshot: this.snapshot() };
      } catch (error) {
        this.stopLease();
        const failed = await this.pauseForError(error, { page, target: this.target });
        return failed;
      }
    }

    run() {
      if (this.running) return this.running;
      this.running = this.process().finally(() => { this.running = null; });
      return this.running;
    }

    async stableSurface(options = {}) {
      this.setState('waiting-surface', options.reason || '正在等待评论区稳定...');
      const result = await this.invoke(this.platform.surface.waitUntilStable, this.page, this.target, {
        ...options,
        signal: this.session.abortController.signal,
        wait: this.wait,
        onWaiting: (reason) => this.setState('stabilizing', reason),
      });
      return resultValue(result, 'surface') ? result : { surface: resultValue(result, 'surface') };
    }

    async readThreads(surface) {
      const recordsResult = await this.invoke(this.platform.comments.collect, surface, this.target, { signal: this.session.abortController.signal, page: this.page, surface });
      const records = resultValue(recordsResult, 'records') || [];
      const threadsResult = await this.invoke(this.platform.comments.buildThreads, records, { signal: this.session.abortController.signal, page: this.page, surface, target: this.target });
      const threads = resultValue(threadsResult, 'threads') || [];
      return { records, threads };
    }

    updateScanStats(records, threads, selected) {
      const allIds = new Set((records || []).map((record) => String(record?.id || '')).filter(Boolean));
      const replies = replyIds(threads);
      allIds.forEach((id) => this.seenCommentIds.add(id));
      replies.forEach((id) => { this.session.seenIds.add(id); this.seenReplyIds.add(id); });
      selected.candidates.forEach((record) => this.session.matchedIds.add(String(record.id)));
      selected.skippedIds.forEach((id) => this.session.skippedIds.add(String(id)));
      this.session.stats.scanned = records.length;
      this.session.stats.loaded = this.seenReplyIds.size;
      this.session.stats.replies = this.seenReplyIds.size;
      this.session.stats.topLevel = [...this.seenCommentIds].filter((id) => !this.seenReplyIds.has(id)).length;
      this.session.stats.discovered = this.seenCommentIds.size;
      this.session.stats.matched = this.session.matchedIds.size;
      this.session.stats.skipped = this.session.skippedIds.size;
    }

    async scan() {
      if (!this.session) throw new Error('任务会话尚未启动。');
      this.session.setStatus('scanning');
      this.setState('scanning', '正在等待评论区稳定...');
      const stable = await this.stableSurface({ timeoutMs: 15000, requireData: false, reason: '正在等待评论区出现...' });
      const surface = resultValue(stable, 'surface');
      await this.invoke(this.platform.loader.expandAll, surface, this.target, this.actionContext({ surface }));
      const refreshed = await this.stableSurface({ timeoutMs: 15000, requireData: false, reason: '正在等待展开后的评论区稳定...' });
      const resolvedSurface = resultValue(refreshed, 'surface') || surface;
      let { records, threads } = await this.readThreads(resolvedSurface);
      if (resolvedSurface !== this.page) {
        const fallback = await this.readThreads(this.page);
        if (fallback.records.length > records.length || replyIds(fallback.threads).size > replyIds(threads).size) {
          records = fallback.records;
          threads = fallback.threads;
        }
      }
      const selected = candidatePolicy.selectCandidates(threads, candidatePolicy.prepareRules(this.settings), this.platform.capabilities);
      this.updateScanStats(records, threads, selected);
      this.session.candidates = selected.candidates.filter((record) => !this.session.processedIds.has(String(record.id)));
      this.session.setStatus('running');
      this.setState('running');
      return { ok: true, surface: resolvedSurface, records, threads, candidates: this.session.candidates };
    }

    actionContext(extra = {}) {
      return {
        signal: this.session?.abortController.signal,
        page: this.page,
        target: this.target,
        wait: this.wait,
        settings: this.settings,
        coordinateAction: (type, action, options) => this.coordinateAction(type, action, options),
        waitUntilStable: (options) => this.stableSurface(options),
        ...extra,
      };
    }

    async scanParent(parentId) {
      const stable = await this.stableSurface({ timeoutMs: 15000, requireData: false, reason: '正在等待当前一级评论稳定...' });
      const surface = resultValue(stable, 'surface');
      const { records, threads } = await this.readThreads(surface);
      let parent = (this.platform.comments.findParent?.(threads, parentId) || threads.find((item) => String(item?.id) === String(parentId)));
      let resolvedRecords = records;
      let resolvedThreads = threads;
      if (!parent && surface !== this.page) {
        const fallback = await this.readThreads(this.page);
        parent = this.platform.comments.findParent?.(fallback.threads, parentId) || fallback.threads.find((item) => String(item?.id) === String(parentId));
        if (parent) { resolvedRecords = fallback.records; resolvedThreads = fallback.threads; }
      }
      if (!parent) throw Object.assign(new Error('当前一级评论已被页面替换，无法重新定位，已暂停。'), { platformError: contract.createPlatformError('ambiguous', '当前一级评论已被页面替换，无法重新定位，已暂停。') });
      const selected = candidatePolicy.selectCandidates([parent], candidatePolicy.prepareRules(this.settings), this.platform.capabilities);
      this.updateScanStats(resolvedRecords, [parent], selected);
      if (this.session.mode === 'preview') {
        selected.candidates.forEach((record) => this.previewCandidateMap.set(String(record.id), record));
        this.session.candidates = [...this.previewCandidateMap.values()];
      } else {
        this.session.candidates = selected.candidates.filter((record) => !this.session.processedIds.has(String(record.id)));
      }
      this.setState('running');
      return { surface, parent, threads: resolvedThreads, candidates: this.session.candidates, ids: replyIds([parent]) };
    }

    async acquireRate() {
      while (this.isActive()) {
        const result = await this.transport.send('SC_RATE_ACQUIRE', { platformId: this.platform.id, canonicalTargetUrl: this.target.canonicalUrl, limits: this.settings.pace?.rateLimit });
        if (result?.ok) return true;
        if (!Number.isFinite(result?.retryAfterMs)) throw new Error(result?.reason || '无法申请操作额度。');
        if (!(await this.wait?.delay?.(result.retryAfterMs, `全局操作上限已满，等待 ${Math.ceil(result.retryAfterMs / 1000)} 秒...`))) return false;
      }
      return false;
    }

    async coordinateAction(type, action, options = {}) {
      if (!this.pace?.coordinate) return { ok: await action(type), status: 'completed', type };
      const operationDelay = this.delayGenerator(this.settings.pace?.operation);
      const extraDelay = options.extraDelay ? this.delayGenerator(options.extraDelay) : 0;
      return this.pace.coordinate(type, action, {
        isActive: () => this.isActive(),
        acquire: () => this.acquireRate(),
        delayMs: operationDelay + extraDelay,
        wait: (ms) => this.wait?.delay?.(ms, type === 'open-comment-menu' ? '正在准备打开评论菜单...' : type === 'scroll-comment-surface' ? '正在准备滚动评论区...' : '正在准备下一次页面操作...'),
      });
    }

    async executeCandidate(record) {
      if (!this.session || this.session.mode === 'preview') return { ok: true, preview: true };
      if (this.session.processedIds.has(String(record?.id || ''))) return { ok: true, skipped: true };
      const context = this.actionContext({ record });
      try {
        this.setState('running');
        await this.invoke(this.platform.actions.ensureReplyVisible, record, context);
        const resolved = await this.invoke(this.platform.actions.resolveElement, record, context);
        const element = resultValue(resolved, 'element');
        await this.invoke(this.platform.actions.revealMenu, element, context);
        const menu = await this.invoke(this.platform.actions.getMenu, element, context);
        const deleteAction = await this.invoke(this.platform.actions.findDeleteAction, resultValue(menu, 'menu'), context);
        await this.invoke(this.platform.actions.confirmDelete, resultValue(deleteAction, 'action'), context);
        const verified = await this.invoke(this.platform.actions.verifyDeleted, record, context);
        if (!(verified.deleted ?? verified.value ?? verified === true)) throw new Error('删除结果无法确认，已暂停。');
        this.session.addProcessed(record);
        this.emit();
        return { ok: true, deleted: true };
      } catch (error) {
        return this.pauseForError(error, { ...context, record });
      }
    }

    async createPagination(surface) {
      if (this.pagination || typeof this.platform.loader.createPagination !== 'function') return this.pagination;
      const result = await this.platform.loader.createPagination(surface, this.settings.pagination || {}, this.actionContext({ surface, onProgress: () => this.emit() }));
      this.pagination = resultValue(result, 'pagination') || result || null;
      return this.pagination;
    }

    nextParent(threads) {
      if (typeof this.platform.comments.nextParent === 'function') return this.platform.comments.nextParent(threads, this.completedParentIds);
      return (threads || []).find((item) => item?.kind === 'root' && item.id && !this.completedParentIds.has(String(item.id))) || null;
    }

    limitReached() {
      if (Number(this.settings.sessionMaxMinutes) > 0 && this.clock.now() - this.session.startedAt >= Number(this.settings.sessionMaxMinutes) * 60000) return '已达到本次任务运行时间上限。';
      if (this.session.mode !== 'preview' && this.settings.sessionLimit !== 'unlimited' && this.session.stats.deleted >= Number(this.settings.sessionLimit)) return '已达到本次任务删除数量上限。';
      return '';
    }

    async process() {
      if (this.session.mode !== 'preview' && !candidatePolicy.prepareRules(this.settings).keywords.length) {
        this.setState('running', '扫描完成，未配置删除关键词。');
        return this.stop('idle');
      }
      try {
        // 与旧流程一致：取得任务锁后，在首次扫描评论区前识别挑战、验证和限流页面。
        await this.invoke(this.platform.preflight.detectPageState, this.page, this.target, this.actionContext());
        const initial = await this.stableSurface({ timeoutMs: 15000, requireData: false, reason: '正在等待评论区出现...' });
        let surface = resultValue(initial, 'surface');
        while (this.isActive()) {
          const limitReason = this.limitReached();
          if (limitReason) return this.pause(limitReason);
          let current = await this.readThreads(surface);
          let parent = this.nextParent(current.threads);
          if (!parent && surface !== this.page) {
            const fallback = await this.readThreads(this.page);
            const fallbackParent = this.nextParent(fallback.threads);
            if (fallbackParent) { current = fallback; parent = fallbackParent; }
          }
          if (parent) {
            const parentId = String(parent.id);
            this.setState('expanding');
            const resolved = await this.invoke(this.platform.actions.resolveElement, parent, this.actionContext({ surface, record: parent }));
            const parentElement = resultValue(resolved, 'element');
            await this.invoke(this.platform.loader.expandParent, surface, parentElement, this.target, this.actionContext({ surface, parentId }));
            const scanned = await this.scanParent(parentId);
            surface = scanned.surface || surface;
            while (this.session.mode !== 'preview' && this.session.candidates.length && this.isActive()) {
              const candidate = this.session.candidates.shift();
              if (!candidate || this.session.processedIds.has(String(candidate.id))) continue;
              const deleted = await this.executeCandidate(candidate);
              if (!deleted.ok) return deleted;
              const saved = await this.saveCheckpoint('running');
              if (!saved.ok) throw new Error(saved.reason);
              const paceState = this.pace?.success?.();
              // 删除会重绘评论面；沿用旧流程，按父级 ID 重新定位后再继续展开。
              const refreshedParent = await this.invoke(this.platform.actions.resolveElement, parent, this.actionContext({ surface, record: parent }));
              await this.invoke(this.platform.loader.expandParent, surface, resultValue(refreshedParent, 'element'), this.target, this.actionContext({ surface, parentId }));
              const refreshed = await this.scanParent(parentId);
              surface = refreshed.surface || surface;
              if (paceState === 'REST') {
                this.setState('cooling-down');
                if (!(await this.wait?.delay?.(this.delayGenerator(this.settings.pace?.rest), '连续处理达到上限，正在休息...'))) return { ok: false, cancelled: true };
                this.pace.restComplete?.();
              }
            }
            this.completedParentIds.add(parentId);
            continue;
          }
          if (!this.pagination) return this.finishCurrentRound('当前稳定评论容器中没有待处理回复。');
          const before = this.pagination.getSnapshot?.();
          if (before?.phase === 'completed') return this.finishCurrentRound(before.terminalReason || '当前页面没有更多可加载评论。');
          this.setState('loading', '正在准备加载下一批评论...');
          const loaded = await this.invoke(this.platform.loader.loadNextBatch, surface, this.target, this.actionContext({ surface, pagination: this.pagination }));
          this.pagination = resultValue(loaded, 'pagination') || this.pagination;
          const progress = resultValue(loaded, 'progress') || this.pagination?.getSnapshot?.() || {};
          this.session.stats.batches = Number(progress.batchIndex) || 0;
          this.session.stats.newComments = Number(progress.newIds) || 0;
          this.emit();
          if (progress.status === 'completed' && !progress.newIds) return this.finishCurrentRound(progress.terminalReason || '当前页面没有更多可加载评论。');
          const stable = await this.stableSurface({ timeoutMs: 15000, requireData: false, reason: '正在等待下一批评论稳定...' });
          surface = resultValue(stable, 'surface') || surface;
        }
      } catch (error) {
        if (this.session?.status === 'paused' || this.session?.abortController.signal.aborted) return { ok: false, cancelled: true };
        return this.pauseForError(error, this.actionContext());
      }
      return { ok: false, cancelled: true };
    }

    checkpoint(status = this.state, reason = this.error || '') {
      return global.SocialCommentTaskSession?.create?.({
        sessionId: this.session?.id,
        target: { platformId: this.platform.id, canonicalUrl: this.target?.canonicalUrl || '' },
        mode: this.session?.mode,
        status,
        startedAt: this.session?.startedAt,
        stats: this.session?.stats,
        processedIds: [...(this.session?.processedIds || [])],
        refresh: this.refresh,
        pace: { state: this.pace?.state || 'NORMAL', consecutive: this.pace?.consecutive || 0, failures: this.pace?.failures || 0 },
        reason,
      }) || null;
    }

    async saveCheckpoint(status = this.state, reason = '') {
      if (!this.target?.canonicalUrl || !this.session?.id) return { ok: false, reason: '当前没有可保存的任务会话。' };
      const response = await this.transport.send('SC_SAVE_SESSION', { platformId: this.platform.id, canonicalTargetUrl: this.target.canonicalUrl, snapshot: this.checkpoint(status, reason) });
      return response?.ok ? response : { ok: false, reason: response?.reason || '任务检查点保存失败。' };
    }

    clearRestTimer() {
      if (this.restTimer !== null) this.clock.clearInterval?.(this.restTimer);
      this.restTimer = null;
    }

    async finishCurrentRound(reason) {
      if (this.session.mode === 'preview') return this.stop('completed', `预览完成：${reason}`);
      return this.enterScheduledRest(`本轮已完成：${reason}`);
    }

    async enterScheduledRest(reason) {
      if (this.session.mode === 'preview' || !this.isActive() || this.state === 'scheduled-rest') return { ok: true };
      const delay = global.SocialCommentScheduledRest?.generate?.(this.settings.pace?.refreshRest) || 0;
      this.refresh = { ...this.refresh, count: this.refresh.count + 1, restStartedAt: this.clock.now(), restDelayMs: delay, nextRefreshAt: this.clock.now() + delay, lastReason: reason };
      this.setState('scheduled-rest', reason);
      const saved = await this.saveCheckpoint('scheduled-rest', reason);
      if (!saved.ok) return this.pause(saved.reason);
      const scheduled = await this.transport.send('SC_SCHEDULE_REFRESH', { platformId: this.platform.id, canonicalTargetUrl: this.target.canonicalUrl, nextRefreshAt: this.refresh.nextRefreshAt, sessionId: this.session.id });
      if (!scheduled?.ok) return this.pause(scheduled?.reason || '无法安排下一轮刷新。');
      this.clearRestTimer();
      this.restTimer = this.clock.setInterval?.(() => this.emit(), 1000) || null;
      return { ok: true };
    }

    async restoreScheduledRest() {
      const scheduled = await this.transport.send('SC_SCHEDULE_REFRESH', { platformId: this.platform.id, canonicalTargetUrl: this.target.canonicalUrl, nextRefreshAt: this.refresh.nextRefreshAt, sessionId: this.session.id });
      if (!scheduled?.ok) throw new Error(scheduled?.reason || '无法恢复下一轮刷新。');
      this.clearRestTimer();
      this.restTimer = this.clock.setInterval?.(() => this.emit(), 1000) || null;
    }

    async pause(reason = '任务已暂停。') {
      this.pagination?.cancel?.('自动加载已暂停。', 'paused');
      this.platform.loader.cancel?.(this.actionContext({ pagination: this.pagination }));
      this.wait?.cancelAll?.();
      this.clearRestTimer();
      this.session?.pause(reason);
      this.state = 'paused';
      this.waiting = '已暂停，点击“开始”继续。';
      if (this.target?.canonicalUrl) await this.transport.send('SC_CANCEL_REFRESH', { platformId: this.platform.id, canonicalTargetUrl: this.target.canonicalUrl });
      const saved = await this.saveCheckpoint('paused', reason);
      await this.releaseLock();
      this.emit();
      return saved.ok ? { ok: true } : saved;
    }

    async releaseLock() {
      this.stopLease();
      if (this.target?.canonicalUrl) await this.transport.send('SC_RELEASE_LOCK', { platformId: this.platform.id, canonicalTargetUrl: this.target.canonicalUrl });
    }

    async stop(finalState = 'idle', reason = '') {
      this.pagination?.cancel?.('自动加载已停止。', 'cancelled');
      this.platform.loader.cancel?.(this.actionContext({ pagination: this.pagination }));
      this.wait?.cancelAll?.();
      this.clearRestTimer();
      this.session?.stop(reason || '任务已停止。');
      this.state = finalState;
      this.waiting = reason || (finalState === 'completed' ? this.waiting : '');
      if (this.target?.canonicalUrl) {
        await this.transport.send('SC_CANCEL_REFRESH', { platformId: this.platform.id, canonicalTargetUrl: this.target.canonicalUrl });
        if (finalState === 'paused') await this.saveCheckpoint('paused', reason || this.error);
        else await this.transport.send('SC_CLEAR_SESSION', { platformId: this.platform.id, canonicalTargetUrl: this.target.canonicalUrl });
      }
      await this.releaseLock();
      this.emit();
      return { ok: true };
    }
  }

  global.SocialCommentCleanerRuntime = Object.freeze({ CleanerRuntime, create: (options) => new CleanerRuntime(options) });
})(globalThis);
