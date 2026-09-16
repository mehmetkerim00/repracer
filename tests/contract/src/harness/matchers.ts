/**
 * Сопоставление фактического значения с ожидаемым из фикстуры.
 *  - exact: объекты без лишних ключей (запросы к каналу — адаптер не должен отправлять ничего сверх ожидаемого);
 *  - subset: проверяются только перечисленные ключи (результаты порта).
 * Массивы в обоих режимах — той же длины, поэлементно, если не указан оператор.
 *
 * Операторы (объект из одного ключа):
 *   {"$any": true}            любое значение, кроме отсутствующего
 *   {"$absent": true}         ключ отсутствует
 *   {"$type": "string"}       string | number | boolean | object | array | null
 *   {"$regex": "^kfl:"}       строка по регулярному выражению
 *   {"$isoInstant": true}     строка ISO-8601 с датой и временем
 *   {"$contains": [..]}       массив содержит элементы, подходящие под каждый образец
 *   {"$unordered": [..]}      массив той же длины в любом порядке
 *   {"$exact": ..} / {"$subset": ..}  сменить режим для поддерева
 *   {"$gte": n} / {"$lte": n} / {"$gt": n}  число не меньше, не больше, больше (сводки симулятора, шаг 21)
 *   {"$every": образец}       каждый элемент массива подходит под образец (в том числе пустой массив)
 */
export type MatchMode = 'exact' | 'subset';

const OPERATORS = new Set(['$any', '$absent', '$type', '$regex', '$isoInstant', '$contains', '$unordered', '$exact', '$subset', '$gte', '$lte', '$gt', '$every']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function short(v: unknown): string {
  const s = v === undefined ? 'undefined' : JSON.stringify(v);
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
}

function operatorOf(expected: unknown): string | null {
  if (!isPlainObject(expected)) return null;
  const keys = Object.keys(expected);
  return keys.length === 1 && OPERATORS.has(keys[0]!) ? keys[0]! : null;
}

export function match(actual: unknown, expected: unknown, mode: MatchMode, path = '$'): string[] {
  const op = operatorOf(expected);
  if (op) {
    const arg = (expected as Record<string, unknown>)[op];
    switch (op) {
      case '$any':
        return actual === undefined ? [`${path}: expected a value, got nothing`] : [];
      case '$absent':
        return actual === undefined ? [] : [`${path}: expected absent, got ${short(actual)}`];
      case '$type':
        return typeOf(actual) === arg ? [] : [`${path}: expected type ${String(arg)}, got ${typeOf(actual)}`];
      case '$regex':
        return typeof actual === 'string' && new RegExp(String(arg)).test(actual) ? [] : [`${path}: ${short(actual)} does not match /${String(arg)}/`];
      case '$isoInstant':
        return typeof actual === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(actual) && !Number.isNaN(Date.parse(actual))
          ? [] : [`${path}: expected ISO instant, got ${short(actual)}`];
      case '$gte':
        return typeof actual === 'number' && actual >= Number(arg) ? [] : [`${path}: expected ≥ ${String(arg)}, got ${short(actual)}`];
      case '$lte':
        return typeof actual === 'number' && actual <= Number(arg) ? [] : [`${path}: expected ≤ ${String(arg)}, got ${short(actual)}`];
      case '$gt':
        return typeof actual === 'number' && actual > Number(arg) ? [] : [`${path}: expected > ${String(arg)}, got ${short(actual)}`];
      case '$every':
        if (!Array.isArray(actual)) return [`${path}: $every needs an array, got ${typeOf(actual)}`];
        return actual.flatMap((a, i) => match(a, arg, mode, `${path}[${i}]`));
      case '$exact':
        return match(actual, arg, 'exact', path);
      case '$subset':
        return match(actual, arg, 'subset', path);
      case '$contains': {
        if (!Array.isArray(actual) || !Array.isArray(arg)) return [`${path}: $contains needs arrays, got ${typeOf(actual)}`];
        const out: string[] = [];
        arg.forEach((e, i) => {
          if (!actual.some((a) => match(a, e, mode).length === 0)) out.push(`${path}: no element matches $contains[${i}] ${short(e)}`);
        });
        return out;
      }
      case '$unordered': {
        if (!Array.isArray(actual) || !Array.isArray(arg)) return [`${path}: $unordered needs arrays, got ${typeOf(actual)}`];
        if (actual.length !== arg.length) return [`${path}: expected ${arg.length} elements, got ${actual.length}`];
        const used = new Set<number>();
        const out: string[] = [];
        arg.forEach((e, i) => {
          const found = actual.findIndex((a, j) => !used.has(j) && match(a, e, mode).length === 0);
          if (found < 0) out.push(`${path}: no unused element matches $unordered[${i}] ${short(e)}`);
          else used.add(found);
        });
        return out;
      }
    }
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path}: expected array, got ${short(actual)}`];
    if (actual.length !== expected.length) return [`${path}: expected ${expected.length} elements, got ${actual.length} ${short(actual)}`];
    return expected.flatMap((e, i) => match(actual[i], e, mode, `${path}[${i}]`));
  }

  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return [`${path}: expected object, got ${short(actual)}`];
    const out: string[] = [];
    for (const [key, e] of Object.entries(expected)) out.push(...match(actual[key], e, mode, `${path}.${key}`));
    if (mode === 'exact') {
      for (const key of Object.keys(actual)) {
        if (!(key in expected) && actual[key] !== undefined) out.push(`${path}.${key}: unexpected key with ${short(actual[key])}`);
      }
    }
    return out;
  }

  return Object.is(actual, expected) ? [] : [`${path}: expected ${short(expected)}, got ${short(actual)}`];
}
