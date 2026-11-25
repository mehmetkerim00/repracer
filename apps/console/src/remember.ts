import { useEffect, useState } from 'react';

/**
 * Шаг 181 (#38): фильтры экрана переживают навигацию — ушёл на квитанцию или страницу предложения и вернулся, а выборка, период и страница
 * те же. Хранится в `sessionStorage` этой вкладки под ключом экрана и пространства; хранилище недоступно — экран работает с умолчанием.
 * Явный фильтр из ссылки (плитка тени, строка состояния, пункт чеклиста) важнее запомненного: он и есть то, что человек открыл
 */
export function useRemembered<T>(key: string, initial: T, explicit?: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    if (explicit !== undefined) return explicit;
    try {
      const raw = sessionStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* память фильтров — удобство: без хранилища экран работает с умолчанием */ }
  }, [key, value]);
  return [value, setValue];
}

/** Ключ памяти экрана: пространство и экран — у разных пространств своя выборка */
export function rememberKey(worldId: string, screen: string): string {
  return `repracer.view:${worldId}:${screen}`;
}
