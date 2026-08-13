-- desk_018: put desk-cron-ask on the Supabase Cron.
--
-- The desk wakes ITSELF up (owner ruling 2026-08-11). Same net.http_post shape
-- as the desk-ibkr-sync jobs: anon key for the gateway, x-cron-secret for the
-- function's own gate, both read out of Vault so no secret is written into a
-- migration or a cron command.
--
-- WHY EVERY 5 MINUTES for a schedule measured in hours: pg_cron's clock is UTC
-- and the roster's clock is PACIFIC, so a "daily at 08:00 PT" job cannot be
-- expressed as a fixed UTC cron line — it would drift an hour at every DST
-- change and deliver the morning summary at 7am for half the year. The job
-- therefore ticks often and the FUNCTION decides what is due, resolving PT
-- through the timezone database. A tick with nothing due is one indexed read of
-- a ten-row table; `at_min` is constrained to a multiple of 5 (desk_017) so
-- every schedulable minute is one this tick can actually land on.
--
-- Source-of-record only; applied to the dedicated project (kwugzhyfjevzwgplhtsd)
-- via Supabase MCP apply_migration.

select cron.schedule(
  'desk-cron-ask',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://kwugzhyfjevzwgplhtsd.supabase.co/functions/v1/desk-cron-ask',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'anon_key'),
      'authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'anon_key'),
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb,
    -- Generous, because a firing runs a full desk-ask tool loop end to end. The
    -- function stamps last_run_at BEFORE that call, so a timeout here cannot
    -- make the next tick start the same question again.
    timeout_milliseconds := 240000)
  $$
);
