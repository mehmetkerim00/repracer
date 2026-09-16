/**
 * HTTP-интерфейс ClickHouse без клиентской библиотеки: запрос — POST, вставка — JSONEachRow. Учётные данные — заголовками,
 * не в URL (URL попадает в журналы). Настройки запроса — параметрами URL.
 */

export interface ClickHouseConfig {
  url: string;
  user: string;
  password: string;
}

export class ClickHouseError extends Error {}

export class ClickHouseHttp {
  private readonly config: ClickHouseConfig;

  constructor(config: ClickHouseConfig) {
    this.config = config;
  }

  private endpoint(settings: Record<string, string | number>): string {
    const params = new URLSearchParams(Object.entries(settings).map(([k, v]): [string, string] => [k, String(v)]));
    const q = params.toString();
    return `${this.config.url.replace(/\/$/, '')}/${q ? `?${q}` : ''}`;
  }

  async query(sql: string, settings: Record<string, string | number> = {}): Promise<string> {
    const response = await fetch(this.endpoint(settings), {
      method: 'POST',
      headers: { 'X-ClickHouse-User': this.config.user, 'X-ClickHouse-Key': this.config.password },
      body: sql,
    });
    const body = await response.text();
    if (!response.ok) throw new ClickHouseError(`ClickHouse ${response.status}: ${body.trim().slice(0, 500)}`);
    return body;
  }

  async rows<T = Record<string, unknown>>(sql: string, settings: Record<string, string | number> = {}): Promise<T[]> {
    const body = await this.query(`${sql} FORMAT JSONEachRow`, { output_format_json_quote_64bit_integers: 0, ...settings });
    return body.split('\n').filter(Boolean).map((line) => JSON.parse(line) as T);
  }

  /** Вставка строк; deduplicationToken — повтор той же части не удваивает данные (окно дедупликации таблицы, 050) */
  async insert(table: string, rows: readonly object[], deduplicationToken?: string): Promise<void> {
    if (rows.length === 0) return;
    const settings: Record<string, string | number> = {
      query: `INSERT INTO ${table} FORMAT JSONEachRow`,
      date_time_input_format: 'best_effort',
      input_format_null_as_default: 0,
      // Экспорт ждёт фиксации части: подтверждение в partition_export не должно опережать данные
      async_insert: 0,
      wait_end_of_query: 1,
    };
    if (deduplicationToken) {
      settings.insert_deduplication_token = deduplicationToken;
      // Шаг 20: повтор той же части не должен второй раз попасть в агрегат через материализованное представление (060, 070)
      settings.deduplicate_blocks_in_dependent_materialized_views = 1;
    }
    const response = await fetch(this.endpoint(settings), {
      method: 'POST',
      headers: { 'X-ClickHouse-User': this.config.user, 'X-ClickHouse-Key': this.config.password },
      body: rows.map((r) => JSON.stringify(r)).join('\n'),
    });
    const body = await response.text();
    if (!response.ok) throw new ClickHouseError(`ClickHouse insert into ${table} ${response.status}: ${body.trim().slice(0, 500)}`);
  }
}
