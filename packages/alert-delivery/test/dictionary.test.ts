import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { messagesFor } from '@repracer/console-model';

/**
 * Р-161, часть 2. До шага 37 текст письма был у шести кодов из полусотни, и событие без текста приходило продавцу как
 * «Ereignis PRICE_WRITE_DISPATCH_ERROR» — то есть письмом ни о чём. Разовая правка словаря это не держит: следующий
 * алерт снова заведут без текста. Поэтому правило [Р-146]: КАЖДЫЙ код, который поднимает код репозитория, обязан иметь
 * текст на обоих языках, и наоборот — текст без события в коде запрещён, чтобы словарь не наполнялся выдуманными
 * событиями.
 *
 * Детектор ищет ровно те формы, которыми алерт поднимается на самом деле, и у каждой есть положительный контроль ниже:
 * правило, которое ничего не находит, зеленеет всегда [Р-94].
 */

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

/** Формы, в которых алерт поднимается: прямой вызов приёмника, побочное действие пути решения, помощники процессов */
const FORMS: readonly RegExp[] = [
  // alerts.raise({ code: 'X', severity: … })
  /raise\(\{[\s\S]{0,300}?\bcode:\s*'([A-Z][A-Z0-9_]+)'/g,
  // effects.push({ kind: 'alert', code: 'X', … })
  /\bkind:\s*'alert',\s*code:\s*'([A-Z][A-Z0-9_]+)'/g,
  // alert(tenantId, 'X', 'CRITICAL', …) — помощник диспетчера
  /\balert\(\s*[A-Za-z][A-Za-z0-9_.]*\s*,\s*'([A-Z][A-Z0-9_]+)'\s*,\s*'(?:WARNING|CRITICAL)'/g,
  // alert('X', 'CRITICAL', …) — помощник приёмника уведомлений
  /\balert\(\s*'([A-Z][A-Z0-9_]+)'\s*,\s*'(?:WARNING|CRITICAL)'/g,
  // { code: 'X', severity: 'CRITICAL' } — алерт работы планировщика и алерт решения Gate
  /\{\s*code:\s*'([A-Z][A-Z0-9_]+)',\s*severity:\s*(?:'(?:WARNING|CRITICAL)'|[A-Za-z][^,]{0,80}\?)/g,
];

/** Тот же список форм, но код выбирается условием: `code: mismatch ? 'A' : 'B'` — обе ветви поднимают алерт */
const BRANCHED: readonly RegExp[] = [
  /raise\(\{[\s\S]{0,300}?\bcode:[^,\n]*\?\s*'([A-Z][A-Z0-9_]+)'\s*:\s*'([A-Z][A-Z0-9_]+)'/g,
  /\bkind:\s*'alert',\s*code:[^,\n]*\?\s*'([A-Z][A-Z0-9_]+)'\s*:\s*'([A-Z][A-Z0-9_]+)'/g,
];

/** Коды, поднимаемые исходным текстом: тесты и фикстуры не в счёт — там коды выдуманные по условию сценария */
function raisedInSource(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'test') continue;
        walk(path);
        continue;
      }
      if (!path.endsWith('.ts') || path.endsWith('.test.ts')) continue;
      const source = readFileSync(path, 'utf8');
      for (const form of [...FORMS, ...BRANCHED]) {
        form.lastIndex = 0;
        for (let m = form.exec(source); m; m = form.exec(source)) {
          for (const code of [m[1], m[2]]) {
            if (!code) continue;
            found.set(code, [...(found.get(code) ?? []), path.slice(ROOT.length + 1)]);
          }
        }
      }
    }
  };
  /**
   * Шаг 38 (находка 7 ревью шага 37): обход захватывает и `apps/`. С шага 37 консоль — разворачиваемый процесс [Р-159],
   * и алерт, поднятый из неё, правило не видело: «у каждого события есть текст» было бы ложным молча.
   */
  for (const root of ['packages', 'services', 'apps']) walk(join(ROOT, root));
  return found;
}

const de = messagesFor('de').ui.alerts.codes as Record<string, { what: string; step: string } | undefined>;
const en = messagesFor('en').ui.alerts.codes as Record<string, { what: string; step: string } | undefined>;

test('Р-161: у каждого события, которое поднимает код репозитория, есть текст письма', () => {
  const raised = raisedInSource();
  // Положительный контроль детектора: без него правило зеленело бы и на пустом наборе
  assert.ok(raised.size > 30, `детектор нашёл слишком мало событий, значит он сломан: ${raised.size}`);
  assert.ok(raised.has('PRICING_STOPPED_BY_PERSON') && raised.has('SCHEDULER_JOB_LAGGING') && raised.has('AMAZON_TENANT_MISMATCH'),
    `детектор обязан находить все три формы — прямой вызов, помощник процесса и код из условия: ${[...raised.keys()].join(', ')}`);

  const withoutText = [...raised.keys()].filter((code) => !de[code] || !en[code]).sort();
  assert.deepEqual(withoutText, [], `событие без текста приходит письмом «Ereignis CODE»: ${withoutText.join(', ')}`);
});

test('Р-161: словарь не содержит выдуманных событий — у каждого текста есть место, где его поднимают', () => {
  const raised = raisedInSource();
  const invented = Object.keys(en).filter((code) => !raised.has(code)).sort();
  assert.deepEqual(invented, [], `текст события, которого никто не поднимает: ${invented.join(', ')}`);
});

test('Р-161: английский текст события — перевод, а не немецкая копия', () => {
  const codes = Object.keys(en).sort();
  assert.ok(codes.length > 30, `словарь обязан покрывать все события, а не горстку: ${codes.length}`);
  for (const code of codes) {
    const d = de[code]!;
    const e = en[code]!;
    // Пустой текст хуже кода: он ничего не говорит и прячет код
    for (const [lang, text] of [['de', d], ['en', e]] as const) {
      assert.ok(text.what.trim().length > 10, `${code}/${lang}: «что случилось» не написано`);
      assert.ok(text.step.trim().length > 20, `${code}/${lang}: первое действие не написано`);
      assert.ok(!text.what.includes(code), `${code}/${lang}: текст пересказывает код вместо события`);
    }
    // Копия немецкого в английском словаре — то же самое немецкое письмо, только с английским подзаголовком
    assert.notEqual(e.what, d.what, `${code}: английский текст — копия немецкого`);
    assert.notEqual(e.step, d.step, `${code}: английское первое действие — копия немецкого`);
  }
});

test('Р-161: события ПЛАТФОРМЫ написаны голосом оператора, а не продавца [находка 3 ревью шага 36]', () => {
  /**
   * Получатель платформенного события — оператор (`PgAlertSink` кладёт алерт без тенанта платформенному тенанту,
   * доставка адресует его `operatorEmail`). Проверяется именно это: у оператора нет ни консоли продавца, ни
   * кабинета канала, и совет «от вас пока ничего не требуется, мы тоже это видим» адресован ему же самому.
   */
  const platform = ['ANALYTICS_EXPORT_BACKLOG', 'ANALYTICS_EXPORT_FAILED', 'ANALYTICS_EXPORT_UNVERIFIED', 'ANALYTICS_EXPORT_PARTITION_MISSING',
    'ANALYTICS_PARTITION_FORCE_DROPPED', 'COMPETITOR_POLL_BUDGET_EXCEEDED', 'COMPETITOR_POLL_FAILURES', 'AMAZON_RECONCILIATION_CIRCLE_SLOW',
    'SCHEDULER_JOB_FAILING', 'SCHEDULER_JOB_LAGGING', 'SCHEDULER_LEASE_LOST', 'BROKER_MESSAGE_POISONED', 'OUTBOX_SCOPE_SEQ_GAP_RELEASED',
    'WRITE_DISPATCH_SWEEP_FAILED', 'NOTIFICATION_QUEUE_SILENT', 'NOTIFICATION_UNPARSEABLE', 'NOTIFICATION_UNKNOWN_SELLER',
    'NOTIFICATION_FOREIGN_APPLICATION', 'NOTIFICATION_GIVING_UP', 'ALERT_NOT_STORED'];
  // Обороты продавца: «от вас ничего не требуется», «сообщите нам», «откройте консоль», «ваш кабинет канала»
  const sellerVoiceDe = /Von Ihnen ist|sagen Sie uns|melden Sie sich bei uns|Melden Sie sich|Öffnen Sie die Konsole|Kanal-Konto/;
  const sellerVoiceEn = /nothing is to be done by you|No action from you|contact us|tell us|Open the console|channel cabinet/i;
  for (const code of platform) {
    assert.ok(de[code] && en[code], `платформенное событие без текста: ${code}`);
    assert.ok(!sellerVoiceDe.test(de[code]!.step), `${code}/de: первое действие написано голосом продавца: ${de[code]!.step}`);
    assert.ok(!sellerVoiceEn.test(en[code]!.step), `${code}/en: первое действие написано голосом продавца: ${en[code]!.step}`);
  }
  // Положительный контроль: те же обороты у события ПРОДАВЦА на месте, иначе правило ловило бы пустоту
  assert.ok(sellerVoiceDe.test(de.PRICING_STOPPED_BY_PERSON!.step) || sellerVoiceDe.test(de.PRICE_WRITE_SCOPE_BLOCKED!.step),
    'правило обязано узнавать голос продавца там, где он уместен');
  assert.ok(sellerVoiceEn.test(en.PRICE_WRITE_SCOPE_BLOCKED!.step), 'то же по-английски');
});
