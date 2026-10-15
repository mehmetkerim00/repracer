import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { applyTheme, storedTheme } from './theme.ts';
// Шаг 83: интерфейс — системный стек шрифтов (как у Primer); IBM Plex Mono — только денежные колонки таблиц, локальным пакетом без CDN
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './tokens.css';
import './styles.css';

// Шаг 93: тема устройства — до первой отрисовки, без мигания светлой страницы у тёмного выбора
applyTheme(storedTheme(), false);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
