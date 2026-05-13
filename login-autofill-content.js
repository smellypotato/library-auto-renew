(() => {
  if (globalThis.__libraryAutoRenew_loginAutofillRan) return;
  globalThis.__libraryAutoRenew_loginAutofillRan = true;

  /** Per-tab / per-page load only. Global storage caused stray login tabs to skip submit. */
  let didAutoSubmitLogin = false;

  /** Keep in sync with PHASE_PAGE_TIMEOUT_MS in background.js */
  const PHASE_PAGE_TIMEOUT_MS = 30000;
  const PHASE_POLL_INTERVAL_MS = 250;
  const PHASE_POLL_MAX_ATTEMPTS = Math.ceil(
    PHASE_PAGE_TIMEOUT_MS / PHASE_POLL_INTERVAL_MS,
  );

  let phaseFailedReported = false;

  function reportLoginPhaseFailed(error) {
    if (phaseFailedReported) return;
    phaseFailedReported = true;
    chrome.runtime.sendMessage({
      type: "PHASE_FAILED",
      phase: "login",
      error,
    });
  }

  function dispatchInputEvents(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
  }

  async function tryAutofill() {
    const { account, password, currentAccount } =
      await chrome.storage.local.get(["account", "password", "currentAccount"]);
    const acct = currentAccount?.account ?? account;
    const pw = currentAccount?.password ?? password;

    if (!acct && !pw) return;

    const accountEl = document.querySelector("#account, input[name='USER']");
    const passwordEl = document.querySelector("#password, input[name='PASSWORD']");

    if (accountEl && acct) {
      setNativeValue(accountEl, acct);
      dispatchInputEvents(accountEl);
    }

    if (passwordEl && pw) {
      setNativeValue(passwordEl, pw);
      dispatchInputEvents(passwordEl);
    }

    const submitButton =
      document.querySelector("#submitButton") ||
      document.querySelector("button[type='submit']") ||
      document.querySelector("form#login button");

    if (
      !didAutoSubmitLogin &&
      accountEl &&
      passwordEl &&
      submitButton
    ) {
      didAutoSubmitLogin = true;
      submitButton.click();
    }
  }

  let loginAutofillPollAttempts = 0;
  const timer = setInterval(async () => {
    loginAutofillPollAttempts += 1;
    await tryAutofill();

    const accountEl = document.querySelector("#account, input[name='USER']");
    const passwordEl = document.querySelector("#password, input[name='PASSWORD']");
    const hasAccount = !!accountEl;
    const hasPassword = !!passwordEl;

    if (
      (hasAccount && hasPassword) ||
      loginAutofillPollAttempts >= PHASE_POLL_MAX_ATTEMPTS
    ) {
      clearInterval(timer);

      if (loginAutofillPollAttempts >= PHASE_POLL_MAX_ATTEMPTS) {
        if (!hasAccount || !hasPassword) {
          reportLoginPhaseFailed(
            "Cannot find HKPL login username/password fields (timed out).",
          );
          return;
        }
        if (!didAutoSubmitLogin) {
          reportLoginPhaseFailed(
            "Login form found but could not submit (timed out or blocked).",
          );
        }
      }
    }
  }, PHASE_POLL_INTERVAL_MS);
})();
