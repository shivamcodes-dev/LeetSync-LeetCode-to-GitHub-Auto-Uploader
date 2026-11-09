/*
 * LeetSync - background service worker.
 *
 * Receives verified, Accepted submissions from content.js and uploads them to
 * GitHub (via github.js). Also keeps the state shown in the popup.
 *
 * chrome.storage.local keys:
 *   settings      { username, repo, token, branch }
 *   autoUpload    boolean (default true)
 *   connection    result of the last successful connection test (popup only)
 *   uploaded      { [submissionId]: "path in repo" }   duplicate protection
 *   lastUpload    details of the most recent successful upload
 *   lastFailure   { message, code, time, title, payload|null }  (payload enables "Retry")
 */
/* global importScripts, LeetSyncGitHub */
importScripts('github.js');

const MAX_TRACKED_SUBMISSIONS = 1000;
const LEETCODE_ORIGIN = 'https://leetcode.com';

/* ---------------- serial queue (avoids storage read/modify/write races) ---------------- */

let queue = Promise.resolve();
function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

/* ---------------- helpers ---------------- */

function setBadge(text, color) {
  try {
    chrome.action.setBadgeBackgroundColor({ color });
    chrome.action.setBadgeText({ text });
    if (text) setTimeout(() => chrome.action.setBadgeText({ text: '' }), 10000);
  } catch (e) {
    /* badge is cosmetic */
  }
}

function safeMessage(err) {
  if (err && err.name === 'GitHubError') return err.message;
  return 'Unexpected error while uploading. Please try again.';
}

function validatePayload(p) {
  if (!p || typeof p !== 'object') return 'No submission data was received.';
  if (!/^\d+$/.test(String(p.submissionId || ''))) return 'The submission id is missing or invalid.';
  if (typeof p.code !== 'string' || p.code.trim().length === 0) return 'The submitted source code is empty or unavailable.';
  if (typeof p.title !== 'string' || !p.title.trim()) return 'The problem title is missing.';
  if (p.questionFrontendId == null || String(p.questionFrontendId).trim() === '') return 'The problem number is missing.';
  if (typeof p.langName !== 'string' || !p.langName) return 'The programming language is missing.';
  return null;
}

async function recordFailure(payload, code, message) {
  const failure = {
    message,
    code,
    time: Date.now(),
    title: payload && payload.title ? String(payload.title) : '',
    payload: payload || null
  };
  await chrome.storage.local.set({ lastFailure: failure });
  setBadge('!', '#d1453b');
  console.error('[LeetSync] upload problem:', code, message);
  return { ok: false, code, message };
}

function describe(result, settings) {
  const repo = `${settings.username}/${settings.repo}`;
  if (result.status === 'created') return `Uploaded "${result.path}" to ${repo}.`;
  if (result.status === 'created_alt') {
    return `"${result.requestedPath}" already exists with different code, so this solution was saved as "${result.path}". Nothing was overwritten.`;
  }
  return `"${result.path}" is already in ${repo} with identical code.`;
}

/* ---------------- main upload pipeline ---------------- */

async function processSubmission(payload, options) {
  const manual = Boolean(options && options.manual);

  const problem = validatePayload(payload);
  if (problem) return recordFailure(null, 'BAD_PAYLOAD', problem);

  const id = String(payload.submissionId);
  const store = await chrome.storage.local.get(['settings', 'autoUpload', 'uploaded']);

  if (store.autoUpload === false && !manual) {
    return { ok: false, code: 'DISABLED', message: 'Automatic upload is turned off in LeetSync.' };
  }

  const uploaded = store.uploaded && typeof store.uploaded === 'object' ? store.uploaded : {};
  if (uploaded[id]) {
    return { ok: true, status: 'duplicate', path: uploaded[id], message: 'This submission was already uploaded.' };
  }

  const validation = LeetSyncGitHub.validateSettings(store.settings);
  if (!validation.valid) {
    return recordFailure(
      payload,
      'NO_SETTINGS',
      'GitHub settings are missing or invalid. Open the LeetSync popup, fill them in and save, then press "Retry upload".'
    );
  }
  const settings = validation.settings;

  const stem = LeetSyncGitHub.buildStem(payload.questionFrontendId, payload.title);
  const ext = LeetSyncGitHub.extensionFor(payload.langName);
  if (!stem) return recordFailure(payload, 'BAD_FILE', 'Could not build a file name for this problem.');

  let result;
  try {
    result = await LeetSyncGitHub.uploadSolution(settings, {
      stem,
      ext,
      content: payload.code,
      message: `Add ${stem}.${ext}${payload.langVerbose ? ` (${payload.langVerbose})` : ''}`
    });
  } catch (err) {
    return recordFailure(payload, (err && err.code) || 'UPLOAD_FAILED', safeMessage(err));
  }

  // GitHub confirmed (created, or identical file already present): remember it.
  uploaded[id] = result.path;
  const ids = Object.keys(uploaded);
  if (ids.length > MAX_TRACKED_SUBMISSIONS) {
    ids
      .sort((a, b) => Number(a) - Number(b))
      .slice(0, ids.length - MAX_TRACKED_SUBMISSIONS)
      .forEach((k) => delete uploaded[k]);
  }

  const lastUpload = {
    submissionId: id,
    title: String(payload.title),
    questionFrontendId: String(payload.questionFrontendId),
    langName: payload.langName,
    path: result.path,
    htmlUrl: result.htmlUrl,
    status: result.status,
    repo: `${settings.username}/${settings.repo}`,
    branch: settings.branch,
    time: Date.now()
  };

  const update = { uploaded, lastUpload };
  const current = await chrome.storage.local.get('lastFailure');
  if (current.lastFailure && current.lastFailure.payload && String(current.lastFailure.payload.submissionId) === id) {
    await chrome.storage.local.remove('lastFailure');
  }
  await chrome.storage.local.set(update);
  setBadge('OK', '#2ea043');

  return {
    ok: true,
    status: result.status,
    path: result.path,
    htmlUrl: result.htmlUrl,
    message: describe(result, settings)
  };
}

async function retryLastFailure() {
  const { lastFailure } = await chrome.storage.local.get('lastFailure');
  if (!lastFailure || !lastFailure.payload) {
    return { ok: false, code: 'NOTHING_TO_RETRY', message: 'There is no failed upload to retry.' };
  }
  return processSubmission(lastFailure.payload, { manual: true });
}

/* ---------------- messaging ---------------- */

function fromLeetCodeTab(sender) {
  try {
    return Boolean(sender && sender.tab && sender.url && new URL(sender.url).origin === LEETCODE_ORIGIN);
  } catch (e) {
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string' || sender.id !== chrome.runtime.id) return false;

  let task = null;
  if (message.type === 'UPLOAD_SUBMISSION' && fromLeetCodeTab(sender)) {
    task = () => processSubmission(message.payload, { manual: false });
  } else if (message.type === 'REPORT_ERROR' && fromLeetCodeTab(sender)) {
    task = () => recordFailure(null, 'PAGE_ERROR', String(message.message || 'Could not read the submission.').slice(0, 300));
  } else if (message.type === 'RETRY_LAST_FAILED' && !sender.tab) {
    task = () => retryLastFailure();
  }
  if (!task) return false;

  enqueue(task).then(sendResponse, (err) => sendResponse({ ok: false, code: 'INTERNAL', message: safeMessage(err) }));
  return true; // keep the channel open for the async response
});

chrome.runtime.onInstalled.addListener(async () => {
  const { autoUpload } = await chrome.storage.local.get('autoUpload');
  if (autoUpload === undefined) await chrome.storage.local.set({ autoUpload: true });
});
