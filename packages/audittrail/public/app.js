/* AuditTrail Admin — vanilla ES2020, no build step, no frameworks */

// ── LocalStorage key ─────────────────────────────────────────────────────────
const LS_KEY = 'audittrail_api_key';

// ── DOM helpers (no innerHTML / insertAdjacentHTML with dynamic content) ──────

/**
 * Create an element, set text content and optional attributes/classes.
 * All text written via .textContent — never innerHTML.
 */
function el(tag, { text, cls, attrs } = {}) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls)  node.className = cls;
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      node.setAttribute(k, v);
    }
  }
  return node;
}

/** Append child nodes to a parent and return the parent. */
function append(parent, ...children) {
  for (const child of children) parent.appendChild(child);
  return parent;
}

/** Build a <td> with textContent. */
function td(text) {
  const cell = document.createElement('td');
  cell.textContent = text ?? '';
  return cell;
}

/** Build a <td> containing a single badge <span> (purely static CSS classes). */
function tdBadge(value) {
  const cell = document.createElement('td');
  const span = el('span', {
    text: value ? 'Yes' : 'No',
    cls:  value ? 'badge-yes' : 'badge-no',
  });
  cell.appendChild(span);
  return cell;
}

/** Replace all children of a tbody with a single "empty" message row. */
function showEmptyRow(tbody, colspan, message) {
  tbody.replaceChildren();
  const row  = document.createElement('tr');
  row.className = 'empty-row';
  const cell = document.createElement('td');
  cell.setAttribute('colspan', String(colspan));
  cell.textContent = message;
  row.appendChild(cell);
  tbody.appendChild(row);
}

// ── Other helpers ─────────────────────────────────────────────────────────────

function getApiKey() {
  return (localStorage.getItem(LS_KEY) || '').trim();
}

function showBanner(id, visible) {
  const node = document.getElementById(id);
  if (node) node.hidden = !visible;
}

function setError(id, msg) {
  const node = document.getElementById(id);
  if (node) node.textContent = msg || '';
}

function clearError(id) { setError(id, ''); }

function fmtDate(iso) {
  if (!iso) return '—';
  try   { return new Date(iso).toLocaleString(); }
  catch (_) { return String(iso); }
}

// ── Central fetch helper ─────────────────────────────────────────────────────

async function api(path, options = {}) {
  const key     = getApiKey();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (key) headers['x-api-key'] = key;

  const res = await fetch(path, { ...options, headers });

  if (res.status === 401) {
    showBanner('auth-banner', true);
    const err = new Error('401 Unauthorized');
    err.status = 401;
    throw err;
  } else {
    showBanner('auth-banner', false);
  }

  const contentType = res.headers.get('content-type') || '';
  let body = null;
  if (contentType.includes('json')) body = await res.json();

  if (!res.ok) {
    // RFC-7807 problem+json
    const detail = body?.detail || body?.title || `HTTP ${res.status}`;
    const err = new Error(detail);
    err.status = res.status;
    err.body   = body;
    throw err;
  }

  return body;
}

// ── Tab routing ──────────────────────────────────────────────────────────────

function initTabs() {
  const buttons = document.querySelectorAll('.tab-btn');
  const panels  = document.querySelectorAll('.tab-panel');

  function activate(tabName) {
    buttons.forEach(btn => {
      const active = btn.dataset.tab === tabName;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    panels.forEach(panel => {
      panel.hidden = panel.id !== `tab-${tabName}`;
    });
  }

  buttons.forEach(btn => {
    btn.addEventListener('click', () => activate(btn.dataset.tab));
  });
}

// ── API-key bar ──────────────────────────────────────────────────────────────

function initApiKeyBar() {
  const input       = document.getElementById('api-key-input');
  const btn         = document.getElementById('api-key-save');
  const status      = document.getElementById('api-key-status');
  const noKeyBanner = document.getElementById('no-key-banner');

  function applyKey() {
    const val = (input.value || '').trim();
    if (val) {
      localStorage.setItem(LS_KEY, val);
      status.textContent = 'Saved.';
      setTimeout(() => { status.textContent = ''; }, 2500);
      noKeyBanner.hidden = true;
    } else {
      localStorage.removeItem(LS_KEY);
      status.textContent = '';
      noKeyBanner.hidden = false;
    }
  }

  const stored = getApiKey();
  if (stored) {
    input.value = stored;
    noKeyBanner.hidden = true;
  }

  btn.addEventListener('click', applyKey);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') applyKey(); });
}

// ── Ingest tab ───────────────────────────────────────────────────────────────

function initIngest() {
  const form      = document.getElementById('ingest-form');
  const resultBox = document.getElementById('ingest-result');
  const resultPre = document.getElementById('ingest-result-pre');
  const ERR       = 'ingest-error';

  form.addEventListener('submit', async e => {
    e.preventDefault();
    clearError(ERR);
    resultBox.hidden = true;

    if (!getApiKey()) { setError(ERR, 'Enter your API key first.'); return; }

    const actor    = form.elements['actor'].value.trim();
    const action   = form.elements['action'].value.trim();
    const resource = form.elements['resource'].value.trim();

    if (!actor || !action || !resource) {
      setError(ERR, 'Actor, Action and Resource are required.');
      return;
    }

    const body = { actor, action, resource };

    const occurredAt = form.elements['occurredAt'].value;
    if (occurredAt) body.occurredAt = new Date(occurredAt).toISOString();

    const ip = form.elements['ip'].value.trim();
    if (ip) body.ip = ip;

    const rawMeta = form.elements['metadata'].value.trim();
    if (rawMeta) {
      try {
        body.metadata = JSON.parse(rawMeta);
      } catch (_) {
        setError(ERR, 'Metadata is not valid JSON.');
        return;
      }
    }

    const submitBtn = form.querySelector('button[type=submit]');
    submitBtn.disabled = true;
    try {
      const event = await api('/events', { method: 'POST', body: JSON.stringify(body) });
      // textContent is safe for all user/server strings
      resultPre.textContent = JSON.stringify(event, null, 2);
      resultBox.hidden = false;
      form.reset();
    } catch (err) {
      setError(ERR, err.message);
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// ── Search tab ───────────────────────────────────────────────────────────────

let searchState = { params: null, nextCursor: null, totalShown: 0 };

/** Build a <tr> for one event using only DOM methods — no string interpolation. */
function makeEventRow(ev) {
  const hash      = String(ev.hash || '');
  const shortHash = hash.slice(0, 12) + (hash.length > 12 ? '…' : '');

  const hashCell = document.createElement('td');
  hashCell.className = 'hash-cell';
  hashCell.textContent = shortHash;
  hashCell.setAttribute('title', hash); // title is plain text, safe

  const row = document.createElement('tr');
  append(row,
    td(ev.id),
    td(fmtDate(ev.occurredAt)),
    td(ev.actor),
    td(ev.action),
    td(ev.resource),
    td(ev.ip || '—'),
    hashCell,
  );
  return row;
}

function appendEventRows(items) {
  const tbody = document.getElementById('events-tbody');
  const frag  = document.createDocumentFragment();
  items.forEach(ev => frag.appendChild(makeEventRow(ev)));
  tbody.appendChild(frag);

  searchState.totalShown += items.length;
  const n = searchState.totalShown;
  document.getElementById('search-count').textContent =
    `${n} event${n !== 1 ? 's' : ''} loaded`;
}

function setLoadMoreVisible(visible) {
  document.getElementById('load-more-btn').hidden = !visible;
}

async function fetchEvents(params, cursor) {
  const qs = new URLSearchParams();
  if (params.actor)    qs.set('actor',    params.actor);
  if (params.action)   qs.set('action',   params.action);
  if (params.resource) qs.set('resource', params.resource);
  if (params.from)     qs.set('from',     params.from);
  if (params.to)       qs.set('to',       params.to);
  if (params.limit)    qs.set('limit',    params.limit);
  if (cursor != null)  qs.set('cursor',   cursor);
  return api(`/events?${qs.toString()}`);
}

function initSearch() {
  const form           = document.getElementById('search-form');
  const resultsSection = document.getElementById('search-results');
  const tbody          = document.getElementById('events-tbody');
  const loadMore       = document.getElementById('load-more-btn');
  const ERR            = 'search-error';

  form.addEventListener('submit', async e => {
    e.preventDefault();
    clearError(ERR);

    if (!getApiKey()) { setError(ERR, 'Enter your API key first.'); return; }

    const fromRaw = form.elements['from'].value;
    const toRaw   = form.elements['to'].value;

    const params = {
      actor:    form.elements['actor'].value.trim(),
      action:   form.elements['action'].value.trim(),
      resource: form.elements['resource'].value.trim(),
      from:     fromRaw ? new Date(fromRaw).toISOString() : '',
      to:       toRaw   ? new Date(toRaw).toISOString()   : '',
      limit:    form.elements['limit'].value || '25',
    };

    searchState = { params, nextCursor: null, totalShown: 0 };
    tbody.replaceChildren();
    resultsSection.hidden = true;
    setLoadMoreVisible(false);

    const submitBtn = form.querySelector('button[type=submit]');
    submitBtn.disabled = true;
    try {
      const data = await fetchEvents(params, null);
      resultsSection.hidden = false;
      if (!data.items || data.items.length === 0) {
        showEmptyRow(tbody, 7, 'No events found.');
      } else {
        appendEventRows(data.items);
      }
      searchState.nextCursor = data.nextCursor ?? null;
      setLoadMoreVisible(searchState.nextCursor != null);
    } catch (err) {
      setError(ERR, err.message);
    } finally {
      submitBtn.disabled = false;
    }
  });

  loadMore.addEventListener('click', async () => {
    clearError(ERR);
    loadMore.disabled = true;
    try {
      const data = await fetchEvents(searchState.params, searchState.nextCursor);
      if (data.items && data.items.length > 0) appendEventRows(data.items);
      searchState.nextCursor = data.nextCursor ?? null;
      setLoadMoreVisible(searchState.nextCursor != null);
    } catch (err) {
      setError(ERR, err.message);
    } finally {
      loadMore.disabled = false;
    }
  });
}

// ── Verify tab ───────────────────────────────────────────────────────────────

/**
 * Build the verify-result panel entirely with DOM methods.
 * No innerHTML, no string interpolation into HTML.
 */
function buildVerifyPanel(data) {
  const wrap = document.createElement('div');

  if (data.valid) {
    wrap.className = 'verify-result-ok';
    const n = data.checkedCount;
    wrap.appendChild(
      el('span', { text: '✓ Chain intact' })
    );
    wrap.appendChild(
      el('div', {
        text: `${n} event${n !== 1 ? 's' : ''} checked — no tampering detected.`,
        cls:  'verify-detail',
      })
    );
  } else {
    wrap.className = 'verify-result-fail';
    const id     = data.brokenAtId != null ? String(data.brokenAtId) : 'unknown';
    const reason = data.reason || 'Unknown reason';
    const n      = data.checkedCount;

    const heading = el('span', { text: `✗ Tampering detected at id ${id}` });
    wrap.appendChild(heading);

    wrap.appendChild(el('div', { text: `Reason: ${reason}`, cls: 'verify-detail' }));

    if (data.expected) {
      wrap.appendChild(el('div', { text: `Expected: ${data.expected}`, cls: 'verify-detail' }));
    }
    if (data.actual) {
      wrap.appendChild(el('div', { text: `Actual:  ${data.actual}`, cls: 'verify-detail' }));
    }
    wrap.appendChild(
      el('div', {
        text: `${n} event${n !== 1 ? 's' : ''} checked.`,
        cls:  'verify-detail',
      })
    );
  }

  return wrap;
}

function initVerify() {
  const btn       = document.getElementById('verify-btn');
  const resultBox = document.getElementById('verify-result');
  const ERR       = 'verify-error';

  btn.addEventListener('click', async () => {
    clearError(ERR);
    resultBox.hidden = true;

    if (!getApiKey()) { setError(ERR, 'Enter your API key first.'); return; }

    btn.disabled    = true;
    btn.textContent = 'Verifying…';
    try {
      const data = await api('/verify');
      resultBox.replaceChildren(buildVerifyPanel(data));
      resultBox.hidden = false;
    } catch (err) {
      setError(ERR, err.message);
    } finally {
      btn.disabled    = false;
      btn.textContent = 'Verify Chain';
    }
  });
}

// ── Alerts tab ───────────────────────────────────────────────────────────────

function makeRuleRow(rule) {
  const row = document.createElement('tr');
  append(row,
    td(rule.id),
    td(rule.name),
    td(rule.matchAction),
    td(rule.threshold),
    td(rule.windowSeconds),
    tdBadge(rule.groupByActor),
    tdBadge(rule.enabled !== false),
  );
  return row;
}

function makeAlertRow(alert) {
  const row = document.createElement('tr');
  append(row,
    td(alert.id),
    td(alert.ruleId),
    td(alert.actor || '—'),
    td(alert.matchedCount),
    td(fmtDate(alert.windowStart)),
    td(fmtDate(alert.windowEnd)),
    td(fmtDate(alert.triggeredAt)),
  );
  return row;
}

async function loadRules() {
  const tbody = document.getElementById('rules-tbody');
  const ERR   = 'rules-error';
  clearError(ERR);
  try {
    const rules = await api('/alert-rules');
    const list  = Array.isArray(rules) ? rules : (rules.items || []);
    if (list.length === 0) {
      showEmptyRow(tbody, 7, 'No rules defined.');
    } else {
      const frag = document.createDocumentFragment();
      list.forEach(r => frag.appendChild(makeRuleRow(r)));
      tbody.replaceChildren(frag);
    }
  } catch (err) {
    setError(ERR, err.message);
  }
}

async function loadAlerts() {
  const tbody = document.getElementById('triggered-tbody');
  const ERR   = 'alerts-error';
  clearError(ERR);
  const limit = document.getElementById('alerts-limit').value || '50';
  try {
    const data = await api(`/alerts?limit=${encodeURIComponent(limit)}`);
    const list = Array.isArray(data) ? data : (data.items || []);
    if (list.length === 0) {
      showEmptyRow(tbody, 7, 'No triggered alerts.');
    } else {
      const frag = document.createDocumentFragment();
      list.forEach(a => frag.appendChild(makeAlertRow(a)));
      tbody.replaceChildren(frag);
    }
  } catch (err) {
    setError(ERR, err.message);
  }
}

function initAlerts() {
  const form  = document.getElementById('rule-form');
  const ERR   = 'rule-error';

  form.addEventListener('submit', async e => {
    e.preventDefault();
    clearError(ERR);

    if (!getApiKey()) { setError(ERR, 'Enter your API key first.'); return; }

    const name         = form.elements['name'].value.trim();
    const matchAction  = form.elements['matchAction'].value.trim();
    const thresholdRaw = form.elements['threshold'].value;
    const windowRaw    = form.elements['windowSeconds'].value;
    const groupByActor = form.elements['groupByActor'].checked;
    const enabled      = form.elements['enabled'].checked;

    if (!name || !matchAction || !thresholdRaw || !windowRaw) {
      setError(ERR, 'Name, Match Action, Threshold and Window are required.');
      return;
    }

    const body = {
      name,
      matchAction,
      threshold:     parseInt(thresholdRaw, 10),
      windowSeconds: parseInt(windowRaw,     10),
      groupByActor,
      enabled,
    };

    const submitBtn = form.querySelector('button[type=submit]');
    submitBtn.disabled = true;
    try {
      await api('/alert-rules', { method: 'POST', body: JSON.stringify(body) });
      form.reset();
      form.elements['enabled'].checked = true; // restore default
      await loadRules();
    } catch (err) {
      setError(ERR, err.message);
    } finally {
      submitBtn.disabled = false;
    }
  });

  document.getElementById('refresh-rules-btn').addEventListener('click', loadRules);
  document.getElementById('refresh-alerts-btn').addEventListener('click', loadAlerts);

  // Auto-load when the Alerts tab is activated
  document.querySelectorAll('.tab-btn').forEach(btn => {
    if (btn.dataset.tab === 'alerts') {
      btn.addEventListener('click', () => {
        if (getApiKey()) { loadRules(); loadAlerts(); }
      });
    }
  });
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

function init() {
  initApiKeyBar();
  initTabs();
  initIngest();
  initSearch();
  initVerify();
  initAlerts();
}

document.addEventListener('DOMContentLoaded', init);
