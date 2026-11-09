# 🚀 LeetSync

**Automatically Sync Your Accepted LeetCode Solutions to GitHub.**

LeetSync is a Chrome Extension built using Manifest V3 that automatically uploads your accepted LeetCode solutions to your GitHub repository.

No manual copying. No backend server. Just solve a problem, get Accepted, and let LeetSync handle the upload.

## ✨ Features

- **Automatic Submission Detection** – Detects when a LeetCode submission receives Accepted status.
- **Automatic GitHub Upload** – Uploads the submitted source code directly to your repository.
- **Multiple Programming Languages** – Supports Java, Python, C++, JavaScript, TypeScript and more.
- **Clean File Structure** – Stores all solutions directly in the repository root.
- **Duplicate Protection** – Prevents processing the same submission multiple times.
- **Safe File Handling** – Never silently overwrites existing solutions.
- **GitHub Integration** – Uses the GitHub REST API.
- **Secure Local Storage** – Stores GitHub configuration in Chrome local storage.
- **Modern UI** – Clean, dark-themed developer interface.

## 📸 Preview

<!-- Add your extension screenshots here -->

## 🛠️ Tech Stack

- JavaScript
- HTML5
- CSS3
- Chrome Extension Manifest V3
- Chrome Storage API
- GitHub REST API
- LeetCode GraphQL

## 📂 Project Structure

```text
LeetSync/
│
├── manifest.json
├── popup.html
├── popup.css
├── popup.js
├── github.js
├── background.js
├── content.js
├── inject.js
└── README.md
```

## 📁 GitHub Repository Structure

LeetSync uploads solutions directly into the repository root.

Example:

```text
LeetCode-Solutions/
│
├── 1. Two Sum.java
├── 2. Add Two Numbers.py
├── 3. Longest Substring Without Repeating Characters.cpp
└── README.md
```

No problem-wise, language-wise or difficulty-wise folders are created.

**File naming convention:**

`{problemNumber}. {problemTitle}.{extension}`

## ⚙️ Installation

1. Download or clone this repository.
2. Extract the project folder if downloaded as ZIP.
3. Open Google Chrome.
4. Navigate to `chrome://extensions`.
5. Enable **Developer Mode**.
6. Click **Load unpacked**.
7. Select the LeetSync project folder containing `manifest.json`.
8. Pin LeetSync to your Chrome toolbar.

## 🔑 GitHub Configuration

LeetSync requires a GitHub Personal Access Token.

### Create a Fine-Grained Personal Access Token

1. Open GitHub Settings.
2. Navigate to Developer Settings.
3. Select Personal Access Tokens → Fine-grained tokens.
4. Generate a new token.
5. Select your target repository.
6. Grant the following permission:

| Permission | Access         |
| ---------- | -------------- |
| Contents   | Read and write |
| Metadata   | Read           |

### Configure LeetSync

Open the extension and enter:

- GitHub Username
- Repository Name
- Personal Access Token
- Default Branch

Click **Save Settings**, followed by **Test GitHub Connection**.

## 🔄 How It Works

1. Open a problem on LeetCode.
2. Write and submit your solution.
3. LeetSync monitors the submission result.
4. It verifies that the submission is Accepted.
5. It retrieves the source code associated with the actual submission ID.
6. It checks whether the solution already exists in GitHub.
7. It creates a new file in your repository root.
8. The popup displays the upload result.

## 🔐 Security & Privacy

- GitHub tokens are stored locally using `chrome.storage.local`.
- No backend server is required.
- No external database is used.
- Tokens are never intentionally printed in logs.
- Source code is uploaded directly to GitHub.
- GitHub credentials are not sent to third-party servers.

Use a fine-grained token restricted to your solutions repository.

## ⚠️ Limitations

- Currently supports LeetCode on `leetcode.com`.
- Requires an active LeetCode login session.
- Only accepted submissions are eligible for upload.
- LeetCode's internal APIs are undocumented and may change.
- Submissions made before installing the extension are not automatically imported.
- Live end-to-end compatibility should be verified after installation.

## 🚀 Future Improvements

- Support for more coding platforms.
- Upload history and submission statistics.
- Retry failed uploads.
- Custom filename formats.
- Improved submission detection and recovery.
- Extension settings for automatic upload control.

## 👨‍💻 Author

**Shivam Raj**

Built as a personal project to simplify LeetCode solution management and explore Chrome Extension development.

---

⭐ If you find this project useful, consider giving it a star!

**Made with ❤️ and JavaScript.**
