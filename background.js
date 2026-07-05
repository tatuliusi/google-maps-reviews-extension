'use strict';

const CONTENT_FILES = [
  'utils.js',
  'adapters/maps.js',
  'adapters/tripadvisor.js',
  'adapters/expedia.js',
  'adapters/booking.js',
  'content.js',
];

chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.sendMessage(tab.id, { type: 'toggle-panel' }).catch(() => {
    // Content script not yet injected — programmatically inject it.
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: CONTENT_FILES,
    });
  });
});
