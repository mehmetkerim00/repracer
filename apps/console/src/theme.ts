/**
 * Шаг 93: тема — свойство УСТРОЙСТВА (язык остаётся свойством тенанта). По умолчанию системная (`prefers-color-scheme`); ручной выбор
 * «светлая» или «тёмная» хранится в браузере и пишет `data-theme` на корень страницы — значения цветов в tokens.css. Хранилище может быть
 * недоступно (приватное окно) — тогда выбор живёт до перезагрузки, страница работает
 */
export type ThemeChoice = 'system' | 'light' | 'dark';
/** Шаг 94: порядок круга кнопки темы — Light → Dark → System */
export const THEME_CHOICES: readonly ThemeChoice[] = ['light', 'dark', 'system'];
const THEME_KEY = 'repracer.theme';

export function storedTheme(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(choice: ThemeChoice, remember = true): void {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
  if (!remember) return;
  try {
    if (choice === 'system') window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, choice);
  } catch {
    // выбор живёт до перезагрузки
  }
}
