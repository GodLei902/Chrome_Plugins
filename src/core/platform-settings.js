(function (global) {
  'use strict';

  function resolvePlatform(settings = {}, registry = global.SocialCommentPlatformRegistry) {
    const platformId = String(settings.platformId || settings.platform || '');
    const targetUrl = settings.targetUrl || settings.targetPostUrl || '';
    // 目标地址能唯一匹配插件时优先使用它，防止用户切换到新平台地址后
    // 仍被旧设置中的 platformId 锁定；无匹配时保持原平台和默认回退顺序。
    return registry?.resolve?.(targetUrl) || registry?.get?.(platformId) || registry?.all?.()[0] || null;
  }

  function normalize(raw = {}, registry = global.SocialCommentPlatformRegistry) {
    const platform = resolvePlatform(raw, registry);
    const platformId = String(platform?.id || raw.platformId || raw.platform || '');
    const sourceTarget = String(raw.targetUrl || raw.targetPostUrl || '').trim();
    const canonicalTargetUrl = platform?.identity?.normalizeTargetUrl?.(sourceTarget) || sourceTarget;
    return {
      ...raw,
      platform: platformId,
      platformId,
      targetUrl: canonicalTargetUrl || sourceTarget,
      targetPostUrl: canonicalTargetUrl || sourceTarget,
      platformOptions: { ...(raw.platformOptions || {}) },
    };
  }

  function validateTarget(raw = {}, { required = false, registry } = {}) {
    const settings = normalize(raw, registry);
    const platform = resolvePlatform(settings, registry);
    const targetUrl = platform?.identity?.normalizeTargetUrl?.(settings.targetUrl) || '';
    if (required && !targetUrl) throw new Error(`请输入 ${platform?.displayName || '当前平台'} 目标页面的完整 URL。`);
    return { ...settings, targetUrl: targetUrl || settings.targetUrl, targetPostUrl: targetUrl || settings.targetPostUrl };
  }

  function getFormMetadata(settings = {}, registry = global.SocialCommentPlatformRegistry) {
    const platform = resolvePlatform(settings, registry);
    return Object.freeze({
      platformId: platform?.id || '',
      displayName: platform?.displayName || '',
      placeholder: String(platform?.targetPlaceholder || ''),
      capabilities: Object.freeze({ ...(platform?.capabilities || {}) }),
    });
  }

  global.SocialCommentPlatformSettings = Object.freeze({ resolvePlatform, normalize, validateTarget, getFormMetadata });
})(globalThis);
