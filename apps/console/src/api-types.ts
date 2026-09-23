import type { BoundsEditRequest, HumanReason, Locale, MemberRole, PageInfo, StopTarget, StrategyListView } from '@repracer/console-model';

/** Контракт сервера стенда и интерфейса: экраны получают готовые модели @repracer/console-model на языке сессии [Р-72] */

export interface WorldSummary {
  id: string;
  title: string;
  description: string;
  /** Расхождения прогона сценария с его ожиданиями */
  failures: string[];
  scopes: number;
  /** Р-154: счётчики считает база агрегатом за ОКНО, а не по всем решениям тенанта — окно названо в имени поля */
  decisionsLastDay: number;
  /** Решения, где движок вмешался: цена изменена или изменение остановлено Gate (всё, кроме NO_CHANGE) */
  interventionsLastWeek: number;
  activeStops: number;
  activeHalts: number;
  /** Роль пользователя в этом мире */
  role: string;
  /** Р-151: данные синтетические, путь настоящий */
  demo: boolean;
  /** Р-150: сколько каналов ждёт доступа */
  awaitingAccess: number;
}

/** Вход [Р-78]: пользователь токена поставщика и язык; роль — своя в каждом мире, из членства; simulator — только стенд */
export interface SessionView {
  user: { subject: string; email: string | null } | null;
  locale: Locale;
  simulator: Array<{ role: MemberRole; label: string }> | null;
  /** Р-160: публичное демо включено — на странице входа есть кнопка «посмотреть демо», вход без регистрации */
  demoGuest: boolean;
}

/** Токен имитатора поставщика стенда */
export interface StandToken {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

export interface BoundsIndexItem {
  writeScopeId: string;
  label: string;
  minPrice: string;
  maxPrice: string;
}

/** Шаг 23: список границ и право правки по роли зрителя (MANAGE_PRICING) — кнопок без права экран не показывает */
export interface BoundsIndexView {
  items: BoundsIndexItem[];
  /** Р-136: страница списка — каталог целевого клиента в один ответ не помещается */
  page: PageInfo;
  canEdit: boolean;
}

export interface StopRequest {
  target: StopTarget;
  note: string;
  confirmed: boolean;
}

/** Возобновление остановки человеком и снятие системной остановки — с заметкой */
export interface NoteRequest {
  note: string;
  confirmed: boolean;
}

export interface EnableRequest {
  acknowledgeWarnings: boolean;
}

/** Шаг 12, G: предупреждения — до включения, а не отказы Gate потом */
export interface EnableResult {
  enabled: boolean;
  problems: HumanReason[];
  warnings: HumanReason[];
}

/** Шаг 21: сохранение стратегии — только с токеном показанного превью */
export interface StrategySaveRequest {
  draft: unknown;
  writeScopeIds: string[];
  strategyId: string | null;
  previewToken: string;
  confirmed: boolean;
}

export interface StrategySaveResponse {
  message: string;
  strategies: StrategyListView;
}

/** Шаг 21: применение правки границ — с токеном экрана различий */
export interface BoundsApplyRequest {
  request: BoundsEditRequest;
  planToken: string;
  confirmed: boolean;
}

/**
 * Р-139 (шаг 30): ответ на массовую операцию — созданное ЗАДАНИЕ, а не итог работы. Итог продавец видит на экране хода: он
 * переживает перезагрузку страницы и падение процесса, чего ответ синхронного запроса не переживал.
 */
export interface JobCreatedResponse {
  jobId: string;
  message: string;
  job?: import('@repracer/console-model').BulkJobView;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export const NOTE_MIN = 10;
export const NOTE_MAX = 2000;

/** Р-123 (шаг 24): ответ объявления скидки и выгрузка доказательной истории цен */
export interface DiscountAnnounceResponse {
  message: string;
  compliance: import('@repracer/console-model').ComplianceView;
}


