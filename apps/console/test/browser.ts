import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Шаг 76 (предполётный прогон демо): страница консоли исполняется НАСТОЯЩИМ браузером. Живые прогоны ходят через HTTP API и React
 * не исполняют, поэтому пустую страницу (модуль Node в коде страницы) не видел никто с шага 29. Здесь — безголовый Chrome по
 * протоколу отладки (WebSocket встроен в Node ≥ 22): открыть адрес, нажать кнопку, дождаться текста, собрать исключения страницы и
 * вызовы `console.error`. Зависимостей не добавляет [Р-33].
 */

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];

/** Путь к Chrome: `REPRACER_CHROME` или известные места. Нет — отказ, а не пропуск теста [Р-84] */
export function chromePath(): string {
  const found = [process.env.REPRACER_CHROME, ...CANDIDATES].find((p): p is string => typeof p === 'string' && p !== '' && existsSync(p));
  if (!found) throw new Error(`Chrome is needed to run the console page (set REPRACER_CHROME); looked in: ${CANDIDATES.join(', ')}`);
  return found;
}

export interface Browser {
  open(url: string): Promise<void>;
  /** Текст основной части страницы (как его видит человек) */
  text(): Promise<string>;
  waitText(needle: string | RegExp, timeoutMs?: number): Promise<void>;
  /** Нажать кнопку или ссылку с ровно таким текстом */
  click(label: string, selector?: string): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
  /** Шаг 85: ширина и высота окна страницы (эмуляция устройства CDP) — телефон, планшет, ноутбук, монитор */
  setViewport(width: number, height: number): Promise<void>;
  /** Шаг 93: системная тема устройства (`prefers-color-scheme`) — эмуляцией CDP; null — как у машины прогона */
  setColorScheme(scheme: 'light' | 'dark' | null): Promise<void>;
  /** Шаг 100 (B): настоящее движение мыши в точку окна — состояние :hover, которого синтетическое событие страницы не даёт */
  mouseMove(x: number, y: number): Promise<void>;
  /** Шаг 109: снимок видимой части окна в JPEG — для доказательств шага (смоук пишет их, только когда задан каталог снимков) */
  screenshot(): Promise<Buffer>;
  /** Исключения страницы и вызовы console.error с начала работы */
  errors(): string[];
  close(): Promise<void>;
}

export async function launchBrowser(): Promise<Browser> {
  const profile = mkdtempSync(join(tmpdir(), 'repracer-chrome-'));
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,900', '--no-first-run',
    '--no-default-browser-check', '--disable-gpu', ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []), 'about:blank'];
  // Своя группа процессов: на Linux помощники Chrome (zygote, crashpad) переживают сам браузер и пишут в профиль — закрытие гасит
  // группу целиком (CI шага 76: удаление профиля падало после зелёного теста, стенд оставался открытым, и задание висело до срока)
  const chrome: ChildProcess = spawn(chromePath(), args, { stdio: 'ignore', detached: process.platform !== 'win32' });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Порт отладки Chrome пишет в профиль, когда готов
  let port = 0;
  for (let i = 0; i < 300 && port === 0; i++) {
    const file = join(profile, 'DevToolsActivePort');
    if (existsSync(file)) port = Number(readFileSync(file, 'utf8').split('\n')[0]);
    if (port === 0) await sleep(100);
  }
  if (port === 0) { chrome.kill(); throw new Error('Chrome did not open its debugging port within 30 s'); }
  let pageUrl: string | null = null;
  for (let i = 0; i < 100 && pageUrl === null; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
      pageUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? null;
    } catch { /* ещё не готов */ }
    if (pageUrl === null) await sleep(100);
  }
  if (pageUrl === null) { chrome.kill(); throw new Error('Chrome has no page to drive'); }
  const ws = new WebSocket(pageUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let seq = 0;
  const pending = new Map<number, (m: { result?: Record<string, unknown> }) => void>();
  const errors: string[] = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data)) as { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> };
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params!.exceptionDetails as { text: string; exception?: { description?: string } };
      errors.push(d.exception?.description ?? d.text);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params!.type === 'error') {
      errors.push((m.params!.args as { value?: unknown; description?: string }[]).map((a) => String(a.value ?? a.description)).join(' '));
    }
  });
  // Шаг 85: у команды срок — ответ, не пришедший за минуту (страница перезагрузилась посреди вычисления, браузер завис), — отказ с
  // именем команды, а не тест, висящий до срока задания CI
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<{ result?: Record<string, unknown> }>((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Chrome did not answer ${method} within 60 s`)); }, 60_000);
      pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send('Page.enable');
  await send('Runtime.enable');

  const evaluate = async <T>(expression: string): Promise<T> => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const result = r.result as { result?: { value?: T }; exceptionDetails?: { text: string } } | undefined;
    if (result?.exceptionDetails) throw new Error(`evaluate: ${result.exceptionDetails.text}`);
    return result?.result?.value as T;
  };
  const text = () => evaluate<string>('(document.querySelector("main") ?? document.body).innerText');
  return {
    async open(url) { await send('Page.navigate', { url }); },
    async setViewport(width, height) { await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); },
    async mouseMove(x, y) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); },
    async setColorScheme(scheme) { await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme ?? '' }] }); },
    async screenshot() {
      const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
      return Buffer.from(String((r.result as { data?: string } | undefined)?.data ?? ''), 'base64');
    },
    text,
    async waitText(needle, timeoutMs = 60_000) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const t = await text().catch(() => '');
        if (typeof needle === 'string' ? t.includes(needle) : needle.test(t)) return;
        await sleep(100);
      }
      throw new Error(`the page did not show «${String(needle)}»; it shows: ${(await text().catch(() => '')).slice(0, 400)}; page errors: ${errors.join(' | ')}`);
    },
    async click(label, selector = 'button, a') {
      // Шаг 84: кнопка с доступным именем (aria-label) — по нему, как её назвал бы экранный чтец: строка роли на входе называет роль и её права
      const ok = await evaluate<boolean>(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim() === ${JSON.stringify(label)} || e.getAttribute('aria-label') === ${JSON.stringify(label)});
        if (!el) return false; el.click(); return true; })()`);
      if (!ok) throw new Error(`nothing to click with the text «${label}»`);
    },
    evaluate,
    errors: () => [...errors],
    async close() {
      try { ws.close(); } catch { /* уже закрыт */ }
      const exited = new Promise((r) => (chrome.exitCode !== null || chrome.signalCode !== null ? r(null) : chrome.once('exit', r)));
      try { process.kill(-chrome.pid!, 'SIGKILL'); } catch { chrome.kill('SIGKILL'); }
      await Promise.race([exited, sleep(10_000)]);
      // Временный профиль: остаток в каталоге временных файлов — не результат теста, поэтому повторы и без отказа
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* остаётся во временном каталоге */ }
    },
  };
}
