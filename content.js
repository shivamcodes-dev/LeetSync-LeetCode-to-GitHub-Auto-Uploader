/*
 * LeetSync - content script (extension's isolated world, runs on leetcode.com).
 *
 * Flow:
 *   inject.js (page world) --postMessage--> content.js --runtime message--> background.js
 *
 * 1. inject.js reports "SUBMITTED" (submission id + problem slug) and
 *    "JUDGED" (final verdict for a submission id).
 * 2. On an Accepted verdict this script asks LeetCode itself for the
 *    submission (GraphQL `submissionDetails`) and re-checks that LeetCode
 *    reports statusCode 10 (Accepted). Messages from the page are therefore
 *    only hints; nothing is uploaded on their word alone.
 * 3. It also fetches the problem number/title (GraphQL `question`) and makes
 *    sure the submission belongs to that problem.
 * 4. The verified data is sent to background.js, which uploads to GitHub.
 *
 * Because the script is injected on every leetcode.com page and keeps no
 * DOM state, in-app (single page) navigation between problems just works.
 */
(function () {
  'use strict';

  if (window.__leetsyncContent) return;
  window.__leetsyncContent = true;

  const PAGE_SOURCE = 'leetsync-page';
  const STATUS_ACCEPTED = 10; // LeetCode's numeric code for "Accepted"
  const SLUG_RE = /^[a-z0-9-]+$/i;

  const FALLBACK_DELAY_MS = 10000; // wait for the page's own polling first
  const FALLBACK_INTERVAL_MS = 2000;
  const FALLBACK_MAX_POLLS = 30;
  const DETAIL_RETRIES = 4;
  const DETAIL_RETRY_DELAY_MS = 1200;

  const Q_SUBMISSION =
    'query submissionDetails($submissionId: Int!) {' +
    ' submissionDetails(submissionId: $submissionId) {' +
    ' code statusCode lang { name verboseName } question { questionId } } }';

  const Q_QUESTION =
    'query questionMeta($titleSlug: String!) {' +
    ' question(titleSlug: $titleSlug) { questionId questionFrontendId title titleSlug } }';

  const slugById = new Map(); // submission id -> problem slug (from the submit request)
  const judged = new Set(); // ids whose verdict has been seen
  const handled = new Set(); // ids already being / done being processed
  const fallbackTimers = new Map();

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /* ------------------------------------------------------------------ */
  /* Small UI helper: a toast so you get feedback on the LeetCode tab   */
  /* ------------------------------------------------------------------ */

  let toastTimer = null;

  function toast(kind, text) {
    try {
      let el = document.getElementById('leetsync-toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'leetsync-toast';
        el.setAttribute('role', 'status');
        el.style.cssText =
          'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:360px;padding:10px 14px;' +
          'border-radius:8px;font:13px/1.4 system-ui,sans-serif;color:#fff;box-shadow:0 6px 24px rgba(0,0,0,.35);';
        (document.body || document.documentElement).appendChild(el);
      }
      const colors = { success: '#1f7a4d', info: '#2b5d9b', error: '#a33a3a' };
      el.style.background = colors[kind] || colors.info;
      el.textContent = 'LeetSync: ' + text;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 7000);
    } catch (e) {
      /* UI feedback is optional */
    }
  }

  /* ------------------------------------------------------------------ */
  /* Messaging with the background service worker                       */
  /* ------------------------------------------------------------------ */

  function sendToBackground(message) {
    return new Promise((resolve) => {
      try {
        if (!chrome.runtime || !chrome.runtime.id) {
          resolve({
            ok: false,
            message: 'LeetSync was reloaded or updated. Refresh this LeetCode tab and submit again.'
          });
          return;
        }
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError || !response) {
            resolve({ ok: false, message: 'LeetSync background service did not respond. Try again.' });
            return;
          }
          resolve(response);
        });
      } catch (e) {
        resolve({
          ok: false,
          message: 'LeetSync was reloaded or updated. Refresh this LeetCode tab and submit again.'
        });
      }
    });
  }

  async function reportError(message) {
    toast('error', message);
    await sendToBackground({ type: 'REPORT_ERROR', message });
  }

  /* ------------------------------------------------------------------ */
  /* LeetCode GraphQL                                                   */
  /* ------------------------------------------------------------------ */

  function csrfToken() {
    const m = /(?:^|;\s*)csrftoken=([^;]+)/.exec(document.cookie || '');
    return m ? decodeURIComponent(m[1]) : '';
  }

  async function graphql(query, variables) {
    const res = await fetch('/graphql/', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrftoken': csrfToken() },
      body: JSON.stringify({ query, variables })
    });
    if (!res.ok) throw new Error('LeetCode request failed (HTTP ' + res.status + ').');
    const json = await res.json();
    if (json && json.errors && json.errors.length) {
      throw new Error('LeetCode returned an error: ' + String(json.errors[0].message || 'unknown error'));
    }
    return json && json.data;
  }

  async function loadSubmission(submissionId) {
    for (let attempt = 1; attempt <= DETAIL_RETRIES; attempt++) {
      const data = await graphql(Q_SUBMISSION, { submissionId: Number(submissionId) });
      const details = data && data.submissionDetails;
      if (details && typeof details.code === 'string' && details.code.length > 0) return details;
      if (attempt < DETAIL_RETRIES) await sleep(DETAIL_RETRY_DELAY_MS);
    }
    throw new Error('The submitted source code could not be retrieved from LeetCode.');
  }

  async function loadQuestion(slug) {
    const data = await graphql(Q_QUESTION, { titleSlug: slug });
    const q = data && data.question;
    if (!q || !q.title || q.questionFrontendId == null || q.questionFrontendId === '') {
      throw new Error('Could not read the problem number and title from LeetCode.');
    }
    return q;
  }

  /* ------------------------------------------------------------------ */
  /* Accepted submission handling                                       */
  /* ------------------------------------------------------------------ */

  function slugFromLocation() {
    const m = /\/problems\/([a-z0-9-]+)/i.exec(window.location.pathname || '');
    return m ? m[1].toLowerCase() : null;
  }

  async function processAccepted(submissionId) {
    if (handled.has(submissionId)) return; // never process the same submission twice
    handled.add(submissionId);

    try {
      const slug = slugById.get(submissionId) || slugFromLocation();
      if (!slug) throw new Error('Could not tell which LeetCode problem this submission belongs to.');

      const details = await loadSubmission(submissionId);
      if (details.statusCode !== STATUS_ACCEPTED) {
        // The page claimed "Accepted" but LeetCode disagrees: ignore it.
        return;
      }

      const question = await loadQuestion(slug);
      if (details.question && String(details.question.questionId) !== String(question.questionId)) {
        throw new Error('The submission does not belong to the problem page it was seen on. Skipped.');
      }

      const payload = {
        submissionId: String(submissionId),
        slug,
        title: String(question.title),
        questionFrontendId: String(question.questionFrontendId),
        langName: String((details.lang && details.lang.name) || ''),
        langVerbose: String((details.lang && details.lang.verboseName) || ''),
        code: details.code
      };

      const result = await sendToBackground({ type: 'UPLOAD_SUBMISSION', payload });
      if (result.ok) {
        if (result.status !== 'duplicate') toast('success', result.message || 'Solution uploaded.');
      } else {
        toast('error', result.message || 'Upload failed.');
      }
    } catch (err) {
      handled.delete(submissionId); // allow a later attempt
      await reportError(err && err.message ? err.message : 'Unexpected error while reading the submission.');
    }
  }

  async function onJudged(submissionId, statusMsg) {
    judged.add(submissionId);
    clearFallback(submissionId);
    if (statusMsg !== 'Accepted') return; // only Accepted submissions are ever uploaded
    await processAccepted(submissionId);
  }

  /* ------------------------------------------------------------------ */
  /* Fallback: poll the verdict ourselves if the page's polling is not  */
  /* observed (for example if LeetCode changes how it fetches results)  */
  /* ------------------------------------------------------------------ */

  function clearFallback(submissionId) {
    const t = fallbackTimers.get(submissionId);
    if (t) clearTimeout(t);
    fallbackTimers.delete(submissionId);
  }

  function startFallback(submissionId) {
    if (fallbackTimers.has(submissionId) || judged.has(submissionId)) return;
    const timer = setTimeout(async () => {
      fallbackTimers.delete(submissionId);
      for (let i = 0; i < FALLBACK_MAX_POLLS && !judged.has(submissionId); i++) {
        try {
          const res = await fetch('/submissions/detail/' + submissionId + '/check/', {
            credentials: 'same-origin'
          });
          if (res.ok) {
            const data = await res.json();
            if (data && data.state === 'SUCCESS') {
              await onJudged(submissionId, String(data.status_msg || ''));
              return;
            }
          }
        } catch (e) {
          /* try again on the next tick */
        }
        await sleep(FALLBACK_INTERVAL_MS);
      }
    }, FALLBACK_DELAY_MS);
    fallbackTimers.set(submissionId, timer);
  }

  /* ------------------------------------------------------------------ */
  /* Messages from inject.js                                            */
  /* ------------------------------------------------------------------ */

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.source !== PAGE_SOURCE || !/^\d+$/.test(String(data.submissionId))) return;
    const id = String(data.submissionId);

    if (data.type === 'SUBMITTED') {
      if (typeof data.slug === 'string' && SLUG_RE.test(data.slug)) slugById.set(id, data.slug.toLowerCase());
      startFallback(id);
    } else if (data.type === 'JUDGED') {
      onJudged(id, String(data.statusMsg || ''));
    }
  });
})();
