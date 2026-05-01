(() => {
  if (globalThis.__libraryAutoRenew_hkplLogoutDoneRan) return;
  globalThis.__libraryAutoRenew_hkplLogoutDoneRan = true;

  /** Same target as background LOGIN_URL — jump immediately while queue advances. */
  const LOGIN_URL = "https://www.hkpl.gov.hk/tc/login.html";

  async function notifyDone() {
    const { shouldLogout, didNotifyLogoutDone } = await chrome.storage.local.get([
      "shouldLogout",
      "didNotifyLogoutDone",
    ]);
    if (!shouldLogout || didNotifyLogoutDone) return;

    await chrome.storage.local.set({ didNotifyLogoutDone: true });

    chrome.runtime.sendMessage(
      { type: "LOGOUT_DONE", url: location.href },
      (response) => {
        const err = chrome.runtime.lastError;
        if (err) return;
        if (response?.ok && response.goLogin) {
          window.location.href = LOGIN_URL;
        }
      },
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => notifyDone().catch(() => {}));
  } else {
    notifyDone().catch(() => {});
  }
})();
