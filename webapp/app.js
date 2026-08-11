// Whisper Personal Mini App. No login screen - Telegram's initData proves
// who's asking, and the backend rejects anyone who isn't AUTHORIZED_CHAT_ID.

const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor('#07070b');
  tg.setBackgroundColor('#07070b');
}

const $ = (id) => document.getElementById(id);
const initData = tg?.initData || '';

function api(path, opts = {}) {
  return fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': initData,
      ...(opts.headers || {}),
    },
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Request failed');
    return data;
  });
}

// ---- tabs ----
function switchView(viewId) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  $(viewId).classList.add('active');
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === viewId));
  if (viewId === 'historyView') loadAlerts();
}
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

// ---- symbol dropdown ----
async function populateSymbols() {
  const symbols = await api('/api/symbols');
  $('symbolSelect').innerHTML =
    '<option value="" disabled selected>Select symbol…</option>' +
    Object.entries(symbols).map(([code, label]) => `<option value="${code}">${label}</option>`).join('');
}

// ---- alerts ----
let cachedAlerts = [];
let knownTriggeredIds = new Set(JSON.parse(localStorage.getItem('whisper_seen_triggers') || '[]'));

async function loadAlerts() {
  cachedAlerts = await api('/api/alerts');
  renderUpcoming();
  renderHistory();
  checkForNewTriggers();
}

// If the app is open when an alert fires, sound the alarm right here -
// same idea as the Android app's foreground alert, just browser-based, so
// it only works while this tab/Mini App is actually open.
function checkForNewTriggers() {
  const newlyTriggered = cachedAlerts.filter(
    (a) => a.status === 'triggered' && !knownTriggeredIds.has(a.id)
  );
  if (newlyTriggered.length === 0) return;

  newlyTriggered.forEach((a) => knownTriggeredIds.add(a.id));
  localStorage.setItem('whisper_seen_triggers', JSON.stringify([...knownTriggeredIds]));

  const alert = newlyTriggered[0];
  $('alarmTitle').textContent = `${alert.label} (${alert.timeframe})`;
  $('alarmDetails').textContent = `Target ${alert.target_price} reached (${alert.direction})`;
  $('alarmOverlay').classList.remove('hidden');

  const audio = $('alertAudio');
  audio.currentTime = 0;
  audio.play().catch(() => {}); // browsers may block autoplay until first user interaction
  tg?.HapticFeedback?.notificationOccurred('warning');
}

$('dismissAlarmBtn').addEventListener('click', () => {
  $('alarmOverlay').classList.add('hidden');
  $('alertAudio').pause();
});

// Poll every 5s while the app is open, so a trigger that happens mid-session gets caught.
setInterval(loadAlerts, 5000);

function renderUpcoming() {
  const active = cachedAlerts.filter((a) => a.status === 'active');
  $('alertsEmpty').classList.toggle('hidden', active.length > 0);
  $('alertsList').innerHTML = active.map((a) => `
    <div class="alert-card">
      <div>
        <div style="font-weight:600;">${a.label}</div>
        <div class="sub">${a.timeframe} → ${a.target_price} (${a.direction})</div>
        <div class="status-${a.status}" style="font-size:0.78rem;">${a.status}</div>
      </div>
      <button class="link-btn delete-btn" data-id="${a.id}">Delete</button>
    </div>`).join('');

  $('alertsList').querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/alerts/${btn.dataset.id}`, { method: 'DELETE' });
      loadAlerts();
    });
  });
}

function renderHistory() {
  const triggered = cachedAlerts.filter((a) => a.status === 'triggered');
  $('historyEmpty').classList.toggle('hidden', triggered.length > 0);
  $('historyList').innerHTML = triggered.map((a) => `
    <div class="alert-card">
      <div>
        <div style="font-weight:600;">${a.label}</div>
        <div class="sub">${a.timeframe} → ${a.target_price} (${a.direction})</div>
      </div>
    </div>`).join('');
}

$('alertForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const statusEl = $('createStatus');
  statusEl.textContent = 'Creating…';
  try {
    await api('/api/alerts', {
      method: 'POST',
      body: JSON.stringify({
        symbol: $('symbolSelect').value,
        timeframe: $('timeframeInput').value,
        target_price: Number($('priceInput').value),
        direction: $('directionSelect').value,
      }),
    });
    e.target.reset();
    statusEl.textContent = '✅ Alert created.';
    statusEl.style.color = 'var(--success)';
    tg?.HapticFeedback?.notificationOccurred('success');
    switchView('alertsView');
    loadAlerts();
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.style.color = 'var(--danger)';
  }
});

populateSymbols();
loadAlerts();
