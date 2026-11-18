import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { applyTheme, storedTheme } from './theme.ts';
// Шаг 167 (тема «Spruce Hybrid»): Inter и Schibsted Grotesk — файлами в репозитории (src/fonts, OFL), без CDN; моноширинного шрифта нет
import './fonts/fonts.css';
import './tokens.css';
import './styles.css';

// Шаг 93: тема устройства — до первой отрисовки, без мигания светлой страницы у тёмного выбора
applyTheme(storedTheme(), false);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
