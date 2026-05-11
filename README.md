# Library Auto Renew

Browser extension (Manifest V3) for **Hong Kong Public Library (HKPL)**. It helps you sign in to WebCat, renew loans that are **due today**, and manage **multiple library accounts**. Optional **daily reminders** are supported.

This project is **not** affiliated with HKPL. Use it at your own risk and in line with HKPL’s terms of service.

---

## Requirements

- **Chrome**, **Microsoft Edge**, **Brave**, or another Chromium-based browser that supports **developer / unpacked** extensions.
- The folder you load must include [`manifest.json`](manifest.json) and the [`icons`](icons/) directory referenced there.

---

## How to install (easiest way — download the ZIP)

**We recommend downloading the project as a ZIP file.** You do not need a GitHub account, and you do not need to know Git.

### Step 1: Download the ZIP

**Recommended — ready-to-load extension (small ZIP):**

- **[Download library-auto-renew-v1.0.0.zip](dist/library-auto-renew-v1.0.0.zip)** — contains only the extension files (`manifest.json`, scripts, `icons/`, etc.). After you extract it, use **Load unpacked** on the extracted folder.

This link uses a **path relative to this README**. It works on GitHub **after** `dist/library-auto-renew-v1.0.0.zip` has been **committed and pushed** to the branch you are viewing (for example `main`). You do not need to invent a special URL; GitHub turns the link above into the correct download page for that file.

**Alternative — whole project folder (larger ZIP):**

1. Open this project’s page on GitHub.
2. Click the green **Code** button.
3. Click **Download ZIP**.
4. Extract it; open the folder that contains **`manifest.json`** (often named like `library-auto-renew-main`).

### Step 2: Unzip the folder

1. Find the ZIP in your **Downloads** folder.
2. **Extract** it (on Windows: right‑click the ZIP → **Extract All…**; on Mac: double‑click the ZIP).
3. After extracting, open the folder that contains **`manifest.json`** and an **`icons`** folder.  
   - If you used the **whole repository** ZIP, GitHub often names that folder something like `library-auto-renew-main`.  
   - If you used the **small extension** ZIP, the folder may match the file name (for example `library-auto-renew-v1.0.0`).

Keep this folder somewhere permanent (for example **Documents**). If you delete it later, the unpacked extension may stop working until you point Chrome/Edge at the folder again.

### Step 3: Load the extension in your browser

1. Open your browser’s extensions page:
   - **Chrome:** type `chrome://extensions` in the address bar and press Enter.
   - **Edge:** type `edge://extensions` in the address bar and press Enter.
2. Turn **Developer mode** **ON** (switch near the top corner of the page).
3. Click **Load unpacked**.
4. When the file picker opens, select the **folder that contains `manifest.json`** (the folder from Step 2 — not the ZIP file, and not a folder above or below it).

You should see **Library Auto Renew** in your extensions list. Pin it to the toolbar if you want one‑click access to the popup.

### Alternative for developers: clone with Git

If you use Git and prefer cloning: clone the repository, then use **Load unpacked** and choose the cloned folder that contains `manifest.json`. Steps 3–4 above are the same.

---

## First-time setup

1. Click the extension icon to open the **popup**.
2. Add your HKPL account(s) (library card number and password). Credentials are stored **only in your browser’s local extension storage**—they are not sent to this project’s servers (there aren’t any).
3. Use the popup to **run renewal** for one account or all accounts. The extension automates login on HKPL sites and renewal actions on WebCat as described in the manifest.

---

## Package a ZIP (Windows)

If you want a single ZIP file (e.g. to share or sideload), from PowerShell in this repository run:

```powershell
.\pack-extension.ps1
```

Output is written to `dist/` as `library-auto-renew-v<version>.zip`. To install from that ZIP, extract it first, then **Load unpacked** on the extracted folder (Chrome does not install extensions directly from arbitrary ZIPs without unpacking).

If you publish a **direct download** link in this README (see Step 1), **commit and push** the new ZIP under `dist/` whenever you bump the version, and update the README filename if it changes (for example `library-auto-renew-v1.0.1.zip`).

---

## Updating

Download a **fresh ZIP** (use the **[direct link](dist/library-auto-renew.zip)** in Step 1 if it matches the latest release, or repeat Step 1), extract it over your old folder or into a new folder, then on `chrome://extensions` or `edge://extensions` click **Reload** on **Library Auto Renew**. If you used a new folder, use **Remove** on the old extension entry and **Load unpacked** again on the new folder.

Your saved accounts usually stay as long as you do not remove the extension or clear extension data. If you use Git instead, you can pull the latest changes and reload the extension the same way.

---

## Permissions (why they exist)

- **`storage`** — Saved accounts and extension settings.
- **`tabs`** — Opens and drives the HKPL / WebCat tabs needed for login and renewal.
- **`alarms`** — Optional scheduled checks (e.g. daily reminder behaviour).
- **Host access** — Limited to `hkpl.gov.hk` and `webcat.hkpl.gov.hk` as declared in [`manifest.json`](manifest.json).

---

## Troubleshooting

- **“Manifest file is missing or unreadable”** — You selected the wrong folder; choose the directory that contains `manifest.json`.
- **Icons / load errors** — Ensure the [`icons`](icons/) folder and PNG files listed in `manifest.json` are present.
- **Sites changed** — HKPL may update pages; if automation breaks, check for updates to this repo or open an issue with steps to reproduce.