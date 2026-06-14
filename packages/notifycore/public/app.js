/**
 * NotifyCore Admin Dashboard
 * Security: all server data is inserted via textContent or createElement — never innerHTML with
 * server data — to prevent XSS.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DEFAULT_API_KEY = 'dev-notifycore-key';
const LS_KEY = 'notifycore_api_key';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let apiKey = localStorage.getItem(LS_KEY) ?? DEFAULT_API_KEY;

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function apiFetch(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
    },
  });

  if (res.status === 401) {
    document.getElementById('auth-banner').hidden = false;
  } else {
    document.getElementById('auth-banner').hidden = true;
  }

  return res;
}

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach((b) => {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.hidden = true;
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    document.getElementById('tab-' + tab).hidden = false;
    if (tab === 'notifications') loadNotifications();
    if (tab === 'dlq') loadDlq();
  });
});

// ---------------------------------------------------------------------------
// API key bar
// ---------------------------------------------------------------------------
const keyInput = document.getElementById('api-key-input');
const keyStatus = document.getElementById('api-key-status');
const noKeyBanner = document.getElementById('no-key-banner');

keyInput.value = apiKey;
noKeyBanner.hidden = Boolean(apiKey);

document.getElementById('api-key-save').addEventListener('click', () => {
  const v = keyInput.value.trim();
  if (!v) return;
  apiKey = v;
  localStorage.setItem(LS_KEY, apiKey);
  keyStatus.textContent = 'Saved';
  noKeyBanner.hidden = true;
  setTimeout(() => { keyStatus.textContent = ''; }, 2000);
  loadNotifications();
});

// ---------------------------------------------------------------------------
// Notifications tab
// ---------------------------------------------------------------------------
function statusBadge(status) {
  const span = document.createElement('span');
  span.className = 'badge-' + status;
  span.textContent = status;
  return span;
}

async function loadNotifications() {
  const errEl = document.getElementById('notifications-error');
  errEl.textContent = '';
  try {
    const res = await apiFetch('/notifications?limit=50');
    if (!res.ok) {
      errEl.textContent = 'Error ' + String(res.status) + ' loading notifications';
      return;
    }
    renderNotificationsTable(await res.json());
  } catch (err) {
    errEl.textContent = String(err);
  }
}

function renderNotificationsTable(items) {
  const tbody = document.getElementById('notifications-tbody');
  while (tbody.firstChild) tbody.removeChild(tbody.firstChild);

  if (items.length === 0) {
    const tr = document.createElement('tr');
    tr.className = 'empty-row';
    const td = document.createElement('td');
    td.setAttribute('colspan', '6');
    td.textContent = 'No notifications yet.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const item of items) {
    const tr = document.createElement('tr');

    const tdId = document.createElement('td');
    tdId.textContent = String(item.id);
    tr.appendChild(tdId);

    const tdRecipient = document.createElement('td');
    tdRecipient.textContent = item.recipient;
    tr.appendChild(tdRecipient);

    const tdChannel = document.createElement('td');
    tdChannel.textContent = item.channel;
    tr.appendChild(tdChannel);

    const tdStatus = document.createElement('td');
    tdStatus.appendChild(statusBadge(item.status));
    tr.appendChild(tdStatus);

    const tdAttempts = document.createElement('td');
    tdAttempts.textContent = String(item.attempts) + ' / ' + String(item.maxAttempts);
    tr.appendChild(tdAttempts);

    const tdUpdated = document.createElement('td');
    tdUpdated.textContent = new Date(item.updatedAt).toLocaleString();
    tr.appendChild(tdUpdated);

    tbody.appendChild(tr);
  }
}

document.getElementById('refresh-notifications-btn').addEventListener('click', loadNotifications);

// ---------------------------------------------------------------------------
// DLQ tab
// ---------------------------------------------------------------------------
async function loadDlq() {
  const errEl = document.getElementById('dlq-error');
  errEl.textContent = '';
  try {
    const res = await apiFetch('/dlq');
    if (!res.ok) {
      errEl.textContent = 'Error ' + String(res.status) + ' loading DLQ';
      return;
    }
    renderDlqTable(await res.json());
  } catch (err) {
    errEl.textContent = String(err);
  }
}

function renderDlqTable(items) {
  const tbody = document.getElementById('dlq-tbody');
  while (tbody.firstChild) tbody.removeChild(tbody.firstChild);

  if (items.length === 0) {
    const tr = document.createElement('tr');
    tr.className = 'empty-row';
    const td = document.createElement('td');
    td.setAttribute('colspan', '7');
    td.textContent = 'No dead notifications.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const item of items) {
    const tr = document.createElement('tr');

    const tdId = document.createElement('td');
    tdId.textContent = String(item.id);
    tr.appendChild(tdId);

    const tdRecipient = document.createElement('td');
    tdRecipient.textContent = item.recipient;
    tr.appendChild(tdRecipient);

    const tdChannel = document.createElement('td');
    tdChannel.textContent = item.channel;
    tr.appendChild(tdChannel);

    const tdTemplate = document.createElement('td');
    tdTemplate.textContent = item.templateKey;
    tr.appendChild(tdTemplate);

    const tdError = document.createElement('td');
    tdError.textContent = item.lastError ?? '—';
    tdError.style.color = 'var(--color-danger)';
    tr.appendChild(tdError);

    const tdAttempts = document.createElement('td');
    tdAttempts.textContent = String(item.attempts);
    tr.appendChild(tdAttempts);

    const tdActions = document.createElement('td');
    const replayBtn = document.createElement('button');
    replayBtn.className = 'btn-replay';
    replayBtn.textContent = 'Replay';
    replayBtn.addEventListener('click', () => replayNotification(item.id));
    tdActions.appendChild(replayBtn);
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  }
}

async function replayNotification(id) {
  const errEl = document.getElementById('dlq-error');
  errEl.textContent = '';
  try {
    const res = await apiFetch('/dlq/' + String(id) + '/replay', { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      errEl.textContent = 'Replay failed: ' + String(body.detail ?? res.status);
      return;
    }
    await loadDlq();
  } catch (err) {
    errEl.textContent = String(err);
  }
}

document.getElementById('refresh-dlq-btn').addEventListener('click', loadDlq);

// ---------------------------------------------------------------------------
// Send Test tab
// ---------------------------------------------------------------------------
document.getElementById('send-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('send-error');
  const resultDiv = document.getElementById('send-result');
  const resultPre = document.getElementById('send-result-pre');
  errEl.textContent = '';
  resultDiv.hidden = true;

  const idempotencyKey = document.getElementById('send-idempotency-key').value.trim();
  const recipient = document.getElementById('send-recipient').value.trim();
  const channel = document.getElementById('send-channel').value;
  const templateKey = document.getElementById('send-template-key').value.trim();
  const dataRaw = document.getElementById('send-data').value.trim();

  if (!idempotencyKey || !recipient || !templateKey) {
    errEl.textContent = 'Idempotency Key, Recipient, and Template Key are required.';
    return;
  }

  let data = {};
  if (dataRaw) {
    try {
      data = JSON.parse(dataRaw);
    } catch {
      errEl.textContent = 'Data is not valid JSON.';
      return;
    }
  }

  const body = { idempotencyKey, recipient, channel, templateKey, data };

  try {
    const res = await apiFetch('/notifications', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const responseData = await res.json();
    resultPre.textContent = JSON.stringify(responseData, null, 2);
    resultDiv.hidden = false;
    if (res.ok) loadNotifications();
  } catch (err) {
    errEl.textContent = String(err);
  }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
if (apiKey) {
  noKeyBanner.hidden = true;
  loadNotifications();
}
