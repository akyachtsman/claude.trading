-- desk_008: persistent Ask-the-desk conversation memory (live desk assistant).
--
-- One owner, one PIN, one shared history. The table is RLS deny-all (no
-- policies) exactly like desk_feed_cache (desk_006): anon reaches it ONLY
-- through the two SECURITY DEFINER PIN RPCs below, or via the service-role key
-- inside the desk-ask edge function (which bypasses RLS to replay + append).
-- No client ever writes a row directly — the append is server-side only.
--
-- Source-of-record only; applied to the dedicated project (kwugzhyfjevzwgplhtsd)
-- via Supabase MCP apply_migration (earlier desk_00N migrations were applied
-- out-of-band and are tracked in the project's supabase_migrations table).

-- ── table ──────────────────────────────────────────────────────────────────
create table if not exists public.desk_chat_memory (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.desk_users(id) on delete cascade,
  question    text not null,
  answer      text not null,
  model       text,
  sources     jsonb not null default '[]'::jsonb,   -- [{title,url}] web sources
  created_at  timestamptz not null default now()
);

create index if not exists desk_chat_memory_user_time
  on public.desk_chat_memory (user_id, created_at desc);

-- deny-all: RLS on, NO policies → anon/authenticated cannot select/insert/update/delete.
alter table public.desk_chat_memory enable row level security;

-- ── PIN-gated read (for the client transcript) ───────────────────────────────
-- Returns the last 40 exchanges for the PIN's user as a JSON array (oldest→newest);
-- '[]' when the PIN is unknown (no existence leak).
create or replace function public.desk_chat_history(pin text)
 returns jsonb
 language sql
 security definer
 set search_path to 'public'
as $function$
  with me as (
    select u.id from public.desk_users u
    where u.pin_hash = encode(extensions.digest(u.salt || pin, 'sha256'), 'hex')
    limit 1
  ),
  recent as (
    select c.id, c.question, c.answer, c.sources, c.created_at
    from public.desk_chat_memory c, me
    where c.user_id = me.id
    order by c.created_at desc
    limit 40
  )
  select coalesce(
    (select jsonb_agg(to_jsonb(r) order by r.created_at asc) from recent r),
    '[]'::jsonb);
$function$;

-- ── PIN-gated wipe (the "Clear conversation" control) ────────────────────────
-- Deletes ALL history for the PIN's user; {ok:true,cleared:N} or {ok:false}.
create or replace function public.desk_chat_clear(pin text)
 returns jsonb
 language sql
 security definer
 set search_path to 'public'
as $function$
  with me as (
    select u.id from public.desk_users u
    where u.pin_hash = encode(extensions.digest(u.salt || pin, 'sha256'), 'hex')
    limit 1
  ),
  del as (
    delete from public.desk_chat_memory c
    using me
    where c.user_id = me.id
    returning c.id
  )
  select case when not exists (select 1 from me)
    then jsonb_build_object('ok', false)
    else jsonb_build_object('ok', true, 'cleared', (select count(*) from del))
  end;
$function$;

-- anon-only EXECUTE (matches desk_login / desk_get_dashboard).
revoke all on function public.desk_chat_history(text) from public;
revoke all on function public.desk_chat_clear(text)   from public;
grant execute on function public.desk_chat_history(text) to anon;
grant execute on function public.desk_chat_clear(text)   to anon;
