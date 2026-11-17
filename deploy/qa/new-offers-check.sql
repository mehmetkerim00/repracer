-- Шаг 165 (решение владельца по следу шага 155): у каждого аккаунта, у которого задана стратегия по умолчанию [Р-228], правило умолчания
-- завело хотя бы одно новое предложение. На QA-A база собирается заново при выкладке и сбросе, и демо США задаёт умолчание amazon.com,
-- затем обнаруживает два новых листинга. С 13 по 17 ноября обнаружение отказывало («demo US new offers failed: permission denied for
-- table tenant», 0236), а SMOKE GREEN этого не видел. Ответ — два числа: аккаунтов с умолчанием и из них без единого назначения правилом
WITH current_default AS (
  SELECT DISTINCT ON (tenant_id, channel_account_id) tenant_id, channel_account_id, pricing_strategy_id
    FROM tenant_data.default_strategy_change ORDER BY tenant_id, channel_account_id, seq DESC
)
SELECT count(*) FILTER (WHERE d.pricing_strategy_id IS NOT NULL),
       count(*) FILTER (WHERE d.pricing_strategy_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM tenant_data.strategy_assignment s
          WHERE s.tenant_id = d.tenant_id AND s.channel_account_id = d.channel_account_id
            AND s.source = 'DEFAULT_RULE' AND s.outcome = 'ASSIGNED'))
  FROM current_default d;
