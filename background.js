'use strict';

chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.sendMessage(tab.id, { type: 'toggle-panel' }).catch(() => {
    // Content script not yet injected — programmatically inject it
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['utils.js', 'content.js'],
    });
  });
});
