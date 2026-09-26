/**
 * Страница панели [Р-168]. Одна страница, семь экранов, собранная сборка не нужна: панель — внутренний инструмент на
 * десяток человек, и React со сборкой здесь стоил бы дороже, чем стоит сама панель. Всё, что страница показывает, она
 * берёт ТЕМИ ЖЕ запросами, которыми ходит живой прогон, — второго источника данных у неё нет.
 *
 * Текстов тенанта здесь нет: панель читает оператор платформы, и её язык — рабочий английский, как у кодов и журналов.
 * Письма продавцу по-прежнему идут на языке ТЕНАНТА [Р-161] и собираются словарём консоли.
 */
export const PANEL_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>repracer — operator panel</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
 body { font: 14px/1.45 system-ui, sans-serif; margin: 0; background: #0f1115; color: #e6e8ec; }
 header { padding: 12px 16px; background: #171a21; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
 header b { color: #8ab4f8; } input { background: #0f1115; color: #e6e8ec; border: 1px solid #2b3040; padding: 6px; border-radius: 4px; }
 nav { display: flex; gap: 6px; flex-wrap: wrap; padding: 10px 16px; }
 nav button { background: #1d2230; color: #e6e8ec; border: 1px solid #2b3040; padding: 6px 10px; border-radius: 4px; cursor: pointer; }
 nav button[aria-current="true"] { background: #2b3f6b; }
 main { padding: 0 16px 24px; overflow-x: auto; }
 table { border-collapse: collapse; width: 100%; } th, td { border-bottom: 1px solid #262b38; padding: 6px 8px; text-align: left; white-space: nowrap; }
 th { color: #9aa3b2; font-weight: 600; } .bad { color: #ff8a80; } .ok { color: #9fe2a0; }
 p.note { color: #9aa3b2; }
 section#actions { border: 1px solid #262b38; border-radius: 6px; padding: 10px 12px; margin: 0 0 14px; }
 section#actions h2 { font-size: 14px; margin: 0 0 8px; color: #9aa3b2; font-weight: 600; }
 form { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 0 0 8px; }
 form b { min-width: 190px; font-weight: 600; }
 button { background: #1d2230; color: #e6e8ec; border: 1px solid #2b3040; padding: 6px 10px; border-radius: 4px; cursor: pointer; }
 select { background: #0f1115; color: #e6e8ec; border: 1px solid #2b3040; padding: 6px; border-radius: 4px; }
</style></head><body>
<header><b>repracer</b> operator panel · <span id="who">not signed in</span>
  <input id="token" size="40" placeholder="Bearer token of the identity provider" autocomplete="off">
  <button id="signin">sign in</button></header>
<nav>
  <button data-screen="tenants" aria-current="true">tenants</button>
  <button data-screen="jobs">scheduler jobs</button>
  <button data-screen="alerts">alerts</button>
  <button data-screen="write-queue">write queue</button>
  <button data-screen="notifications">notifications</button>
  <button data-screen="snapshot-skips">snapshot skips</button>
  <button data-screen="actions">operator actions</button>
</nav>
<main>
  <p class="note" id="status">Sign in to load the screens.</p>
  <section id="actions" hidden>
    <h2>Actions</h2>
    <form id="pilot">
      <b>New pilot</b>
      <input name="name" placeholder="seller account name" required>
      <input name="region" value="EU" size="4" required>
      <input name="ownerEmail" type="email" placeholder="owner email" required>
      <select name="locale"><option value="de">de</option><option value="en">en</option></select>
      <button>create tenant</button>
    </form>
    <form id="invite">
      <b>Invite the owner</b>
      <input name="tenantId" placeholder="tenant id" size="38" required>
      <input name="email" type="email" placeholder="owner email" required>
      <button>send invitation</button>
    </form>
    <form id="ack">
      <b>Acknowledge an alert</b>
      <input name="tenantId" placeholder="tenant id" size="38" required>
      <input name="alertId" placeholder="alert id" size="38" required>
      <button>acknowledged</button>
    </form>
    <form id="skip">
      <b>Resolve a snapshot skip</b>
      <input name="snapshotId" placeholder="snapshot id" size="38" required>
      <select name="resolution"><option>LOSS_ACCEPTED</option><option>EXPORTED_AFTER_FIX</option></select>
      <input name="note" placeholder="note for the record (10 characters or more)" size="40" required>
      <button>resolved</button>
    </form>
    <p class="note" id="result">Every action needs a second factor in your sign-in; the database refuses it otherwise.</p>
  </section>
  <table id="grid"></table>
</main>
<script>
const $ = (id) => document.getElementById(id);
let token = '';
let screen = 'tenants';
const KEYS = { tenants: 'tenants', jobs: 'jobs', alerts: 'alerts', 'write-queue': 'queue', notifications: 'notifications', 'snapshot-skips': 'skips', actions: 'actions' };
async function call(path, method, payload) {
  const r = await fetch('/api/operator/' + path, {
    method: method || 'GET',
    headers: { authorization: 'Bearer ' + token, ...(payload ? { 'content-type': 'application/json' } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(body.message || body.code || r.status);
  return body;
}
/** Действие: то же тело, что шлёт живой прогон [Р-142]. Отказ печатается ЦЕЛИКОМ — его причину даёт база, не панель */
function action(id, request) {
  $(id).onsubmit = async (event) => {
    event.preventDefault();
    const f = Object.fromEntries(new FormData(event.target).entries());
    try {
      const { path, method, payload } = request(f);
      const body = await call(path, method, payload);
      $('result').textContent = 'done: ' + JSON.stringify(body);
      await load();
    } catch (e) { $('result').textContent = 'refused: ' + e.message; }
  };
}
action('pilot', (f) => ({ path: 'tenants', method: 'POST', payload: { name: f.name, region: f.region, ownerEmail: f.ownerEmail, locale: f.locale } }));
action('invite', (f) => ({ path: 'tenants/' + f.tenantId + '/invite', method: 'POST', payload: { email: f.email } }));
action('ack', (f) => ({ path: 'alerts/' + f.alertId + '/acknowledge', method: 'POST', payload: { tenantId: f.tenantId } }));
action('skip', (f) => ({ path: 'snapshot-skips/' + f.snapshotId + '/resolve', method: 'POST', payload: { resolution: f.resolution, note: f.note } }));
function render(rows) {
  const grid = $('grid');
  grid.innerHTML = '';
  if (!rows.length) { $('status').textContent = 'nothing here — and that is an answer, not an error'; return; }
  const cols = Object.keys(rows[0]);
  const head = grid.insertRow();
  for (const c of cols) { const th = document.createElement('th'); th.textContent = c; head.append(th); }
  for (const row of rows) {
    const tr = grid.insertRow();
    for (const c of cols) {
      const td = tr.insertCell();
      const v = row[c];
      td.textContent = v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      if ((c === 'lag_level' || c === 'last_outcome') && v && v !== 'OK' && v !== 'SUCCESS') td.className = 'bad';
      if (c === 'delivered_at') td.className = v ? 'ok' : 'bad';
    }
  }
  $('status').textContent = rows.length + ' rows';
}
async function load() {
  try {
    $('status').textContent = 'loading ' + screen + '…';
    const body = await call(screen === 'alerts' || screen === 'snapshot-skips' ? screen + '?limit=200' : screen);
    render(body[KEYS[screen]] || []);
  } catch (e) { $('status').textContent = 'error: ' + e.message; $('grid').innerHTML = ''; }
}
$('signin').onclick = async () => {
  token = $('token').value.trim();
  try {
    const s = await call('session');
    $('who').textContent = s.displayName + (s.secondFactor ? ' · second factor present' : ' · NO second factor: actions will be refused');
    $('actions').hidden = false;
    await load();
  } catch (e) { $('who').textContent = 'sign-in refused: ' + e.message; }
};
for (const b of document.querySelectorAll('nav button')) b.onclick = () => {
  for (const other of document.querySelectorAll('nav button')) other.setAttribute('aria-current', String(other === b));
  screen = b.dataset.screen; void load();
};
</script></body></html>`;
