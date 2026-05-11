(() => {
  if (globalThis.__libraryAutoRenew_patronCheckallRan) return;
  globalThis.__libraryAutoRenew_patronCheckallRan = true;

  /** Keep in sync with PHASE_PAGE_TIMEOUT_MS in background.js */
  const PHASE_PAGE_TIMEOUT_MS = 30000;
  const PHASE_POLL_INTERVAL_MS = 250;
  const PHASE_POLL_MAX_ATTEMPTS = Math.ceil(
    PHASE_PAGE_TIMEOUT_MS / PHASE_POLL_INTERVAL_MS,
  );

  let phaseFailedReported = false;

  function reportPatronPhaseFailed(error) {
    if (phaseFailedReported) return;
    phaseFailedReported = true;
    chrome.runtime.sendMessage({
      type: "PHASE_FAILED",
      phase: "patron",
      error,
    });
  }

  function dispatchInputEvents(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setNativeChecked(el, checked) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "checked");
    if (desc?.set) desc.set.call(el, checked);
    else el.checked = checked;
  }

  function formatYyyyMmDd(date) {
    const yyyy = String(date.getFullYear());
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  /**
   * When there are no borrowed items, HKPL still renders `table#checkout` with
   * `.norecords-tr` / `.norecords-td` (e.g. 沒有借出項目) and no renewal checkboxes.
   * Without this, `total` stays 0 until the phase poll times out.
   */
  function patronCheckoutLoansReadyState() {
    const checkout = document.querySelector("table#checkout");
    if (!checkout) return { ready: false, emptyLoans: false };

    const checkboxes = checkout.querySelectorAll(
      "input[type='checkbox'][name='renewalCheckboxGroup']",
    );
    if (checkboxes.length > 0) return { ready: true, emptyLoans: false };

    if (checkout.querySelector("tr.norecords-tr, td.norecords-td")) {
      return { ready: true, emptyLoans: true };
    }

    return { ready: false, emptyLoans: false };
  }

  function checkDueTodayOnly() {
    const today = formatYyyyMmDd(new Date());

    const checkboxes = Array.from(
      document.querySelectorAll(
        "input[type='checkbox'][name='renewalCheckboxGroup']",
      ),
    );

    let checkedNow = 0;
    for (const cb of checkboxes) {
      const tr = cb.closest("tr");
      const tds = tr ? Array.from(tr.querySelectorAll("td")) : [];
      const dueText = (tds[4]?.textContent ?? "").trim();

      if (dueText === today && !cb.checked) {
        setNativeChecked(cb, true);
        dispatchInputEvents(cb);
        checkedNow += 1;
      }
    }

    return { total: checkboxes.length, checkedNow, today };
  }

  let patronPollAttempts = 0;
  const timer = setInterval(() => {
    patronPollAttempts += 1;

    const { total, checkedNow, today } = checkDueTodayOnly();
    const checkoutState = patronCheckoutLoansReadyState();

    if (
      total > 0 ||
      checkoutState.ready ||
      patronPollAttempts >= PHASE_POLL_MAX_ATTEMPTS
    ) {
      clearInterval(timer);

      if (patronPollAttempts >= PHASE_POLL_MAX_ATTEMPTS && total === 0) {
        const hasCheckout = !!document.querySelector("table#checkout");
        if (!hasCheckout) {
          reportPatronPhaseFailed(
            "Cannot find borrowed items table or renewal checklist (timed out).",
          );
          return;
        }
      }

      if (phaseFailedReported) return;

      const renewButton =
        document.querySelector("button#button\\.renew") ||
        document.querySelector("button[value='Renew']") ||
        document.querySelector("button[type='submit']#button\\.renew");

      const didClickRenew = !!renewButton && checkedNow > 0;

      chrome.runtime.sendMessage({
        type: "PATRON_CHECKED",
        total,
        checkedNow,
        today,
        didClickRenew,
        url: location.href,
      });

      if (total > 0 && checkedNow === 0) {
        setTimeout(() => {
          window.location.href =
            "https://webcat.hkpl.gov.hk/auth/logout?theme=WEB&locale=zh_TW";
        }, 250);
        return;
      }

      if (didClickRenew) {
        setTimeout(() => {
          renewButton.click();
        }, 150);
      }
    }
  }, PHASE_POLL_INTERVAL_MS);
})();
