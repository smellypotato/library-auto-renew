(() => {
  if (globalThis.__libraryAutoRenew_hkplConfirmLogoutRan) return;
  globalThis.__libraryAutoRenew_hkplConfirmLogoutRan = true;

  async function maybeConfirmLogout() {
    const { shouldLogout, didConfirmLogout } = await chrome.storage.local.get([
      "shouldLogout",
      "didConfirmLogout",
    ]);
    if (didConfirmLogout) return;
    if (!shouldLogout) {
      const bodyText = (document.body?.textContent ?? "").replace(/\s+/g, "");
      if (!bodyText.includes("你確定要登出嗎")) return;
    }

    const buttons = Array.from(document.querySelectorAll("button"));

    const yesButton =
      buttons.find((b) => (b.getAttribute("onclick") ?? "").includes("logout()")) ||
      buttons.find((b) => (b.textContent ?? "").replace(/\s+/g, "") === "是") ||
      buttons.find((b) => (b.textContent ?? "").includes("是"));

    if (!yesButton && typeof window.logout !== "function") return;

    await chrome.storage.local.set({ didConfirmLogout: true });
    if (yesButton) yesButton.click();
    else window.logout();
  }

  let confirmLogoutPollAttempts = 0;
  const maxAttempts = 120;
  const intervalMs = 250;
  const timer = setInterval(() => {
    confirmLogoutPollAttempts += 1;
    maybeConfirmLogout().catch(() => {});
    if (confirmLogoutPollAttempts >= maxAttempts) clearInterval(timer);
  }, intervalMs);
})();
