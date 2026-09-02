(function (global) {
  'use strict';

  const registry = global.SocialCommentPlatformRegistry;
  const plugin = registry?.resolve?.(global.location?.href || '') || null;

  // 入口只选择平台并暴露只读元数据，不启动扫描、不触碰评论 DOM。
  global.SocialCommentActivePlatform = plugin ? Object.freeze(plugin) : null;
})(globalThis);
