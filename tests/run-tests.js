/*
 * LeetSync offline test suite. Run with:  node tests/run-tests.js
 *
 * It loads the REAL extension files (github.js, inject.js, content.js,
 * background.js, popup.js) into sandboxes and drives them against
 *   - an in-memory fake of the GitHub REST API,
 *   - an in-memory fake of the LeetCode endpoints the extension uses,
 *   - a fake `chrome` runtime / storage,
 *   - a stub DOM for the popup.
 *
 * It does NOT prove that the real LeetCode site still behaves the way the fake does.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, what, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await sleepReal(5);
  }
  throw new Error('Timed out waiting for: ' + what);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

/* ====================================================================== */
/* Fake GitHub                                                            */
/* ====================================================================== */

const TOKEN = 'github_pat_TESTTOKEN_1234567890abcdef';

function makeGitHub() {
  const state = {
    token: TOKEN,
    repo: {
      full_name: 'octo/sols',
      default_branch: 'main',
      private: true,
      archived: false,
      permissions: { admin: true, push: true, pull: true },
      html_url: 'https://github.com/octo/sols'
    },
    branches: new Set(['main']),
    files: new Map(), // path -> content (utf8 string)
    calls: [], // { method, url, headers, body }
    puts: [],
    rules: [], // { match(method, url) -> bool, respond() -> {status, headers, body}, once }
    networkDown: false
  };

  function res(status, body, headers) {
    const h = Object.assign({}, headers || {});
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (n) => (h[String(n).toLowerCase()] !== undefined ? h[String(n).toLowerCase()] : null) },
      text: async () => (body === undefined || body === null ? '' : typeof body === 'string' ? body : JSON.stringify(body))
    };
  }

  async function fetchImpl(url, init) {
    init = init || {};
    const method = (init.method || 'GET').toUpperCase();
    const u = String(url);
    state.calls.push({ method, url: u, headers: init.headers || {}, body: init.body });
    if (state.networkDown) throw new TypeError('Failed to fetch');

    for (let i = 0; i < state.rules.length; i++) {
      const rule = state.rules[i];
      if (rule.match(method, u)) {
        if (rule.once) state.rules.splice(i, 1);
        const r = rule.respond(method, u, init);
        return res(r.status, r.body, r.headers);
      }
    }

    assert(u.startsWith('https://api.github.com/'), 'request must go to api.github.com only: ' + u);
    const headers = init.headers || {};
    assert.strictEqual(headers.Accept, 'application/vnd.github+json', 'Accept header');
    assert.strictEqual(headers['X-GitHub-Api-Version'], '2022-11-28', 'API version header');
    if (headers.Authorization !== 'Bearer ' + state.token) return res(401, { message: 'Bad credentials' });

    const p = u.slice('https://api.github.com'.length);
    if (method === 'GET' && p === '/repos/octo/sols') return res(200, state.repo);
    if (method === 'GET' && p.startsWith('/repos/octo/sols/branches/')) {
      const b = decodeURIComponent(p.slice('/repos/octo/sols/branches/'.length));
      return state.branches.has(b) ? res(200, { name: b }) : res(404, { message: 'Branch not found' });
    }
    const m = /^\/repos\/octo\/sols\/contents\/([^?]+)(?:\?ref=(.*))?$/.exec(p);
    if (m) {
      const file = decodeURIComponent(m[1]);
      if (method === 'GET') {
        const ref = decodeURIComponent(m[2] || 'main');
        if (!state.branches.has(ref)) return res(404, { message: 'No commit found for the ref ' + ref });
        if (state.files.has(file)) {
          const b64 = Buffer.from(state.files.get(file), 'utf8').toString('base64').replace(/(.{60})/g, '$1\n');
          return res(200, {
            type: 'file',
            encoding: 'base64',
            content: b64,
            sha: 'sha-' + file,
            html_url: 'https://github.com/octo/sols/blob/main/' + encodeURIComponent(file)
          });
        }
        return res(404, { message: 'Not Found' });
      }
      if (method === 'PUT') {
        const body = JSON.parse(init.body);
        assert.strictEqual(typeof body.message, 'string');
        assert(body.branch, 'PUT must name the branch');
        assert.strictEqual(headers['Content-Type'], 'application/json');
        if (state.files.has(file)) return res(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
        if (!state.branches.has(body.branch)) return res(404, { message: 'Branch ' + body.branch + ' not found' });
        const content = Buffer.from(body.content, 'base64').toString('utf8');
        state.files.set(file, content);
        state.puts.push({ file, message: body.message, branch: body.branch });
        return res(201, {
          content: { path: file, sha: 'sha-' + file, html_url: 'https://github.com/octo/sols/blob/main/' + encodeURIComponent(file) },
          commit: { sha: 'c' + state.puts.length, html_url: 'https://github.com/octo/sols/commit/c' + state.puts.length }
        });
      }
    }
    return res(404, { message: 'Not Found' });
  }

  state.fetch = fetchImpl;
  state.addRule = (rule) => state.rules.push(rule);
  state.reset = () => {
    state.calls.length = 0;
  };
  return state;
}

function nodeGlobals(extra) {
  return Object.assign(
    { TextEncoder, TextDecoder, btoa, atob, URL, console, setTimeout, clearTimeout, Date },
    extra
  );
}

/* ====================================================================== */
/* 1. Static checks                                                       */
/* ====================================================================== */

test('manifest.json is valid and references only files that exist', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.strictEqual(m.manifest_version, 3);
  const refs = [];
  Object.values(m.icons || {}).forEach((f) => refs.push(f));
  Object.values((m.action && m.action.default_icon) || {}).forEach((f) => refs.push(f));
  refs.push(m.action.default_popup, m.background.service_worker);
  (m.content_scripts || []).forEach((cs) => (cs.js || []).forEach((f) => refs.push(f)));
  refs.forEach((f) => assert(fs.existsSync(path.join(ROOT, f)), 'missing file referenced by manifest: ' + f));
  assert.deepStrictEqual(m.permissions, ['storage'], 'only the storage permission is requested');
  assert.deepStrictEqual(m.host_permissions, ['https://api.github.com/*']);
  const world = m.content_scripts.find((c) => c.js.includes('inject.js'));
  assert.strictEqual(world.world, 'MAIN');
  assert.strictEqual(world.run_at, 'document_start');
});

test('popup.html loads github.js before popup.js and references existing files', () => {
  const html = read('popup.html');
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(scripts, ['github.js', 'popup.js']);
  [...html.matchAll(/(?:src|href)="([^"#]+\.(?:js|css|png))"/g)].forEach((m) =>
    assert(fs.existsSync(path.join(ROOT, m[1])), 'popup.html references missing file ' + m[1])
  );
  assert(!/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/.test(html), 'no inline scripts (MV3 CSP)');
  assert(!/\son[a-z]+=/.test(html), 'no inline event handlers (MV3 CSP)');
});

test('every JS file compiles', () => {
  ['github.js', 'inject.js', 'content.js', 'background.js', 'popup.js'].forEach((f) => new vm.Script(read(f), { filename: f }));
});

test('no source file contains a hard-coded token or logs the token variable', () => {
  ['github.js', 'inject.js', 'content.js', 'background.js', 'popup.js'].forEach((f) => {
    const src = read(f);
    assert(!/gh[pousr]_[A-Za-z0-9]{20,}/.test(src) && !/github_pat_[A-Za-z0-9_]{20,}/.test(src), f + ' contains a token-like literal');
    assert(!/console\.\w+\([^)]*token/i.test(src), f + ' logs something token related');
  });
});

/* ====================================================================== */
/* 2. github.js                                                           */
/* ====================================================================== */

function loadGithubLib(gh) {
  const ctx = vm.createContext(nodeGlobals({ fetch: gh.fetch }));
  vm.runInContext(read('github.js'), ctx, { filename: 'github.js' });
  return ctx.LeetSyncGitHub;
}

const GOOD = { username: 'octo', repo: 'sols', token: TOKEN, branch: 'main' };

test('github.js: settings validation', () => {
  const L = loadGithubLib(makeGitHub());
  assert.strictEqual(L.validateSettings(GOOD).valid, true);
  const bad = L.validateSettings({ username: '', repo: 'a/b', token: 'has space', branch: 'bad branch' });
  assert.strictEqual(bad.valid, false);
  assert.deepStrictEqual(Object.keys(bad.errors).sort(), ['branch', 'repo', 'token', 'username']);
  assert.strictEqual(L.validateSettings(undefined).valid, false);
  assert.strictEqual(L.validateSettings({ ...GOOD, branch: 'feature/x-1' }).valid, true);
  assert.strictEqual(L.validateSettings({ ...GOOD, branch: 'a..b' }).valid, false);
  assert.strictEqual(L.validateSettings({ ...GOOD, repo: '..' }).valid, false);
  assert.strictEqual(L.validateSettings({ ...GOOD, username: '  octo  ' }).settings.username, 'octo');
});

test('github.js: file names are "{number}. {title}.{ext}" and sanitized', () => {
  const L = loadGithubLib(makeGitHub());
  assert.strictEqual(L.buildStem('1', 'Two Sum'), '1. Two Sum');
  assert.strictEqual(L.buildStem(3, 'Longest Substring Without Repeating Characters'), '3. Longest Substring Without Repeating Characters');
  const nasty = L.buildStem('146', 'LRU/Cache: "x"? <y> | z\\w');
  assert(!/[\\/:*?"<>|]/.test(nasty), 'no invalid characters left: ' + nasty);
  assert.strictEqual(L.buildStem('7', 'Reverse Integer.  '), '7. Reverse Integer');
  assert.strictEqual(L.buildStem('50', 'Pow(x, n)'), '50. Pow(x, n)');
  assert.strictEqual(L.buildStem('9', 'Привет 世界'), '9. Привет 世界');
  assert(!L.buildStem('1', 'a\u0000b\u0007c').match(/[\u0000-\u001f]/));
  assert.strictEqual(L.extensionFor('java'), 'java');
  assert.strictEqual(L.extensionFor('python3'), 'py');
  assert.strictEqual(L.extensionFor('golang'), 'go');
  assert.strictEqual(L.extensionFor('cpp'), 'cpp');
  assert.strictEqual(L.extensionFor('totally-new-language'), 'txt');
  assert.strictEqual(L.extensionFor('constructor'), 'txt');
});

test('github.js: Base64 round-trips Unicode and large input', () => {
  const L = loadGithubLib(makeGitHub());
  const samples = ['hello', '日本語 ✓ 🚀 é ñ', 'line1\r\nline2\n', 'x'.repeat(300000), '\u{1F600}'.repeat(5000)];
  samples.forEach((s) => assert.strictEqual(L.base64ToUtf8(L.utf8ToBase64(s)), s));
  assert.strictEqual(L.utf8ToBase64('日本'), Buffer.from('日本', 'utf8').toString('base64'));
});

test('github.js: testConnection success shows repo and branch', async () => {
  const gh = makeGitHub();
  const info = plain(await loadGithubLib(gh).testConnection(GOOD));
  assert.strictEqual(info.fullName, 'octo/sols');
  assert.strictEqual(info.branch, 'main');
  assert.strictEqual(info.defaultBranch, 'main');
  assert.strictEqual(gh.calls[0].url, 'https://api.github.com/repos/octo/sols');
  assert.strictEqual(gh.calls[0].method, 'GET');
});

async function expectCode(promise, code, mustMatch) {
  let err;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  assert(err, 'expected an error with code ' + code);
  assert.strictEqual(err.code, code, 'got ' + err.code + ': ' + err.message);
  assert(!String(err.message).includes(TOKEN), 'error message leaks the token');
  if (mustMatch) assert(mustMatch.test(err.message), 'message "' + err.message + '" should match ' + mustMatch);
  return err;
}

test('github.js: connection errors are specific (401, 404, 403, network, branch, archived, read-only)', async () => {
  let gh = makeGitHub();
  await expectCode(loadGithubLib(gh).testConnection({ ...GOOD, token: 'wrong_token_value_1234' }), 'BAD_CREDENTIALS', /token/i);

  gh = makeGitHub();
  await expectCode(loadGithubLib(gh).testConnection({ ...GOOD, repo: 'nope' }), 'NOT_FOUND', /octo\/nope.*not found/i);

  gh = makeGitHub();
  gh.addRule({ match: (m, u) => u.endsWith('/repos/octo/sols'), respond: () => ({ status: 403, body: { message: 'Resource not accessible by personal access token' } }) });
  await expectCode(loadGithubLib(gh).testConnection(GOOD), 'FORBIDDEN', /permission|access/i);

  gh = makeGitHub();
  gh.networkDown = true;
  await expectCode(loadGithubLib(gh).testConnection(GOOD), 'NETWORK', /network/i);

  gh = makeGitHub();
  await expectCode(loadGithubLib(gh).testConnection({ ...GOOD, branch: 'dev' }), 'BRANCH_NOT_FOUND', /dev.*not found/i);

  gh = makeGitHub();
  gh.repo.archived = true;
  await expectCode(loadGithubLib(gh).testConnection(GOOD), 'ARCHIVED');

  gh = makeGitHub();
  gh.repo.permissions = { admin: false, push: false, pull: true };
  await expectCode(loadGithubLib(gh).testConnection(GOOD), 'FORBIDDEN', /cannot write/i);

  gh = makeGitHub();
  gh.addRule({ match: (m, u) => u.endsWith('/repos/octo/sols'), respond: () => ({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 120) }, body: { message: 'API rate limit exceeded' } }) });
  await expectCode(loadGithubLib(gh).testConnection(GOOD), 'RATE_LIMIT', /rate limit/i);

  gh = makeGitHub();
  await expectCode(loadGithubLib(gh).testConnection({ ...GOOD, username: '' }), 'NO_SETTINGS');
});

test('github.js: upload creates a root-level file, Unicode intact, with required headers', async () => {
  const gh = makeGitHub();
  const L = loadGithubLib(gh);
  const code = 'class Solution {\n  // 日本語 ✓ 🚀\n}\r\n';
  const r = plain(await L.uploadSolution(GOOD, { stem: '1. Two Sum', ext: 'java', content: code, message: 'Add 1. Two Sum.java' }));
  assert.strictEqual(r.status, 'created');
  assert.strictEqual(r.path, '1. Two Sum.java');
  assert.strictEqual(gh.files.get('1. Two Sum.java'), code);
  assert([...gh.files.keys()].every((k) => !k.includes('/')), 'files must be in the repository root');
  const put = gh.calls.find((c) => c.method === 'PUT');
  assert.strictEqual(put.url, 'https://api.github.com/repos/octo/sols/contents/1.%20Two%20Sum.java');
  assert.strictEqual(put.headers.Authorization, 'Bearer ' + TOKEN);
  assert.strictEqual(JSON.parse(put.body).branch, 'main');
  assert(gh.calls[0].url.endsWith('?ref=main'), 'existence check uses the configured branch');
});

test('github.js: identical file -> unchanged; different code -> new "(n)" file, never overwritten', async () => {
  const gh = makeGitHub();
  const L = loadGithubLib(gh);
  const up = (content) => L.uploadSolution(GOOD, { stem: '1. Two Sum', ext: 'java', content, message: 'm' }).then(plain);

  assert.strictEqual((await up('A')).status, 'created');
  const again = await up('A');
  assert.strictEqual(again.status, 'unchanged');
  assert.strictEqual(gh.puts.length, 1);

  const second = await up('B');
  assert.strictEqual(second.status, 'created_alt');
  assert.strictEqual(second.path, '1. Two Sum (2).java');
  const third = await up('C');
  assert.strictEqual(third.path, '1. Two Sum (3).java');
  assert.strictEqual((await up('B')).status, 'unchanged'); // already stored as "(2)"

  assert.strictEqual(gh.files.get('1. Two Sum.java'), 'A', 'original untouched');
  assert.strictEqual(gh.puts.length, 3);
});

test('github.js: line-ending differences alone do not create duplicates', async () => {
  const gh = makeGitHub();
  const L = loadGithubLib(gh);
  gh.files.set('5. X.py', 'a\nb\n');
  const r = plain(await L.uploadSolution(GOOD, { stem: '5. X', ext: 'py', content: 'a\r\nb\r\n', message: 'm' }));
  assert.strictEqual(r.status, 'unchanged');
});

test('github.js: a directory or odd response at the target name is never overwritten', async () => {
  const gh = makeGitHub();
  const L = loadGithubLib(gh);
  gh.addRule({ once: true, match: (m, u) => m === 'GET' && u.includes('/contents/1.%20Two%20Sum.java'), respond: () => ({ status: 200, body: [{ type: 'file', name: 'x' }] }) });
  const r = plain(await L.uploadSolution(GOOD, { stem: '1. Two Sum', ext: 'java', content: 'A', message: 'm' }));
  assert.strictEqual(r.path, '1. Two Sum (2).java');
});

test('github.js: upload failures are reported, never as success', async () => {
  let gh = makeGitHub();
  gh.addRule({ match: (m) => m === 'PUT', respond: () => ({ status: 403, body: { message: 'Resource not accessible by personal access token' } }) });
  await expectCode(loadGithubLib(gh).uploadSolution(GOOD, { stem: '1. A', ext: 'java', content: 'x', message: 'm' }), 'FORBIDDEN');

  gh = makeGitHub();
  gh.addRule({ match: (m) => m === 'PUT', respond: () => ({ status: 404, body: { message: 'Not Found' } }) });
  await expectCode(loadGithubLib(gh).uploadSolution(GOOD, { stem: '1. A', ext: 'java', content: 'x', message: 'm' }), 'NOT_FOUND', /repository.*branch/i);

  gh = makeGitHub();
  gh.addRule({ match: (m) => m === 'PUT', respond: () => ({ status: 200, body: {} }) });
  await expectCode(loadGithubLib(gh).uploadSolution(GOOD, { stem: '1. A', ext: 'java', content: 'x', message: 'm' }), 'UNCONFIRMED');

  gh = makeGitHub();
  gh.addRule({ match: (m) => m === 'PUT', respond: () => ({ status: 429, headers: { 'retry-after': '30' }, body: { message: 'secondary rate limit' } }) });
  const e = await expectCode(loadGithubLib(gh).uploadSolution(GOOD, { stem: '1. A', ext: 'java', content: 'x', message: 'm' }), 'RATE_LIMIT', /30 seconds/);
  assert.strictEqual(e.retryAfter, 30);

  gh = makeGitHub();
  gh.addRule({ match: (m) => m === 'PUT', respond: () => ({ status: 503, body: { message: 'Service Unavailable' } }) });
  await expectCode(loadGithubLib(gh).uploadSolution(GOOD, { stem: '1. A', ext: 'java', content: 'x', message: 'm' }), 'SERVER');

  gh = makeGitHub();
  gh.networkDown = true;
  await expectCode(loadGithubLib(gh).uploadSolution(GOOD, { stem: '1. A', ext: 'java', content: 'x', message: 'm' }), 'NETWORK');

  gh = makeGitHub();
  await expectCode(loadGithubLib(gh).uploadSolution({ ...GOOD, branch: 'dev' }, { stem: '1. A', ext: 'java', content: 'x', message: 'm' }), 'BRANCH_NOT_FOUND');

  gh = makeGitHub();
  await expectCode(loadGithubLib(gh).uploadSolution(GOOD, { stem: '1. A', ext: 'java', content: '', message: 'm' }), 'NO_CONTENT');
  await expectCode(loadGithubLib(gh).uploadSolution({ ...GOOD, token: '' }, { stem: '1. A', ext: 'java', content: 'x', message: 'm' }), 'NO_SETTINGS');
  assert.strictEqual(gh.puts.length, 0);
});

test('github.js: an empty repository can receive the first file', async () => {
  const gh = makeGitHub();
  gh.addRule({ once: true, match: (m, u) => m === 'GET' && u.includes('/contents/'), respond: () => ({ status: 404, body: { message: 'This repository is empty.' } }) });
  const r = plain(await loadGithubLib(gh).uploadSolution(GOOD, { stem: '1. A', ext: 'java', content: 'x', message: 'm' }));
  assert.strictEqual(r.status, 'created');
});

test('github.js: a race (file appears between check and PUT) is retried safely', async () => {
  const gh = makeGitHub();
  gh.addRule({
    once: true,
    match: (m) => m === 'PUT',
    respond: () => {
      gh.files.set('1. A.java', 'someone else');
      return { status: 422, body: { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' } };
    }
  });
  const r = plain(await loadGithubLib(gh).uploadSolution(GOOD, { stem: '1. A', ext: 'java', content: 'mine', message: 'm' }));
  assert.strictEqual(r.path, '1. A (2).java');
  assert.strictEqual(gh.files.get('1. A.java'), 'someone else');
  assert.strictEqual(gh.files.get('1. A (2).java'), 'mine');
});

test('github.js: a token echoed back inside a GitHub error message is redacted', async () => {
  const gh = makeGitHub();
  gh.addRule({ match: (m) => m === 'PUT', respond: () => ({ status: 422, body: { message: 'weird failure for ' + TOKEN } }) });
  const e = await expectCode(loadGithubLib(gh).uploadSolution(GOOD, { stem: '1. A', ext: 'java', content: 'x', message: 'm' }), 'VALIDATION');
  assert(e.message.includes('***'));
  assert(!e.apiMessage.includes(TOKEN));
});

/* ====================================================================== */
/* 3. Extension runtime: fake chrome, fake LeetCode, real scripts          */
/* ====================================================================== */

function makeEnv() {
  const gh = makeGitHub();
  const store = {};
  const msgListeners = [];
  const changeListeners = [];
  const logs = [];
  const badges = [];

  const storage = {
    async get(keys) {
      const list = keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
      const out = {};
      list.forEach((k) => {
        if (k in store) out[k] = plain(store[k]);
      });
      return out;
    },
    async set(obj) {
      const changes = {};
      Object.entries(obj).forEach(([k, v]) => {
        store[k] = plain(v);
        changes[k] = { newValue: plain(v) };
      });
      changeListeners.forEach((fn) => fn(changes, 'local'));
    },
    async remove(keys) {
      const changes = {};
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
        delete store[k];
        changes[k] = {};
      });
      changeListeners.forEach((fn) => fn(changes, 'local'));
    }
  };

  function chromeFor(sender) {
    return {
      runtime: {
        id: 'ext-id',
        lastError: undefined,
        onMessage: { addListener: (fn) => msgListeners.push(fn) },
        onInstalled: { addListener: () => {} },
        sendMessage(msg, cb) {
          const p = new Promise((resolve) => {
            const senderObj = { id: 'ext-id', tab: sender.tab ? { id: 1 } : undefined, url: sender.url };
            for (const l of msgListeners) {
              const r = l(plain(msg), senderObj, (resp) => resolve(plain(resp)));
              if (r === true) return;
            }
            resolve(undefined);
          });
          if (typeof cb === 'function') {
            p.then(cb);
            return undefined;
          }
          return p;
        }
      },
      storage: { local: storage, onChanged: { addListener: (fn) => changeListeners.push(fn) } },
      action: { setBadgeText: (o) => badges.push(o.text), setBadgeBackgroundColor() {} }
    };
  }

  // background service worker
  const bgCtx = vm.createContext(
    nodeGlobals({
      chrome: chromeFor({}),
      fetch: gh.fetch,
      console: { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')) },
      setTimeout: (fn, ms, ...a) => {
        const t = setTimeout(fn, ms, ...a);
        if (t.unref) t.unref();
        return t;
      },
      importScripts: (f) => vm.runInContext(read(f), bgCtx, { filename: f })
    })
  );
  vm.runInContext(read('background.js'), bgCtx, { filename: 'background.js' });

  const env = { gh, store, storage, logs, badges, chromeFor, msgListeners };

  env.saveSettings = (s) => storage.set({ settings: Object.assign({ username: 'octo', repo: 'sols', token: TOKEN, branch: 'main' }, s) });
  env.sendFromPopup = (msg) => chromeFor({}).runtime.sendMessage(msg);
  return env;
}

function makeLeetCode() {
  const lc = {
    problems: {
      'two-sum': { questionId: '1', questionFrontendId: '1', title: 'Two Sum', titleSlug: 'two-sum' },
      'add-two-numbers': { questionId: '2', questionFrontendId: '2', title: 'Add Two Numbers', titleSlug: 'add-two-numbers' },
      'valid-parentheses': { questionId: '9020', questionFrontendId: '20', title: 'Valid Parentheses', titleSlug: 'valid-parentheses' }
    },
    submissions: {}, // id -> { code, statusCode, statusMsg, lang, questionId, hidden }
    nextSubmitId: null,
    checkCounts: {},
    graphql: []
  };
  const json = (obj, status) => ({ ok: (status || 200) < 300, status: status || 200, json: async () => obj, clone() { return this; } });

  lc.addSubmission = (id, over) => {
    lc.submissions[id] = Object.assign(
      { code: 'class Solution {}', statusCode: 10, statusMsg: 'Accepted', lang: { name: 'java', verboseName: 'Java' }, questionId: '1' },
      over || {}
    );
  };

  lc.fetch = async (url, init) => {
    init = init || {};
    const u = String(url).replace(/^https:\/\/leetcode\.com/, '');
    const method = (init.method || 'GET').toUpperCase();
    let m;
    if (method === 'POST' && (m = /^\/problems\/([a-z0-9-]+)\/submit\/$/.exec(u))) return json({ submission_id: lc.nextSubmitId });
    if ((m = /^\/submissions\/detail\/(\d+)\/check\/$/.exec(u))) {
      const id = m[1];
      lc.checkCounts[id] = (lc.checkCounts[id] || 0) + 1;
      const s = lc.submissions[id];
      if (!s || lc.checkCounts[id] < 2) return json({ state: 'PENDING' });
      return json({ state: 'SUCCESS', status_msg: s.statusMsg, status_code: s.statusCode, lang: s.lang.name });
    }
    if (method === 'POST' && u === '/graphql/') {
      assert.strictEqual(init.credentials, 'same-origin');
      assert.strictEqual(init.headers['x-csrftoken'], 'abc123');
      const body = JSON.parse(init.body);
      lc.graphql.push(body);
      if (/submissionDetails\(/.test(body.query)) {
        assert.strictEqual(typeof body.variables.submissionId, 'number');
        const s = lc.submissions[body.variables.submissionId];
        if (!s || s.hidden) return json({ data: { submissionDetails: null } });
        return json({ data: { submissionDetails: { code: s.code, statusCode: s.statusCode, lang: s.lang, question: { questionId: s.questionId } } } });
      }
      if (/question\(titleSlug/.test(body.query)) return json({ data: { question: lc.problems[body.variables.titleSlug] || null } });
    }
    throw new Error('fake LeetCode: unexpected request ' + method + ' ' + u);
  };
  return lc;
}

class FakeXHR {
  constructor() {
    this._l = {};
    this.responseType = '';
    this.responseText = '';
  }
  open(method, url) {
    this._method = method;
    this._url = url;
  }
  addEventListener(t, fn) {
    (this._l[t] = this._l[t] || []).push(fn);
  }
  send() {
    FakeXHR.server(this._url, { method: this._method })
      .then((r) => r.json())
      .then((obj) => {
        this.responseText = JSON.stringify(obj);
        setTimeout(() => (this._l.load || []).forEach((fn) => fn.call(this)), 0);
      });
  }
}

/** One LeetCode tab: inject.js in a "main world" and content.js in an "isolated world". */
function makePage(env, lc, pathname) {
  FakeXHR.server = lc.fetch;
  const isoListeners = [];
  const fastTimeout = (fn, ms, ...a) => setTimeout(fn, 0, ...a); // compress all delays

  const doc = {
    cookie: 'csrftoken=abc123; other=1',
    toasts: [],
    getElementById: () => null,
    createElement: () => ({ style: {}, setAttribute() {}, parentNode: null }),
    body: { appendChild() {} },
    documentElement: { appendChild() {} }
  };
  const location = { origin: 'https://leetcode.com', pathname: pathname || '/problems/two-sum/description/' };

  const iso = { console, JSON, Date, setTimeout: fastTimeout, clearTimeout, document: doc, location, chrome: env.chromeFor({ tab: true, url: 'https://leetcode.com' + location.pathname }), fetch: lc.fetch, URL };
  iso.window = iso;
  iso.addEventListener = (t, fn) => {
    if (t === 'message') isoListeners.push(fn);
  };

  const main = { console, JSON, Date, setTimeout, clearTimeout, location, fetch: lc.fetch, XMLHttpRequest: FakeXHR };
  main.window = main;
  vm.createContext(main);
  vm.createContext(iso);
  // Inside a vm context `window` is the context's own global, not the outer sandbox object,
  // and a real MessageEvent's `source` is that same window object.
  const isoWindow = vm.runInContext('window', iso);
  main.postMessage = (data, targetOrigin) => {
    assert.strictEqual(targetOrigin, 'https://leetcode.com', 'postMessage must target the page origin');
    setTimeout(() => isoListeners.forEach((fn) => fn({ data, source: isoWindow, origin: 'https://leetcode.com' })), 0);
  };

  vm.runInContext(read('inject.js'), main, { filename: 'inject.js' });
  vm.runInContext(read('content.js'), iso, { filename: 'content.js' });
  return { main, iso, location };
}

async function userSubmits(page, lc, { id, slug = 'two-sum', polls = 2, viaXhr = false }) {
  lc.nextSubmitId = id;
  await page.main.fetch(`/problems/${slug}/submit/`, { method: 'POST', body: '{}' });
  for (let i = 0; i < polls; i++) {
    if (viaXhr) {
      const x = new page.main.XMLHttpRequest();
      x.open('GET', `https://leetcode.com/submissions/detail/${id}/check/`);
      x.send();
    } else {
      await page.main.fetch(`https://leetcode.com/submissions/detail/${id}/check/`);
    }
    await sleepReal(15);
  }
}

const storeHas = (env, key) => key in env.store;

test('flow: Accepted submission -> exact code uploaded to repository root', async () => {
  const env = makeEnv();
  const lc = makeLeetCode();
  await env.saveSettings();
  const code = 'class Solution {\n  // 日本語 ✓ 🚀\n}\r\n';
  lc.addSubmission(5001, { code });
  const page = makePage(env, lc);
  await userSubmits(page, lc, { id: 5001 });
  await waitFor(() => env.gh.files.has('1. Two Sum.java'), 'file upload');

  assert.strictEqual(env.gh.files.get('1. Two Sum.java'), code, 'uploaded code must equal submitted code exactly');
  assert.strictEqual(env.gh.puts[0].message, 'Add 1. Two Sum.java (Java)');
  assert.strictEqual(env.gh.puts[0].branch, 'main');
  await waitFor(() => storeHas(env, 'lastUpload'), 'lastUpload');
  assert.strictEqual(env.store.lastUpload.path, '1. Two Sum.java');
  assert.strictEqual(env.store.lastUpload.status, 'created');
  assert.strictEqual(env.store.uploaded['5001'], '1. Two Sum.java');
  assert(!storeHas(env, 'lastFailure'));
  assert(env.badges.includes('OK'));
});

test('flow: the same submission is never uploaded twice (replayed events, page reload)', async () => {
  const env = makeEnv();
  const lc = makeLeetCode();
  await env.saveSettings();
  lc.addSubmission(5001);
  const page = makePage(env, lc);
  await userSubmits(page, lc, { id: 5001, polls: 4 }); // page reports the verdict several times
  await waitFor(() => env.gh.puts.length === 1, 'first upload');
  await sleepReal(100);
  assert.strictEqual(env.gh.puts.length, 1, 'repeated verdicts on one page -> still one upload');

  const reloaded = makePage(env, lc); // fresh content script: its own memory is empty
  lc.checkCounts[5001] = 0;
  await userSubmits(reloaded, lc, { id: 5001 });
  await sleepReal(150);
  assert.strictEqual(env.gh.puts.length, 1, 'background dedup by submission id');
  const gets = env.gh.calls.length;
  const direct = await env.chromeFor({ tab: true, url: 'https://leetcode.com/problems/two-sum/' }).runtime.sendMessage({
    type: 'UPLOAD_SUBMISSION',
    payload: { submissionId: '5001', slug: 'two-sum', title: 'Two Sum', questionFrontendId: '1', langName: 'java', langVerbose: 'Java', code: 'x' }
  });
  assert.strictEqual(direct.status, 'duplicate');
  assert.strictEqual(env.gh.calls.length, gets, 'duplicate check must not call GitHub');
});

test('flow: existing different solution is kept; new code goes to "(2)"; identical code is not re-uploaded', async () => {
  const env = makeEnv();
  const lc = makeLeetCode();
  await env.saveSettings();
  lc.addSubmission(5001, { code: 'A' });
  lc.addSubmission(5002, { code: 'B' });
  lc.addSubmission(5003, { code: 'A' });
  const page = makePage(env, lc);

  await userSubmits(page, lc, { id: 5001 });
  await waitFor(() => env.gh.files.has('1. Two Sum.java'), 'first file');
  await userSubmits(page, lc, { id: 5002 });
  await waitFor(() => env.gh.files.has('1. Two Sum (2).java'), 'second file');
  assert.strictEqual(env.gh.files.get('1. Two Sum.java'), 'A');
  assert.strictEqual(env.gh.files.get('1. Two Sum (2).java'), 'B');
  await waitFor(() => env.store.lastUpload && env.store.lastUpload.status === 'created_alt', 'created_alt status');

  await userSubmits(page, lc, { id: 5003 });
  await waitFor(() => env.store.lastUpload.submissionId === '5003', 'third submission processed');
  assert.strictEqual(env.store.lastUpload.status, 'unchanged');
  assert.strictEqual(env.gh.puts.length, 2);
});

test('flow: non-Accepted verdicts never upload or even fetch the code', async () => {
  const env = makeEnv();
  const lc = makeLeetCode();
  await env.saveSettings();
  lc.addSubmission(5004, { statusCode: 11, statusMsg: 'Wrong Answer' });
  const page = makePage(env, lc);
  await userSubmits(page, lc, { id: 5004 });
  await sleepReal(150);
  assert.strictEqual(env.gh.calls.length, 0);
  assert.strictEqual(lc.graphql.length, 0, 'no code was requested for a wrong answer');
  assert(!storeHas(env, 'lastFailure'));
});

test('flow: a spoofed "Accepted" message from the page is rejected after verification with LeetCode', async () => {
  const env = makeEnv();
  const lc = makeLeetCode();
  await env.saveSettings();
  lc.addSubmission(5005, { statusCode: 11, statusMsg: 'Wrong Answer' });
  const page = makePage(env, lc);
  page.main.postMessage({ source: 'leetsync-page', type: 'JUDGED', submissionId: '5005', statusMsg: 'Accepted', statusCode: 10 }, 'https://leetcode.com');
  await sleepReal(150);
  assert.strictEqual(env.gh.calls.length, 0);
  assert(lc.graphql.some((g) => /submissionDetails/.test(g.query)), 'LeetCode itself was asked');
});

test('flow: fallback polling still catches the verdict if the page polling is not observed', async () => {
  const env = makeEnv();
  const lc = makeLeetCode();
  await env.saveSettings();
  lc.addSubmission(5006, { code: 'def f(): pass', lang: { name: 'python3', verboseName: 'Python3' }, questionId: '2' });
  const page = makePage(env, lc, '/problems/add-two-numbers/');
  await userSubmits(page, lc, { id: 5006, slug: 'add-two-numbers', polls: 0 });
  await waitFor(() => env.gh.files.has('2. Add Two Numbers.py'), 'fallback upload');
  assert.strictEqual(env.gh.puts.length, 1);
});

test('flow: XHR-based result polling, slug taken from the submit request, frontend id used in the file name', async () => {
  const env = makeEnv();
  const lc = makeLeetCode();
  await env.saveSettings();
  lc.addSubmission(5007, { code: '// c++', lang: { name: 'cpp', verboseName: 'C++' }, questionId: '9020' });
  const page = makePage(env, lc, '/problemset/'); // location says nothing about the problem
  await userSubmits(page, lc, { id: 5007, slug: 'valid-parentheses', viaXhr: true });
  await waitFor(() => env.gh.files.has('20. Valid Parentheses.cpp'), 'xhr flow upload');
});

test('flow: source code unavailable / problem mismatch -> clear failure, nothing uploaded', async () => {
  const env = makeEnv();
  const lc = makeLeetCode();
  await env.saveSettings();
  lc.addSubmission(5008, { hidden: true });
  const page = makePage(env, lc);
  await userSubmits(page, lc, { id: 5008 });
  await waitFor(() => storeHas(env, 'lastFailure'), 'failure recorded');
  assert.strictEqual(env.store.lastFailure.code, 'PAGE_ERROR');
  assert(/source code/i.test(env.store.lastFailure.message));
  assert.strictEqual(env.gh.calls.length, 0);

  lc.addSubmission(5009, { questionId: '777' });
  await userSubmits(page, lc, { id: 5009 });
  await waitFor(() => /does not belong/.test((env.store.lastFailure || {}).message || ''), 'mismatch failure');
  assert.strictEqual(env.gh.calls.length, 0);
});

test('flow: missing settings -> failure kept with retry payload; retry works after saving settings', async () => {
  const env = makeEnv();
  const lc = makeLeetCode();
  lc.addSubmission(5010, { code: 'late code' });
  const page = makePage(env, lc);
  await userSubmits(page, lc, { id: 5010 });
  await waitFor(() => storeHas(env, 'lastFailure'), 'NO_SETTINGS failure');
  assert.strictEqual(env.store.lastFailure.code, 'NO_SETTINGS');
  assert(env.store.lastFailure.payload && env.store.lastFailure.payload.submissionId === '5010');
  assert(env.badges.includes('!'));
  assert.strictEqual(env.gh.calls.length, 0);

  await env.saveSettings();
  const res = await env.sendFromPopup({ type: 'RETRY_LAST_FAILED' });
  assert.strictEqual(res.ok, true, res.message);
  assert.strictEqual(env.gh.files.get('1. Two Sum.java'), 'late code');
  assert(!storeHas(env, 'lastFailure'), 'failure cleared after successful retry');
});

test('flow: GitHub failures are surfaced (403, 401, rate limit, network) and the token is never logged', async () => {
  const env = makeEnv();
  const lc = makeLeetCode();
  await env.saveSettings();
  const page = makePage(env, lc);

  lc.addSubmission(5011, { code: 'one' });
  env.gh.addRule({ once: true, match: (m) => m === 'PUT', respond: () => ({ status: 403, body: { message: 'Resource not accessible by personal access token' } }) });
  await userSubmits(page, lc, { id: 5011 });
  await waitFor(() => storeHas(env, 'lastFailure'), '403 failure');
  assert.strictEqual(env.store.lastFailure.code, 'FORBIDDEN');
  assert.strictEqual(env.gh.puts.length, 0, 'no success claimed');
  assert(!storeHas(env, 'lastUpload'));

  const retry = await env.sendFromPopup({ type: 'RETRY_LAST_FAILED' });
  assert.strictEqual(retry.ok, true);
  assert.strictEqual(env.gh.puts.length, 1);

  await env.saveSettings({ token: 'ghp_wrong_token_zzzzzzzzzzzzzzzz' });
  lc.addSubmission(5012, { code: 'SECRET_SOLUTION_CODE_MARKER' });
  await userSubmits(page, lc, { id: 5012 });
  await waitFor(() => (env.store.lastFailure || {}).code === 'BAD_CREDENTIALS', '401 failure');

  await env.saveSettings();
  env.gh.addRule({ once: true, match: (m, u) => m === 'GET' && u.includes('/contents/'), respond: () => ({ status: 403, headers: { 'x-ratelimit-remaining': '0' }, body: { message: 'API rate limit exceeded' } }) });
  const rl = await env.sendFromPopup({ type: 'RETRY_LAST_FAILED' });
  assert.strictEqual(rl.ok, false);
  assert.strictEqual(rl.code, 'RATE_LIMIT');

  env.gh.networkDown = true;
  const net = await env.sendFromPopup({ type: 'RETRY_LAST_FAILED' });
  assert.strictEqual(net.code, 'NETWORK');

  const everything = env.logs.join('\n') + JSON.stringify(env.store.lastFailure && env.store.lastFailure.message);
  assert(!everything.includes(TOKEN) && !everything.includes('ghp_wrong_token'), 'token leaked into logs or messages');
  assert(!env.logs.join('\n').includes('SECRET_SOLUTION_CODE_MARKER'), 'source code must not be logged');
});

test('flow: the automatic-upload switch is respected', async () => {
  const env = makeEnv();
  const lc = makeLeetCode();
  await env.saveSettings();
  await env.storage.set({ autoUpload: false });
  lc.addSubmission(5013);
  const page = makePage(env, lc);
  await userSubmits(page, lc, { id: 5013 });
  await sleepReal(150);
  assert.strictEqual(env.gh.calls.length, 0);
  assert(!storeHas(env, 'lastFailure'));
});

test('background rejects messages that do not come from a LeetCode tab / the popup', async () => {
  const env = makeEnv();
  await env.saveSettings();
  const payload = { submissionId: '1', slug: 'two-sum', title: 'Two Sum', questionFrontendId: '1', langName: 'java', langVerbose: 'Java', code: 'x' };
  const fromWeb = await env.chromeFor({ tab: true, url: 'https://evil.example/' }).runtime.sendMessage({ type: 'UPLOAD_SUBMISSION', payload });
  assert.strictEqual(fromWeb, undefined);
  const retryFromTab = await env.chromeFor({ tab: true, url: 'https://leetcode.com/' }).runtime.sendMessage({ type: 'RETRY_LAST_FAILED' });
  assert.strictEqual(retryFromTab, undefined);
  const bad = await env.chromeFor({ tab: true, url: 'https://leetcode.com/problems/x/' }).runtime.sendMessage({ type: 'UPLOAD_SUBMISSION', payload: { ...payload, code: '   ' } });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(env.gh.calls.length, 0);
});

/* ====================================================================== */
/* 4. Popup                                                               */
/* ====================================================================== */

function makeEl() {
  const listeners = {};
  const classes = new Set();
  return {
    value: '', textContent: '', hidden: false, disabled: false, checked: false, type: 'text', href: '', className: '', attrs: {},
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    async fire(t) { for (const fn of listeners[t] || []) await fn({ preventDefault() {} }); }
  };
}

async function openPopup(env) {
  const html = read('popup.html');
  const els = {};
  [...html.matchAll(/\sid="([^"]+)"/g)].forEach((m) => (els[m[1]] = makeEl()));
  els.token.type = 'password';
  els.branch.value = 'main';
  els['auto-toggle'].checked = true;

  const ctx = vm.createContext(nodeGlobals({ document: { getElementById: (id) => els[id] || null }, chrome: env.chromeFor({}), fetch: env.gh.fetch }));
  vm.runInContext(read('github.js'), ctx, { filename: 'github.js' });
  vm.runInContext(read('popup.js'), ctx, { filename: 'popup.js' });
  await sleepReal(30);
  return els;
}

test('popup: first open shows "Setup needed" and an empty last-upload card', async () => {
  const env = makeEnv();
  const els = await openPopup(env);
  assert.strictEqual(els['status-pill'].textContent, 'SETUP');
  assert.strictEqual(els['last-empty'].hidden, false);
  assert.strictEqual(els['last-body'].hidden, true);
  assert.strictEqual(els['failure-card'].hidden, true);
  assert.strictEqual(els['connection'].hidden, true);
  assert.strictEqual(els.branch.value, 'main');
});

test('popup: validation messages, save, and settings are loaded again on the next open', async () => {
  const env = makeEnv();
  let els = await openPopup(env);
  await els['settings-form'].fire('submit');
  assert(els['err-username'].textContent && els['err-repo'].textContent && els['err-token'].textContent);
  assert.strictEqual(els.message.className, 'message error');
  assert(!storeHas(env, 'settings'));

  els.username.value = ' octo ';
  els.repo.value = 'sols';
  els.token.value = TOKEN;
  els.branch.value = 'main';
  await els['settings-form'].fire('submit');
  assert.strictEqual(els['err-username'].textContent, '');
  assert.strictEqual(env.store.settings.username, 'octo');
  assert.strictEqual(env.store.settings.token, TOKEN);
  assert.strictEqual(els['status-pill'].textContent, 'ON');
  assert.strictEqual(els.message.className, 'message success');

  els = await openPopup(env);
  assert.strictEqual(els.username.value, 'octo');
  assert.strictEqual(els.repo.value, 'sols');
  assert.strictEqual(els.token.value, TOKEN);
  assert.strictEqual(els['status-pill'].textContent, 'ON');
});

test('popup: show/hide token', async () => {
  const els = await openPopup(makeEnv());
  assert.strictEqual(els.token.type, 'password');
  await els['toggle-token'].fire('click');
  assert.strictEqual(els.token.type, 'text');
  assert.strictEqual(els['toggle-token'].textContent, 'Hide');
  await els['toggle-token'].fire('click');
  assert.strictEqual(els.token.type, 'password');
  assert.strictEqual(els['toggle-token'].textContent, 'Show');
});

test('popup: "Test GitHub connection" shows repo + branch on success and meaningful errors otherwise', async () => {
  const env = makeEnv();
  const els = await openPopup(env);
  els.username.value = 'octo';
  els.repo.value = 'sols';
  els.token.value = TOKEN;
  els.branch.value = 'main';
  await els['test-btn'].fire('click');
  assert.strictEqual(els.connection.hidden, false);
  assert.strictEqual(els['connection-repo'].textContent, 'octo/sols');
  assert.strictEqual(els['connection-branch'].textContent, 'main');
  assert.strictEqual(els.message.className, 'message success');
  assert.strictEqual(els['test-btn'].disabled, false);

  els.repo.value = 'missing-repo';
  await els['test-btn'].fire('click');
  assert.strictEqual(els.connection.hidden, true);
  assert.strictEqual(els.message.className, 'message error');
  assert(/not found/i.test(els.message.textContent));

  els.repo.value = 'sols';
  els.token.value = 'bad_token_value_123456';
  await els['test-btn'].fire('click');
  assert(/token/i.test(els.message.textContent));

  env.gh.networkDown = true;
  els.token.value = TOKEN;
  await els['test-btn'].fire('click');
  assert(/network/i.test(els.message.textContent));
  assert(!els.message.textContent.includes(TOKEN));
});

test('popup: auto-upload switch, last upload card (safe link), failure card with Retry/Dismiss', async () => {
  const env = makeEnv();
  const lc = makeLeetCode();
  await env.saveSettings();
  const els = await openPopup(env);

  els['auto-toggle'].checked = false;
  await els['auto-toggle'].fire('change');
  assert.strictEqual(env.store.autoUpload, false);
  assert.strictEqual(els['status-pill'].textContent, 'PAUSED');
  els['auto-toggle'].checked = true;
  await els['auto-toggle'].fire('change');
  assert.strictEqual(els['status-pill'].textContent, 'ON');

  await env.storage.set({ lastUpload: { title: 'Two Sum', path: '1. Two Sum.java', status: 'created', repo: 'octo/sols', time: Date.now(), htmlUrl: 'https://github.com/octo/sols/blob/main/x' } });
  await sleepReal(30); // the popup re-renders asynchronously on storage changes
  assert.strictEqual(els['last-title'].textContent, '1. Two Sum.java');
  assert.strictEqual(els['last-link'].hidden, false);
  assert(/^https:\/\/github\.com\//.test(els['last-link'].href));
  await env.storage.set({ lastUpload: { title: 'x', path: 'x.java', status: 'created', repo: 'octo/sols', time: 1, htmlUrl: 'javascript:alert(1)' } });
  await sleepReal(30);
  assert.strictEqual(els['last-link'].hidden, true, 'non-GitHub links are never rendered');

  await env.storage.set({ lastFailure: { message: 'boom', code: 'X', time: 1, title: 'Two Sum', payload: { submissionId: '9001', slug: 'two-sum', title: 'Two Sum', questionFrontendId: '1', langName: 'java', langVerbose: 'Java', code: 'retry me' } } });
  await sleepReal(30);
  assert.strictEqual(els['failure-card'].hidden, false);
  assert.strictEqual(els['retry-btn'].hidden, false);
  assert(/boom/.test(els['failure-text'].textContent));
  await els['retry-btn'].fire('click');
  assert.strictEqual(env.gh.files.get('1. Two Sum.java'), 'retry me');
  assert.strictEqual(els['failure-card'].hidden, true);
  assert.strictEqual(els.message.className, 'message success');

  await env.storage.set({ lastFailure: { message: 'no payload', code: 'PAGE_ERROR', time: 1, title: '', payload: null } });
  await sleepReal(30);
  assert.strictEqual(els['retry-btn'].hidden, true);
  await els['dismiss-btn'].fire('click');
  assert.strictEqual(els['failure-card'].hidden, true);
  void lc;
});

/* ====================================================================== */

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log('  ✓ ' + t.name);
    } catch (e) {
      failed++;
      console.log('  ✗ ' + t.name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n      ') : e));
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
