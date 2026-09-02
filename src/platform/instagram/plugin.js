(function (global) {
  'use strict';

  const contract = global.SocialCommentPlatformContract;
  const registry = global.SocialCommentPlatformRegistry;
  const identity = global.SocialCommentInstagramIdentity;
  if (!contract || !registry || !identity) throw new Error('Instagram 插件依赖的平台基础模块未加载。');

  // Background 只需要 identity；页面能力在内容脚本中延迟解析，避免 Service Worker
  // 在没有 document 的环境中访问 DOM，同时保持同一个完整插件对象。
  const method = (moduleName, methodName) => (...args) => {
    const implementation = global[moduleName]?.[methodName];
    if (typeof implementation !== 'function') {
      return contract.createActionResult(false, {
        code: 'unsupported',
        message: `当前环境未加载 Instagram 页面能力：${methodName}`,
      });
    }
    return implementation(...args);
  };

  const plugin = {
    id: 'instagram',
    displayName: 'Instagram',
    targetPlaceholder: 'https://www.instagram.com/p/shortcode/',
    matches: ['https://www.instagram.com/*', 'https://instagram.com/*'],
    capabilities: {
      supportsReplies: true,
      supportsNestedReplies: true,
      supportsAutoLoad: true,
      supportsCommentDelete: true,
      requiresAuthorConfirmation: true,
      supportsPreview: true,
    },
    identity: {
      normalizeTargetUrl: identity.normalizeTargetUrl,
      isTargetUrl: identity.isTargetUrl,
      matchesPage: identity.matchesPage,
      getTargetContext: identity.getTargetContext,
      getCurrentAccount: method('SocialCommentInstagramPreflight', 'getCurrentAccount'),
      getContentOwner: method('SocialCommentInstagramPreflight', 'getContentOwner'),
      compareAccounts: method('SocialCommentInstagramPreflight', 'compareAccounts'),
    },
    preflight: {
      detectLogin: method('SocialCommentInstagramPreflight', 'detectLogin'),
      detectPageState: method('SocialCommentInstagramPreflight', 'detectPageState'),
      checkTarget: method('SocialCommentInstagramPreflight', 'checkTarget'),
      checkDeletePermission: method('SocialCommentInstagramPreflight', 'checkDeletePermission'),
      getRestrictionReason: method('SocialCommentInstagramPreflight', 'getRestrictionReason'),
    },
    surface: {
      findCommentSurface: method('SocialCommentInstagramSurface', 'findCommentSurface'),
      findScrollableSurface: method('SocialCommentInstagramSurface', 'findScrollableSurface'),
      observe: method('SocialCommentInstagramSurface', 'observe'),
      disconnect: method('SocialCommentInstagramSurface', 'disconnect'),
      getMutationVersion: method('SocialCommentInstagramSurface', 'getMutationVersion'),
      snapshot: method('SocialCommentInstagramSurface', 'snapshot'),
      isVisible: method('SocialCommentInstagramSurface', 'isVisible'),
      getScrollState: method('SocialCommentInstagramSurface', 'getScrollState'),
      waitUntilStable: method('SocialCommentInstagramSurface', 'waitUntilStable'),
    },
    loader: {
      findExpansionControls: method('SocialCommentInstagramLoader', 'findExpansionControls'),
      expand: method('SocialCommentInstagramLoader', 'expand'),
      expandAll: method('SocialCommentInstagramLoader', 'expandAll'),
      expandParent: method('SocialCommentInstagramLoader', 'expandParent'),
      findLoadMoreControls: method('SocialCommentInstagramLoader', 'findLoadMoreControls'),
      loadNextBatch: method('SocialCommentInstagramLoader', 'loadNextBatch'),
      createPagination: method('SocialCommentInstagramLoader', 'createPagination'),
      getProgress: method('SocialCommentInstagramLoader', 'getProgress'),
      hasReachedEnd: method('SocialCommentInstagramLoader', 'hasReachedEnd'),
      cancel: method('SocialCommentInstagramLoader', 'cancel'),
    },
    comments: {
      collect: method('SocialCommentInstagramComments', 'collect'),
      toRecord: method('SocialCommentInstagramComments', 'toRecord'),
      getId: (record) => String(record?.id || ''),
      getParentId: (record) => String(record?.parentId || ''),
      isReply: (record) => record?.kind === 'reply' || Boolean(record?.parentId),
      getAuthor: (record) => String(record?.username || ''),
      getText: (record) => String(record?.text || ''),
      getElement: (record) => record?.element || null,
      buildThreads: method('SocialCommentInstagramComments', 'buildThreads'),
      getPostAuthor: method('SocialCommentInstagramComments', 'postAuthorUsername'),
      findParent: method('SocialCommentInstagramComments', 'findParent'),
      nextParent: method('SocialCommentInstagramComments', 'nextParent'),
    },
    actions: {
      resolveElement: method('SocialCommentInstagramActions', 'resolveElement'),
      ensureReplyVisible: method('SocialCommentInstagramActions', 'ensureReplyVisible'),
      revealMenu: method('SocialCommentInstagramActions', 'revealMenu'),
      getMenu: method('SocialCommentInstagramActions', 'getMenu'),
      findDeleteAction: method('SocialCommentInstagramActions', 'findDeleteAction'),
      confirmDelete: method('SocialCommentInstagramActions', 'confirmDelete'),
      verifyDeleted: method('SocialCommentInstagramActions', 'verifyDeleted'),
      getHoverPoint: method('SocialCommentInstagramActions', 'getHoverPoint'),
    },
    errors: {
      classify: (error) => global.SocialCommentInstagramErrors?.classify?.(error)
        || contract.createPlatformError(error?.code, error?.message || 'Instagram 页面状态未知。'),
      toUserMessage: (error) => global.SocialCommentInstagramErrors?.toUserMessage?.(error)
        || String(error?.message || 'Instagram 页面状态未知。'),
      isRetryable: (error) => global.SocialCommentInstagramErrors?.isRetryable?.(error)
        || ['not-ready', 'rate-limited'].includes(error?.code),
    },
  };

  registry.register(plugin);
})(globalThis);
