(() => {
  if (globalThis.__libraryAutoRenew_webcatGoAccountRan) return;
  globalThis.__libraryAutoRenew_webcatGoAccountRan = true;

  /** Keep in sync with PHASE_PAGE_TIMEOUT_MS in background.js */
  const PHASE_PAGE_TIMEOUT_MS = 30000;
  const PHASE_POLL_INTERVAL_MS = 250;
  const PHASE_POLL_MAX_ATTEMPTS = Math.ceil(
    PHASE_PAGE_TIMEOUT_MS / PHASE_POLL_INTERVAL_MS,
  );

  let phaseFailedReported = false;

  function reportPhaseFailed(error) {
    if (phaseFailedReported) return;
    phaseFailedReported = true;
    chrome.runtime.sendMessage({
      type: "PHASE_FAILED",
      phase: "webcat-account-link",
      error,
    });
  }

  function clickAccountLink() {
    const byHref = document.querySelector(
      "a[href*='com.vtls.chamo.webapp.component.patron.PatronAccountPage']",
    );
    if (byHref) {
      byHref.click();
      return true;
    }

    const anchors = Array.from(document.querySelectorAll("a"));
    const byText = anchors.find((a) =>
      (a.textContent ?? "").replace(/\s+/g, "").includes("我的帳戶"),
    );
    if (byText) {
      byText.click();
      return true;
    }

    return false;
  }

  let goAccountPollAttempts = 0;
  const timer = setInterval(() => {
    goAccountPollAttempts += 1;
    const ok = clickAccountLink();

    if (goAccountPollAttempts >= PHASE_POLL_MAX_ATTEMPTS && !ok) {
      clearInterval(timer);
      reportPhaseFailed(
        "Cannot find “My Account” / patron link on catalogue page (timed out).",
      );
      return;
    }

    if (ok || goAccountPollAttempts >= PHASE_POLL_MAX_ATTEMPTS) {
      clearInterval(timer);
    }
  }, PHASE_POLL_INTERVAL_MS);
})();
