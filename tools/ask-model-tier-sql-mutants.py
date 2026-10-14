#!/usr/bin/env python3
"""Mutation run for supabase/migrations/desk_021_ask_model_tier.sql: apply a single-edit mutant of the migration to a
FRESH scratch database, run tools/ask-model-tier-verify.sql in it, and require the probe to FAIL (all_pass false, or the
migration/probe unable to complete). A guard whose removal leaves the probe green is a guard nothing checks.

    python3 tools/ask-model-tier-sql-mutants.py             # baseline, then every mutant
    python3 tools/ask-model-tier-sql-mutants.py --list
    python3 tools/ask-model-tier-sql-mutants.py is_test     # only mutants whose name contains "is_test"

Needs a SCRATCH Postgres (16+ with pgcrypto) you may freely create databases in, reached through the usual libpq
environment (PGHOST / PGPORT / PGUSER; trust auth is fine) and the `psql` client. It never touches a Supabase project.
One way to get one without installing anything, as a non-root OS user:
    initdb -D /tmp/pgscratch -A trust -U postgres && pg_ctl -D /tmp/pgscratch -o "-p 54399 -k /tmp -c listen_addresses=" -w start
    PGHOST=/tmp PGPORT=54399 PGUSER=postgres python3 tools/ask-model-tier-sql-mutants.py
Each mutant gets its own database (created and dropped); the baseline must pass every probe step first — on a fresh row AND after the owner has used the switch.
Not run by CI. The counts quoted in docs/architecture/desk-ask-and-cron.md come from this file."""
import json, os, re, subprocess, sys
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
MIG = open(os.path.join(ROOT, 'supabase/migrations/desk_021_ask_model_tier.sql')).read()
STUB = os.path.join(ROOT, 'tools/ask-model-tier-sql-stub.sql')
VERIFY = os.path.join(ROOT, 'tools/ask-model-tier-verify.sql')

M = {
 'revoke_omits_service_role': ("from public, anon, authenticated, service_role;\ngrant select on table", "from public, anon, authenticated;\ngrant select on table"),
 'grant_update_to_authenticated': ("grant select on table public.desk_ask_model to service_role;", "grant select on table public.desk_ask_model to service_role;\ngrant update (model) on table public.desk_ask_model to authenticated;"),
 'grant_select_to_anon': ("grant select on table public.desk_ask_model to service_role;", "grant select on table public.desk_ask_model to service_role, anon;"),
 'service_role_may_update': ("grant select on table public.desk_ask_model to service_role;", "grant select, update on table public.desk_ask_model to service_role;"),
 'rls_off': ("alter table public.desk_ask_model enable row level security;", ""),
 'getter_allows_test_user': ("    where not u.is_test\n      and u.pin_hash", "    where u.pin_hash"),
 'setter_allows_test_user': ("   where not u.is_test\n     and u.pin_hash", "   where u.pin_hash"),
 'setter_no_null_guard': ("  if new_model is null then return jsonb_build_object('ok', false, 'error', 'unknown model'); end if;\n", ""),
 'setter_no_exception_handler': ("exception when check_violation then\n  return jsonb_build_object('ok', false, 'error', 'unknown model');\n", ""),
 'trigger_no_nullif': ("nullif(current_setting('desk.actor', true), '')::uuid", "current_setting('desk.actor', true)::uuid"),
 'no_trigger': ("create or replace trigger desk_ask_model_stamp\n  before update on public.desk_ask_model\n  for each row execute function public.desk_ask_model_stamp();", ""),
 'trigger_leaves_updated_by': ("  new.updated_by := nullif(current_setting('desk.actor', true), '')::uuid;\n", ""),
 'trigger_leaves_updated_at': ("  new.updated_at := now();\n", ""),
 'no_allowed_check': ("  constraint desk_ask_model_singleton check (id),\n  constraint desk_ask_model_allowed   check (model in ('claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'))", "  constraint desk_ask_model_singleton check (id)"),
 'no_singleton_check': ("  constraint desk_ask_model_singleton check (id),\n", ""),
 'exec_getter_to_authenticated': ("grant execute on function public.desk_get_ask_model(text)       to anon;", "grant execute on function public.desk_get_ask_model(text)       to anon, authenticated;"),
 'exec_setter_to_service_role': ("grant execute on function public.desk_set_ask_model(text, text) to anon;", "grant execute on function public.desk_set_ask_model(text, text) to anon, service_role;"),
 'setter_upserts_when_no_row': ("  if v_at is null then return jsonb_build_object('ok', false, 'error', 'no row'); end if;", "  if v_at is null then insert into public.desk_ask_model (id, model) values (true, new_model) returning updated_at into v_at; end if;"),
 'setter_uses_found_after_perform': ("  if v_at is null then return jsonb_build_object('ok', false, 'error', 'no row'); end if;", "  if not found then return jsonb_build_object('ok', false, 'error', 'no row'); end if;"),
 'setter_leaves_actor_set': ("  perform set_config('desk.actor', '', true);\n  -- NOT", "  -- NOT"),
 'getter_ignores_the_pin': ("    where not u.is_test\n      and u.pin_hash = encode(extensions.digest(u.salt || pin, 'sha256'), 'hex')\n    limit 1\n  )\n  select case", "    where not u.is_test\n    limit 1\n  )\n  select case"),
 'setter_ignores_the_pin': ("   where not u.is_test\n     and u.pin_hash = encode(extensions.digest(u.salt || pin, 'sha256'), 'hex')\n   limit 1;", "   where not u.is_test\n   limit 1;"),
 'getter_shows_default_when_empty': ("jsonb_build_object('ok', true, 'model', null))", "jsonb_build_object('ok', true, 'model', 'claude-haiku-5-5'))"),
 'getter_search_path_public': ("create or replace function public.desk_get_ask_model(pin text)\n returns jsonb\n language sql\n security definer\n set search_path to ''", "create or replace function public.desk_get_ask_model(pin text)\n returns jsonb\n language sql\n security definer\n set search_path to 'public'"),
 'setter_not_definer': ("create or replace function public.desk_set_ask_model(pin text, new_model text)\n returns jsonb\n language plpgsql\n security definer", "create or replace function public.desk_set_ask_model(pin text, new_model text)\n returns jsonb\n language plpgsql\n security invoker"),
 'stamp_is_definer': (" language plpgsql\n security invoker\n set search_path to ''\nas $function$\nbegin\n  new.updated_at", " language plpgsql\n security definer\n set search_path to ''\nas $function$\nbegin\n  new.updated_at"),
 'stamp_search_path_public': (" security invoker\n set search_path to ''", " security invoker\n set search_path to 'public'"),
 'stamp_fn_executable_by_anon': ("revoke all on function public.desk_ask_model_stamp() from public, anon, authenticated, service_role;", "revoke all on function public.desk_ask_model_stamp() from public, authenticated, service_role;"),
 'no_primary_key': ("  id          boolean     primary key default true,", "  id          boolean     default true,"),
 # two edits: with a plain seed the migration still applies, so the probe's OWN primary-key step is what must notice
 'no_primary_key_and_a_plain_seed': [("  id          boolean     primary key default true,", "  id          boolean     default true,"), ("values (true, 'claude-opus-5-5')\non conflict (id) do nothing;", "values (true, 'claude-opus-5-5');")],
}

def psql(db, *args, **kw):
    return subprocess.run(['psql', '-q', '-X', '-d', db, *args], capture_output=True, text=True, **kw)

def scratch_run(sql_text, after_apply=None):
    """build a fresh database, apply the stub and `sql_text` (then `after_apply`, if given), run the probe; returns (verdict dict | None, why)"""
    db = 'ask_tier_mut'
    psql('postgres', '-c', f'drop database if exists {db}'); r = psql('postgres', '-c', f'create database {db}')
    if r.returncode: return None, 'cannot create a scratch database: ' + r.stderr.strip()[:200]
    try:
        r = psql(db, '-v', 'ON_ERROR_STOP=1', '-f', STUB)
        if r.returncode: return None, 'the stub failed: ' + r.stderr.strip()[:300]
        r = psql(db, '-c', 'select 1') if False else subprocess.run(['psql', '-q', '-X', '-d', db], input=sql_text, capture_output=True, text=True)
        applied = r.returncode == 0 and 'ERROR' not in r.stderr
        if after_apply: psql(db, '-c', after_apply)
        v = psql(db, '-At', '-f', VERIFY)
        m = re.search(r'ASK_MODEL_TIER_PROBE (\{.*\})', v.stdout + v.stderr, re.S)
        if not m: return None, ('the migration did not apply: ' + r.stderr.strip()[:160]) if not applied else 'the probe gave no verdict: ' + (v.stderr or v.stdout)[:200]
        return json.loads(m.group(1)), ''
    finally:
        psql('postgres', '-c', f'drop database if exists {db}')

if '--list' in sys.argv: print('\n'.join(M)); sys.exit(0)
only = [a for a in sys.argv[1:] if not a.startswith('--')]
base, why = scratch_run(MIG)
if not base or not base['all_pass']:
    print('BASELINE FAILS — the unmutated migration does not pass the probe.', why or json.dumps(base['failed'])); sys.exit(2)
# the probe is also run on a database whose row the OWNER HAS ALREADY USED (the stub's owner PIN is 1111): a re-run on the live
# project after the switch has been used must not read as a regression
used, why2 = scratch_run(MIG, "select public.desk_set_ask_model('1111', 'claude-sonnet-5-5')")
if not used or not used['all_pass']:
    print('BASELINE AFTER USE FAILS — the probe is tied to a never-used row.', why2 or json.dumps(used['failed'])); sys.exit(2)
print(f"baseline: all {base['steps_run']} probe steps pass on the unmutated migration, also after the owner has used the switch\n")
n = caught = 0; bad = []
for name, spec in M.items():
    if only and not any(o in name for o in only): continue
    edits = spec if isinstance(spec, list) else [spec]
    if any(MIG.count(a) != 1 for a, _ in edits): print(f'INVALID   {name}  (an anchor is not found exactly once)'); bad.append(name); continue
    n += 1
    mutated = MIG
    for a, b in edits: mutated = mutated.replace(a, b)
    j, why = scratch_run(mutated)
    if j is None: caught += 1; print(f'caught    {name}  <- {why[:110]}')
    elif j['all_pass']: print(f'SURVIVED  {name}'); bad.append(name)
    else:
        caught += 1; f = j['failed']
        print(f"caught    {name}  <- {'; '.join(x['step'][:46] for x in f[:2])}" + (f' (+{len(f) - 2})' if len(f) > 2 else ''))
print(f'\nmutants caught: {caught}/{n}' + (f'   NOT caught / invalid: {bad}' if bad else ''))
sys.exit(1 if bad else 0)
