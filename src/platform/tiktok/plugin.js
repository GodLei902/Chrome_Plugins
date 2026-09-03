(function (global) {
  'use strict';

  const contract = global.SocialCommentPlatformContract;
  const registry = global.SocialCommentPlatformRegistry;
  const identity = global.SocialCommentTikTokIdentity;
  if (!contract || !registry || !identity) throw new Error('TikTok 插件依赖的平台基础模块未加载。');

  // 后台与设置页只加载身份模块和插件；未加载页面模块时必须明确拒绝，而非伪造成功结果。
  const method = (moduleName, methodName) => (...args) => {
    const implementation = global[moduleName]?.[methodName];
    if (typeof implementation !== 'function') {
      return contract.createActionResult(false, {
        code: 'unsupported',
        message: `TikTok 能力尚未实现：${methodName}`,
      });
    }
    return implementation(...args);
  };

  const plugin = {
    id: 'tiktok',
    displayName: 'TikTok',
    targetPlaceholder: 'https://www.tiktok.com/@creator/video/1234567890123456789',
    matches: ['https://www.tiktok.com/*'],
    capabilities: {
      supportsReplies: Boolean(global.SocialCommentTikTokComments),
      supportsNestedReplies: false,
      supportsAutoLoad: false,
      supportsCommentDelete: Boolean(global.SocialCommentTikTokActions),
      requiresAuthorConfirmation: true,
      supportsPreview: Boolean(global.SocialCommentTikTokSurface && global.SocialCommentTikTokComments),
    },
    identity: {
      normalizeTargetUrl: identity.normalizeTargetUrl,
      isTargetUrl: identity.isTargetUrl,
      matchesPage: identity.matchesPage,
      getTargetContext: identity.getTargetContext,
      getCurrentAccount: method('SocialCommentTikTokPreflight', 'getCurrentAccount'),
      getContentOwner: method('SocialCommentTikTokPreflight', 'getContentOwner'),
      compareAccounts: identity.compareAccounts,
    },
    preflight: {
      detectLogin: method('SocialCommentTikTokPreflight', 'detectLogin'),
      detectPageState: method('SocialCommentTikTokPreflight', 'detectPageState'),
      checkTarget: method('SocialCommentTikTokPreflight', 'checkTarget'),
      checkDeletePermission: method('SocialCommentTikTokPreflight', 'checkDeletePermission'),
      getRestrictionReason: method('SocialCommentTikTokPreflight', 'getRestrictionReason'),
    },
    surface: {
      findCommentSurface: method('SocialCommentTikTokSurface', 'findCommentSurface'),
      findScrollableSurface: method('SocialCommentTikTokSurface', 'findScrollableSurface'),
      observe: method('SocialCommentTikTokSurface', 'observe'),
      disconnect: method('SocialCommentTikTokSurface', 'disconnect'),
      getMutationVersion: method('SocialCommentTikTokSurface', 'getMutationVersion'),
      snapshot: method('SocialCommentTikTokSurface', 'snapshot'),
      isVisible: method('SocialCommentTikTokSurface', 'isVisible'),
      getScrollState: method('SocialCommentTikTokSurface', 'getScrollState'),
      waitUntilStable: method('SocialCommentTikTokSurface', 'waitUntilStable'),
    },
    loader: {
      findExpansionControls: method('SocialCommentTikTokLoader', 'findExpansionControls'),
      expand: method('SocialCommentTikTokLoader', 'expand'),
      expandAll: method('SocialCommentTikTokLoader', 'expandAll'),
      expandParent: method('SocialCommentTikTokLoader', 'expandParent'),
      findLoadMoreControls: method('SocialCommentTikTokLoader', 'findLoadMoreControls'),
      loadNextBatch: method('SocialCommentTikTokLoader', 'loadNextBatch'),
      createPagination: (...args) => global.SocialCommentTikTokSurface
        ? null
        : method('SocialCommentTikTokLoader', 'createPagination')(...args),
      getProgress: method('SocialCommentTikTokLoader', 'getProgress'),
      hasReachedEnd: method('SocialCommentTikTokLoader', 'hasReachedEnd'),
      cancel: method('SocialCommentTikTokLoader', 'cancel'),
    },
    comments: {
      collect: method('SocialCommentTikTokComments', 'collect'),
      toRecord: method('SocialCommentTikTokComments', 'toRecord'),
      getId: (record) => String(record?.id || ''),
      getParentId: (record) => String(record?.parentId || ''),
      isReply: (record) => record?.kind === 'reply' || Boolean(record?.parentId),
      getAuthor: (record) => String(record?.username || ''),
      getText: (record) => String(record?.text || ''),
      getElement: (record) => record?.element || null,
      buildThreads: method('SocialCommentTikTokComments', 'buildThreads'),
      getPostAuthor: method('SocialCommentTikTokComments', 'getPostAuthor'),
      findParent: method('SocialCommentTikTokComments', 'findParent'),
      nextParent: method('SocialCommentTikTokComments', 'nextParent'),
    },
    actions: {
      // 阶段 2/3 未加载动作模块时仍允许 Preview 重新定位父评论；正式动作优先使用阶段 4 的稳定键重定位。
      resolveElement: (...args) => global.SocialCommentTikTokActions
        ? global.SocialCommentTikTokActions.resolveElement(...args)
        : (global.SocialCommentTikTokComments
          ? global.SocialCommentTikTokComments.resolveElement(...args)
          : method('SocialCommentTikTokActions', 'resolveElement')(...args)),
      ensureReplyVisible: method('SocialCommentTikTokActions', 'ensureReplyVisible'),
      revealMenu: method('SocialCommentTikTokActions', 'revealMenu'),
      getMenu: method('SocialCommentTikTokActions', 'getMenu'),
      findDeleteAction: method('SocialCommentTikTokActions', 'findDeleteAction'),
      confirmDelete: method('SocialCommentTikTokActions', 'confirmDelete'),
      verifyDeleted: method('SocialCommentTikTokActions', 'verifyDeleted'),
      getHoverPoint: method('SocialCommentTikTokActions', 'getHoverPoint'),
    },
    errors: {
      classify: (error) => global.SocialCommentTikTokErrors?.classify?.(error)
        || contract.createPlatformError(error?.code, error?.message || 'TikTok 页面状态未知。'),
      toUserMessage: (error) => global.SocialCommentTikTokErrors?.toUserMessage?.(error)
        || String(error?.message || 'TikTok 页面状态未知。'),
      isRetryable: (error) => global.SocialCommentTikTokErrors?.isRetryable?.(error)
        || ['not-ready', 'rate-limited'].includes(error?.code),
    },
  };

  registry.register(plugin);
})(globalThis);
