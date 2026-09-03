(function (global) {
  'use strict';

  const settingsApi = global.SocialCommentPlatformSettings;
  if (!settingsApi) throw new Error('平台设置模块必须在 options/platform-form.js 之前加载。');

  function applyMetadata(targetInput, settings) {
    const metadata = settingsApi.getFormMetadata(settings);
    if (targetInput && metadata.placeholder) targetInput.placeholder = metadata.placeholder;
    return metadata;
  }

  function renderPlatformOptions(platformSelect, selectedPlatformId) {
    if (!platformSelect) return [];
    const options = settingsApi.getFormOptions();
    platformSelect.replaceChildren();
    for (const platform of options) {
      const option = global.document.createElement('option');
      option.value = platform.id;
      option.textContent = platform.displayName;
      platformSelect.append(option);
    }
    platformSelect.value = options.some((platform) => platform.id === selectedPlatformId)
      ? selectedPlatformId
      : options[0]?.id || '';
    return options;
  }

  global.SocialCommentPlatformForm = Object.freeze({
    applyMetadata,
    renderPlatformOptions,
    platforms: () => settingsApi.getFormOptions(),
    normalize: (raw, options) => settingsApi.normalize(raw, options),
    validate: (raw, required, options) => settingsApi.validateTarget(raw, { required, ...options }),
  });
})(globalThis);
