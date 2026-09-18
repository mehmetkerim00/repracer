/**
 * Шаг 27 (OQ-190): общие части процессов переехали в @repracer/service-runtime — их используют планировщик, диспетчер записей и
 * приёмник уведомлений. Здесь остаётся реэкспорт, чтобы сборка планировщика не зависела от порядка переезда.
 */
export { credentialsFromFiles, jsonSink, pgAccountDirectory, type JsonSink } from '@repracer/service-runtime';
