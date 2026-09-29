-- desk_004_enable_pg_net — RECONSTRUCTED on 2026-09-29 from the live catalog,
-- NOT the original text. The original was applied out-of-band through the
-- Supabase MCP (live migration log: version 20260713201519, name
-- desk_004_enable_pg_net) and was never committed. The live catalog shows
-- pg_net 0.20.3 installed in the `extensions` schema, which is all a migration
-- with this name can have done.
--
-- DO NOT APPLY THIS TO THE LIVE PROJECT — it is already at this state. It
-- exists so a scratch/fresh database can be rebuilt by replaying
-- supabase/migrations/ in order.
--
-- revert: drop extension pg_net — but FIRST unschedule every cron job that calls net.http_post (desk_005's two sync jobs and desk_018's desk-cron-ask), or they fail on every tick.
--
-- Why it exists: the pg_cron jobs (desk_005, desk_018) reach the edge functions
-- with net.http_post, which is pg_net. The functions' own auth headers come
-- from Vault at run time, so nothing secret is stored by this migration.

create extension if not exists pg_net with schema extensions;
