const STORAGE_KEY = 'socialCommentCleanerSettings';

const DEFAULT_SETTINGS = {
  platform: 'instagram',
  targetPostUrl: '',
  whitelist: '',
  deleteKeywords: '',
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
const settingInputs = [...form.querySelectorAll('input, textarea, select')];
let saveTimer;

function normalizeSettings(raw) {
  const result = {
    platform: typeof raw?.platform === 'string' ? raw.platform : DEFAULT_SETTINGS.platform,
    targetPostUrl: typeof raw?.targetPostUrl === 'string' ? raw.targetPostUrl.trim() : '',
    whitelist: typeof raw?.whitelist === 'string' ? raw.whitelist.trim() : '',
    deleteKeywords: typeof raw?.deleteKeywords === 'string' ? raw.deleteKeywords.trim() : '',
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
  for (const key of ['deleteDelayMin', 'deleteDelayMax', 'batchLimit', 'cooldownMin', 'cooldownMax', 'sessionLimit', 'sessionMaxMinutes']) document.getElementById(key).value = settings[key];
}

function collectSettings() {
  return normalizeSettings({
    platform: platformInput.value,
    targetPostUrl: targetPostUrlInput.value,
    whitelist: whitelistInput.value,
    deleteKeywords: deleteKeywordsInput.value,
    ...Object.fromEntries(['deleteDelayMin', 'deleteDelayMax', 'batchLimit', 'cooldownMin', 'cooldownMax', 'sessionLimit', 'sessionMaxMinutes'].map((key) => [key, document.getElementById(key).value])),
  });
}

function setStatus(message) {
  statusEl.textContent = message;
}

function clearValidationState() {
  targetPostUrlInput.removeAttribute('aria-invalid');
}

function validateSettings(settings) {
  clearValidationState();
  const normalizedTargetUrl = InstagramCommentRules.normalizeTargetUrl(settings.targetPostUrl);
  if (!normalizedTargetUrl) {
    targetPostUrlInput.setAttribute('aria-invalid', 'true');
    targetPostUrlInput.focus();
    throw new Error('请输入 Instagram 帖子或 Reels 的完整 URL。');
  }
  if (settings.deleteDelayMin > settings.deleteDelayMax || settings.cooldownMin > settings.cooldownMax) {
    throw new Error('每组最小值不能大于最大值。');
  }
  return { ...settings, targetPostUrl: normalizedTargetUrl };
}

function normalizeTarget(settings) {
  const normalizedTargetUrl = InstagramCommentRules.normalizeTargetUrl(settings.targetPostUrl);
  return normalizedTargetUrl ? { ...settings, targetPostUrl: normalizedTargetUrl } : settings;
}

async function persistCurrentSettings() {
  await saveSettings(normalizeTarget(collectSettings()));
}

function scheduleAutoSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await persistCurrentSettings();
    } catch (error) {
      setStatus(error.message || '自动保存失败');
    }
  }, 350);
}

document.addEventListener('DOMContentLoaded', async () => {
  renderSettings(await loadSettings());
  settingInputs.forEach((input) => input.addEventListener('input', () => {
    clearValidationState();
    scheduleAutoSave();
  }));
  settingInputs.forEach((input) => input.addEventListener('change', scheduleAutoSave));
});

async function launch(mode) {
  setStatus('准备开始...');

  try {
    const settings = validateSettings(collectSettings());
    await saveSettings(settings);
    const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
    const tab = tabs.find((item) => InstagramCommentRules.normalizeTargetUrl(item.url || '') === settings.targetPostUrl);
    if (!tab?.id) throw new Error('请先打开与目标 URL 完全匹配的 Instagram 帖子页面。');
    const response = await chrome.tabs.sendMessage(tab.id, { type: mode === 'preview' ? 'ICC_PREVIEW' : 'ICC_START' }).catch(() => null);
    if (!response?.ok) throw new Error(response?.reason || '当前页面尚未加载清理器，请刷新 Instagram 页面后重试。');
    setStatus(mode === 'preview' ? '预览已开始' : '已开始');
  } catch (error) {
    setStatus(error.message || '启动失败');
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  launch('run');
});

document.getElementById('previewButton').addEventListener('click', () => launch('preview'));
