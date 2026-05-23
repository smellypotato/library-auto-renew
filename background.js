const TARGET_AFTER_LOGIN = "https://webcat.hkpl.gov.hk/search/query?theme=WEB";
const LOGIN_URL = "https://www.hkpl.gov.hk/tc/login.html";
const ACCOUNT_URL =
  "https://webcat.hkpl.gov.hk/wicket/bookmarkable/com.vtls.chamo.webapp.component.patron.PatronAccountPage?theme=WEB";
const RENEW_RESULT_URL_PREFIX = "https://webcat.hkpl.gov.hk/wicket/page?7";
const WEBCAT_LOGOUT_URL =
  "https://webcat.hkpl.gov.hk/auth/logout?theme=WEB&locale=zh_TW";
const FLOW_TIMEOUT_MS = 45000;
const PHASE_PAGE_TIMEOUT_MS = 30000;
/** Extra time after flow timeout before treating a run as stale. */
const STALE_RUN_GRACE_MS = 5000;
const CALENDAR_DAY_CHECK_ALARM = "calendarDayCheck";
/** Minimum Chrome period for repeating alarms; checks often enough to notice a new calendar day. */
const CALENDAR_DAY_CHECK_PERIOD_MINUTES = 30;

const HKPL_INDEX_URLS = [
  "https://www.hkpl.gov.hk/en/index.html",
  "https://www.hkpl.gov.hk/tc/index.html",
];

const ASYNC_MESSAGE_TYPES = new Set([
  "ADD_ACCOUNT",
  "UPDATE_ACCOUNT",
  "REMOVE_ACCOUNT",
  "RUN_ALL",
  "RUN_ONE",
  "CANCEL_RUN",
  "START_LOGIN",
  "LOGOUT_DONE",
]);

function isPhaseTimeoutExemptUrl(url) {
  if (!url || !url.startsWith("http")) return true;
  if (url.startsWith(RENEW_RESULT_URL_PREFIX)) return true;
  if (url.includes("/auth/logout")) return true;
  if (url.includes("confirm_logout")) return true;
  if (url.includes("/logout.html")) return true;
  return false;
}

async function clearPagePhaseAlarm(tabId) {
  if (typeof tabId !== "number") return;
  chrome.alarms.clear(`pagePhase:${tabId}`).catch(() => {});
  const { pagePhaseTimeout } = await getState(["pagePhaseTimeout"]);
  if (pagePhaseTimeout?.tabId === tabId) {
    await chrome.storage.local.remove("pagePhaseTimeout");
  }
}

async function armPagePhaseAlarm(tabId, url) {
  if (typeof tabId !== "number" || !url) return;
  await clearPagePhaseAlarm(tabId);
  await chrome.storage.local.set({
    pagePhaseTimeout: { tabId, urlAtStart: url },
  });
  chrome.alarms
    .create(`pagePhase:${tabId}`, {
      when: Date.now() + PHASE_PAGE_TIMEOUT_MS,
    })
    .catch(() => {});
}

async function maybeRearmPagePhaseSameUrl(tabId, url) {
  const { pagePhaseTimeout } = await getState(["pagePhaseTimeout"]);
  if (
    pagePhaseTimeout?.tabId === tabId &&
    pagePhaseTimeout?.urlAtStart === url
  ) {
    return;
  }
  await armPagePhaseAlarm(tabId, url);
}

async function setRunState(state) {
  await chrome.storage.local.set({
    runState: state.runState,
    runError: state.runError ?? null,
    runTabId: state.runTabId ?? null,
    runStartedAt: state.runStartedAt ?? null,
    runFinishedAt: state.runFinishedAt ?? null,
  });

  if (state.runState === "failed") {
    chrome.action.setBadgeText({ text: "ERR" }).catch(() => {});
  } else if (state.runState === "success") {
    chrome.action.setBadgeText({ text: "OK" }).catch(() => {});
  } else if (state.runState === "running") {
    chrome.action.setBadgeText({ text: "…" }).catch(() => {});
  } else {
    chrome.action.setBadgeText({ text: "" }).catch(() => {});
  }
}

function ensureCalendarDayCheckAlarm() {
  chrome.alarms.get(CALENDAR_DAY_CHECK_ALARM, (existing) => {
    if (chrome.runtime.lastError || existing) return;
    chrome.alarms.create(CALENDAR_DAY_CHECK_ALARM, {
      periodInMinutes: CALENDAR_DAY_CHECK_PERIOD_MINUTES,
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: "#d83b01" }).catch(() => {});
  ensureCalendarDayCheckAlarm();
  maybeAutoRunToday().catch(() => {});
});

function todayKey() {
  const d = new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function newId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function getState(keys) {
  return await chrome.storage.local.get(keys);
}

async function setState(obj) {
  await chrome.storage.local.set(obj);
}

async function tabExists(tabId) {
  if (typeof tabId !== "number") return false;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return !!tab;
}

async function clearRunAlarmsForTab(tabId) {
  if (typeof tabId !== "number") return;
  await clearPagePhaseAlarm(tabId);
  chrome.alarms.clear(`flowTimeout:${tabId}`).catch(() => {});
}

async function isRunStale() {
  const {
    runningAll = false,
    runningOne = false,
    runState,
    runTabId,
    runnerTabId,
    runStartedAt,
  } = await getState([
    "runningAll",
    "runningOne",
    "runState",
    "runTabId",
    "runnerTabId",
    "runStartedAt",
  ]);

  const active = runningAll || runningOne || runState === "running";
  if (!active) return false;

  const tabId =
    typeof runTabId === "number"
      ? runTabId
      : typeof runnerTabId === "number"
        ? runnerTabId
        : null;

  if (typeof tabId === "number") {
    if (!(await tabExists(tabId))) return true;
    if (
      runStartedAt &&
      Date.now() - runStartedAt > FLOW_TIMEOUT_MS + STALE_RUN_GRACE_MS
    ) {
      return true;
    }
    return false;
  }

  if (!runStartedAt) return true;
  return Date.now() - runStartedAt > STALE_RUN_GRACE_MS;
}

let abortRunChain = Promise.resolve();
let abortInProgress = false;

async function abortRun(options = {}) {
  const p = abortRunChain.then(() => abortRunImpl(options).catch(() => {}));
  abortRunChain = p.catch(() => {});
  return p;
}

async function abortRunImpl({
  reason = "Run stopped.",
  details = null,
  markCurrentFailed = true,
} = {}) {
  if (abortInProgress) return;
  abortInProgress = true;
  try {
    const {
      runningAll = false,
      runningOne = false,
      runState,
      runTabId,
      runnerTabId,
      currentAccountId,
      accountResults = {},
      accounts = [],
      runStartedAt,
    } = await getState([
      "runningAll",
      "runningOne",
      "runState",
      "runTabId",
      "runnerTabId",
      "currentAccountId",
      "accountResults",
      "accounts",
      "runStartedAt",
    ]);

    const wasActive =
      runningAll || runningOne || runState === "running" || currentAccountId;
    if (!wasActive) return;

    const failDetails = details || reason;
    const tabIds = new Set();
    if (typeof runTabId === "number") tabIds.add(runTabId);
    if (typeof runnerTabId === "number") tabIds.add(runnerTabId);
    for (const id of tabIds) {
      await clearRunAlarmsForTab(id);
    }

    if (markCurrentFailed) {
      if (runningAll) {
        for (const acct of accounts) {
          const st = accountResults[acct.id]?.state;
          if (st === "pending") {
            accountResults[acct.id] = {
              state: "failed",
              details: "Cancelled.",
              finishedAt: Date.now(),
            };
          } else if (st === "running") {
            accountResults[acct.id] = {
              state: "failed",
              details: failDetails,
              finishedAt: Date.now(),
            };
          }
        }
      } else if (
        currentAccountId &&
        (runningOne || runState === "running")
      ) {
        accountResults[currentAccountId] = {
          state: "failed",
          details: failDetails,
          finishedAt: Date.now(),
        };
      }
      await setState({ accountResults });
    }

    await setState({
      runningAll: false,
      runningOne: false,
      currentAccountId: null,
      currentAccount: null,
      runnerTabId: null,
      queueIndex: 0,
      shouldLogout: false,
      didClickLogout: false,
      didConfirmLogout: false,
      didNotifyLogoutDone: false,
      waitingForRenewResult: false,
      renewResultSeen: false,
      renewAttempted: false,
      runError: reason,
      runDetails: markCurrentFailed ? failDetails : null,
    });

    await setRunState({
      runState: "failed",
      runError: reason,
      runTabId: null,
      runStartedAt,
      runFinishedAt: Date.now(),
    });

    await computeAndSetBadge();
  } finally {
    abortInProgress = false;
  }
}

async function clearStaleRunIfNeeded() {
  if (!(await isRunStale())) return false;
  await abortRun({
    reason: "Previous run did not finish (tab closed or timed out).",
    details:
      "Failed: previous run was interrupted (tab closed or timed out).",
    markCurrentFailed: true,
  });
  return true;
}

async function computeAndSetBadge() {
  const { runningAll = false, accounts = [], accountResults = {} } =
    await getState(["runningAll", "accounts", "accountResults"]);

  if (runningAll) {
    chrome.action.setBadgeText({ text: "…" }).catch(() => {});
    return;
  }

  if (!accounts.length) {
    chrome.action.setBadgeText({ text: "" }).catch(() => {});
    return;
  }

  const states = accounts.map((a) => accountResults?.[a.id]?.state ?? "pending");
  const anyFailed = states.some((s) => s === "failed");
  const allSuccess = states.length > 0 && states.every((s) => s === "success");

  if (allSuccess) {
    chrome.action.setBadgeText({ text: "OK" }).catch(() => {});
  } else if (anyFailed) {
    chrome.action.setBadgeText({ text: "ERR" }).catch(() => {});
  } else {
    chrome.action.setBadgeText({ text: "" }).catch(() => {});
  }
}

async function resetFlowFlagsForAccountRun() {
  await setState({
    shouldLogout: false,
    didClickLogout: false,
    didConfirmLogout: false,
    didNotifyLogoutDone: false,
    waitingForRenewResult: false,
    renewResultSeen: false,
    renewAttempted: false,
    runState: "running",
    runError: null,
    runDetails: null,
    sessionEndedAt: null,
  });
}

/** Serialize tab creation so concurrent auto-run / queue starts never open duplicate login tabs. */
let ensureRunnerTabChain = Promise.resolve();

async function ensureRunnerTab() {
  const p = ensureRunnerTabChain.then(async () => {
    const { runnerTabId = null } = await getState(["runnerTabId"]);
    if (typeof runnerTabId === "number") {
      const tab = await chrome.tabs.get(runnerTabId).catch(() => null);
      if (tab) return runnerTabId;
    }

    const tab = await chrome.tabs.create({ url: LOGIN_URL, active: false });
    const newTabId = tab?.id ?? null;
    if (typeof newTabId === "number") {
      await setState({ runnerTabId: newTabId });
      return newTabId;
    }
    return null;
  });
  ensureRunnerTabChain = p.catch(() => {});
  return p;
}

/**
 * Serialize queue steps so two callers never overlap on flags + runner tab
 * (e.g. LOGOUT_DONE advancing the queue vs a duplicate RUN_ALL).
 */
let startNextAccountIfAnyChain = Promise.resolve();

async function startNextAccountIfAny() {
  const p = startNextAccountIfAnyChain.then(() =>
    startNextAccountIfAnyImpl().catch(() => {}),
  );
  startNextAccountIfAnyChain = p.catch(() => {});
  return p;
}

async function startNextAccountIfAnyImpl() {
  const {
    runningAll = false,
    accounts = [],
    queueIndex = 0,
  } = await getState(["runningAll", "accounts", "queueIndex"]);

  if (!runningAll) return;

  if (queueIndex >= accounts.length) {
    const { runnerTabId = null } = await getState(["runnerTabId"]);
    if (typeof runnerTabId === "number") {
      chrome.tabs.remove(runnerTabId).catch(() => {});
      await setState({ runnerTabId: null });
    }
    await setState({
      runningAll: false,
      currentAccountId: null,
      currentAccount: null,
    });
    await setState({ lastAutoRunDate: todayKey() });
    await computeAndSetBadge();
    return;
  }

  const acct = accounts[queueIndex];

  const { accountResults = {} } = await getState(["accountResults"]);
  accountResults[acct.id] = { state: "running", details: "" };
  await setState({ accountResults });

  await setState({
    currentAccountId: acct.id,
    currentAccount: { account: acct.account, password: acct.password },
  });

  await resetFlowFlagsForAccountRun();

  const runStartedAt = Date.now();
  await setRunState({
    runState: "running",
    runError: null,
    runTabId: null,
    runStartedAt,
    runFinishedAt: null,
  });

  const tabId = await ensureRunnerTab();
  if (typeof tabId !== "number") {
    await chrome.storage.local.set({
      runDetails: "Could not create runner tab.",
      runError: "Could not create runner tab.",
    });
    await setRunState({
      runState: "failed",
      runError: "Could not create runner tab.",
      runTabId: null,
      runStartedAt,
      runFinishedAt: Date.now(),
    });
    await finalizeCurrentAccountResult();
    await computeAndSetBadge();
    const { queueIndex: qi = 0 } = await getState(["queueIndex"]);
    await setState({ queueIndex: qi + 1 });
    await startNextAccountIfAny();
    return;
  }

  await chrome.tabs
    .update(tabId, { url: LOGIN_URL, active: false })
    .catch(() => {});

  await setRunState({
    runState: "running",
    runError: null,
    runTabId: tabId,
    runStartedAt,
    runFinishedAt: null,
  });

  chrome.alarms.clear(`flowTimeout:${tabId}`).catch(() => {});
  chrome.alarms.create(`flowTimeout:${tabId}`, {
    when: Date.now() + FLOW_TIMEOUT_MS,
  });
}

let runSingleAccountChain = Promise.resolve();

async function runSingleAccountById(id) {
  const p = runSingleAccountChain.then(() =>
    runSingleAccountByIdImpl(id).catch(() => false),
  );
  runSingleAccountChain = p.catch(() => {});
  return p;
}

async function runSingleAccountByIdImpl(id) {
  await clearStaleRunIfNeeded();

  const { runningAll = false, runningOne = false } = await getState([
    "runningAll",
    "runningOne",
  ]);
  if (runningAll || runningOne) {
    await setState({ runError: "Another run is already in progress." });
    return false;
  }

  const { accounts = [] } = await getState(["accounts"]);
  const acct = accounts.find((a) => a.id === id);
  if (!acct) {
    await setState({ runError: "Account not found." });
    return false;
  }

  const { accountResults = {} } = await getState(["accountResults"]);
  accountResults[acct.id] = { state: "running", details: "" };
  await setState({ accountResults });

  await setState({
    runningAll: false,
    runningOne: true,
    currentAccountId: acct.id,
    currentAccount: { account: acct.account, password: acct.password },
  });

  await resetFlowFlagsForAccountRun();

  const runStartedAt = Date.now();
  await setRunState({
    runState: "running",
    runError: null,
    runTabId: null,
    runStartedAt,
    runFinishedAt: null,
  });

  const tabId = await ensureRunnerTab();
  if (typeof tabId !== "number") {
    await chrome.storage.local.set({
      runDetails: "Could not create runner tab.",
      runError: "Could not create runner tab.",
    });
    await setRunState({
      runState: "failed",
      runError: "Could not create runner tab.",
      runTabId: null,
      runStartedAt,
      runFinishedAt: Date.now(),
    });
    await setState({ runError: "Could not create runner tab." });
    await finalizeCurrentAccountResult();
    await setState({ runningOne: false });
    await computeAndSetBadge();
    return false;
  }

  await chrome.tabs
    .update(tabId, { url: LOGIN_URL, active: false })
    .catch(() => {});

  await setRunState({
    runState: "running",
    runError: null,
    runTabId: tabId,
    runStartedAt,
    runFinishedAt: null,
  });

  chrome.alarms.clear(`flowTimeout:${tabId}`).catch(() => {});
  chrome.alarms.create(`flowTimeout:${tabId}`, {
    when: Date.now() + FLOW_TIMEOUT_MS,
  });
  return true;
}

async function finalizeCurrentAccountResult() {
  const {
    currentAccountId,
    runState,
    runDetails,
    runError,
    accountResults = {},
  } = await getState([
    "currentAccountId",
    "runState",
    "runDetails",
    "runError",
    "accountResults",
  ]);
  if (!currentAccountId) return;

  accountResults[currentAccountId] = {
    state: runState === "success" ? "success" : "failed",
    details: runDetails || runError || "",
    finishedAt: Date.now(),
  };

  await setState({ accountResults });
}

async function isAuthorizedRunTab(senderTabId) {
  const { runTabId, runState } = await getState(["runTabId", "runState"]);
  if (runState !== "running") return false;
  if (typeof runTabId !== "number" || typeof senderTabId !== "number") {
    return false;
  }
  return senderTabId === runTabId;
}

/** Logout lands after success/failure; runState is often no longer "running". */
async function isAuthorizedLogoutTab(senderTabId) {
  const { runTabId } = await getState(["runTabId"]);
  if (typeof runTabId !== "number" || typeof senderTabId !== "number") {
    return false;
  }
  return senderTabId === runTabId;
}

async function failRunAndLogout(tabId, runError, runDetails) {
  const { runState, runTabId } = await getState(["runState", "runTabId"]);
  if (runState !== "running") return;
  if (typeof runTabId !== "number" || tabId !== runTabId) return;

  await clearPagePhaseAlarm(runTabId);
  chrome.alarms.clear(`flowTimeout:${runTabId}`).catch(() => {});

  await chrome.storage.local.set({
    runDetails,
    runError,
    shouldLogout: true,
    waitingForRenewResult: false,
  });

  await setRunState({
    runState: "failed",
    runError,
    runTabId,
    runStartedAt: (await chrome.storage.local.get(["runStartedAt"]))
      .runStartedAt,
    runFinishedAt: Date.now(),
  });

  await finalizeCurrentAccountResult();
  await computeAndSetBadge();

  chrome.tabs
    .update(runTabId, { url: WEBCAT_LOGOUT_URL, active: false })
    .catch(() => {});
}

/** Serialize so onStartup, onInstalled, and calendar alarm cannot start two runs in parallel. */
let maybeAutoRunTodayChain = Promise.resolve();

async function maybeAutoRunToday() {
  maybeAutoRunTodayChain = maybeAutoRunTodayChain.then(() =>
    maybeAutoRunTodayCore().catch(() => {}),
  );
  return maybeAutoRunTodayChain;
}

async function maybeAutoRunTodayCore() {
  const {
    lastAutoRunDate = null,
    runningAll = false,
    runningOne = false,
    accounts = [],
  } = await getState([
    "lastAutoRunDate",
    "runningAll",
    "runningOne",
    "accounts",
  ]);

  await clearStaleRunIfNeeded();

  const {
    runningAll: runningAllAfterStale = false,
    runningOne: runningOneAfterStale = false,
  } = await getState(["runningAll", "runningOne"]);
  if (runningAllAfterStale || runningOneAfterStale) return;
  if (!accounts.length) return;

  const today = todayKey();
  if (lastAutoRunDate === today) return;

  const accountResults = Object.fromEntries(
    accounts.map((a) => [a.id, { state: "pending", details: "" }]),
  );

  await setState({
    runningAll: true,
    queueIndex: 0,
    accountResults,
    runError: null,
  });
  await computeAndSetBadge();
  await startNextAccountIfAny();
}

chrome.runtime.onStartup.addListener(() => {
  ensureCalendarDayCheckAlarm();
  maybeAutoRunToday().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) return;

  if (!ASYNC_MESSAGE_TYPES.has(message.type)) {
    (async () => {
      switch (message.type) {
        case "PATRON_CHECKED": {
          const senderTabId = sender.tab?.id;
          if (!(await isAuthorizedRunTab(senderTabId))) return;

          const { runTabId } = await getState(["runTabId"]);
          const tab =
            typeof runTabId === "number"
              ? await chrome.tabs.get(runTabId).catch(() => null)
              : null;
          if (!tab?.url?.startsWith(ACCOUNT_URL.split("?")[0])) return;

          const checkedNow = message.checkedNow ?? 0;
          const total = message.total ?? 0;
          const today = message.today ?? null;
          const didClickRenew = !!message.didClickRenew;
          const displayOnlyLoanRows = !!message.displayOnlyLoanRows;

          if (total === 0 || checkedNow === 0) {
            const details =
              total === 0 && !displayOnlyLoanRows
                ? "Success: no borrowed items found."
                : today
                  ? `Success: no items due today (${today}).`
                  : "Success: no items due today.";

            await chrome.storage.local.set({
              runDetails: details,
              shouldLogout: true,
              renewAttempted: false,
              waitingForRenewResult: false,
            });

            if (typeof runTabId === "number") {
              await clearPagePhaseAlarm(runTabId);
              chrome.tabs
                .update(runTabId, { url: WEBCAT_LOGOUT_URL, active: false })
                .catch(() => {});
            }

            await setRunState({
              runState: "success",
              runError: null,
              runTabId,
              runStartedAt: (await chrome.storage.local.get(["runStartedAt"]))
                .runStartedAt,
              runFinishedAt: Date.now(),
            });

            if (typeof runTabId === "number") {
              chrome.alarms.clear(`flowTimeout:${runTabId}`).catch(() => {});
            }
            return;
          }

          if (didClickRenew) {
            await chrome.storage.local.set({
              renewAttempted: true,
              waitingForRenewResult: true,
              renewResultSeen: false,
            });
            return;
          }

          await chrome.storage.local.set({
            runDetails: "Failed: selected item(s) but couldn't click Renew.",
            shouldLogout: true,
            renewAttempted: true,
            waitingForRenewResult: false,
          });

          if (typeof runTabId === "number") {
            chrome.tabs
              .update(runTabId, { url: WEBCAT_LOGOUT_URL, active: false })
              .catch(() => {});
          }

          await setRunState({
            runState: "failed",
            runError: "Could not click Renew button.",
            runTabId,
            runStartedAt: (await chrome.storage.local.get(["runStartedAt"]))
              .runStartedAt,
            runFinishedAt: Date.now(),
          });
          break;
        }

        case "PHASE_FAILED": {
          const senderTabId = sender.tab?.id;
          if (!(await isAuthorizedRunTab(senderTabId))) return;

          const phase = message.phase ?? "unknown";
          const err =
            message.error ||
            "Timed out or could not find an expected element on this page.";
          const details = `Failed (${phase}): ${err}`;
          await failRunAndLogout(senderTabId, err, details);
          break;
        }

        default:
          break;
      }
    })().catch(() => {});
    return false;
  }

  (async () => {
    try {
      switch (message.type) {
        case "ADD_ACCOUNT": {
          const { accounts = [] } = await getState(["accounts"]);
          const id = newId();
          accounts.push({
            id,
            account: message.account,
            password: message.password,
          });
          await setState({ accounts });
          sendResponse({ ok: true, id });
          break;
        }

        case "UPDATE_ACCOUNT": {
          const { accounts = [] } = await getState(["accounts"]);
          const idx = accounts.findIndex((a) => a.id === message.id);
          if (idx === -1) {
            sendResponse({ ok: false, error: "Account not found." });
            break;
          }
          const next = {
            ...accounts[idx],
            account: String(message.account ?? "").trim(),
          };
          if (!next.account) {
            sendResponse({ ok: false, error: "Account label is required." });
            break;
          }
          const pw = message.password;
          if (typeof pw === "string" && pw.length > 0) {
            next.password = pw;
          }
          accounts[idx] = next;
          await setState({ accounts });
          sendResponse({ ok: true });
          break;
        }

        case "REMOVE_ACCOUNT": {
          const { accounts = [], accountResults = {} } = await getState([
            "accounts",
            "accountResults",
          ]);
          const nextAccounts = accounts.filter((a) => a.id !== message.id);
          delete accountResults[message.id];
          await setState({ accounts: nextAccounts, accountResults });
          await computeAndSetBadge();
          sendResponse({ ok: true });
          break;
        }

        case "RUN_ALL": {
          await clearStaleRunIfNeeded();
          const {
            accounts = [],
            runningAll = false,
            runningOne = false,
          } = await getState(["accounts", "runningAll", "runningOne"]);
          if (runningAll || runningOne) {
            sendResponse({
              ok: false,
              error: "Already running. Wait for the current run to finish.",
            });
            break;
          }
          if (!accounts.length) {
            await setState({ runError: "No accounts configured." });
            sendResponse({ ok: false, error: "No accounts configured." });
            break;
          }

          const accountResults = Object.fromEntries(
            accounts.map((a) => [a.id, { state: "pending", details: "" }]),
          );

          await setState({
            runningAll: true,
            queueIndex: 0,
            accountResults,
            runError: null,
            runnerTabId: (await getState(["runnerTabId"])).runnerTabId ?? null,
          });
          await computeAndSetBadge();

          await startNextAccountIfAny();
          sendResponse({ ok: true });
          break;
        }

        case "RUN_ONE": {
          await setState({ runError: null });
          const started = await runSingleAccountById(message.id);
          if (!started) {
            const { runError: err } = await getState(["runError"]);
            sendResponse({
              ok: false,
              error: err || "Could not start run for this account.",
            });
            break;
          }
          await computeAndSetBadge();
          sendResponse({ ok: true });
          break;
        }

        case "CANCEL_RUN": {
          const { runnerTabId = null, runTabId = null } = await getState([
            "runnerTabId",
            "runTabId",
          ]);
          const tabId =
            typeof runTabId === "number"
              ? runTabId
              : typeof runnerTabId === "number"
                ? runnerTabId
                : null;
          await abortRun({
            reason: "Run stopped.",
            details: "Stopped by user.",
            markCurrentFailed: true,
          });
          if (typeof tabId === "number") {
            chrome.tabs.remove(tabId).catch(() => {});
          }
          sendResponse({ ok: true });
          break;
        }

        case "START_LOGIN": {
          await resetFlowFlagsForAccountRun();
          const runStartedAt = Date.now();
          const tabId = await ensureRunnerTab();
          if (typeof tabId !== "number") {
            sendResponse({ ok: false, error: "Could not open login tab." });
            break;
          }
          await chrome.tabs
            .update(tabId, { url: LOGIN_URL, active: false })
            .catch(() => {});
          await setRunState({
            runState: "running",
            runError: null,
            runTabId: tabId,
            runStartedAt,
            runFinishedAt: null,
          });
          chrome.alarms.clear(`flowTimeout:${tabId}`).catch(() => {});
          chrome.alarms.create(`flowTimeout:${tabId}`, {
            when: Date.now() + FLOW_TIMEOUT_MS,
          });
          sendResponse({ ok: true, tabId, url: LOGIN_URL });
          break;
        }

        case "LOGOUT_DONE": {
          const senderTabId = sender.tab?.id;
          if (!(await isAuthorizedLogoutTab(senderTabId))) {
            sendResponse({ ok: false, error: "Unauthorized tab." });
            break;
          }

          const { runTabId } = await getState(["runTabId"]);
          await chrome.storage.local.set({
            sessionEndedAt: Date.now(),
            shouldLogout: false,
          });
          if (typeof runTabId === "number") {
            chrome.alarms.clear(`flowTimeout:${runTabId}`).catch(() => {});
            await clearPagePhaseAlarm(runTabId);
          }

          const { runningAll = false, runningOne = false } = await getState([
            "runningAll",
            "runningOne",
          ]);

          if (runningAll) {
            await finalizeCurrentAccountResult();
            const { queueIndex = 0, accounts = [] } = await getState([
              "queueIndex",
              "accounts",
            ]);
            const nextIndex = queueIndex + 1;
            await setState({ queueIndex: nextIndex });
            const moreAccounts = nextIndex < accounts.length;
            sendResponse({
              ok: true,
              goLogin: moreAccounts,
            });
            await computeAndSetBadge();
            await startNextAccountIfAny();
          } else if (runningOne) {
            await finalizeCurrentAccountResult();
            sendResponse({ ok: true, goLogin: false });
            await setState({ runningOne: false });
            const { runnerTabId = null } = await getState(["runnerTabId"]);
            if (typeof runnerTabId === "number") {
              chrome.tabs.remove(runnerTabId).catch(() => {});
              await setState({ runnerTabId: null });
            }
            await computeAndSetBadge();
          } else {
            sendResponse({ ok: true, goLogin: false });
            await computeAndSetBadge();
          }
          break;
        }

        default:
          break;
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message ?? e) });
    }
  })();

  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== "complete") return;

  (async () => {
    const { runState, runTabId } = await chrome.storage.local.get([
      "runState",
      "runTabId",
    ]);

    const url = changeInfo.url ?? tab?.url ?? "";

    if (runState === "running" && runTabId === tabId) {
      if (isPhaseTimeoutExemptUrl(url)) {
        await clearPagePhaseAlarm(tabId);
      } else if (
        (changeInfo.status === "complete" || changeInfo.url) &&
        url.startsWith("http")
      ) {
        await maybeRearmPagePhaseSameUrl(tabId, url);
      }
    }

    if (runState !== "running") return;
    if (runTabId !== tabId) return;

    if (url.startsWith(RENEW_RESULT_URL_PREFIX)) {
      const { waitingForRenewResult } = await chrome.storage.local.get([
        "waitingForRenewResult",
      ]);
      if (!waitingForRenewResult) return;

      await clearPagePhaseAlarm(tabId);

      await chrome.storage.local.set({
        renewResultSeen: true,
        waitingForRenewResult: false,
        shouldLogout: true,
        runDetails: "Success: renew result page opened.",
      });

      chrome.tabs
        .update(tabId, { url: WEBCAT_LOGOUT_URL, active: false })
        .catch(() => {});

      await setRunState({
        runState: "success",
        runError: null,
        runTabId: tabId,
        runStartedAt: (await chrome.storage.local.get(["runStartedAt"]))
          .runStartedAt,
        runFinishedAt: Date.now(),
      });

      return;
    }
    if (url.startsWith(TARGET_AFTER_LOGIN)) {
      return;
    }

    if (HKPL_INDEX_URLS.some((u) => url.startsWith(u))) {
      chrome.tabs
        .update(tabId, { url: TARGET_AFTER_LOGIN, active: false })
        .catch(() => {});
    }
  })().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm?.name) return;

  if (alarm.name === CALENDAR_DAY_CHECK_ALARM) {
    maybeAutoRunToday().catch(() => {});
    return;
  }

  if (alarm.name.startsWith("pagePhase:")) {
    const tabId = Number(alarm.name.split(":")[1]);
    if (!Number.isFinite(tabId)) return;

    (async () => {
      const { runState, runTabId, pagePhaseTimeout } = await getState([
        "runState",
        "runTabId",
        "pagePhaseTimeout",
      ]);
      if (runState !== "running" || runTabId !== tabId) return;
      if (!pagePhaseTimeout || pagePhaseTimeout.tabId !== tabId) return;

      let currentUrl = "";
      try {
        const t = await chrome.tabs.get(tabId);
        currentUrl = t?.url ?? "";
      } catch {
        await failRunAndLogout(
          tabId,
          "Runner tab closed or inaccessible.",
          "Failed: runner tab was closed before the flow finished.",
        );
        return;
      }

      if (currentUrl !== pagePhaseTimeout.urlAtStart) {
        await chrome.storage.local.remove("pagePhaseTimeout");
        return;
      }

      if (isPhaseTimeoutExemptUrl(currentUrl)) {
        await clearPagePhaseAlarm(tabId);
        return;
      }

      await failRunAndLogout(
        tabId,
        "Page step timed out (30s) with no navigation.",
        "Failed: this page did not progress within 30 seconds (timeout).",
      );
    })().catch(() => {});
    return;
  }

  if (!alarm.name.startsWith("flowTimeout:")) return;

  const tabId = Number(alarm.name.split(":")[1]);
  if (!Number.isFinite(tabId)) return;

  (async () => {
    const { runState, runTabId } = await chrome.storage.local.get([
      "runState",
      "runTabId",
    ]);
    if (runState !== "running") return;
    if (runTabId !== tabId) return;

    let url = "";
    try {
      const tab = await chrome.tabs.get(tabId);
      url = tab?.url ?? "";
    } catch {
      // Tab gone.
    }

    if (url.startsWith(TARGET_AFTER_LOGIN)) {
      return;
    }

    if (HKPL_INDEX_URLS.some((u) => url.startsWith(u))) {
      chrome.tabs
        .update(tabId, { url: TARGET_AFTER_LOGIN, active: false })
        .catch(() => {});
      return;
    }

    const { waitingForRenewResult, renewAttempted, shouldLogout } =
      await chrome.storage.local.get([
        "waitingForRenewResult",
        "renewAttempted",
        "shouldLogout",
      ]);

    if (waitingForRenewResult) {
      await chrome.storage.local.set({
        waitingForRenewResult: false,
        shouldLogout: true,
        runDetails: "Failed: renew result page did not appear.",
      });

      chrome.tabs
        .update(tabId, { url: WEBCAT_LOGOUT_URL, active: false })
        .catch(() => {});

      await setRunState({
        runState: "failed",
        runError: "Renew result page did not appear.",
        runTabId: tabId,
        runStartedAt: (await chrome.storage.local.get(["runStartedAt"]))
          .runStartedAt,
        runFinishedAt: Date.now(),
      });
      return;
    }

    if (renewAttempted && shouldLogout) {
      return;
    }

    await setRunState({
      runState: "failed",
      runError:
        "Flow timeout. Possible captcha/invalid credentials, or webcat page didn’t load.",
      runTabId: tabId,
      runStartedAt: (await chrome.storage.local.get(["runStartedAt"]))
        .runStartedAt,
      runFinishedAt: Date.now(),
    });

    await chrome.storage.local.set({
      runDetails:
        "Failed: flow timeout before reaching renew/logout completion.",
      shouldLogout: true,
    });

    chrome.tabs
      .update(tabId, { url: WEBCAT_LOGOUT_URL, active: false })
      .catch(() => {});
  })().catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  (async () => {
    const {
      runningAll = false,
      runningOne = false,
      runState,
      runTabId,
      runnerTabId,
    } = await getState([
      "runningAll",
      "runningOne",
      "runState",
      "runTabId",
      "runnerTabId",
    ]);

    if (!runningAll && !runningOne && runState !== "running") return;

    const isRunner = tabId === runnerTabId;
    const isRunTab = tabId === runTabId;
    if (!isRunner && !isRunTab) return;

    await abortRun({
      reason: "Runner tab was closed.",
      details: "Failed: runner tab was closed before the flow finished.",
      markCurrentFailed: true,
    });
  })().catch(() => {});
});
