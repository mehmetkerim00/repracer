#!/usr/bin/env node
// Шаг 94 [Р-146]: стандарт формы консоли держится механически. Поле ввода консоли — `input`, `select`, `textarea` и компоненты, которые
// их рисуют (`DateTimeField`, `OfferPicker`, `FileDrop`), — живёт только внутри поля стандарта (`Field`, `CheckField` рисует свой
// чекбокс сам): подпись над контролом, пояснение под ним. Без правила формы «летали» — подпись, поле и хвост фразы в одной строке,
// чекбокс в углу, — и каждый новый экран повторял бы это.
//
// Разбор — синтаксическим деревом TypeScript, как у правила браузерных импортов: элемент JSX с именем контрола должен иметь среди
// предков элемент `Field`; обход идёт сквозь выражения (`.map`, условия), но не сквозь объявление другого компонента. Исключение —
// тела самих компонентов-контролов в файлах стандарта (`forms.tsx`, `components.tsx`): там контрол и определяется.
//
// Использование: node scripts/form-fields.mjs — печатает нарушения с файлом и строкой; код 1, если они есть.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Каталог страницы консоли */
export const FORM_ROOT = 'apps/console/src';
/** Элементы, которые вводят значение: родные поля и компоненты, которые их рисуют */
export const CONTROLS = new Set(['input', 'select', 'textarea', 'DateTimeField', 'OfferPicker', 'FileDrop']);
/** Поле стандарта: контрол внутри него получает подпись над собой и пояснение под собой */
export const WRAPPERS = new Set(['Field']);
/** Компоненты-контролы: в их телах контрол определяется, а не используется; только в файлах стандарта */
export const DEFINITIONS = new Set(['Field', 'CheckField', 'DateTimeField', 'OfferPicker', 'FileDrop']);
export const DEFINITION_FILES = new Set(['forms.tsx', 'components.tsx']);

const tagName = (node) => {
  const tag = ts.isJsxElement(node) ? node.openingElement.tagName : ts.isJsxSelfClosingElement(node) ? node.tagName : null;
  return tag ? tag.getText() : null;
};

/** Имя функции-компонента, внутри которой стоит узел (ближайшая объявленная функция или стрелка с именем) */
function componentOf(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)) return p.parent.name.text;
  }
  return null;
}

/** Нарушения стандарта в одном файле: контрол без поля-предка */
export function fieldProblemsIn(source, fileName = 'screen.tsx') {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const base = fileName.split('/').pop();
  const problems = [];
  const visit = (node) => {
    const name = tagName(node);
    if (name && CONTROLS.has(name)) {
      let wrapped = false;
      for (let p = node.parent; p; p = p.parent) {
        const pn = tagName(p);
        if (pn && WRAPPERS.has(pn)) { wrapped = true; break; }
        // Объявление функции — граница: поле в ВЫЗЫВАЮЩЕМ коде не видно отсюда, контрол обязан быть в поле там, где написан
        if (ts.isFunctionDeclaration(p)) break;
      }
      const owner = componentOf(node);
      const definition = owner !== null && DEFINITIONS.has(owner) && DEFINITION_FILES.has(base);
      if (!wrapped && !definition) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        problems.push({ file: fileName, line: line + 1, control: name, component: owner });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return problems;
}

function tsxFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
    else if (name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** Нарушения во всей странице консоли и число проверенных контролов (правило не зеленеет на пустом) */
export function formFieldProblems(dir = FORM_ROOT) {
  const problems = [];
  let controls = 0;
  for (const file of tsxFiles(join(root, dir))) {
    const source = readFileSync(file, 'utf8');
    const rel = relative(root, file);
    problems.push(...fieldProblemsIn(source, rel));
    const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const count = (node) => { const n = tagName(node); if (n && CONTROLS.has(n)) controls += 1; ts.forEachChild(node, count); };
    count(sf);
  }
  return { problems, controls };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { problems, controls } = formFieldProblems();
  for (const p of problems) console.log(`${p.file}:${p.line}: <${p.control}> outside <Field>${p.component ? ` (in ${p.component})` : ''}`);
  console.log(`form controls: ${controls}; outside a field: ${problems.length}`);
  process.exit(problems.length > 0 ? 1 : 0);
}
