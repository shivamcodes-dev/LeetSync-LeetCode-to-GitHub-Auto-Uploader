/*
 * LeetSync - page-world observer (runs in the page's own JavaScript world).
 *
 * Content scripts normally cannot see the network traffic of the page's own
 * scripts, so this file wraps window.fetch and XMLHttpRequest and watches the
 * two LeetCode endpoints that matter:
 *
 *   POST /problems/{slug}/submit/                 -> { submission_id }
 *   GET  /submissions/detail/{id}/check/          -> { state, status_msg, status_code, ... }
 *
 * It never touches the response seen by LeetCode's own code (it works on a
 * clone) and it never reads source code. It only posts small messages to
 * content.js, which re-verifies everything with LeetCode before anything is
 * uploaded.
 */
(function () {
  'use strict';

  if (window.__leetsyncInjected) return;
  window.__leetsyncInjected = true;

  const SOURCE = 'leetsync-page';
  const CHECK_RE = /\/submissions\/detail\/(\d+)\/check\/?(?:[?#]|$)/;
  const SUBMIT_RE = /\/problems\/([a-z0-9-]+)\/submit\/?(?:[?#]|$)/i;

  function emit(message) {
    try {
      window.postMessage(Object.assign({ source: SOURCE }, message), window.location.origin);
    } catch (e) {
      /* ignore */
    }
  }

  function inspect(method, url, data) {
    if (!data || typeof data !== 'object') return;

    const submit = SUBMIT_RE.exec(url);
    if (submit) {
      if (method === 'POST' && data.submission_id != null) {
        emit({ type: 'SUBMITTED', submissionId: String(data.submission_id), slug: submit[1] });
      }
      return;
    }

    const check = CHECK_RE.exec(url);
    // Only numeric ids are real submissions ("Run Code" uses ids like "runcode_...").
    if (check && data.state === 'SUCCESS') {
      emit({
        type: 'JUDGED',
        submissionId: check[1],
        statusMsg: String(data.status_msg || ''),
        statusCode: Number(data.status_code)
      });
    }
  }

  function interesting(url) {
    return CHECK_RE.test(url) || SUBMIT_RE.test(url);
  }

  /* ---- fetch ---- */
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      const promise = nativeFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : (input && (input.url || input.href)) || '';
        if (interesting(url)) {
          const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
          promise
            .then((res) => res.clone().json())
            .then((data) => inspect(method, url, data))
            .catch(() => {});
        }
      } catch (e) {
        /* never break the page */
      }
      return promise;
    };
  }

  /* ---- XMLHttpRequest ---- */
  const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (proto) {
    const nativeOpen = proto.open;
    const nativeSend = proto.send;

    proto.open = function (method, url) {
      try {
        this.__leetsync = { method: String(method || 'GET').toUpperCase(), url: String(url || '') };
      } catch (e) {
        /* ignore */
      }
      return nativeOpen.apply(this, arguments);
    };

    proto.send = function () {
      try {
        const info = this.__leetsync;
        if (info && interesting(info.url)) {
          this.addEventListener('load', () => {
            try {
              let data = null;
              if (this.responseType === 'json') data = this.response;
              else if (this.responseType === '' || this.responseType === 'text') data = JSON.parse(this.responseText);
              inspect(info.method, info.url, data);
            } catch (e) {
              /* ignore */
            }
          });
        }
      } catch (e) {
        /* never break the page */
      }
      return nativeSend.apply(this, arguments);
    };
  }
})();
