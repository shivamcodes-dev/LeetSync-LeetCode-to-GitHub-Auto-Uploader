# LeetSync

A Manifest V3 Chrome extension that uploads your **Accepted** LeetCode solutions to your GitHub repository, straight into the repository root. No backend, no framework, no third-party servers.

```
LeetCode-Solutions/
├── 1. Two Sum.java
├── 2. Add Two Numbers.py
├── 3. Longest Substring Without Repeating Characters.cpp
└── README.md
```

No problem/language/difficulty folders are ever created. File names are `{problemNumber}. {problemTitle}.{extension}`.

## Install (Load unpacked)

1. Unzip the project so you have a folder named `LeetSync` containing `manifest.json`.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `LeetSync` folder (the one that contains `manifest.json`).
5. Click the puzzle-piece icon in the toolbar and pin **LeetSync** (optional but handy).
6. Click the LeetSync icon, fill in your GitHub details, press **Save settings**, then **Test GitHub connection**.
7. Open any problem on https://leetcode.com, submit, and wait for **Accepted**. A small "LeetSync: Uploaded ..." notice appears on the page and the popup's **Last uploaded solution** card updates.

Requires Chrome 111 or newer. After editing any file, press the reload icon on the extension's card in `chrome://extensions`, then refresh open LeetCode tabs.

## GitHub token permissions

Create the repository first and make sure it has at least one commit (for example, tick "Add a README" when creating it).

**Fine-grained personal access token (recommended)**

- Repository access: *Only select repositories* -> your solutions repository
- Repository permissions: **Contents -> Read and write** (Metadata -> Read is added automatically)

**Classic token**: scope `repo` (private repositories) or `public_repo` (public repositories only).

The token is stored in `chrome.storage.local` (on this computer, in this Chrome profile only). It is only ever sent to `https://api.github.com` in the `Authorization` header and is never logged. Anyone with access to your Chrome profile files could read it, so use a token limited to one repository and revoke it if you stop using the extension.

## Architecture and data flow

```
 LeetCode page (MAIN world)          content script (isolated)          service worker              GitHub
 ┌──────────────────────┐            ┌────────────────────────┐        ┌───────────────────┐
 │ inject.js            │ postMessage│ content.js             │ message│ background.js     │
 │ watches fetch / XHR: │ ─────────► │ 1. verdict == Accepted?│ ─────► │ - validate payload│
 │  POST .../submit/    │ SUBMITTED  │ 2. GraphQL:            │ UPLOAD │ - dedup by id     │ REST
 │  GET  .../check/     │ JUDGED     │    submissionDetails   │        │ - build file name │ ───────►  PUT /contents
 └──────────────────────┘            │    (code, lang,        │        │ - github.js:      │
                                     │     statusCode == 10)  │        │   check, create,  │
                                     │ 3. GraphQL: question   │        │   never overwrite │
                                     │    (number, title)     │        │ - store status    │
                                     └────────────────────────┘        └───────────────────┘
                                                                                │ chrome.storage.local
                                                                                ▼
                                                                         popup.html / popup.js
```

1. **inject.js** runs in the page's own JavaScript world (content scripts cannot otherwise see the page's network calls). It wraps `fetch` and `XMLHttpRequest` and watches two LeetCode endpoints: the submit request (gives the submission id and the problem slug) and the verdict poll `/submissions/detail/{id}/check/` (gives `state: SUCCESS` and `status_msg`). It never reads source code and never modifies responses.
2. **content.js** only treats those messages as hints. When a verdict says "Accepted" it asks LeetCode itself (same-origin GraphQL `submissionDetails`, using your logged-in session) for the submission and requires `statusCode == 10` and a non-empty `code`. It also loads the problem number and title (GraphQL `question(titleSlug)`) and checks the submission belongs to that problem. If the page's own polling is not observed (for example, LeetCode changes how it polls), a fallback poller checks the verdict itself.
3. **background.js** validates the payload, skips submission ids it has already processed, builds the file name, and calls **github.js**. Uploads run one at a time. The result is stored for the popup.
4. **github.js** checks for the file on your branch (`GET /contents/{path}?ref=branch`). Missing: `PUT` creates it. Identical code already there: nothing to do. Different code there: it is **never overwritten**; the new solution is saved next to it as `1. Two Sum (2).java`, `(3)`, and so on. Success is reported only when GitHub's response confirms the commit.
5. **popup** shows settings, connection status, the automatic-upload switch, the last uploaded solution, and the last failure with a **Retry upload** button (the failed submission's code is kept locally for that, until it is retried or dismissed).

### What LeetCode data is used (and how reliable it is)

I checked how other open-source LeetCode tools talk to the site rather than guessing:

| Purpose | Mechanism | Notes |
|---|---|---|
| Detect verdict | `GET /submissions/detail/{id}/check/` -> `state`, `status_msg` | Same endpoint the site polls after Submit; also used by CLI tools. |
| Get exact source code | GraphQL `submissionDetails(submissionId)` -> `code`, `statusCode`, `lang { name verboseName }`, `question { questionId }` | The code is **not** reliably in the DOM (the editor is Monaco and is virtualized), so the DOM is not used. Needs your logged-in session, which the extension uses automatically. |
| Problem number and title | GraphQL `question(titleSlug)` -> `questionFrontendId`, `title` | The file number is LeetCode's displayed problem number, not the internal id. |

**Limitations to know about**

- These are LeetCode's *internal, undocumented* endpoints. LeetCode can change them without notice; if that happens uploads will fail with a visible message rather than silently succeeding.
- Only `leetcode.com` is supported (not `leetcode.cn`).
- Submission ids are sent as a GraphQL `Int`. If LeetCode ever outgrows that or changes the schema, the code lookup will fail and you will see "source code could not be retrieved".
- Only submissions made while the tab is open and the extension is enabled are captured. Old submissions are not back-filled.
- If you submit from a tab and close it before the verdict arrives, nothing is uploaded.
- The Chrome service worker can be stopped by Chrome when idle; it is woken automatically by the next message.

## Behaviour details

| Situation | What LeetSync does |
|---|---|
| Wrong Answer / TLE / etc. | Nothing (the code is not even fetched). |
| Same submission seen twice | Uploaded once (tracked by submission id, last 1000 kept). |
| File exists with identical code | Reports "already in repo", no commit. |
| File exists with different code | Keeps the original, saves the new one as `... (2).ext`. |
| Missing/invalid settings | Failure shown in popup; fix settings and press **Retry upload**. |
| 401 | "GitHub rejected the token (invalid, expired or revoked)." |
| 403 | Token lacks write permission (or SSO authorization). |
| 403/429 rate limit | "GitHub rate limit reached. Try again in N seconds." |
| 404 | Repository (or branch) not found, or the token cannot see a private repo. |
| Network failure | "Network error: could not reach GitHub." |

File name rules: `/` and `\` become `-`; `" * : < > ? |` and control characters are removed; repeated spaces are collapsed; trailing dots/spaces are trimmed. Extensions: java, cpp, py (python/python3), c, cs, js, ts, php, swift, kt, dart, go, rb, scala, rs, rkt, erl, ex, sql, sh; unknown languages use `.txt`.

## Permissions (minimum)

- `storage` - settings and status.
- Host access to `https://api.github.com/*` - GitHub uploads.
- Content scripts on `https://leetcode.com/*` - detect results (declared in the manifest, no extra permission).

No `tabs`, `scripting`, `cookies` or broad host permissions. No data leaves your browser except requests to LeetCode (your own session) and `api.github.com`.

## Project structure

```
LeetSync/
├── manifest.json     MV3 manifest
├── inject.js         page-world observer (fetch / XHR)
├── content.js        verifies Accepted, reads code + problem info
├── background.js     service worker: dedup, upload pipeline, state
├── github.js         GitHub REST helper (shared by popup and background)
├── popup.html        popup markup (loads github.js, then popup.js)
├── popup.css         dark developer theme
├── popup.js          popup logic
├── icons/            16/32/48/128 px icons
├── tests/run-tests.js   offline test suite
└── README.md
```

## Tests

```
node tests/run-tests.js
```

Runs the real extension files against in-memory fakes of GitHub, LeetCode and the Chrome APIs: manifest/file consistency; settings validation; file naming and Unicode Base64; connection test (success, 401, 404, 403, read-only token, archived repo, missing branch, rate limit, network); upload (create, identical, conflict -> `(2)`, race, empty repo, failures never reported as success); Accepted detection, wrong-answer handling, spoofed messages, fallback polling, XHR polling, duplicate prevention, missing settings + retry, token never appearing in logs or messages; popup behaviour.

**What the tests cannot prove:** that the live LeetCode site and the live GitHub API still behave like the fakes, and that Chrome loads the extension exactly as expected. Do a real run (below) before relying on it.

### Quick real-world check

1. Load the extension, save settings, press **Test GitHub connection** -> you should see `owner/repo` and the branch.
2. On LeetCode open a problem, submit a correct solution -> within a few seconds you should see the green notice and the file in your repo root.
3. Submit the same code again -> notice says it is already uploaded/identical; no new commit.
4. Submit a wrong answer -> nothing happens.
5. If something fails: open `chrome://extensions` -> LeetSync -> **service worker** (to see background logs) and the LeetCode tab's DevTools console (content script logs). Neither ever prints your token or code.

## Troubleshooting

- **Nothing uploads after Accepted**: refresh the LeetCode tab once after installing/reloading the extension (existing tabs do not get the new scripts). Check the popup for a red failure card.
- **"Repository not found"** but it exists: for private repos the token must be granted that repository.
- **"The token cannot write"**: fine-grained token needs *Contents: Read and write*.
- **Empty repository error**: create a first commit (a README) on the branch, then Test again.
- **Wrong branch**: the Branch field must match an existing branch (`main` vs `master`).
