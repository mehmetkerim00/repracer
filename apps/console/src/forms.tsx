import { Children, cloneElement, useId, useState, type ReactElement, type ReactNode } from 'react';
import { useMessages } from './components.tsx';

/**
 * Шаг 94: стандарт формы консоли по образцу Primer FormControl. Поле — подпись НАД контролом, пояснение мелким приглушённым ПОД ним,
 * ошибка — под пояснением; поля стоят сеткой с шагами шкалы, связанные — группой в карточке с заголовком; чекбокс — контрол слева,
 * подпись справа; кнопки — одним рядом в конце группы. Голый `input`, `select` или `textarea` вне поля роняет правило репозитория
 * `scripts/form-fields.mjs` — стандарт держится механически, а не договорённостью.
 *
 * Порядок кнопок по Primer: в форме страницы ряд слева, главное действие — первым; в окне подтверждения ряд справа, «Отмена» — перед
 * главным действием (Primer Dialog). Недоступная кнопка говорит почему: подсказкой при наведении и строкой под рядом.
 */

const NATIVE = new Set(['input', 'select', 'textarea']);

export function Field({ label, caption = null, error = null, children, wide = false, span = 1, group = false }: {
  label: ReactNode;
  /** Пояснение под контролом — мелким приглушённым текстом */
  caption?: ReactNode | null;
  error?: string | null;
  /** Ровно один контрол: родной `input`/`select`/`textarea` или компонент поля, передающий `id` своему полю ввода */
  children: ReactElement;
  /** Поле на всю ширину сетки */
  wide?: boolean;
  /** Поле на две колонки сетки (имя рядом с коротким выбором) */
  span?: 1 | 2;
  /** Контрол без собственного поля ввода (ряд кнопок-сегментов): подпись называет группу, а не поле */
  group?: boolean;
}) {
  const id = useId();
  const child = Children.only(children) as ReactElement<Record<string, unknown>>;
  const controlId = (child.props.id as string | undefined) ?? `${id}-control`;
  const describedBy = [caption ? `${id}-caption` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;
  const native = typeof child.type === 'string' && NATIVE.has(child.type);
  const control = cloneElement(child, {
    ...(group ? {} : { id: controlId }),
    ...(describedBy ? { 'aria-describedby': describedBy } : {}),
    ...(error && native ? { 'aria-invalid': true } : {}),
    ...(group ? { role: 'group', 'aria-labelledby': `${id}-label` } : {}),
  });
  return (
    <div className={`field${wide ? ' field-wide' : ''}${span === 2 ? ' field-span-2' : ''}`}>
      {group
        ? <span className="field-label" id={`${id}-label`}>{label}</span>
        : <label className="field-label" id={`${id}-label`} htmlFor={controlId}>{label}</label>}
      {control}
      {caption ? <p className="field-caption" id={`${id}-caption`}>{caption}</p> : null}
      {error ? <p className="field-error" id={`${id}-error`} role="alert">{error}</p> : null}
    </div>
  );
}

/** Чекбокс: контрол слева, подпись справа, пояснение — под подписью; стоит в сетке, а не в углу строки */
export function CheckField({ label, caption = null, checked, onChange, disabled = false, title }: {
  label: ReactNode; caption?: ReactNode | null; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; title?: string;
}) {
  const id = useId();
  return (
    <div className={`check-field${disabled ? ' disabled' : ''}`} {...(title ? { title } : {})}>
      <input type="checkbox" id={id} checked={checked} disabled={disabled} onChange={(e) => onChange(e.currentTarget.checked)}
        {...(caption ? { 'aria-describedby': `${id}-caption` } : {})} />
      <label htmlFor={id}>{label}</label>
      {caption ? <p className="field-caption" id={`${id}-caption`}>{caption}</p> : null}
    </div>
  );
}

/**
 * Поля формы — сеткой, зазоры — шкала. Без `cols` колонки не уже 14rem; с `cols` — ровно столько колонок, сколько полей в строке
 * (параметры черновика стратегии): ни одно поле не остаётся сиротой на второй строке. Ниже 1012 — две колонки, ниже 768 — одна
 */
export function FieldGrid({ children, cols }: { children: ReactNode; cols?: 2 | 3 | 4 }) {
  return <div className={`field-grid${cols ? ` cols-${cols}` : ''}`}>{children}</div>;
}

/** Связанные поля — карточкой с заголовком группы и пояснением под ним */
export function FieldGroup({ title, caption = null, children, className = '' }: { title?: ReactNode; caption?: ReactNode | null; children: ReactNode; className?: string }) {
  return (
    <section className={`card field-group${className ? ` ${className}` : ''}`}>
      {title ? <h3 className="field-group-title">{title}</h3> : null}
      {caption ? <p className="field-caption field-group-caption">{caption}</p> : null}
      {children}
    </section>
  );
}

/** Кнопки формы — одним рядом в конце группы; `hint` — почему главное действие недоступно (строкой под рядом) */
export function FormActions({ children, hint = null, dialog = false }: { children: ReactNode; hint?: string | null; dialog?: boolean }) {
  return (
    <div className={`form-actions${dialog ? ' dialog-actions' : ''}`}>
      <div className="form-actions-row">{children}</div>
      {hint ? <p className="field-caption form-hint" role="status">{hint}</p> : null}
    </div>
  );
}

/**
 * Плашка канала («Before anything is written»): заголовок канала и пилюля, одна-две строки сути, подробности — по раскрытию. Текст
 * не шире ~80 знаков: длинное предупреждение одной строкой через весь экран не читают
 */
export function Banner({ title, badge, summary, details = null, children, tone = 'warn' }: {
  title: ReactNode; badge: ReactNode; summary: ReactNode; details?: ReactNode | null; children?: ReactNode; tone?: 'warn' | 'info';
}) {
  const m = useMessages();
  const [open, setOpen] = useState(false);
  return (
    <div className={`banner banner-${tone}`}>
      <div className="banner-head"><strong className="banner-title">{title}</strong>{badge}</div>
      <p className="banner-summary">{summary}</p>
      {details ? (
        <>
          <button type="button" className="link" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? m.ui.common.showLess : m.ui.common.learnMore}</button>
          {open ? <p className="banner-details">{details}</p> : null}
        </>
      ) : null}
      {children}
    </div>
  );
}
