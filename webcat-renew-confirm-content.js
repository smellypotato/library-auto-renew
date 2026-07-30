(() => {
  if (globalThis.__libraryAutoRenew_webcatRenewConfirmRan) return;
  globalThis.__libraryAutoRenew_webcatRenewConfirmRan = true;

  let confirmClicked = false;

  function isContainerHidden(el) {
    if (!el) return true;
    if (el.style?.display === "none") return true;
    const st = el.getAttribute("style");
    if (st && /display\s*:\s*none/i.test(st)) return true;
    return false;
  }

  function findConfirmSubmitIn(container) {
    if (!container || isContainerHidden(container)) return null;
    const form = container.querySelector("form");
    if (!form) return null;
    for (const input of form.querySelectorAll('input[type="submit"]')) {
      if (input.name === "cancelButton") continue;
      const value = (input.value ?? "").trim();
      if (
        value === "是" ||
        value === "接受" ||
        /^yes$/i.test(value) ||
        /^accept$/i.test(value)
      ) {
        return input;
      }
    }
    return null;
  }

  function isRenewConfirmDom() {
    const h1 = document.querySelector("#main h1, h1");
    const title = (h1?.textContent ?? "").trim();
    if (title !== "續借提示" && !/renewal prompt/i.test(title)) return false;

    if (findConfirmSubmitIn(document.querySelector("#confirm-group"))) return true;
    if (findConfirmSubmitIn(document.querySelector("#confirm-overdue"))) return true;
    return false;
  }

  function clickRenewConfirmYes() {
    if (confirmClicked) return false;

    const confirmBtn =
      findConfirmSubmitIn(document.querySelector("#confirm-group")) ||
      findConfirmSubmitIn(document.querySelector("#confirm-overdue"));
    if (!confirmBtn) return false;

    confirmClicked = true;
    confirmBtn.click();
    return true;
  }

  async function maybeConfirmRenew() {
    const { waitingForRenewResult } = await chrome.storage.local.get([
      "waitingForRenewResult",
    ]);
    if (!waitingForRenewResult || !isRenewConfirmDom()) return;
    clickRenewConfirmYes();
  }

  let pollAttempts = 0;
  const maxAttempts = 40;
  const timer = setInterval(() => {
    pollAttempts += 1;
    maybeConfirmRenew().catch(() => {});
    if (pollAttempts >= maxAttempts) clearInterval(timer);
  }, 250);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      maybeConfirmRenew().catch(() => {});
    });
  } else {
    maybeConfirmRenew().catch(() => {});
  }
})();
