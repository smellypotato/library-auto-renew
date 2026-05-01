(() => {
  if (globalThis.__libraryAutoRenew_webcatLogoutRan) return;
  globalThis.__libraryAutoRenew_webcatLogoutRan = true;

  async function maybeLogout() {
    const { shouldLogout, didClickLogout } = await chrome.storage.local.get([
      "shouldLogout",
      "didClickLogout",
    ]);
    if (!shouldLogout || didClickLogout) return;

    const logoutLink =
      document.querySelector("a[href*='/auth/logout']") ||
      Array.from(document.querySelectorAll("a")).find((a) =>
        (a.textContent ?? "").replace(/\s+/g, "").includes("登出"),
      );

    if (!logoutLink) return;

    await chrome.storage.local.set({ didClickLogout: true });
    logoutLink.click();
  }

  let logoutPollAttempts = 0;
  const maxAttempts = 40;
  const intervalMs = 250;
  const timer = setInterval(() => {
    logoutPollAttempts += 1;
    maybeLogout().catch(() => {});
    if (logoutPollAttempts >= maxAttempts) clearInterval(timer);
  }, intervalMs);
})();
