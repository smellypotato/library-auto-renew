(() => {
  if (globalThis.__libraryAutoRenew_webcatRenewResultRan) return;
  globalThis.__libraryAutoRenew_webcatRenewResultRan = true;

  function isRenewResultDom() {
    for (const h2 of document.querySelectorAll("h2")) {
      const t = (h2.textContent ?? "").trim();
      if (t.includes("續借結果") || /續借成功/.test(t)) return true;
      if (/renewal result/i.test(t) || /renewal.*success/i.test(t)) return true;
    }
    return false;
  }

  async function maybeReportRenewResult() {
    const { waitingForRenewResult } = await chrome.storage.local.get([
      "waitingForRenewResult",
    ]);
    if (!waitingForRenewResult || !isRenewResultDom()) return;

    chrome.runtime.sendMessage({
      type: "RENEW_RESULT_DETECTED",
      url: location.href,
    });
  }

  let pollAttempts = 0;
  const maxAttempts = 40;
  const timer = setInterval(() => {
    pollAttempts += 1;
    maybeReportRenewResult().catch(() => {});
    if (pollAttempts >= maxAttempts) clearInterval(timer);
  }, 250);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      maybeReportRenewResult().catch(() => {});
    });
  } else {
    maybeReportRenewResult().catch(() => {});
  }
})();
