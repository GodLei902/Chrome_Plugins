(function (global) {
  'use strict';

  // 平台插件与通用运行时之间的最小数据契约。阶段 0 只建立边界，
  // 后续阶段再逐步把现有 Instagram 页面能力接入这些方法组。
  const ERROR_CODES = Object.freeze([
    'not-ready',
    'not-found',
    'ambiguous',
    'permission',
    'challenge',
    'rate-limited',
    'unsupported',
    'cancelled',
    'unknown',
  ]);

  const DEFAULT_CAPABILITIES = Object.freeze({
    supportsReplies: false,
    supportsNestedReplies: false,
    supportsAutoLoad: false,
    supportsCommentDelete: false,
    requiresAuthorConfirmation: true,
    supportsPreview: true,
  });

  function isErrorCode(code) {
    return ERROR_CODES.includes(code);
  }

  function createPlatformError(code, message, details = {}) {
    const normalizedCode = isErrorCode(code) ? code : 'unknown';
    const { code: ignoredCode, message: ignoredMessage, ...extraDetails } = details;
    void ignoredCode;
    void ignoredMessage;
    return {
      code: normalizedCode,
      message: String(message || '平台操作失败。'),
      ...extraDetails,
    };
  }

  function createActionResult(ok, details = {}) {
    if (ok) return { ok: true, ...details };
    const error = details.error?.code
      ? details.error
      : createPlatformError(details.code, details.message, details);
    const result = { ok: false, error };
    if (details.reason) result.reason = details.reason;
    return result;
  }

  function createUnsupported(methodName) {
    return () => createActionResult(false, {
      code: 'unsupported',
      message: `当前插件尚未实现能力：${methodName}`,
    });
  }

  function normalizeCapabilities(capabilities) {
    return Object.freeze({ ...DEFAULT_CAPABILITIES, ...(capabilities || {}) });
  }

  function validateMethodGroup(plugin, groupName, methodNames) {
    const group = plugin[groupName];
    if (!group || typeof group !== 'object') throw new TypeError(`插件缺少方法组：${groupName}`);
    for (const methodName of methodNames) {
      if (typeof group[methodName] !== 'function') throw new TypeError(`插件缺少方法：${groupName}.${methodName}`);
    }
  }

  const REQUIRED_METHODS = Object.freeze({
    identity: ['normalizeTargetUrl', 'isTargetUrl', 'matchesPage', 'getTargetContext', 'getCurrentAccount', 'getContentOwner', 'compareAccounts'],
    preflight: ['detectLogin', 'detectPageState', 'checkTarget', 'checkDeletePermission', 'getRestrictionReason'],
    surface: ['findCommentSurface', 'findScrollableSurface', 'observe', 'disconnect', 'getMutationVersion', 'snapshot', 'isVisible', 'getScrollState', 'waitUntilStable'],
    loader: ['findExpansionControls', 'expand', 'expandAll', 'expandParent', 'findLoadMoreControls', 'loadNextBatch', 'createPagination', 'getProgress', 'hasReachedEnd', 'cancel'],
    comments: ['collect', 'toRecord', 'getId', 'getParentId', 'isReply', 'getAuthor', 'getText', 'getElement', 'buildThreads', 'getPostAuthor', 'findParent', 'nextParent'],
    actions: ['resolveElement', 'ensureReplyVisible', 'revealMenu', 'getMenu', 'findDeleteAction', 'confirmDelete', 'verifyDeleted', 'getHoverPoint'],
    errors: ['classify', 'toUserMessage', 'isRetryable'],
  });

  function validatePlugin(plugin) {
    if (!plugin || typeof plugin !== 'object') throw new TypeError('平台插件必须是对象。');
    if (!/^[a-z][a-z0-9-]*$/.test(String(plugin.id || ''))) throw new TypeError('平台插件 id 无效。');
    if (!String(plugin.displayName || '').trim()) throw new TypeError('平台插件必须提供 displayName。');
    if (!Array.isArray(plugin.matches) || !plugin.matches.length) throw new TypeError('平台插件必须提供 matches。');
    Object.entries(REQUIRED_METHODS).forEach(([groupName, methodNames]) => validateMethodGroup(plugin, groupName, methodNames));
    return {
      ...plugin,
      id: String(plugin.id),
      displayName: String(plugin.displayName),
      matches: Object.freeze([...plugin.matches]),
      capabilities: normalizeCapabilities(plugin.capabilities),
    };
  }

  global.SocialCommentPlatformContract = Object.freeze({
    ERROR_CODES,
    DEFAULT_CAPABILITIES,
    REQUIRED_METHODS,
    isErrorCode,
    createPlatformError,
    createActionResult,
    createUnsupported,
    normalizeCapabilities,
    validatePlugin,
  });
})(globalThis);
