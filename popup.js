/*
 * LeetSync - popup logic.
 * Script order in popup.html: github.js (defines LeetSyncGitHub) -> popup.js.
 */
(function () {
  'use strict';

  const GH = globalThis.LeetSyncGitHub;

  function $(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error('LeetSync popup: missing element #' + id);
    return el;
  }

  const E = {
    pill: $('status-pill'),
    statusText: $('status-text'),
    statusSub: $('status-sub'),
    autoToggle: $('auto-toggle'),
    form: $('settings-form'),
    username: $('username'),
    repo: $('repo'),
    token: $('token'),
    branch: $('branch'),
    errUsername: $('err-username'),
    errRepo: $('err-repo'),
    errToken: $('err-token'),
    errBranch: $('err-branch'),
    toggleToken: $('toggle-token'),
    saveBtn: $('save-btn'),
    testBtn: $('test-btn'),
    message: $('message'),
    connection: $('connection'),
    connectionRepo: $('connection-repo'),
    connectionBranch: $('connection-branch'),
    lastEmpty: $('last-empty'),
    lastBody: $('last-body'),
    lastTitle: $('last-title'),
    lastMeta: $('last-meta'),
    lastLink: $('last-link'),
    failureCard: $('failure-card'),
    failureText: $('failure-text'),
    retryBtn: $('retry-btn'),
    dismissBtn: $('dismiss-btn')
  };

  const FIELDS = [
    { key: 'username', input: E.username, error: E.errUsername },
    { key: 'repo', input: E.repo, error: E.errRepo },
    { key: 'token', input: E.token, error: E.errToken },
    { key: 'branch', input: E.branch, error: E.errBranch }
  ];

  const STORE_KEYS = ['settings', 'autoUpload', 'connection', 'lastUpload', 'lastFailure'];

  /* ---------------- small helpers ---------------- */

  function showMessage(kind, text) {
    E.message.textContent = text || '';
    E.message.className = 'message ' + (kind || '');
    E.message.hidden = !text;
  }

  function messageOf(err) {
    if (err && err.name === 'GitHubError') return err.message;
    return 'Something went wrong while talking to GitHub. Please try again.';
  }

  function setBusy(busy) {
    E.saveBtn.disabled = busy;
    E.testBtn.disabled = busy;
  }

  function readForm() {
    return {
      username: E.username.value,
      repo: E.repo.value,
      token: E.token.value,
      branch: E.branch.value
    };
  }

  function setFieldErrors(errors) {
    FIELDS.forEach((f) => {
      const msg = (errors && errors[f.key]) || '';
      f.error.textContent = msg;
      if (msg) f.input.classList.add('invalid');
      else f.input.classList.remove('invalid');
    });
  }

  function connectionKey(s) {
    return s.username + '/' + s.repo + '@' + s.branch;
  }

  /* ---------------- rendering ---------------- */

  function renderStatus(settings, autoUpload) {
    const valid = GH.validateSettings(settings).valid;
    let kind;
    let text;
    let sub;
    if (!valid) {
      kind = 'warn';
      text = 'Setup needed';
      sub = 'Save your GitHub settings to start syncing.';
    } else if (autoUpload === false) {
      kind = 'off';
      text = 'Paused';
      sub = 'Accepted solutions will not be uploaded.';
    } else {
      const s = GH.validateSettings(settings).settings;
      kind = 'ok';
      text = 'Active';
      sub = 'Uploading Accepted solutions to ' + s.username + '/' + s.repo + ' (' + s.branch + ')';
    }
    E.pill.className = 'pill ' + kind;
    E.pill.textContent = kind === 'ok' ? 'ON' : kind === 'off' ? 'PAUSED' : 'SETUP';
    E.statusText.textContent = text;
    E.statusSub.textContent = sub;
    E.autoToggle.checked = autoUpload !== false;
  }

  function renderConnection(connection, settings) {
    const s = GH.validateSettings(settings).settings;
    if (connection && settings && connection.key === connectionKey(s)) {
      E.connectionRepo.textContent = connection.fullName;
      E.connectionBranch.textContent = connection.branch;
      E.connection.hidden = false;
    } else {
      E.connection.hidden = true;
    }
  }

  const STATUS_LABEL = {
    created: 'Uploaded',
    created_alt: 'Saved as a new version (existing file kept)',
    unchanged: 'Already in repo (identical)'
  };

  function renderLastUpload(last) {
    if (!last) {
      E.lastEmpty.hidden = false;
      E.lastBody.hidden = true;
      return;
    }
    E.lastEmpty.hidden = true;
    E.lastBody.hidden = false;
    E.lastTitle.textContent = last.path || last.title || '';
    const when = last.time ? new Date(last.time).toLocaleString() : '';
    E.lastMeta.textContent = [STATUS_LABEL[last.status] || 'Uploaded', last.repo, when].filter(Boolean).join(' · ');
    if (typeof last.htmlUrl === 'string' && /^https:\/\/github\.com\//.test(last.htmlUrl)) {
      E.lastLink.href = last.htmlUrl;
      E.lastLink.hidden = false;
    } else {
      E.lastLink.hidden = true;
    }
  }

  function renderFailure(failure) {
    if (!failure) {
      E.failureCard.hidden = true;
      return;
    }
    const label = failure.title ? failure.title + ': ' : '';
    E.failureText.textContent = label + failure.message;
    E.retryBtn.hidden = !failure.payload;
    E.failureCard.hidden = false;
  }

  function renderAll(store, options) {
    renderStatus(store.settings, store.autoUpload);
    renderConnection(store.connection, store.settings);
    renderLastUpload(store.lastUpload);
    renderFailure(store.lastFailure);
    if (options && options.fillForm) {
      const s = store.settings || {};
      E.username.value = s.username || '';
      E.repo.value = s.repo || '';
      E.token.value = s.token || '';
      E.branch.value = s.branch || 'main';
    }
  }

  async function refresh() {
    renderAll(await chrome.storage.local.get(STORE_KEYS), { fillForm: false });
  }

  /* ---------------- actions ---------------- */

  async function onSave(event) {
    if (event) event.preventDefault();
    const result = GH.validateSettings(readForm());
    setFieldErrors(result.errors);
    if (!result.valid) {
      showMessage('error', 'Please fix the highlighted fields.');
      return;
    }
    await chrome.storage.local.set({ settings: result.settings });
    const { connection } = await chrome.storage.local.get('connection');
    if (connection && connection.key !== connectionKey(result.settings)) {
      await chrome.storage.local.remove('connection');
    }
    showMessage('success', 'Settings saved. Use "Test GitHub connection" to verify them.');
    await refresh();
  }

  async function onTest() {
    const result = GH.validateSettings(readForm());
    setFieldErrors(result.errors);
    if (!result.valid) {
      showMessage('error', 'Please fix the highlighted fields first.');
      return;
    }
    setBusy(true);
    showMessage('info', 'Testing connection to GitHub...');
    try {
      const info = await GH.testConnection(result.settings);
      await chrome.storage.local.set({
        connection: {
          key: connectionKey(result.settings),
          fullName: info.fullName,
          branch: info.branch,
          testedAt: Date.now()
        }
      });
      E.connectionRepo.textContent = info.fullName;
      E.connectionBranch.textContent = info.branch;
      E.connection.hidden = false;
      showMessage(
        'success',
        'Connection successful: ' + info.fullName + ' (branch ' + info.branch + ')' +
          (info.isPrivate ? ', private repository.' : '.') +
          ' Remember to press "Save settings" if you have not yet.'
      );
    } catch (err) {
      E.connection.hidden = true;
      showMessage('error', messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  function onToggleToken() {
    const show = E.token.type === 'password';
    E.token.type = show ? 'text' : 'password';
    E.toggleToken.textContent = show ? 'Hide' : 'Show';
    E.toggleToken.setAttribute('aria-pressed', show ? 'true' : 'false');
    E.toggleToken.setAttribute('aria-label', show ? 'Hide token' : 'Show token');
  }

  async function onAutoToggle() {
    await chrome.storage.local.set({ autoUpload: E.autoToggle.checked });
    await refresh();
  }

  async function onRetry() {
    E.retryBtn.disabled = true;
    showMessage('info', 'Retrying upload...');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'RETRY_LAST_FAILED' });
      if (res && res.ok) showMessage('success', res.message || 'Uploaded.');
      else showMessage('error', (res && res.message) || 'Retry failed.');
    } catch (err) {
      showMessage('error', 'Could not reach the LeetSync background service.');
    } finally {
      E.retryBtn.disabled = false;
      await refresh();
    }
  }

  async function onDismiss() {
    await chrome.storage.local.remove('lastFailure');
    await refresh();
  }

  /* ---------------- init ---------------- */

  async function init() {
    E.form.addEventListener('submit', onSave);
    E.testBtn.addEventListener('click', onTest);
    E.toggleToken.addEventListener('click', onToggleToken);
    E.autoToggle.addEventListener('change', onAutoToggle);
    E.retryBtn.addEventListener('click', onRetry);
    E.dismissBtn.addEventListener('click', onDismiss);

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') refresh();
    });

    const store = await chrome.storage.local.get(STORE_KEYS);
    renderAll(store, { fillForm: true });
  }

  init().catch((err) => {
    showMessage('error', 'LeetSync popup failed to start: ' + (err && err.message ? err.message : 'unknown error'));
  });
})();
