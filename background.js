const TARGET_AFTER_LOGIN = "https://webcat.hkpl.gov.hk/search/query?theme=WEB";
const LOGIN_URL = "https://www.hkpl.gov.hk/tc/login.html";
const ACCOUNT_URL =
  "https://webcat.hkpl.gov.hk/wicket/bookmarkable/com.vtls.chamo.webapp.component.patron.PatronAccountPage?theme=WEB";
const WEBCAT_WICKET_PAGE_PREFIX = "https://webcat.hkpl.gov.hk/wicket/page?";

/** Wicket page id varies (e.g. ?5, ?7); match any renew-result wicket page URL. */
function isRenewResultUrl(url) {
  if (!url || !url.startsWith(WEBCAT_WICKET_PAGE_PREFIX)) return false;
  return /^\d/.test(url.slice(WEBCAT_WICKET_PAGE_PREFIX.length));
}
const WEBCAT_LOGOUT_URL =
  "https://webcat.hkpl.gov.hk/auth/logout?theme=WEB&locale=zh_TW";
const FLOW_TIMEOUT_MS = 45000;
/** Keep in sync with PHASE_PAGE_TIMEOUT_MS in content scripts. */
const PHASE_PAGE_TIMEOUT_MS = 30000;
/** Extra time after flow timeout before treating a run as stale. */
const STALE_RUN_GRACE_MS = 5000;
/** If LOGOUT_DONE never arrives after a failure, force-advance the queue. */
const QUEUE_ADVANCE_WATCHDOG_MS = 15000;
const QUEUE_ADVANCE_WATCHDOG_ALARM = "queueAdvanceWatchdog";
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
  if (isRenewResultUrl(url)) return true;
  if (url.includes("/auth/logout")) return true;
  if (url.includes("confirm_logout")) return true;
  if (url.includes("/logout.html")) return true;
  return false;
}

function isHkplLoginUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return (
      u.hostname === "www.hkpl.gov.hk" &&
      /\/login\.html$/i.test(u.pathname)
    );
  } catch {
    return false;
  }
}

function isWebcatUrl(url) {
  if (!url) return false;
  try {
    return new URL(url).hostname === "webcat.hkpl.gov.hk";
  } catch {
    return url.includes("webcat.hkpl.gov.hk");
  }
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

async function clearQueueAdvanceWatchdog() {
  chrome.alarms.clear(QUEUE_ADVANCE_WATCHDOG_ALARM).catch(() => {});
  await chrome.storage.local.remove("queueAdvanceWatchdog");
}

async function armQueueAdvanceWatchdog(accountId, queueIndex) {
  await clearQueueAdvanceWatchdog();
  await chrome.storage.local.set({
    queueAdvanceWatchdog: { accountId, queueIndex, armedAt: Date.now() },
  });
  chrome.alarms
    .create(QUEUE_ADVANCE_WATCHDOG_ALARM, {
      when: Date.now() + QUEUE_ADVANCE_WATCHDOG_MS,
    })
    .catch(() => {});
}

/** Persist run fields only; badge is always via computeAndSetBadge. */
async function setRunState(state) {
  await chrome.storage.local.set({
    runState: state.runState,
    runError: state.runError ?? null,
    runTabId: state.runTabId ?? null,
    runStartedAt: state.runStartedAt ?? null,
    runFinishedAt: state.runFinishedAt ?? null,
  });
}

function ensureCalendarDayCheckAlarm() {
  chrome.alarms.get(CALENDAR_DAY_CHECK_ALARM, (existing) => {
    if (chrome.runtime.lastError || existing) return;
    chrome.alarms.create(CALENDAR_DAY_CHECK_ALARM, {
      periodInMinutes: CALENDAR_DAY_CHECK_PERIOD_MINUTES,
    });
  });
}

function todayKey() {
  const d = new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function dateKeyFromTimestamp(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function isSuccessForToday(result) {
  return (
    result?.state === "success" &&
    dateKeyFromTimestamp(result.finishedAt) === todayKey()
  );
}

function allAccountsSuccessForToday(accounts, accountResults) {
  return (
    accounts.length > 0 &&
    accounts.every((a) => isSuccessForToday(accountResults?.[a.id]))
  );
}

function accountHasPasswordExpiryAlert(result) {
  return (result?.alerts ?? []).some((a) => a?.type === "password_expiry");
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

async function markAutoRunDoneForToday() {
  await setState({ lastAutoRunDate: todayKey() });
}

async function maybeMarkDayDoneIfAllSuccess() {
  const { accounts = [], accountResults = {} } = await getState([
    "accounts",
    "accountResults",
  ]);
  if (allAccountsSuccessForToday(accounts, accountResults)) {
    await markAutoRunDoneForToday();
  }
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
  pendingDetails = null,
} = {}) {
  if (abortInProgress) return;
  abortInProgress = true;
  try {
    await clearQueueAdvanceWatchdog();

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

    const wasRunningAll = runningAll;
    const failDetails = details || reason;
    const remainingDetails =
      pendingDetails ||
      "Failed: queue stopped after a prior account could not finish cleanup.";
    const tabIds = new Set();
    if (typeof runTabId === "number") tabIds.add(runTabId);
    if (typeof runnerTabId === "number") tabIds.add(runnerTabId);
    for (const id of tabIds) {
      await clearRunAlarmsForTab(id);
    }

    if (markCurrentFailed) {
      if (runningAll) {
        for (const acct of accounts) {
          const prev = accountResults[acct.id] ?? {};
          const st = prev.state;
          if (st === "pending") {
            accountResults[acct.id] = {
              ...prev,
              state: "failed",
              details: remainingDetails,
              finishedAt: Date.now(),
            };
          } else if (st === "running") {
            accountResults[acct.id] = {
              ...prev,
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
        const prev = accountResults[currentAccountId] ?? {};
        accountResults[currentAccountId] = {
          ...prev,
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
      runQueueIds: null,
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

    // Interrupted multi-account run ends auto-run for the calendar day.
    if (wasRunningAll) {
      await markAutoRunDoneForToday();
    }

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
    pendingDetails:
      "Failed: queue stopped after a prior account could not finish cleanup.",
    markCurrentFailed: true,
  });
  return true;
}

async function computeAndSetBadge() {
  const {
    runningAll = false,
    runningOne = false,
    accounts = [],
    accountResults = {},
  } = await getState([
    "runningAll",
    "runningOne",
    "accounts",
    "accountResults",
  ]);

  if (runningAll || runningOne) {
    chrome.action.setBadgeText({ text: "…" }).catch(() => {});
    return;
  }

  if (!accounts.length) {
    chrome.action.setBadgeText({ text: "" }).catch(() => {});
    return;
  }

  const states = accounts.map(
    (a) => accountResults?.[a.id]?.state ?? "pending",
  );
  const anyFailed = states.some((s) => s === "failed");
  const allSuccess = states.length > 0 && states.every((s) => s === "success");
  const anyExpiryAlert = accounts.some((a) =>
    accountHasPasswordExpiryAlert(accountResults?.[a.id]),
  );

  if (anyFailed) {
    chrome.action.setBadgeText({ text: "ERR" }).catch(() => {});
  } else if (anyExpiryAlert) {
    chrome.action.setBadgeText({ text: "!" }).catch(() => {});
  } else if (allSuccess) {
    chrome.action.setBadgeText({ text: "OK" }).catch(() => {});
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

async function getActiveRunQueue() {
  const { runQueueIds = null, accounts = [] } = await getState([
    "runQueueIds",
    "accounts",
  ]);
  if (Array.isArray(runQueueIds) && runQueueIds.length) {
    return runQueueIds;
  }
  return accounts.map((a) => a.id);
}

async function startNextAccountIfAnyImpl() {
  const { runningAll = false, queueIndex = 0, accounts = [] } = await getState([
    "runningAll",
    "queueIndex",
    "accounts",
  ]);

  if (!runningAll) return;

  const queue = await getActiveRunQueue();

  if (queueIndex >= queue.length) {
    await clearQueueAdvanceWatchdog();
    const { runnerTabId = null } = await getState(["runnerTabId"]);
    if (typeof runnerTabId === "number") {
      chrome.tabs.remove(runnerTabId).catch(() => {});
      await setState({ runnerTabId: null });
    }
    await setState({
      runningAll: false,
      currentAccountId: null,
      currentAccount: null,
      runQueueIds: null,
    });
    await markAutoRunDoneForToday();
    await computeAndSetBadge();
    return;
  }

  const acctId = queue[queueIndex];
  const acct = accounts.find((a) => a.id === acctId);
  if (!acct) {
    await setState({ queueIndex: queueIndex + 1 });
    await startNextAccountIfAny();
    return;
  }

  const { accountResults = {} } = await getState(["accountResults"]);
  accountResults[acct.id] = {
    state: "running",
    details: "",
    // Clear prior alerts for this account on a new run.
  };
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
  await computeAndSetBadge();

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
    await setState({ queueIndex: queueIndex + 1 });
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

/**
 * Finalize current account (idempotent), advance queueIndex, start next.
 * Used after success/failure once the tab is ready for the next login.
 * Serialized + keyed so LOGOUT_DONE and the watchdog cannot double-advance.
 */
let advanceQueueChain = Promise.resolve();

async function advanceQueueAfterAccountTerminal() {
  const p = advanceQueueChain.then(() =>
    advanceQueueAfterAccountTerminalImpl().catch(() => ({
      moreAccounts: false,
      skipped: true,
    })),
  );
  advanceQueueChain = p.catch(() => {});
  return p;
}

async function advanceQueueAfterAccountTerminalImpl() {
  await clearQueueAdvanceWatchdog();

  const {
    runningAll = false,
    runningOne = false,
    currentAccountId = null,
    queueIndex = 0,
    lastQueueAdvanceKey = null,
  } = await getState([
    "runningAll",
    "runningOne",
    "currentAccountId",
    "queueIndex",
    "lastQueueAdvanceKey",
  ]);

  if (!runningAll && !runningOne) {
    await computeAndSetBadge();
    return { moreAccounts: false, skipped: true };
  }

  const advanceKey = `${currentAccountId ?? ""}:${queueIndex}`;
  if (lastQueueAdvanceKey === advanceKey) {
    return { moreAccounts: false, skipped: true };
  }

  await finalizeCurrentAccountResult();
  await setState({ lastQueueAdvanceKey: advanceKey });

  if (runningAll) {
    const queue = await getActiveRunQueue();
    const nextIndex = queueIndex + 1;
    await setState({ queueIndex: nextIndex });
    await computeAndSetBadge();
    await startNextAccountIfAny();
    return { moreAccounts: nextIndex < queue.length };
  }

  // runningOne
  await setState({ runningOne: false });
  const { runnerTabId = null } = await getState(["runnerTabId"]);
  if (typeof runnerTabId === "number") {
    chrome.tabs.remove(runnerTabId).catch(() => {});
    await setState({ runnerTabId: null });
  }
  await maybeMarkDayDoneIfAllSuccess();
  await computeAndSetBadge();
  return { moreAccounts: false };
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
    runQueueIds: null,
    lastQueueAdvanceKey: null,
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
  await computeAndSetBadge();

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

  const prev = accountResults[currentAccountId] ?? {};
  // Idempotent: do not overwrite an already-terminal result for this run.
  if (prev.state === "success" || prev.state === "failed") {
    if (prev.finishedAt) return;
  }

  const nextState = runState === "success" ? "success" : "failed";
  accountResults[currentAccountId] = {
    ...prev,
    state: nextState,
    details: runDetails || runError || prev.details || "",
    finishedAt: Date.now(),
    alerts: prev.alerts ?? [],
  };

  await setState({ accountResults });
}

async function attachPasswordExpiryAlert(message) {
  const { currentAccountId, accountResults = {} } = await getState([
    "currentAccountId",
    "accountResults",
  ]);
  if (!currentAccountId) return;

  const days = message.days;
  const dateText = message.dateText || "";
  let text;
  if (typeof days === "number" && dateText) {
    text = `Password expires in ${days} days (${dateText}).`;
  } else if (typeof days === "number") {
    text = `Password expires in ${days} days.`;
  } else if (dateText) {
    text = `Password expires on ${dateText}.`;
  } else {
    text = "Password is nearing expiry. Change it soon.";
  }

  const prev = accountResults[currentAccountId] ?? {
    state: "running",
    details: "",
  };
  const otherAlerts = (prev.alerts ?? []).filter(
    (a) => a?.type !== "password_expiry",
  );
  accountResults[currentAccountId] = {
    ...prev,
    alerts: [
      ...otherAlerts,
      {
        type: "password_expiry",
        message: text,
        detectedAt: Date.now(),
      },
    ],
  };
  await setState({ accountResults });
  await computeAndSetBadge();
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

/** Password-expiry warning arrives on the login page while the run is still active. */
async function isAuthorizedPasswordExpiryTab(senderTabId) {
  return isAuthorizedRunTab(senderTabId);
}

async function handleRenewResultSuccess(tabId) {
  const { runState, runTabId, waitingForRenewResult } = await getState([
    "runState",
    "runTabId",
    "waitingForRenewResult",
  ]);
  if (runState !== "running" || runTabId !== tabId || !waitingForRenewResult) {
    return false;
  }

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
  await computeAndSetBadge();

  const {
    runningAll = false,
    runningOne = false,
    currentAccountId,
    queueIndex = 0,
  } = await getState([
    "runningAll",
    "runningOne",
    "currentAccountId",
    "queueIndex",
  ]);
  if (runningAll || runningOne) {
    await armQueueAdvanceWatchdog(currentAccountId, queueIndex);
  }

  return true;
}

/**
 * Mark current account failed and either skip logout (still on login) or
 * navigate to WebCat logout with a queue-advance watchdog.
 */
async function failRunAndLogout(tabId, runError, runDetails) {
  const { runState, runTabId } = await getState(["runState", "runTabId"]);
  if (runState !== "running") return;
  if (typeof runTabId !== "number" || tabId !== runTabId) return;

  await clearPagePhaseAlarm(runTabId);
  chrome.alarms.clear(`flowTimeout:${runTabId}`).catch(() => {});

  await chrome.storage.local.set({
    runDetails,
    runError,
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

  let currentUrl = "";
  try {
    const t = await chrome.tabs.get(runTabId);
    currentUrl = t?.url ?? "";
  } catch {
    currentUrl = "";
  }

  const { runningAll = false, runningOne = false } = await getState([
    "runningAll",
    "runningOne",
  ]);

  // Still on HKPL login (or never reached WebCat): skip logout and advance.
  if (!isWebcatUrl(currentUrl) || isHkplLoginUrl(currentUrl)) {
    await setState({
      shouldLogout: false,
      didClickLogout: false,
      didConfirmLogout: false,
      didNotifyLogoutDone: false,
    });

    if (runningAll) {
      const { queueIndex = 0 } = await getState(["queueIndex"]);
      const queue = await getActiveRunQueue();
      const moreAccounts = queueIndex + 1 < queue.length;
      if (moreAccounts) {
        await chrome.tabs
          .update(runTabId, { url: LOGIN_URL, active: false })
          .catch(() => {});
      }
      await advanceQueueAfterAccountTerminal();
      return;
    }

    if (runningOne) {
      await advanceQueueAfterAccountTerminal();
      return;
    }

    await computeAndSetBadge();
    return;
  }

  // On WebCat: logout, then LOGOUT_DONE (or watchdog) advances the queue.
  await setState({ shouldLogout: true });
  chrome.tabs
    .update(runTabId, { url: WEBCAT_LOGOUT_URL, active: false })
    .catch(() => {});

  if (runningAll) {
    const { currentAccountId, queueIndex = 0 } = await getState([
      "currentAccountId",
      "queueIndex",
    ]);
    await armQueueAdvanceWatchdog(currentAccountId, queueIndex);
  } else if (runningOne) {
    await armQueueAdvanceWatchdog(null, 0);
  }
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
    accountResults = {},
  } = await getState([
    "lastAutoRunDate",
    "runningAll",
    "runningOne",
    "accounts",
    "accountResults",
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

  if (allAccountsSuccessForToday(accounts, accountResults)) {
    await markAutoRunDoneForToday();
    await computeAndSetBadge();
    return;
  }

  const runQueueIds = accounts
    .filter((a) => !isSuccessForToday(accountResults?.[a.id]))
    .map((a) => a.id);

  if (!runQueueIds.length) {
    await markAutoRunDoneForToday();
    await computeAndSetBadge();
    return;
  }

  const nextResults = { ...accountResults };
  for (const id of runQueueIds) {
    nextResults[id] = { state: "pending", details: "" };
  }

  await setState({
    runningAll: true,
    queueIndex: 0,
    runQueueIds,
    accountResults: nextResults,
    runError: null,
    lastQueueAdvanceKey: null,
  });
  await computeAndSetBadge();
  await startNextAccountIfAny();
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: "#d83b01" }).catch(() => {});
  ensureCalendarDayCheckAlarm();
  computeAndSetBadge()
    .catch(() => {})
    .finally(() => {
      maybeAutoRunToday().catch(() => {});
    });
});

chrome.runtime.onStartup.addListener(() => {
  ensureCalendarDayCheckAlarm();
  computeAndSetBadge()
    .catch(() => {})
    .finally(() => {
      maybeAutoRunToday().catch(() => {});
    });
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
          const renewDaysBefore = [0, 1, 2, 3].includes(
            Number(message.renewDaysBefore),
          )
            ? Number(message.renewDaysBefore)
            : 0;
          const didClickRenew = !!message.didClickRenew;
          const displayOnlyLoanRows = !!message.displayOnlyLoanRows;

          if (total === 0 || checkedNow === 0) {
            const windowLabel =
              renewDaysBefore === 0
                ? "due today or overdue"
                : `due within ${renewDaysBefore} day(s) or overdue`;
            const details =
              total === 0 && !displayOnlyLoanRows
                ? "Success: no borrowed items found."
                : today
                  ? `Success: no items ${windowLabel} (${today}).`
                  : `Success: no items ${windowLabel}.`;

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
            await computeAndSetBadge();

            if (typeof runTabId === "number") {
              chrome.alarms.clear(`flowTimeout:${runTabId}`).catch(() => {});
            }

            const {
              runningAll = false,
              runningOne = false,
              currentAccountId,
              queueIndex = 0,
            } = await getState([
              "runningAll",
              "runningOne",
              "currentAccountId",
              "queueIndex",
            ]);
            if (runningAll || runningOne) {
              await armQueueAdvanceWatchdog(currentAccountId, queueIndex);
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

          await failRunAndLogout(
            senderTabId,
            "Could not click Renew button.",
            "Failed: selected item(s) but couldn't click Renew.",
          );
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

        case "PASSWORD_EXPIRY_WARNING": {
          const senderTabId = sender.tab?.id;
          if (!(await isAuthorizedPasswordExpiryTab(senderTabId))) return;
          await attachPasswordExpiryAlert(message);
          break;
        }

        case "RENEW_RESULT_DETECTED": {
          const senderTabId = sender.tab?.id;
          if (typeof senderTabId !== "number") return;
          await handleRenewResultSuccess(senderTabId);
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
          const { accounts = [], accountResults = {} } = await getState([
            "accounts",
            "accountResults",
          ]);
          const id = newId();
          accounts.push({
            id,
            account: message.account,
            password: message.password,
          });
          await setState({ accounts });

          if (!isSuccessForToday(accountResults[id])) {
            await setState({ lastAutoRunDate: null });
          }
          await computeAndSetBadge();
          sendResponse({ ok: true, id });
          maybeAutoRunToday().catch(() => {});
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

          const runQueueIds = accounts.map((a) => a.id);
          const accountResults = Object.fromEntries(
            accounts.map((a) => [a.id, { state: "pending", details: "" }]),
          );

          await setState({
            runningAll: true,
            queueIndex: 0,
            runQueueIds,
            accountResults,
            runError: null,
            lastQueueAdvanceKey: null,
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
            pendingDetails: "Stopped by user.",
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
          await computeAndSetBadge();
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
            const { queueIndex = 0 } = await getState(["queueIndex"]);
            const queue = await getActiveRunQueue();
            const moreAccounts = queueIndex + 1 < queue.length;
            sendResponse({
              ok: true,
              goLogin: moreAccounts,
            });
            await advanceQueueAfterAccountTerminal();
          } else if (runningOne) {
            sendResponse({ ok: true, goLogin: false });
            await advanceQueueAfterAccountTerminal();
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

    if (isRenewResultUrl(url)) {
      const { waitingForRenewResult } = await chrome.storage.local.get([
        "waitingForRenewResult",
      ]);
      if (!waitingForRenewResult) return;
      await handleRenewResultSuccess(tabId);
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

  if (alarm.name === QUEUE_ADVANCE_WATCHDOG_ALARM) {
    (async () => {
      const {
        queueAdvanceWatchdog,
        runningAll = false,
        runningOne = false,
        currentAccountId,
        queueIndex = 0,
        runTabId,
      } = await getState([
        "queueAdvanceWatchdog",
        "runningAll",
        "runningOne",
        "currentAccountId",
        "queueIndex",
        "runTabId",
      ]);

      if (!queueAdvanceWatchdog) return;
      if (!runningAll && !runningOne) {
        await clearQueueAdvanceWatchdog();
        return;
      }

      // Still on the same account/index → LOGOUT_DONE never advanced us.
      if (
        runningAll &&
        queueAdvanceWatchdog.accountId === currentAccountId &&
        queueAdvanceWatchdog.queueIndex === queueIndex
      ) {
        if (typeof runTabId === "number") {
          await chrome.tabs
            .update(runTabId, { url: LOGIN_URL, active: false })
            .catch(() => {});
        }
        await advanceQueueAfterAccountTerminal();
        return;
      }

      if (runningOne) {
        await advanceQueueAfterAccountTerminal();
        return;
      }

      await clearQueueAdvanceWatchdog();
    })().catch(() => {});
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
      await failRunAndLogout(
        tabId,
        "Renew result page did not appear.",
        "Failed: renew result page did not appear.",
      );
      return;
    }

    if (renewAttempted && shouldLogout) {
      return;
    }

    await failRunAndLogout(
      tabId,
      "Flow timeout. Possible captcha/invalid credentials, or webcat page didn’t load.",
      "Failed: flow timeout before reaching renew/logout completion.",
    );
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
      pendingDetails: "Failed: runner tab was closed before the flow finished.",
      markCurrentFailed: true,
    });
  })().catch(() => {});
});
