(function (global) {
  'use strict';

  const contract = global.SocialCommentPlatformContract;
  const registry = global.SocialCommentPlatformRegistry;
  const identity = global.SocialCommentInstagramIdentity;
  if (!contract || !registry || !identity) throw new Error('Instagram 插件依赖的平台基础模块未加载。');

  const unsupported = (name) => contract.createUnsupported(`instagram.${name}`);
  const unsupportedGroup = (name, methods) => Object.fromEntries(methods.map((method) => [method, unsupported(`${name}.${method}`)]));

  const plugin = {
    id: 'instagram',
    displayName: 'Instagram',
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
      getCurrentAccount: unsupported('identity.getCurrentAccount'),
      getContentOwner: unsupported('identity.getContentOwner'),
      compareAccounts: unsupported('identity.compareAccounts'),
    },
    // 阶段 0 先以明确 unsupported 占位，避免核心误把未迁移能力当成已可用。
    preflight: unsupportedGroup('preflight', ['detectLogin', 'detectPageState', 'checkTarget', 'checkDeletePermission']),
    surface: {
      ...unsupportedGroup('surface', ['findCommentSurface']),
      snapshot: unsupported('surface.snapshot'),
    },
    loader: unsupportedGroup('loader', ['loadNextBatch', 'cancel']),
    comments: {
      collect: unsupported('comments.collect'),
      toRecord: unsupported('comments.toRecord'),
      getId: (record) => String(record?.id || ''),
      getParentId: (record) => String(record?.parentId || ''),
      isReply: (record) => record?.kind === 'reply' || Boolean(record?.parentId),
      getAuthor: (record) => String(record?.username || ''),
      getText: (record) => String(record?.text || ''),
      getElement: (record) => record?.element || null,
      buildThreads: unsupported('comments.buildThreads'),
    },
    actions: unsupportedGroup('actions', ['resolveElement', 'ensureReplyVisible', 'revealMenu', 'getMenu', 'findDeleteAction', 'confirmDelete', 'verifyDeleted', 'getHoverPoint']),
    errors: {
      classify: (error) => contract.createPlatformError(error?.code, error?.message || 'Instagram 页面状态未知。'),
      toUserMessage: (error) => String(error?.message || 'Instagram 页面状态未知。'),
      isRetryable: (error) => ['not-ready', 'rate-limited'].includes(error?.code),
    },
  };

  registry.register(plugin);
})(globalThis);
