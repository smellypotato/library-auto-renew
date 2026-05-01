const $ = (id) => document.getElementById(id);

let editingAccountId = null;

function setStatus(text) {
  $("status").textContent = text ?? "";
}

function sendMessageAsync(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(response);
    });
  });
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderAccounts(accounts, results) {
  const container = $("accounts");
  if (!accounts?.length) {
    container.innerHTML =
      '<div style="font-size:12px;opacity:.85">No accounts yet. Add one below.</div>';
    return;
  }

  const playIcon = `
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M8 5v14l11-7z"></path>
    </svg>
  `;
  const trashIcon = `
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M9 3h6l1 2h5v2H3V5h5l1-2zm1 6h2v10h-2V9zm4 0h2v10h-2V9zM7 9h2v10H7V9z"></path>
    </svg>
  `;
  const editIcon = `
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"></path>
    </svg>
  `;

  const rows = accounts
    .map((a) => {
      if (editingAccountId === a.id) {
        return `
        <div data-edit-wrap="${escapeHtml(a.id)}" style="margin:8px 0; padding:10px; border-radius:10px; border:1px solid rgba(127,127,127,0.25);">
          <div style="font-size:11px; opacity:.85; margin-bottom:8px;">Edit account</div>
          <label style="margin-top:0;">Account</label>
          <input data-edit-account type="text" autocomplete="off" style="margin-top:4px;" />
          <label>New password</label>
          <input data-edit-password type="password" autocomplete="off" placeholder="Leave blank to keep current" style="margin-top:4px;" />
          <div style="display:flex; gap:8px; margin-top:10px;">
            <button data-save="${escapeHtml(a.id)}" type="button" style="flex:1; margin-top:0;">Save</button>
            <button data-cancel-edit type="button" style="flex:1; margin-top:0; background:rgba(127,127,127,.15); color:inherit;">Cancel</button>
          </div>
        </div>`;
      }

      const r = results?.[a.id] ?? null;
      const state = r?.state ?? "idle";
      const details = r?.details ?? "";
      const color =
        state === "success"
          ? "#107c10"
          : state === "failed"
            ? "#d83b01"
            : state === "pending"
              ? "#666"
              : "#666";

      return `
        <div style="display:flex; gap:8px; align-items:flex-start; margin:8px 0;">
          <div style="flex:1; min-width:0;">
            <div style="display:flex; gap:8px; align-items:baseline;">
              <div style="font-size:12px; font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                ${escapeHtml(a.account)}
              </div>
              <div style="font-size:11px; color:${color};">${escapeHtml(state)}</div>
            </div>
            ${
              details
                ? `<div style="font-size:11px; opacity:.85; margin-top:2px; word-break:break-word;">${escapeHtml(details)}</div>`
                : ""
            }
          </div>
          <div style="display:flex; gap:6px;">
            <button
              data-edit="${escapeHtml(a.id)}"
              type="button"
              title="Edit account"
              aria-label="Edit account"
              style="width:auto; padding:6px 8px; border-radius:8px; background:rgba(127,127,127,.12); color:inherit; display:flex; align-items:center; justify-content:center;"
            >
              ${editIcon}
            </button>
            <button
              data-run="${escapeHtml(a.id)}"
              type="button"
              title="Run this account"
              aria-label="Run this account"
              style="width:auto; padding:6px 8px; border-radius:8px; background:rgba(43,108,255,.2); color:inherit; display:flex; align-items:center; justify-content:center;"
            >
              ${playIcon}
            </button>
            <button
              data-remove="${escapeHtml(a.id)}"
              type="button"
              title="Remove"
              aria-label="Remove"
              style="width:auto; padding:6px 8px; border-radius:8px; background:rgba(127,127,127,.15); color:inherit; display:flex; align-items:center; justify-content:center;"
            >
              ${trashIcon}
            </button>
          </div>
        </div>
      `;
    })
    .join("");

  container.innerHTML = rows;

  const wrap = container.querySelector("[data-edit-wrap]");
  if (wrap) {
    const id = wrap.getAttribute("data-edit-wrap");
    const acc = accounts.find((x) => x.id === id);
    const accInput = wrap.querySelector("[data-edit-account]");
    const pwInput = wrap.querySelector("[data-edit-password]");
    if (accInput && acc) accInput.value = acc.account;

    wrap.querySelector("[data-cancel-edit]")?.addEventListener("click", () => {
      editingAccountId = null;
      refresh().catch(() => {});
    });

    wrap.querySelector("[data-save]")?.addEventListener("click", async () => {
      const account = accInput?.value?.trim() ?? "";
      const password = pwInput?.value ?? "";
      if (!account) {
        setStatus("Account label cannot be empty.");
        return;
      }
      setStatus("Saving…");
      try {
        const resp = await sendMessageAsync({
          type: "UPDATE_ACCOUNT",
          id,
          account,
          password,
        });
        if (!resp?.ok) {
          setStatus(resp?.error ?? "Could not update account.");
          return;
        }
        editingAccountId = null;
        setStatus("");
        await refresh();
      } catch (e) {
        setStatus(`Failed: ${e.message}`);
      }
    });
  }

  container.querySelectorAll("button[data-remove]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-remove");
      try {
        const resp = await sendMessageAsync({ type: "REMOVE_ACCOUNT", id });
        if (!resp?.ok) {
          setStatus(resp?.error ?? "Could not remove account.");
          return;
        }
        setStatus("");
        await refresh();
      } catch (e) {
        setStatus(`Failed: ${e.message}`);
      }
    });
  });

  container.querySelectorAll("button[data-edit]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      editingAccountId = btn.getAttribute("data-edit");
      setStatus("");
      await refresh();
    });
  });

  container.querySelectorAll("button[data-run]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-run");
      setStatus("Starting…");
      try {
        const resp = await sendMessageAsync({ type: "RUN_ONE", id });
        if (!resp?.ok) {
          setStatus(resp?.error ?? "Could not start run.");
          return;
        }
        await refresh();
      } catch (e) {
        setStatus(`Failed: ${e.message}`);
      }
    });
  });
}

async function refresh() {
  const {
    accounts = [],
    accountResults = {},
    runningAll = false,
    runningOne = false,
    runError,
  } = await chrome.storage.local.get([
    "accounts",
    "accountResults",
    "runningAll",
    "runningOne",
    "runError",
  ]);

  renderAccounts(accounts, accountResults);

  if (runningAll || runningOne) setStatus("Running accounts…");
  else if (runError) setStatus(runError);
  else setStatus("");
}

async function start() {
  setStatus("Starting…");
  try {
    const resp = await sendMessageAsync({ type: "RUN_ALL" });
    if (!resp?.ok) {
      setStatus(resp?.error ?? "Could not start.");
      return;
    }
    setStatus("Running…");
    await refresh();
  } catch (e) {
    setStatus(`Failed: ${e.message}`);
  }
}

async function addAccount() {
  const account = $("newAccount").value.trim();
  const password = $("newPassword").value;
  if (!account || !password) {
    setStatus("Please enter account and password.");
    return;
  }

  try {
    const resp = await sendMessageAsync({
      type: "ADD_ACCOUNT",
      account,
      password,
    });
    if (!resp?.ok) {
      setStatus(resp?.error ?? "Could not add account.");
      return;
    }
    $("newAccount").value = "";
    $("newPassword").value = "";
    setStatus("");
    await refresh();
  } catch (e) {
    setStatus(`Failed: ${e.message}`);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const keys = [
      "accounts",
      "accountResults",
      "runningAll",
      "runningOne",
      "runError",
      "runState",
    ];
    if (!keys.some((k) => changes[k])) return;
    refresh().catch(() => {});
  });

  await refresh();
  $("start").addEventListener("click", start);
  $("add").addEventListener("click", addAccount);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const active = document.activeElement?.id;
      if (active === "newAccount" || active === "newPassword") addAccount();
    }
  });
});
