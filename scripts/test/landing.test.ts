import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error — модуль .mjs без объявлений типов
import { landingProblems, readLanding } from '../landing-check.mjs';

/**
 * Р-184, Р-185 (шаг 46): лендинг. Проверяется сам набор страниц репозитория и, рядом, — что каждое правило способно
 * покраснеть: у каждого своя порча страницы и своя причина [Р-94].
 */

test('Р-184, Р-185: обе языковые версии полные, ссылки целые, ничего внешнего, текст по правилам', () => {
  const { pages, css } = readLanding();
  assert.deepEqual(landingProblems(pages, css), []);
});

test('Р-185: каждое правило краснеет на своей порче', () => {
  const { pages, css } = readLanding();
  const spoil = (path: string, from: string | RegExp, to: string) => ({ ...pages, [path]: pages[path].replace(from, to) });
  const cases: Array<[string, Record<string, string>, RegExp]> = [
    ['слово AI', spoil('/', 'Repricing you can explain.', 'AI repricing you can explain.'), /слово AI/],
    ['слово KI', spoil('/de/', 'Nachvollziehbar statt Blackbox', 'KI, nachvollziehbar'), /слово AI\/KI/],
    ['выдуманное число', spoil('/', 'around €89', 'around €89 — 1200 sellers'), /число 1200/],
    ['отзыв', spoil('/', 'Pricing</h2>', 'Pricing</h2><p>Trusted by great sellers</p>'), /отзывы/],
    ['картинка логотипа', spoil('/', '<main>', '<main><img src="/logo.png">'), /картинка/],
    ['внешний шрифт', spoil('/', '<link rel="stylesheet" href="/site.css">', '<link rel="stylesheet" href="https://fonts.example.invalid/a.css">'), /внешний адрес/],
    ['битая ссылка', spoil('/de/', 'href="/de/contact"', 'href="/de/kontakt"'), /ведёт в никуда/],
    ['Omnibus на английской', spoil('/', '<section id="stock">', '<section id="stock"><p>Omnibus proof</p>'), /Omnibus на английской/],
    ['факт Omnibus не дословно', spoil('/de/', '644 Fälle allein 2025 (+11,6 %)', 'rund 600 Fälle'), /в блоке Omnibus нет/],
    ['источник не тот', spoil('/de/', 'https://www.wettbewerbszentrale.de/jahresbericht-2025-mehr-klagen-und-ein-neuer-name/', 'https://blog.example.invalid/644'), /внешний адрес https:\/\/blog/],
    ['источник пропал', spoil('/de/', /<a href="https:\/\/www\.bundesgerichtshof\.de[^>]*>[^<]*<\/a>;?/, ''), /нет источника https:\/\/www\.bundesgerichtshof/],
    ['адрес источника как ресурс', spoil('/de/', '<link rel="stylesheet" href="/site.css">', '<link rel="stylesheet" href="/site.css"><link rel="prefetch" href="https://www.bundesgerichtshof.de/SharedDocs/Pressemitteilungen/DE/2025/2025184.html">'), /внешний адрес/],
    ['ресурс источника после ссылки', spoil('/de/', '</footer>', '</footer><link rel="prefetch" href="https://www.bundesgerichtshof.de/SharedDocs/Pressemitteilungen/DE/2025/2025184.html">'), /внешний адрес/],
    ['источник на английской', spoil('/', '<main>', '<main><a href="https://www.bundesgerichtshof.de/SharedDocs/Pressemitteilungen/DE/2025/2025184.html">BGH</a>'), /внешний адрес/],
    ['LG München I без «erstinstanzlich» (источник)', spoil('/de/', 'LG München I (erstinstanzlich), 4 HK O', 'LG München I, 4 HK O'), /нет «erstinstanzlich»/],
    ['LG München I без «erstinstanzlich» (текст)', spoil('/de/', 'verlor dazu erstinstanzlich vor dem', 'verlor dazu vor dem'), /нет «erstinstanzlich»/],
    ['тариф без периода', spoil('/de/', '39 €</span> pro Monat, zzgl. USt.', '39 €</span>'), /39 € pro Monat, zzgl\. USt\./],
    // Находка 6 ревью шага 46: порча только ДОБАВЛЯЕТ обещание — факт-оговорка на месте, краснеть обязано своё правило
    ['гарантия (DE)', spoil('/de/', 'Wir führen je Kanal', 'Wir garantieren Rechtssicherheit. Wir führen je Kanal'), /обещание гарантии/],
    ['гарантия (EN)', spoil('/', 'Enter your unit cost once.', 'Guaranteed compliant pricing. Enter your unit cost once.'), /обещание гарантии/],
    ['AI в заголовке', spoil('/', '<title>repracer — repricing you can explain</title>', '<title>repracer — AI repricing</title>'), /слово AI/],
    ['отзыв в описании', spoil('/', 'content="Repricing built for', 'content="Trusted by sellers. Repricing built for'), /отзывы/],
    ['число в описании', spoil('/', 'content="Repricing built for', 'content="5000 sellers. Repricing built for'), /число 5000/],
    ['разрешённое число вне фразы', spoil('/', 'Enter your unit cost once.', '30% more revenue. Enter your unit cost once.'), /число 30/],
    ['факт Omnibus на английской', spoil('/', 'Enter your unit cost once.', '644 cases in 2025. Enter your unit cost once.'), /число 644/],
    ['количество словами', spoil('/de/', 'Kunden, die wir zitieren könnten', 'Tausende Händler; Kunden, die wir zitieren könnten'), /количество словами/],
    ['A.I.', spoil('/', 'Repricing you can explain.', 'A.I. repricing you can explain.'), /слово AI/],
    ['внешний адрес в одинарных кавычках', spoil('/', '<main>', "<main><a href='https://tracker.example.invalid/'>x</a>"), /внешний адрес/],
    ['внешний адрес без кавычек', spoil('/', '<main>', '<main><a href=https://tracker.example.invalid/>x</a>'), /внешний адрес/],
    ['встроенный стиль', spoil('/', '<main>', '<main><p style="background:url(https://x.example.invalid/a.png)">x</p>'), /встроенный стиль/],
    ['скрипт', spoil('/', '</body>', '<script>1</script></body>'), /скрипт/],
    ['встроенный не-SVG', spoil('/', 'href="data:image/svg+xml,', 'href="data:text/html,'), /встроенный ресурс/],
    ['битый якорь', spoil('/', '<main>', '<main><a href="#nowhere">x</a>'), /якорь #nowhere/],
    ['относительная ссылка', spoil('/', '<main>', '<main><a href="pricing.html">x</a>'), /относительная ссылка/],
    ['статус design-партнёров', { ...pages, '/': pages['/'].replace(/design partner/gi, 'partner') }, /design-партнёров/],
    ['блок детерминизма', spoil('/', 'Three stop switches', 'Stop switches'), /Three stop switches/],
    ['страница тяжелее предела', spoil('/', '</main>', `${'<p>x</p>'.repeat(3000)}</main>`), /больше 20000 байт/],
    ['внутренний текст', spoil('/', '<main>', '<main><!-- Р-185 -->'), /внутренний текст/],
    ['тариф потерян', spoil('/', '30 days free, no card', '30 days free'), /no card/],
    ['раздел только в одной версии', spoil('/', '<section id="stock">', '<section id="stock-en">'), /разделы версий расходятся/],
    ['язык страницы', spoil('/de/', '<html lang="de">', '<html lang="en">'), /язык страницы не de/],
  ];
  // Порчи таблицы стилей
  const cssCases: Array<[string, string, RegExp]> = [
    ['внешний ресурс в стилях', `@import url(https://fonts.example.invalid/a.css);\n${css}`, /внешний ресурс в стилях/],
    ['стили тяжелее предела', `${css}${'/* x */'.repeat(1000)}`, /больше 5000 байт/],
    ['кириллица в стилях', `/* лендинг */\n${css}`, /внутренний текст/],
  ];
  for (const [name, spoiledCss, reason] of cssCases) {
    const problems: string[] = landingProblems(pages, spoiledCss);
    assert.ok(problems.some((p) => reason.test(p)), `${name}: ждали причину ${reason}, получили ${JSON.stringify(problems)}`);
  }
  for (const [name, spoiled, reason] of cases) {
    const problems: string[] = landingProblems(spoiled, css);
    assert.ok(problems.some((p) => reason.test(p)), `${name}: ждали причину ${reason}, получили ${JSON.stringify(problems)}`);
  }
});

/**
 * Находка 4 ревью шага 46: немецкая страница без Impressum и защиты данных не публикуется. Умолчание профиля — «не
 * опубликован», а прокси отвечает 404, пока значение не `on`: оба конца проверяются по файлам развёртывания.
 */
test('Р-184: лендинг публикуется только явным REPRACER_LANDING_PUBLIC=on', async () => {
  const { readFileSync } = await import('node:fs');
  const compose = readFileSync(new URL('../../deploy/production/compose.yaml', import.meta.url), 'utf8');
  const snippets = readFileSync(new URL('../../deploy/production/snippets.caddy', import.meta.url), 'utf8');
  assert.match(compose, /REPRACER_LANDING_PUBLIC: "\$\{REPRACER_LANDING_PUBLIC:-off\}"/, 'умолчание профиля — не опубликован');
  assert.match(snippets, /@unpublished expression `\{env\.REPRACER_LANDING_PUBLIC\} != "on"`\s+handle @unpublished \{\s+respond "Not published" 404/,
    'прокси не отдаёт лендинг без явного on');
});
