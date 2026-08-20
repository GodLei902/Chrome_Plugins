const STORAGE_KEY = 'socialCommentCleanerSettings';

const DEFAULT_SETTINGS = {
  platform: 'instagram',
  targetPostUrl: '',
  whitelist: '',
  deleteKeywords: '', previewMode: true,
  deleteDelayMin: 12, deleteDelayMax: 25, batchLimit: 3,
  cooldownMin: 120, cooldownMax: 300,
  sessionLimit: 30, sessionMaxMinutes: 120,
};

const form = document.getElementById('settingsForm');
const platformInput = document.getElementById('platform');
const targetPostUrlInput = document.getElementById('targetPostUrl');
const whitelistInput = document.getElementById('whitelist');
const deleteKeywordsInput = document.getElementById('deleteKeywords');
const statusEl = document.getElementById('status');

function normalizeSettings(raw) {
  const result = {
    platform: typeof raw?.platform === 'string' ? raw.platform : DEFAULT_SETTINGS.platform,
    targetPostUrl: typeof raw?.targetPostUrl === 'string' ? raw.targetPostUrl.trim() : '',
    whitelist: typeof raw?.whitelist === 'string' ? raw.whitelist.trim() : '',
    deleteKeywords: typeof raw?.deleteKeywords === 'string' ? raw.deleteKeywords.trim() : '',
    previewMode: raw?.previewMode !== false,
  };
  for (const key of ['deleteDelayMin', 'deleteDelayMax', 'batchLimit', 'cooldownMin', 'cooldownMax', 'sessionLimit', 'sessionMaxMinutes']) {
    result[key] = Number(raw?.[key]) > 0 ? Number(raw[key]) : DEFAULT_SETTINGS[key];
  }
  return result;
}

async function loadSettings() {
  const result = await chrome.storage.sync.get(STORAGE_KEY);
  return normalizeSettings(result[STORAGE_KEY] || DEFAULT_SETTINGS);
}

async function saveSettings(settings) {
  await chrome.storage.sync.set({ [STORAGE_KEY]: settings });
}

function renderSettings(settings) {
  platformInput.value = settings.platform;
  targetPostUrlInput.value = settings.targetPostUrl;
  whitelistInput.value = settings.whitelist;
  deleteKeywordsInput.value = settings.deleteKeywords;
  document.getElementById('previewMode').checked = settings.previewMode;
  for (const key of ['deleteDelayMin', 'deleteDelayMax', 'batchLimit', 'cooldownMin', 'cooldownMax', 'sessionLimit', 'sessionMaxMinutes']) document.getElementById(key).value = settings[key];
}

function collectSettings() {
  return normalizeSettings({
    platform: platformInput.value,
    targetPostUrl: targetPostUrlInput.value,
    whitelist: whitelistInput.value,
    deleteKeywords: deleteKeywordsInput.value,
    previewMode: document.getElementById('previewMode').checked,
    ...Object.fromEntries(['deleteDelayMin', 'deleteDelayMax', 'batchLimit', 'cooldownMin', 'sessionLimit', 'sessionMaxMinutes'].map((key) => [key, document.getElementById(key).value])),
  });
}

function setStatus(message) {
  statusEl.textContent = message;
}

document.addEventListener('DOMContentLoaded', async () => {
  renderSettings(await loadSettings());
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatus('Saving...');

  try {
    const settings = collectSettings();
    const normalizedTargetUrl = InstagramCommentRules.normalizeTargetUrl(settings.targetPostUrl);
    if (!normalizedTargetUrl) throw new Error('请输入 Instagram 帖子或 Reels 的完整 URL。');
    settings.targetPostUrl = normalizedTargetUrl;
    if (settings.deleteDelayMin > settings.deleteDelayMax || settings.cooldownMin > settings.cooldownMax) throw new Error('每组最小值不能大于最大值。');
    await saveSettings(settings);
    setStatus('Saved');
  } catch (error) {
    setStatus(error.message || '保存失败');
  }
});
