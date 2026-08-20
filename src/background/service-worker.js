chrome.runtime.onInstalled.addListener(() => {
  console.info('[Social Comment Cleaner] installed');
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'ICC_PING') {
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
