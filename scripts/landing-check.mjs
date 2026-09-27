#!/usr/bin/env node
// Р-184, Р-185 (шаг 46): проверка лендинга. Два режима:
//   node scripts/landing-check.mjs                         — файлы apps/landing (тест сборки scripts/test/landing.test.ts)
//   node scripts/landing-check.mjs http://127.0.0.1:8080 localhost — то же, но страницы берутся ЧЕРЕЗ ПРОКСИ (подъём
//                                                           профиля production в CI), с заголовком Host домена лендинга
// Правила текста — из Р-185, и каждое проверяется поведением страницы, а не обещанием в комментарии.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const LANDING_DIR = fileURLToPath(new URL('../apps/landing/', import.meta.url));
/** Страницы и их язык: обе версии полные [Р-184] */
export const PAGES = { '/': 'en', '/de/': 'de' };
/** Адреса, которые не файлы, а перенаправления прокси (deploy/production/snippets.caddy) — и куда они ведут без настройки */
export const REDIRECTS = { '/demo': '/#demo-soon', '/de/demo': '/de/#demo-soon', '/contact': '/#contact-soon', '/de/contact': '/de/#contact-soon' };
/**
 * Числа, которые у нас ЕСТЬ [Р-185], — только в своих фразах и только на своей странице (находка 5 ревью шага 46: список
 * чисел без фраз пропускал «30% more revenue in 4 weeks» и «644 cases» на английской странице). Число вне этих фраз —
 * нарушение; «тысячи» словами — тоже, кроме тарифа.
 */
export const ALLOWED_PHRASES = {
  en: ['€39', '€89', '30 days', 'thousands of SKUs'],
  de: ['39 €', '89 €', '30 Tage', 'letzten 30 Tage', '§ 11 PAngV', '644 Fälle allein 2025 (+11,6 %)', 'der BGH hat 2025', '30-Tage-Bestpreis',
    'Az. 4 HK O 13950/24', 'Nr. 184/2025', 'Jahresbericht 2025', 'Endurteil vom 14.07.2025, 4 HK O 13950/24', 'mehreren Tausend SKUs'],
};
/**
 * Факты Omnibus — предложение владельца ДОСЛОВНО (решение по лендингу после шага 46) и источники ссылками. Внешняя ссылка
 * разрешена только так: тег `<a>`, немецкая страница, один из трёх источников. Ресурсы (стили, картинки) — нет никогда.
 */
export const OMNIBUS_SENTENCE = 'Preiswerbung wird aktiv abgemahnt: 644 Fälle allein 2025 (+11,6 %), und der BGH hat 2025 entschieden, dass der 30-Tage-Bestpreis klar genannt werden muss — auch Amazon verlor dazu vor dem LG München I (Az. 4 HK O 13950/24).';
export const SOURCE_LINKS = [
  'https://www.bundesgerichtshof.de/SharedDocs/Pressemitteilungen/DE/2025/2025184.html',
  'https://www.wettbewerbszentrale.de/jahresbericht-2025-mehr-klagen-und-ein-neuer-name/',
  'https://www.gesetze-bayern.de/Content/Document/Y-300-Z-GRURRS-B-2025-N-17142',
];
/** Единственная допустимая фраза со словом «гарантия» — оговорка, что её НЕТ */
const DISCLAIMER = 'keine Garantie der Rechtskonformität';
const MAX_PAGE_BYTES = 20_000;
const MAX_CSS_BYTES = 5_000;

const fileOf = (path) => join(LANDING_DIR, path.endsWith('/') ? `${path}index.html` : path);
/**
 * Текст страницы, который видит человек или поисковик: тело, `<title>` и значения `content`/`alt`/`aria-label`/`title`
 * (находка 5 ревью шага 46: `<head>` вырезался, и «AI» в заголовке проходил)
 */
const textOf = (html) => {
  // `content` — только у описания (у viewport там «initial-scale=1», это не текст страницы)
  const description = [...html.matchAll(/<meta\b[^>]*\bname\s*=\s*["']?description["']?[^>]*>/gi)].map((m) => m[0]).join(' ');
  const attrs = [...`${html.replace(/<meta\b[^>]*>/gi, ' ')} ${description}`.matchAll(/\s(?:content|alt|aria-label|title)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)]
    .map((m) => m[1] ?? m[2]).join(' ');
  const body = html.replace(/<(?:link|meta)\b[^>]*>/gi, ' ').replace(/<[^>]+>/g, ' ');
  return `${body} ${attrs}`.replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ');
};
/** Все ссылочные атрибуты с любыми кавычками и без них */
const refsOf = (html) => [...html.matchAll(/\s(src|href|action|srcset|poster|data|formaction)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)]
  .map((m) => ({ attr: m[1].toLowerCase(), ref: m[2] ?? m[3] ?? m[4], at: m.index }));
const idsOf = (html) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const sectionIdsOf = (html) => [...html.matchAll(/<section id="([^"]+)"/g)].map((m) => m[1]);

/** Проблемы набора страниц: пусто — всё верно. `pages` — путь → HTML, `css` — текст таблицы стилей */
export function landingProblems(pages, css) {
  const problems = [];
  const bad = (what) => problems.push(what);
  for (const [path, lang] of Object.entries(PAGES)) {
    const html = pages[path];
    if (!html) { bad(`${path}: страницы нет`); continue; }
    if (!html.includes(`<html lang="${lang}">`)) bad(`${path}: язык страницы не ${lang}`);
    if (Buffer.byteLength(html) > MAX_PAGE_BYTES) bad(`${path}: страница больше ${MAX_PAGE_BYTES} байт — на телефоне это медленно`);
    // Самодостаточность: ни скриптов, ни ресурсов с чужих адресов, ни картинок (логотипов клиентов у нас нет)
    if (/<script|<iframe|<img|<object|<embed|<picture|<video|<audio|<svg/i.test(html)) bad(`${path}: скрипт, фрейм или картинка на странице`);
    // Стили — только файлом: встроенный стиль прячет url(...) от проверки ресурсов и нарушил бы политику содержимого
    if (/<style|\sstyle\s*=/i.test(html)) bad(`${path}: встроенный стиль`);
    for (const { attr, ref, at } of refsOf(html)) {
      if (attr === 'srcset' || attr === 'poster' || attr === 'data' || attr === 'formaction' || attr === 'action') { bad(`${path}: атрибут ${attr}`); continue; }
      if (/^(?:[a-z]+:)?\/\//i.test(ref)) {
        // Тег, в котором стоит адрес: внешняя ССЫЛКА на источник — да, внешний РЕСУРС — нет
        // Тег — по позиции ЭТОГО атрибута, а не первого вхождения адреса: ресурс после ссылки с тем же адресом не проходит
        const tag = html.slice(html.lastIndexOf('<', at), at);
        if (!(lang === 'de' && attr === 'href' && /^<a(?:\s|$)/i.test(tag) && SOURCE_LINKS.includes(ref))) bad(`${path}: внешний адрес ${ref}`);
      }
      else if (ref.startsWith('data:')) { if (!ref.startsWith('data:image/svg+xml,')) bad(`${path}: встроенный ресурс ${ref.slice(0, 30)}`); }
      else if (ref.startsWith('#')) { if (!idsOf(html).has(ref.slice(1))) bad(`${path}: якорь ${ref} не найден`); }
      else if (ref.startsWith('/')) {
        const [target, anchor] = ref.split('#');
        const redirect = REDIRECTS[target];
        if (redirect) {
          const [page, id] = redirect.split('#');
          if (!pages[page] || !idsOf(pages[page]).has(id)) bad(`${path}: ${ref} ведёт на ${redirect}, а блока там нет`);
        } else if (target in PAGES) {
          if (anchor && !idsOf(pages[target] ?? '').has(anchor)) bad(`${path}: якорь ${ref} не найден`);
        } else if (target !== '/site.css') bad(`${path}: ссылка ${ref} ведёт в никуда`);
      } else if (!ref.startsWith('mailto:')) bad(`${path}: относительная ссылка ${ref} — только абсолютные пути сайта`);
    }
    const text = textOf(html);
    // Р-185: слова «AI» нет (и «A.I.», и немецкого «KI»)
    if (/\bAI\b|\bA\.I\.|\bKI\b|artificial intelligence|künstliche Intelligenz/i.test(text)) bad(`${path}: слово AI/KI`);
    // Никаких отзывов, логотипов и чисел, которых у нас нет
    if (/testimonial|trusted by|our customers say|Kundenstimmen|vertrauen uns|Kunden sagen/i.test(text)) bad(`${path}: отзывы или «нам доверяют»`);
    let rest = text;
    for (const phrase of ALLOWED_PHRASES[lang]) rest = rest.split(phrase).join(' ');
    for (const n of rest.match(/\d+/g) ?? []) bad(`${path}: число ${n}, которого у нас нет`);
    if (/\b(?:hundreds|thousands|dozens|Hunderte|Tausende|Dutzende)\b/i.test(rest)) bad(`${path}: количество словами, которого у нас нет`);
    // Гарантии нет нигде, кроме оговорки «гарантии нет» [Р-185]
    if (/guarant|garant/i.test(text.split(DISCLAIMER).join(' '))) bad(`${path}: обещание гарантии`);
    // Внутреннее в публичном: кириллица и номера решений — только в репозитории (находка 13 ревью шага 46)
    if (/[А-Яа-яЁё]|Р-\d/.test(html)) bad(`${path}: внутренний текст (кириллица или номер решения)`);
    // Честный статус и тарифы — на обеих страницах
    if (!/design.partner/i.test(text)) bad(`${path}: нет статуса «ищем design-партнёров»`);
    for (const need of lang === 'en'
      ? ['€39 per month, excl. VAT/sales tax', '€89 per month, excl. VAT/sales tax', '30 days', 'no card', 'no surcharge per marketplace']
      : ['39 € pro Monat, zzgl. USt.', '89 € pro Monat, zzgl. USt.', '30 Tage', 'ohne Karte', 'kein Aufpreis je Marktplatz']) {
      if (!text.includes(need)) bad(`${path}: в тарифах нет «${need}»`);
    }
    // Детерминизм, который продаём: пол из себестоимости, «почему эта цена», три стоп-крана, тень
    for (const need of lang === 'en' ? ['floor', 'Why this price', 'Three stop switches', 'Shadow mode'] : ['Untergrenze', 'Warum dieser Preis', 'Drei Stoppschalter', 'Schattenmodus']) {
      if (!text.includes(need)) bad(`${path}: нет блока «${need}»`);
    }
  }
  const en = pages['/'] ?? '';
  const de = pages['/de/'] ?? '';
  // Omnibus — ТОЛЬКО на немецкой странице [Р-185]
  if (/Omnibus|PAngV|BGH|13950/.test(textOf(en))) bad('/: блок Omnibus на английской странице');
  const deText = textOf(de);
  for (const link of SOURCE_LINKS) if (!de.includes(`href="${link}"`)) bad(`/de/: нет источника ${link}`);
  for (const fact of [OMNIBUS_SENTENCE, 'Nachweis', DISCLAIMER]) {
    if (!deText.includes(fact)) bad(`/de/: в блоке Omnibus нет «${fact}»`);
  }
  // Обе версии полные: те же разделы, кроме немецкого Omnibus
  const enSections = sectionIdsOf(en).join(',');
  const deSections = sectionIdsOf(de).filter((id) => id !== 'omnibus').join(',');
  if (enSections !== deSections) bad(`разделы версий расходятся: en [${enSections}] / de [${deSections}]`);
  if (css === undefined) bad('/site.css: таблицы стилей нет');
  else {
    if (Buffer.byteLength(css) > MAX_CSS_BYTES) bad(`/site.css больше ${MAX_CSS_BYTES} байт`);
    if (/@import|url\(/i.test(css)) bad('/site.css: внешний ресурс в стилях');
    if (/[А-Яа-яЁё]|Р-\d/.test(css)) bad('/site.css: внутренний текст (кириллица или номер решения)');
  }
  return problems;
}

export function readLanding() {
  const pages = {};
  for (const path of Object.keys(PAGES)) if (existsSync(fileOf(path))) pages[path] = readFileSync(fileOf(path), 'utf8');
  const css = existsSync(fileOf('/site.css')) && statSync(fileOf('/site.css')).isFile() ? readFileSync(fileOf('/site.css'), 'utf8') : undefined;
  return { pages, css };
}

/** GET через прокси с заголовком Host домена (fetch Host не меняет — node:http меняет) */
function get(base, host, path) {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET', headers: { host } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Через прокси: страницы — те же байты, что в репозитории, перенаправления «скоро», 404 на чужое, политика содержимого */
export async function landingProblemsOverHttp(base, host) {
  const problems = [];
  const local = readLanding();
  const pages = {};
  for (const path of Object.keys(PAGES)) {
    const r = await get(base, host, path);
    if (r.status !== 200) { problems.push(`${path}: ответ ${r.status}`); continue; }
    if (r.body !== local.pages[path]) problems.push(`${path}: прокси отдаёт не файл репозитория`);
    if (!/default-src 'none'/.test(String(r.headers['content-security-policy'] ?? ''))) problems.push(`${path}: нет политики содержимого`);
    pages[path] = r.body;
  }
  const css = await get(base, host, '/site.css');
  if (css.status !== 200 || !/text\/css/.test(String(css.headers['content-type']))) problems.push(`/site.css: ${css.status} ${css.headers['content-type']}`);
  problems.push(...landingProblems(pages, css.status === 200 ? css.body : undefined));
  for (const [from, to] of Object.entries(REDIRECTS)) {
    const r = await get(base, host, from);
    if (r.status !== 302 || r.headers.location !== to) problems.push(`${from}: ${r.status} → ${r.headers.location} (ждали 302 → ${to})`);
  }
  const missing = await get(base, host, '/robots-and-nothing-else.txt');
  if (missing.status !== 404) problems.push(`несуществующий адрес: ${missing.status}, а не 404`);
  // Лендинг — не консоль: API консоли на домене лендинга не отвечает
  const api = await get(base, host, '/api/session');
  if (api.status !== 404) problems.push(`/api/session на домене лендинга: ${api.status}, а не 404`);
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [base, host] = process.argv.slice(2);
  const problems = base ? await landingProblemsOverHttp(base, host ?? 'localhost') : (() => { const l = readLanding(); return landingProblems(l.pages, l.css); })();
  if (problems.length > 0) {
    for (const p of problems) console.error(`   landing: ${p}`);
    process.exit(1);
  }
  console.log(`   landing: ${Object.keys(PAGES).length} страницы ${base ? 'через прокси ' : ''}верны (Р-184, Р-185)`);
}
