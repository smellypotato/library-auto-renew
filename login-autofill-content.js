(() => {
  if (globalThis.__libraryAutoRenew_loginAutofillRan) return;
  globalThis.__libraryAutoRenew_loginAutofillRan = true;

  /** Per-tab / per-page load only. Global storage caused stray login tabs to skip submit. */
  let didAutoSubmitLogin = false;
  let didDismissPasswordExpiry = false;
  let didReportPasswordExpiry = false;

  /** Keep in sync with PHASE_PAGE_TIMEOUT_MS in background.js */
  const PHASE_PAGE_TIMEOUT_MS = 30000;
  const PHASE_POLL_INTERVAL_MS = 250;
  const PHASE_POLL_MAX_ATTEMPTS = Math.ceil(
    PHASE_PAGE_TIMEOUT_MS / PHASE_POLL_INTERVAL_MS,
  );

  let phaseFailedReported = false;

  function isElementVisible(el) {
    if (!el) return false;
    if (el.closest("[hidden], [aria-hidden='true']")) return false;
    const style = window.getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0"
    ) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function reportLoginPhaseFailed(error) {
    if (phaseFailedReported) return;
    if (isPasswordExpiryDialogVisible()) return;
    phaseFailedReported = true;
    chrome.runtime.sendMessage({
      type: "PHASE_FAILED",
      phase: "login",
      error,
    });
  }

  /**
   * Only treat expiry UI as active when the dialog (or its continue button) is
   * actually visible. The button can exist in the DOM while hidden; treating
   * mere presence as "open" skipped autofill and clicked an empty login.
   */
  function isPasswordExpiryDialogVisible() {
    const dialog = document.querySelector("#pwExpiryAlertDialog");
    if (dialog && isElementVisible(dialog)) return true;

    const btn = document.querySelector("#pwExpiryLogin");
    if (btn && isElementVisible(btn)) return true;

    // jQuery UI wraps the dialog; check the open dialog shell.
    const uiDialog = document.querySelector(
      ".ui-dialog[aria-describedby='pwExpiryAlertDialog']",
    );
    if (uiDialog && isElementVisible(uiDialog)) return true;

    return false;
  }

  function parsePasswordExpiryInfo() {
    const dialog = document.querySelector("#pwExpiryAlertDialog");
    const raw = (dialog?.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim();

    let days = null;
    const daysMatch = raw.match(/將於\s*(\d+)\s*天後/);
    if (daysMatch) days = Number(daysMatch[1]);

    let dateText = "";
    const dateMatch = raw.match(
      /即\s*(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)/,
    );
    if (dateMatch) {
      dateText = dateMatch[1].replace(/\s+/g, "");
    }

    return { days, dateText, raw };
  }

  function tryDismissPasswordExpiry() {
    if (didDismissPasswordExpiry) return false;
    if (!isPasswordExpiryDialogVisible()) return false;

    const btn = document.querySelector("#pwExpiryLogin");
    if (!btn || !isElementVisible(btn)) return false;

    if (!didReportPasswordExpiry) {
      didReportPasswordExpiry = true;
      const info = parsePasswordExpiryInfo();
      chrome.runtime.sendMessage({
        type: "PASSWORD_EXPIRY_WARNING",
        days: info.days,
        dateText: info.dateText,
        raw: info.raw,
      });
    }

    didDismissPasswordExpiry = true;
    btn.click();
    return true;
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
    if (tryDismissPasswordExpiry()) return;

    // Wait while a visible expiry dialog is open; do not submit empty fields.
    if (isPasswordExpiryDialogVisible()) return;

    const { account, password, currentAccount } =
      await chrome.storage.local.get(["account", "password", "currentAccount"]);
    const acct = currentAccount?.account ?? account;
    const pw = currentAccount?.password ?? password;

    if (!acct || !pw) return;

    const accountEl = document.querySelector("#account, input[name='USER']");
    const passwordEl = document.querySelector(
      "#password, input[name='PASSWORD']",
    );

    if (accountEl) {
      setNativeValue(accountEl, acct);
      dispatchInputEvents(accountEl);
    }

    if (passwordEl) {
      setNativeValue(passwordEl, pw);
      dispatchInputEvents(passwordEl);
    }

    const submitButton =
      document.querySelector("#submitButton") ||
      document.querySelector("button[type='submit']") ||
      document.querySelector("form#login button.butn-login");

    const filled =
      !!accountEl &&
      !!passwordEl &&
      String(accountEl.value ?? "") === String(acct) &&
      String(passwordEl.value ?? "") === String(pw);

    if (!didAutoSubmitLogin && filled && submitButton) {
      didAutoSubmitLogin = true;
      submitButton.click();
    }
  }

  let loginAutofillPollAttempts = 0;
  const timer = setInterval(async () => {
    loginAutofillPollAttempts += 1;
    await tryAutofill();

    const accountEl = document.querySelector("#account, input[name='USER']");
    const passwordEl = document.querySelector(
      "#password, input[name='PASSWORD']",
    );
    const hasAccount = !!accountEl;
    const hasPassword = !!passwordEl;
    const expiryVisible = isPasswordExpiryDialogVisible();

    if (
      didAutoSubmitLogin ||
      loginAutofillPollAttempts >= PHASE_POLL_MAX_ATTEMPTS
    ) {
      clearInterval(timer);

      if (didAutoSubmitLogin) return;

      if (expiryVisible || didDismissPasswordExpiry) {
        // Dialog path handled separately; avoid a false login-field failure.
        return;
      }
      if (!hasAccount || !hasPassword) {
        reportLoginPhaseFailed(
          "Cannot find HKPL login username/password fields (timed out).",
        );
        return;
      }
      reportLoginPhaseFailed(
        "Login form found but could not submit (timed out or blocked).",
      );
      return;
    }

    // Keep polling while waiting for fields, credentials, or a visible expiry dialog.
    if (expiryVisible) return;
  }, PHASE_POLL_INTERVAL_MS);
})();
