(function (global) {
  'use strict';

  const settingsApi = global.SocialCommentPlatformSettings;
  if (!settingsApi) throw new Error('平台设置模块必须在 options/platform-form.js 之前加载。');

  function applyMetadata(targetInput, settings) {
    const metadata = settingsApi.getFormMetadata(settings);
    if (targetInput && metadata.placeholder) targetInput.placeholder = metadata.placeholder;
    return metadata;
  }

  global.SocialCommentPlatformForm = Object.freeze({
    applyMetadata,
    normalize: (raw) => settingsApi.normalize(raw),
    validate: (raw, required) => settingsApi.validateTarget(raw, { required }),
  });
})(globalThis);
