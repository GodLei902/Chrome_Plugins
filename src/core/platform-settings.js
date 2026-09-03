(function (global) {
  'use strict';

  function resolvePlatform(settings = {}, registry = global.SocialCommentPlatformRegistry, { preferPlatformId = false } = {}) {
    const platformId = String(settings.platformId || settings.platform || '');
    const targetUrl = settings.targetUrl || settings.targetPostUrl || '';
    const configured = registry?.get?.(platformId) || null;
    const matched = registry?.resolve?.(targetUrl) || null;
    // 首次读取旧设置时由 URL 推断平台；用户通过设置页主动选择后，
    // 必须以选择项为准，再由该平台校验 URL，不能被旧地址静默切换。
    return preferPlatformId ? configured || matched || registry?.all?.()[0] || null : matched || configured || registry?.all?.()[0] || null;
  }

  function normalize(raw = {}, { registry = global.SocialCommentPlatformRegistry, preferPlatformId = false } = {}) {
    const platform = resolvePlatform(raw, registry, { preferPlatformId });
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

  function validateTarget(raw = {}, { required = false, registry, preferPlatformId = false } = {}) {
    const settings = normalize(raw, { registry, preferPlatformId });
    const platform = resolvePlatform(settings, registry, { preferPlatformId });
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

  function getFormOptions(registry = global.SocialCommentPlatformRegistry) {
    return Object.freeze((registry?.all?.() || []).map((platform) => Object.freeze({
      id: platform.id,
      displayName: platform.displayName,
    })));
  }

  global.SocialCommentPlatformSettings = Object.freeze({ resolvePlatform, normalize, validateTarget, getFormMetadata, getFormOptions });
})(globalThis);
