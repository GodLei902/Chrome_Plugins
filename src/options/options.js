const STORAGE_KEY = 'socialCommentCleanerSettings';

const DEFAULT_SETTINGS = {
  enabled: false,
  platform: 'instagram',
  targetPostUrl: '',
  whitelist: '',
};

const form = document.getElementById('settingsForm');
const enabledInput = document.getElementById('enabled');
const platformInput = document.getElementById('platform');
const targetPostUrlInput = document.getElementById('targetPostUrl');
const whitelistInput = document.getElementById('whitelist');
const statusEl = document.getElementById('status');

function normalizeSettings(raw) {
  return {
    enabled: Boolean(raw?.enabled),
    platform: typeof raw?.platform === 'string' ? raw.platform : DEFAULT_SETTINGS.platform,
    targetPostUrl: typeof raw?.targetPostUrl === 'string' ? raw.targetPostUrl.trim() : '',
    whitelist: typeof raw?.whitelist === 'string' ? raw.whitelist.trim() : '',
  };
}

async function loadSettings() {
  const result = await chrome.storage.sync.get(STORAGE_KEY);
  return normalizeSettings(result[STORAGE_KEY] || DEFAULT_SETTINGS);
}

async function saveSettings(settings) {
  await chrome.storage.sync.set({ [STORAGE_KEY]: settings });
}

function renderSettings(settings) {
  enabledInput.checked = settings.enabled;
  platformInput.value = settings.platform;
  targetPostUrlInput.value = settings.targetPostUrl;
  whitelistInput.value = settings.whitelist;
}

function collectSettings() {
  return normalizeSettings({
    enabled: enabledInput.checked,
    platform: platformInput.value,
    targetPostUrl: targetPostUrlInput.value,
    whitelist: whitelistInput.value,
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
    await saveSettings(collectSettings());
    setStatus('Saved');
  } catch (error) {
    console.error(error);
    setStatus('Save failed');
  }
});
