(function (global) {
  'use strict';

  function createSnapshot({ session, platform, state = '', waiting = '', error = '', pagination, refresh, actions = {} } = {}) {
    const sessionState = typeof session?.getSnapshot === 'function' ? session.getSnapshot() : (session || {});
    return Object.freeze({
      platformId: String(platform?.id || sessionState.target?.platformId || ''),
      platformName: String(platform?.displayName || ''),
      targetLabel: String(sessionState.target?.canonicalUrl || ''),
      status: String(state || sessionState.status || 'idle'),
      waiting: String(waiting || ''),
      error: String(error || sessionState.lastError || ''),
      stats: Object.freeze({ ...(sessionState.stats || {}) }),
      candidates: Object.freeze([...(sessionState.candidates || [])]),
      capabilities: Object.freeze({ ...(platform?.capabilities || {}) }),
      pagination: pagination ? Object.freeze({ ...pagination }) : null,
      refresh: refresh ? Object.freeze({ ...refresh }) : null,
      actions: Object.freeze({ canStart: true, canPreview: true, canPause: false, canStop: false, ...actions }),
    });
  }

  global.SocialCommentUiModel = Object.freeze({ createSnapshot });
})(globalThis);
