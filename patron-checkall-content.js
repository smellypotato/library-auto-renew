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

  function startOfLocalDay(date = new Date()) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function parseYyyyMmDdLocal(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? "").trim());
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function normalizeRenewDaysBefore(value) {
    const n = Number(value);
    if (n === 1 || n === 2 || n === 3) return n;
    return 0;
  }

  /**
   * Renew when due date is on/before (today + renewDaysBefore).
   * Overdue items (due before today) always match, so a missed day still renews.
   */
  function shouldRenewDueDate(dueStr, renewDaysBefore) {
    const due = parseYyyyMmDdLocal(dueStr);
    if (!due) return false;
    const threshold = startOfLocalDay();
    threshold.setDate(threshold.getDate() + renewDaysBefore);
    return due.getTime() <= threshold.getTime();
  }

  const DUE_YYYY_MM_DD = /\b(\d{4}-\d{2}-\d{2})\b/;

  function isTrVisiblyHidden(tr) {
    if (!tr) return true;
    if (tr.style?.display === "none") return true;
    const st = tr.getAttribute("style");
    if (st && /display\s*:\s*none/i.test(st)) return true;
    return false;
  }

  /** Due date cell is usually column 5; whole-row match covers shifted layouts. */
  function dueYyyyMmDdFromLoanRow(tr, checkbox) {
    const rowText = tr.textContent ?? "";
    const fromRow = rowText.match(DUE_YYYY_MM_DD);
    if (fromRow) return fromRow[1];
    if (!checkbox) return "";
    const tds = tr.querySelectorAll("td");
    const col = (tds[4]?.textContent ?? "").trim().match(DUE_YYYY_MM_DD);
    return col ? col[1] : "";
  }

  /**
   * One pass over `#checkout` tbody: each visible loan row with a due date and/or
   * renewal checkbox. Rows without a checkbox (e.g. 今天無需續借) still count for
   * “page loaded” / display-only; only rows with a checkbox contribute to `total`
   * and can be ticked for submit.
   */
  function getCheckoutLoanRows(checkout) {
    const tbody = checkout.querySelector("tbody");
    if (!tbody) return [];

    const out = [];
    for (const tr of tbody.querySelectorAll("tr")) {
      if (isTrVisiblyHidden(tr)) continue;
      if (tr.classList.contains("norecords-tr")) continue;
      const tds = tr.querySelectorAll("td");
      if (tds.length < 3) continue;

      const checkbox = tr.querySelector(
        "input[type='checkbox'][name='renewalCheckboxGroup']",
      );
      const due = dueYyyyMmDdFromLoanRow(tr, checkbox);
      if (!checkbox && !due) continue;

      out.push({ tr, checkbox, due });
    }
    return out;
  }

  /**
   * When there are no borrowed items, HKPL still renders `table#checkout` with
   * `.norecords-tr` / `.norecords-td` (e.g. 沒有借出項目) and no renewal checkboxes.
   * Without this, `total` stays 0 until the phase poll times out.
   */
  function patronCheckoutLoansReadyState() {
    const checkout = document.querySelector("table#checkout");
    if (!checkout) {
      return {
        ready: false,
        emptyLoans: false,
        displayOnlyLoanRows: false,
      };
    }

    const loanRows = getCheckoutLoanRows(checkout);
    const checkboxCount = loanRows.filter((r) => r.checkbox).length;

    if (checkboxCount > 0) {
      return {
        ready: true,
        emptyLoans: false,
        displayOnlyLoanRows: false,
      };
    }

    if (checkout.querySelector("tr.norecords-tr, td.norecords-td")) {
      return {
        ready: true,
        emptyLoans: true,
        displayOnlyLoanRows: false,
      };
    }

    const displayOnly =
      loanRows.length > 0 && loanRows.every((r) => !r.checkbox);
    if (displayOnly) {
      return {
        ready: true,
        emptyLoans: false,
        displayOnlyLoanRows: true,
      };
    }

    return {
      ready: false,
      emptyLoans: false,
      displayOnlyLoanRows: false,
    };
  }

  function checkDueWithinWindow(renewDaysBefore) {
    const today = formatYyyyMmDd(new Date());
    const checkout = document.querySelector("table#checkout");
    const loanRows = checkout ? getCheckoutLoanRows(checkout) : [];

    let checkedNow = 0;
    for (const { checkbox, due } of loanRows) {
      if (!checkbox) continue;
      if (shouldRenewDueDate(due, renewDaysBefore) && !checkbox.checked) {
        setNativeChecked(checkbox, true);
        dispatchInputEvents(checkbox);
        checkedNow += 1;
      }
    }

    const total = loanRows.filter((r) => r.checkbox).length;
    return { total, checkedNow, today, renewDaysBefore };
  }

  let patronPollAttempts = 0;
  let renewDaysBefore = 0;
  let settingsReady = false;

  chrome.storage.local
    .get(["renewDaysBefore"])
    .then((stored) => {
      renewDaysBefore = normalizeRenewDaysBefore(stored.renewDaysBefore);
      settingsReady = true;
    })
    .catch(() => {
      renewDaysBefore = 0;
      settingsReady = true;
    });

  const timer = setInterval(() => {
    if (!settingsReady) return;

    patronPollAttempts += 1;

    const { total, checkedNow, today } = checkDueWithinWindow(renewDaysBefore);
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
        renewDaysBefore,
        didClickRenew,
        displayOnlyLoanRows: !!checkoutState.displayOnlyLoanRows,
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
