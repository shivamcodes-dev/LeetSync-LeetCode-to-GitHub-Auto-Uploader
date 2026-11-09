/*
 * LeetSync - GitHub REST API helper.
 *
 * Loaded by popup.html (<script src="github.js">) and by background.js
 * (importScripts('github.js')). Exposes one global: LeetSyncGitHub.
 *
 * Security notes:
 *  - The token is only ever placed in the Authorization header.
 *  - Error messages are written by this file (plus GitHub's own `message`
 *    field, with the token redacted). The token is never logged.
 */
(function (root) {
  'use strict';

  const API_BASE = 'https://api.github.com';
  const API_VERSION = '2022-11-28';
  const MAX_NAME_ATTEMPTS = 25; // "X.java", "X (2).java", ... "X (25).java"
  const MAX_CONFLICT_RETRIES = 3;

  /** Error type thrown by every function in this file. */
  class GitHubError extends Error {
    constructor(code, message, extra) {
      super(message);
      this.name = 'GitHubError';
      this.code = code;
      this.status = (extra && extra.status) || 0;
      this.retryAfter = (extra && extra.retryAfter) || 0; // seconds
      this.apiMessage = (extra && extra.apiMessage) || '';
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const enc = encodeURIComponent;

  /* ------------------------------------------------------------------ */
  /* Settings validation                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Validates and normalizes { username, repo, token, branch }.
   * Returns { valid, errors: {field: message}, settings: normalized }.
   */
  function validateSettings(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const settings = {
      username: String(src.username || '').trim(),
      repo: String(src.repo || '').trim(),
      token: String(src.token || '').trim(),
      branch: String(src.branch || '').trim()
    };
    const errors = {};

    if (!settings.username) {
      errors.username = 'GitHub username is required.';
    } else if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/.test(settings.username)) {
      errors.username = 'That does not look like a valid GitHub username.';
    }

    if (!settings.repo) {
      errors.repo = 'Repository name is required.';
    } else if (
      !/^[A-Za-z0-9._-]{1,100}$/.test(settings.repo) ||
      settings.repo === '.' ||
      settings.repo === '..'
    ) {
      errors.repo = 'Repository name may only contain letters, numbers, ".", "-" and "_".';
    }

    if (!settings.token) {
      errors.token = 'Personal Access Token is required.';
    } else if (/\s/.test(settings.token)) {
      errors.token = 'The token must not contain spaces or line breaks.';
    }

    const b = settings.branch;
    if (!b) {
      errors.branch = 'Branch is required (for example "main").';
    } else if (
      /[\s~^:?*[\\\u0000-\u001f\u007f]/.test(b) ||
      b.includes('..') ||
      b.includes('@{') ||
      b.includes('//') ||
      b.startsWith('/') ||
      b.endsWith('/') ||
      b.endsWith('.') ||
      b.endsWith('.lock') ||
      b === '@'
    ) {
      errors.branch = 'That is not a valid Git branch name.';
    }

    return { valid: Object.keys(errors).length === 0, errors, settings };
  }

  /* ------------------------------------------------------------------ */
  /* File naming                                                        */
  /* ------------------------------------------------------------------ */

  const LANGUAGE_EXTENSIONS = {
    cpp: 'cpp',
    java: 'java',
    python: 'py',
    python3: 'py',
    pythondata: 'py',
    c: 'c',
    csharp: 'cs',
    javascript: 'js',
    typescript: 'ts',
    php: 'php',
    swift: 'swift',
    kotlin: 'kt',
    dart: 'dart',
    golang: 'go',
    ruby: 'rb',
    scala: 'scala',
    rust: 'rs',
    racket: 'rkt',
    erlang: 'erl',
    elixir: 'ex',
    mysql: 'sql',
    mssql: 'sql',
    oraclesql: 'sql',
    postgresql: 'sql',
    bash: 'sh'
  };

  /** Maps a LeetCode language slug (lang.name) to a file extension. */
  function extensionFor(langName) {
    const key = String(langName || '').toLowerCase();
    return Object.prototype.hasOwnProperty.call(LANGUAGE_EXTENSIONS, key)
      ? LANGUAGE_EXTENSIONS[key]
      : 'txt';
  }

  /**
   * Makes a string safe to use as part of a file name at the repository root.
   * "/" and "\" become "-" (so words stay separated); other characters that
   * are invalid on common file systems (" * : < > ? |) and control characters
   * are removed.
   */
  function sanitizeFilenamePart(value) {
    return String(value == null ? '' : value)
      .normalize('NFC')
      .replace(/[\\/]+/g, '-')
      .replace(/[\u0000-\u001f\u007f"*:<>?|]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 150)
      .replace(/[. ]+$/, '');
  }

  /** "1" + "Two Sum" -> "1. Two Sum" (extension is added by the uploader). */
  function buildStem(problemNumber, title) {
    const num = sanitizeFilenamePart(problemNumber);
    const name = sanitizeFilenamePart(title);
    if (!num && !name) return '';
    if (!num) return name;
    if (!name) return num;
    return `${num}. ${name}`;
  }

  /* ------------------------------------------------------------------ */
  /* Base64 (Unicode safe)                                              */
  /* ------------------------------------------------------------------ */

  function utf8ToBase64(text) {
    const bytes = new TextEncoder().encode(String(text));
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  function base64ToUtf8(b64) {
    const binary = atob(String(b64).replace(/\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  }

  /* ------------------------------------------------------------------ */
  /* HTTP layer                                                         */
  /* ------------------------------------------------------------------ */

  function redact(text, token) {
    let out = String(text || '');
    if (token && token.length >= 8) out = out.split(token).join('***');
    return out;
  }

  function buildHeaders(token, hasBody) {
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION
    };
    if (hasBody) headers['Content-Type'] = 'application/json';
    return headers;
  }

  function formatWait(seconds) {
    if (!seconds || seconds < 1) return 'a little while';
    if (seconds < 90) return `${Math.ceil(seconds)} seconds`;
    return `${Math.ceil(seconds / 60)} minutes`;
  }

  function buildError(res, data, token) {
    const status = res.status;
    const apiMessage = redact(data && typeof data.message === 'string' ? data.message : '', token);
    const header = (name) => (res.headers && res.headers.get ? res.headers.get(name) : null);
    const remaining = header('x-ratelimit-remaining');
    const retryAfterHeader = header('retry-after');
    const resetHeader = header('x-ratelimit-reset');

    const rateLimited =
      status === 429 ||
      (status === 403 &&
        (remaining === '0' || Boolean(retryAfterHeader) || /rate limit/i.test(apiMessage)));

    if (rateLimited) {
      let seconds = 0;
      if (retryAfterHeader && Number(retryAfterHeader) > 0) {
        seconds = Number(retryAfterHeader);
      } else if (resetHeader && Number(resetHeader) > 0) {
        seconds = Math.max(0, Number(resetHeader) - Math.floor(Date.now() / 1000));
      }
      return new GitHubError(
        'RATE_LIMIT',
        `GitHub rate limit reached. Try again in ${formatWait(seconds)}.`,
        { status, retryAfter: seconds, apiMessage }
      );
    }
    if (status === 401) {
      return new GitHubError(
        'BAD_CREDENTIALS',
        'GitHub rejected the token (invalid, expired or revoked). Create a new token and save it again.',
        { status, apiMessage }
      );
    }
    if (status === 403) {
      return new GitHubError(
        'FORBIDDEN',
        'The token is not allowed to do this. It needs read and write access to the repository contents ' +
          '(see the README). For organization repositories the token may also need SSO authorization.',
        { status, apiMessage }
      );
    }
    if (status === 404) {
      return new GitHubError('NOT_FOUND', 'GitHub returned "Not Found".', { status, apiMessage });
    }
    if (status === 409) {
      return new GitHubError('CONFLICT', 'GitHub reported a conflict (the branch changed during the request).', {
        status,
        apiMessage
      });
    }
    if (status === 422) {
      return new GitHubError(
        'VALIDATION',
        `GitHub could not process the request${apiMessage ? `: ${apiMessage.split('\n')[0]}` : '.'}`,
        { status, apiMessage }
      );
    }
    if (status >= 500) {
      return new GitHubError('SERVER', `GitHub is having problems right now (HTTP ${status}). Try again later.`, {
        status,
        apiMessage
      });
    }
    return new GitHubError('HTTP', `Unexpected response from GitHub (HTTP ${status}).`, { status, apiMessage });
  }

  async function request(settings, method, path, body) {
    const init = { method, headers: buildHeaders(settings.token, body !== undefined) };
    if (body !== undefined) init.body = JSON.stringify(body);

    let res;
    try {
      res = await fetch(API_BASE + path, init);
    } catch (e) {
      throw new GitHubError(
        'NETWORK',
        'Network error: could not reach GitHub. Check your internet connection and try again.'
      );
    }

    let data = null;
    try {
      const text = await res.text();
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      data = null;
    }

    if (!res.ok) throw buildError(res, data, settings.token);
    return { status: res.status, data };
  }

  function repoPath(s) {
    return `/repos/${enc(s.username)}/${enc(s.repo)}`;
  }

  function contentsPath(s, fileName) {
    return `${repoPath(s)}/contents/${enc(fileName)}`;
  }

  /* ------------------------------------------------------------------ */
  /* Connection test                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Verifies that the repository and branch exist and that the token can
   * (as far as GitHub reports) write to it.
   * Returns { fullName, defaultBranch, branch, isPrivate, htmlUrl }.
   */
  async function testConnection(rawSettings) {
    const v = validateSettings(rawSettings);
    if (!v.valid) throw new GitHubError('NO_SETTINGS', 'GitHub settings are missing or invalid.');
    const s = v.settings;

    let repo;
    try {
      repo = (await request(s, 'GET', repoPath(s))).data;
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        throw new GitHubError(
          'NOT_FOUND',
          `Repository "${s.username}/${s.repo}" was not found. Check the username and repository name. ` +
            'For a private repository, make sure the token has access to it.',
          { status: 404 }
        );
      }
      throw err;
    }

    if (repo && repo.archived) {
      throw new GitHubError('ARCHIVED', 'This repository is archived (read-only). Unarchive it or choose another one.');
    }
    if (repo && repo.permissions && repo.permissions.push === false) {
      throw new GitHubError(
        'FORBIDDEN',
        'The token can read this repository but cannot write to it. Grant it write access to the repository contents.'
      );
    }

    try {
      await request(s, 'GET', `${repoPath(s)}/branches/${enc(s.branch)}`);
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        throw new GitHubError(
          'BRANCH_NOT_FOUND',
          `Branch "${s.branch}" was not found in ${repo.full_name}. ` +
            `The default branch is "${repo.default_branch}". ` +
            'If the repository is empty, create a first commit (for example a README) on GitHub first.',
          { status: 404 }
        );
      }
      throw err;
    }

    return {
      fullName: repo.full_name,
      defaultBranch: repo.default_branch,
      branch: s.branch,
      isPrivate: Boolean(repo.private),
      htmlUrl: repo.html_url || ''
    };
  }

  /* ------------------------------------------------------------------ */
  /* Upload                                                             */
  /* ------------------------------------------------------------------ */

  /** Returns the contents-API object for a file, or null if it does not exist. */
  async function getFile(s, fileName) {
    try {
      const res = await request(s, 'GET', `${contentsPath(s, fileName)}?ref=${enc(s.branch)}`);
      return res.data || null;
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        if (/no commit found for the ref/i.test(err.apiMessage)) {
          throw new GitHubError(
            'BRANCH_NOT_FOUND',
            `Branch "${s.branch}" was not found in ${s.username}/${s.repo}.`,
            { status: 404 }
          );
        }
        return null; // file (or empty repository) -> nothing there yet
      }
      if (err.code === 'CONFLICT' && /empty/i.test(err.apiMessage)) return null; // empty repository
      throw err;
    }
  }

  function normalizeNewlines(text) {
    return String(text).replace(/\r\n/g, '\n');
  }

  function isSameContent(existing, content) {
    try {
      if (
        existing &&
        !Array.isArray(existing) &&
        existing.type === 'file' &&
        existing.encoding === 'base64' &&
        typeof existing.content === 'string'
      ) {
        return normalizeNewlines(base64ToUtf8(existing.content)) === normalizeNewlines(content);
      }
    } catch (e) {
      /* fall through */
    }
    return false;
  }

  /**
   * Uploads a solution file to the repository root without ever overwriting
   * existing code.
   *
   * file = { stem: "1. Two Sum", ext: "java", content: "<source>", message: "<commit message>" }
   *
   * - File missing                  -> created            (status "created")
   * - File exists, identical code   -> nothing to do      (status "unchanged")
   * - File exists, different code   -> saved next to it as "<stem> (2).<ext>",
   *                                    "(3)", ... (status "created_alt")
   *
   * Success is only returned after GitHub confirms the commit.
   */
  async function uploadSolution(rawSettings, file) {
    const v = validateSettings(rawSettings);
    if (!v.valid) throw new GitHubError('NO_SETTINGS', 'GitHub settings are missing or invalid.');
    const s = v.settings;

    if (!file || typeof file.stem !== 'string' || !file.stem || typeof file.ext !== 'string' || !file.ext) {
      throw new GitHubError('BAD_FILE', 'Could not build a valid file name for this solution.');
    }
    if (typeof file.content !== 'string' || file.content.length === 0) {
      throw new GitHubError('NO_CONTENT', 'There is no source code to upload.');
    }

    const encoded = utf8ToBase64(file.content);
    const requestedPath = `${file.stem}.${file.ext}`;
    const message = file.message || `Add ${requestedPath}`;

    let n = 1;
    let conflictRetries = 0;

    while (n <= MAX_NAME_ATTEMPTS) {
      const path = n === 1 ? requestedPath : `${file.stem} (${n}).${file.ext}`;

      const existing = await getFile(s, path);
      if (existing) {
        if (isSameContent(existing, file.content)) {
          return {
            status: 'unchanged',
            path,
            requestedPath,
            htmlUrl: (!Array.isArray(existing) && existing.html_url) || null,
            commitUrl: null
          };
        }
        n += 1; // something different is already there: never overwrite it
        continue;
      }

      try {
        const res = await request(s, 'PUT', contentsPath(s, path), {
          message,
          content: encoded,
          branch: s.branch
        });
        const data = res.data;
        if (!data || !data.content || !data.content.sha) {
          throw new GitHubError('UNCONFIRMED', 'GitHub did not confirm the upload. Nothing was reported as saved.');
        }
        return {
          status: n === 1 ? 'created' : 'created_alt',
          path,
          requestedPath,
          htmlUrl: data.content.html_url || null,
          commitUrl: (data.commit && data.commit.html_url) || null
        };
      } catch (err) {
        if (err instanceof GitHubError) {
          if (err.code === 'NOT_FOUND') {
            throw new GitHubError(
              'NOT_FOUND',
              `Upload failed: repository "${s.username}/${s.repo}" or branch "${s.branch}" was not found, ` +
                'or the token cannot see it.',
              { status: 404 }
            );
          }
          const fileAppearedMeanwhile = err.code === 'VALIDATION' && /sha/i.test(err.apiMessage);
          if ((fileAppearedMeanwhile || err.code === 'CONFLICT') && conflictRetries < MAX_CONFLICT_RETRIES) {
            conflictRetries += 1;
            await sleep(800 * conflictRetries);
            continue; // re-check the same name
          }
        }
        throw err;
      }
    }

    throw new GitHubError(
      'TOO_MANY_VARIANTS',
      `Could not find a free file name for "${file.stem}" after ${MAX_NAME_ATTEMPTS} tries.`
    );
  }

  root.LeetSyncGitHub = {
    GitHubError,
    validateSettings,
    testConnection,
    uploadSolution,
    buildStem,
    sanitizeFilenamePart,
    extensionFor,
    utf8ToBase64,
    base64ToUtf8
  };
})(globalThis);
