/**
 * Шаг 28 (OQ-194): внешняя отметка переехала в @repracer/service-runtime — её ставят все три процесса, а не только планировщик.
 * Здесь остаётся реэкспорт, чтобы сборка планировщика не зависела от порядка переезда.
 */
export { createHeartbeat, type Heartbeat, type HeartbeatOptions } from '@repracer/service-runtime';
