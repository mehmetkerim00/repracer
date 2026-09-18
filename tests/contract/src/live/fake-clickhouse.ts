import { createServer, type Server } from 'node:http';

/**
 * Р-130 (шаг 27): модель аналитического слоя по протоколу ClickHouse HTTP — чтобы выгрузка [Р-122] исполнялась в живом прогоне там, где
 * настоящего ClickHouse нет (локальная машина). Модель понимает ровно то, что шлёт `ClickHouseHttp`: вставку `FORMAT JSONEachRow` с
 * токеном дедупликации и запросы `SELECT count() … FROM <таблица> [FINAL] WHERE …`. Всё остальное — ответ 400: модель не притворяется
 * базой. Настоящий ClickHouse проверяется в CI (history-survives-stop, clickhouse-export). Данные синтетические.
 */
export interface FakeClickHouse {
  server: Server;
  url: string;
  /** Строки по таблицам в порядке вставки */
  rows: Map<string, Array<Record<string, unknown>>>;
  /** Отказывать на любые запросы: модель «ClickHouse недоступен» */
  down: boolean;
  /** Отказывать вставке, в теле которой встречается эта строка: модель «часть данных слой не принял» (отказ на одних сутках) */
  rejectInsertsContaining: string | null;
  /** Запросы, которые модель не поняла: расхождение модели с выгрузкой не должно выглядеть отказом ClickHouse */
  unknown: string[];
  requests: { inserts: number; queries: number };
  /** Повторить последнюю вставку тем же токеном — как повторная попытка выгрузки: окно дедупликации данные не удваивает (050) */
  replayLastInsert(): Promise<void>;
  close(): Promise<void>;
}

const parseTime = (raw: string): number => Date.parse(raw.endsWith('Z') || raw.includes('+') ? raw : `${raw.replace(' ', 'T')}Z`);

/** Условия, которые шлёт выгрузка: равенство строке, диапазон по времени и вхождение в список идентификаторов */
function matches(row: Record<string, unknown>, where: string): boolean {
  const value = (column: string) => String(row[column] ?? '');
  for (const match of where.matchAll(/(\w+)\s*=\s*'([^']*)'/g)) {
    if (value(match[1]!) !== match[2]!) return false;
  }
  for (const match of where.matchAll(/(\w+)\s*(>=|<)\s*parseDateTime64BestEffort\('([^']+)'/g)) {
    const [, column, op, raw] = match as unknown as [string, string, string, string];
    const at = parseTime(String(row[column] ?? ''));
    const bound = parseTime(raw);
    if (op === '>=' ? !(at >= bound) : !(at < bound)) return false;
  }
  const list = /(\w+)\s+IN\s*\(([^)]*)\)/i.exec(where);
  if (list) {
    const ids = new Set(list[2]!.split(',').map((s) => s.trim().replace(/^'|'$/g, '')));
    if (!ids.has(value(list[1]!))) return false;
  }
  return true;
}

export async function startFakeClickHouse(): Promise<FakeClickHouse> {
  const state = { rows: new Map<string, Array<Record<string, unknown>>>(), down: false, rejectInsertsContaining: null as string | null, requests: { inserts: 0, queries: 0 }, unknown: [] as string[] };
  const seenTokens = new Set<string>();
  let lastInsert: { url: string; body: string } | null = null;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const params = new URL(req.url ?? '/', 'http://fake').searchParams;
      const fail = (code: number, message: string) => res.writeHead(code, { 'content-type': 'text/plain' }).end(message);
      if (state.down) { fail(503, 'CLICKHOUSE_UNAVAILABLE: synthetic outage'); return; }
      const insert = /^INSERT INTO ([\w.]+) FORMAT JSONEachRow$/.exec(params.get('query') ?? '');
      if (insert) {
        state.requests.inserts += 1;
        // Слой не принял часть: столько же кодов ошибки, сколько у недоступности, но остальные части проходят
        if (state.rejectInsertsContaining && body.includes(state.rejectInsertsContaining)) {
          fail(500, 'CLICKHOUSE_INSERT_REJECTED: synthetic rejection of this part');
          return;
        }
        lastInsert = { url: req.url ?? '/', body };
        const token = params.get('insert_deduplication_token');
        // Окно дедупликации таблицы: повтор той же части с тем же токеном данные не удваивает (050)
        if (token && seenTokens.has(token)) { res.writeHead(200).end(''); return; }
        if (token) seenTokens.add(token);
        const table = state.rows.get(insert[1]!) ?? [];
        for (const line of body.split('\n').filter(Boolean)) table.push(JSON.parse(line) as Record<string, unknown>);
        state.rows.set(insert[1]!, table);
        res.writeHead(200).end('');
        return;
      }
      const count = /^SELECT\s+count\(\)\s+AS\s+n\s+FROM\s+([\w.]+)(?:\s+FINAL)?\s*(?:WHERE\s+([\s\S]*?))?\s*FORMAT JSONEachRow$/i.exec(body.trim());
      if (count) {
        state.requests.queries += 1;
        const table = state.rows.get(count[1]!) ?? [];
        const where = count[2] ?? '';
        const n = where ? table.filter((r) => matches(r, where)).length : table.length;
        res.writeHead(200, { 'content-type': 'application/x-ndjson' }).end(`${JSON.stringify({ n })}\n`);
        return;
      }
      // Модель не притворяется базой: незнакомый запрос — отказ, а не пустой ответ. Проверка обязана это заметить: расхождение модели
      // с выгрузкой выглядело бы отказом ClickHouse (ревью шага 27, находка 7)
      state.unknown.push(`${params.get('query') ?? ''} ${body.trim()}`.slice(0, 300));
      fail(400, `fake ClickHouse does not model this query: ${body.trim().slice(0, 200)}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    server, url: `http://127.0.0.1:${port}`, rows: state.rows, requests: state.requests, unknown: state.unknown,
    get rejectInsertsContaining() { return state.rejectInsertsContaining; },
    set rejectInsertsContaining(v: string | null) { state.rejectInsertsContaining = v; },
    async replayLastInsert() {
      if (!lastInsert) throw new Error('no insert to replay');
      const response = await fetch(`http://127.0.0.1:${port}${lastInsert.url}`, { method: 'POST', body: lastInsert.body });
      if (!response.ok) throw new Error(`replay failed: ${response.status}`);
    },
    get down() { return state.down; },
    set down(v: boolean) { state.down = v; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  } as FakeClickHouse;
}
