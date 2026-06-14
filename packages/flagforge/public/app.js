/**
 * FlagForge Admin Dashboard
 * Security: all server data is inserted via textContent or createElement — never innerHTML with
 * server data — to prevent XSS.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DEFAULT_API_KEY = 'dev-flagforge-key';
const LS_KEY = 'flagforge_api_key';

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
    if (tab === 'flags') loadFlags();
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
  loadFlags();
});

// ---------------------------------------------------------------------------
// Flags tab
// ---------------------------------------------------------------------------
async function loadFlags() {
  const showArchived = document.getElementById('show-archived').checked;
  const errEl = document.getElementById('flags-error');
  errEl.textContent = '';
  try {
    const res = await apiFetch('/flags?includeArchived=' + String(showArchived));
    if (!res.ok) {
      errEl.textContent = 'Error ' + String(res.status) + ' loading flags';
      return;
    }
    const flags = await res.json();
    renderFlagsTable(flags);
  } catch (err) {
    errEl.textContent = String(err);
  }
}

function renderFlagsTable(flags) {
  const tbody = document.getElementById('flags-tbody');
  // Clear existing rows safely
  while (tbody.firstChild) tbody.removeChild(tbody.firstChild);

  if (flags.length === 0) {
    const tr = document.createElement('tr');
    tr.className = 'empty-row';
    const td = document.createElement('td');
    td.setAttribute('colspan', '7');
    td.textContent = 'No flags found.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const flag of flags) {
    const tr = document.createElement('tr');

    // Key
    const tdKey = document.createElement('td');
    tdKey.textContent = flag.key;
    tdKey.style.fontFamily = 'monospace';
    tdKey.style.fontWeight = '600';
    tr.appendChild(tdKey);

    // Type
    const tdType = document.createElement('td');
    tdType.textContent = flag.type;
    tr.appendChild(tdType);

    // Enabled badge
    const tdEnabled = document.createElement('td');
    const enabledBadge = document.createElement('span');
    enabledBadge.className = flag.enabled ? 'badge-yes' : 'badge-no';
    enabledBadge.textContent = flag.enabled ? 'Yes' : 'No';
    tdEnabled.appendChild(enabledBadge);
    tr.appendChild(tdEnabled);

    // Version
    const tdVersion = document.createElement('td');
    tdVersion.textContent = String(flag.version);
    tr.appendChild(tdVersion);

    // Archived
    const tdArchived = document.createElement('td');
    if (flag.archived) {
      const ab = document.createElement('span');
      ab.className = 'badge-archived';
      ab.textContent = 'Archived';
      tdArchived.appendChild(ab);
    } else {
      tdArchived.textContent = '—';
    }
    tr.appendChild(tdArchived);

    // Updated at
    const tdUpdated = document.createElement('td');
    tdUpdated.textContent = new Date(flag.updatedAt).toLocaleString();
    tr.appendChild(tdUpdated);

    // Actions: toggle enabled
    const tdActions = document.createElement('td');
    if (!flag.archived) {
      const toggleBtn = document.createElement('button');
      toggleBtn.className = flag.enabled ? 'btn-toggle-on' : 'btn-toggle-off';
      toggleBtn.textContent = flag.enabled ? 'Disable' : 'Enable';
      toggleBtn.addEventListener('click', () => toggleFlag(flag.key, !flag.enabled));
      tdActions.appendChild(toggleBtn);
    } else {
      tdActions.textContent = '—';
    }
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  }
}

async function toggleFlag(key, enabled) {
  const errEl = document.getElementById('flags-error');
  errEl.textContent = '';
  try {
    const res = await apiFetch('/flags/' + encodeURIComponent(key), {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      errEl.textContent = 'Error toggling flag: ' + String(body.detail ?? res.status);
      return;
    }
    await loadFlags();
  } catch (err) {
    errEl.textContent = String(err);
  }
}

document.getElementById('refresh-flags-btn').addEventListener('click', loadFlags);
document.getElementById('show-archived').addEventListener('change', loadFlags);

// ---------------------------------------------------------------------------
// Evaluate tab
// ---------------------------------------------------------------------------
document.getElementById('eval-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('eval-error');
  const resultDiv = document.getElementById('eval-result');
  const resultPre = document.getElementById('eval-result-pre');
  errEl.textContent = '';
  resultDiv.hidden = true;

  const flagKey = document.getElementById('eval-key').value.trim();
  const contextKey = document.getElementById('eval-ctx-key').value.trim();
  const attrsRaw = document.getElementById('eval-attrs').value.trim();
  const defaultRaw = document.getElementById('eval-default').value.trim();

  if (!flagKey || !contextKey) {
    errEl.textContent = 'Flag Key and Context Key are required.';
    return;
  }

  let attributes = {};
  if (attrsRaw) {
    try {
      attributes = JSON.parse(attrsRaw);
    } catch {
      errEl.textContent = 'Context Attributes is not valid JSON.';
      return;
    }
  }

  const body = {
    flagKey,
    context: { key: contextKey, attributes },
  };

  if (defaultRaw) {
    try {
      body.defaultValue = JSON.parse(defaultRaw);
    } catch {
      errEl.textContent = 'Default Value is not valid JSON.';
      return;
    }
  }

  try {
    const res = await apiFetch('/evaluate', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const data = await res.json();
    // textContent prevents XSS — JSON.stringify output is safe but we do it right anyway.
    resultPre.textContent = JSON.stringify(data, null, 2);
    resultDiv.hidden = false;
  } catch (err) {
    errEl.textContent = String(err);
  }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
if (apiKey) {
  noKeyBanner.hidden = true;
  loadFlags();
}
