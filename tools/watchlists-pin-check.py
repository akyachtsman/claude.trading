#!/usr/bin/env python3
"""Checks for supabase/migrations/desk_029_watchlists_pin.sql (the watchlists need the PIN, owner 2026-11-16), against a
SCRATCH Postgres.

    python3 tools/watchlists-pin-check.py             # the baseline, then every mutant of the migration
    python3 tools/watchlists-pin-check.py --list

What it proves, on a FRESH database each time (supabase/migrations/desk_001..desk_028 replayed, then the migration):
tools/watchlists-pin-verify.sql passes. A mutant is CAUGHT when the probe fails or the migration no longer applies (its own
DO block refuses to commit). The replay skips desk_004 and desk_005 (pg_net and pg_cron) and, below Postgres 17,
desk_025 — as tools/pin-lockout-check.py does, which also says how to start a scratch Postgres. It never touches a
Supabase project."""
import glob, json, os, re, subprocess, sys
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
MIG = open(os.path.join(ROOT, 'supabase/migrations/desk_029_watchlists_pin.sql')).read()
VERIFY = os.path.join(ROOT, 'tools/watchlists-pin-verify.sql')
DB = 'watchlists_pin_chk'
ROLES = """do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon')          then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')  then create role service_role nologin bypassrls; end if;
end $$;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
"""

def between(a, b):
    """the migration's text from anchor a up to (not including) anchor b — for a mutant that removes a block"""
    i = MIG.index(a); return MIG[i:MIG.index(b, i)]

M = {
 'read_helper_bypassed': ("declare\n  w jsonb := public.desk_pin_who(pin);\nbegin\n  if not coalesce((w->>'ok')::boolean, false) then\n    return jsonb_strip_nulls(jsonb_build_object('ok', false, 'locked_until', w->'locked_until'));\n  end if;\n  return public.desk_get_watchlists_open();",
                          "begin\n  return public.desk_get_watchlists_open();"),
 'write_helper_bypassed': ("declare\n  w jsonb := public.desk_pin_who(pin);\nbegin\n  if not coalesce((w->>'ok')::boolean, false) then\n    return jsonb_strip_nulls(jsonb_build_object('ok', false, 'locked_until', w->'locked_until'));\n  end if;\n  if coalesce",
                           "declare\n  w jsonb := jsonb_build_object('ok', true, 'is_test', false);\nbegin\n  if coalesce"),
 'test_user_writes': ("  if coalesce((w->>'is_test')::boolean, true) then\n    return jsonb_build_object('ok', false, 'error', 'Only the owner can change the watchlists.');\n  end if;\n", ""),
 'version_dropped': ("  return public.desk_set_watchlists_open(new_lists, expected_version);", "  return public.desk_set_watchlists_open(new_lists, null);"),
 'open_reader_left_to_anon': ("revoke execute on function public.desk_get_watchlists_open() from public, anon, authenticated;", "revoke execute on function public.desk_get_watchlists_open() from public;"),
 'open_writer_left_to_anon': ("revoke execute on function public.desk_set_watchlists_open(jsonb, timestamptz) from public, anon, authenticated;", "revoke execute on function public.desk_set_watchlists_open(jsonb, timestamptz) from public;"),
 'service_role_loses_reader': ("revoke execute on function public.desk_get_watchlists_open() from public, anon, authenticated;", "revoke execute on function public.desk_get_watchlists_open() from public, anon, authenticated, service_role;"),
 'lock_not_passed_on': ("    return jsonb_strip_nulls(jsonb_build_object('ok', false, 'locked_until', w->'locked_until'));\n  end if;\n  return public.desk_get_watchlists_open();",
                        "    return jsonb_build_object('ok', false);\n  end if;\n  return public.desk_get_watchlists_open();"),
 'reader_invoker': ("create or replace function public.desk_get_watchlists_pin(pin text)\n returns jsonb\n language plpgsql\n security definer",
                    "create or replace function public.desk_get_watchlists_pin(pin text)\n returns jsonb\n language plpgsql\n security invoker"),
 'pin_doors_not_granted': ("grant execute on function public.desk_get_watchlists_pin(text) to anon, authenticated, service_role;", "grant execute on function public.desk_get_watchlists_pin(text) to service_role;"),
}

def psql(db, *args, **kw):
    return subprocess.run(['psql', '-q', '-X', '-d', db, *args], capture_output=True, text=True, **kw)

def server_major():
    return int(psql('postgres', '-At', '-c', 'show server_version_num').stdout.strip()) // 10000

def fresh(mig_text):
    """a new scratch database with the roles, desk_001..028 and `mig_text`; returns (applied_ok, message)"""
    psql('postgres', '-c', f'drop database if exists {DB}')
    r = psql('postgres', '-c', f'create database {DB}')
    if r.returncode: return None, 'cannot create a scratch database: ' + r.stderr.strip()[:200]
    r = subprocess.run(['psql', '-q', '-X', '-d', DB, '-v', 'ON_ERROR_STOP=1'], input=ROLES, capture_output=True, text=True)
    if r.returncode: return None, 'the roles failed: ' + r.stderr.strip()[:300]
    skip = {'desk_004', 'desk_005'} | ({'desk_025'} if server_major() < 17 else set())
    for f in sorted(glob.glob(os.path.join(ROOT, 'supabase/migrations/desk_0*.sql'))):
        name = os.path.basename(f)
        if name[:8] in skip or name[:8] >= 'desk_029': continue
        r = psql(DB, '-v', 'ON_ERROR_STOP=1', '-f', f)
        if r.returncode: return None, f'{name} failed: ' + r.stderr.strip()[:300]
    r = subprocess.run(['psql', '-q', '-X', '-d', DB, '-v', 'ON_ERROR_STOP=1'], input=mig_text, capture_output=True, text=True)
    return (r.returncode == 0 and 'ERROR' not in r.stderr), r.stderr.strip()[:200]

def check(mig_text):
    """run the probe on a fresh database; returns (problems, applied)"""
    ok, msg = fresh(mig_text)
    if ok is None: return [msg], None
    if not ok: return ['the migration did not apply: ' + msg], False
    v = psql(DB, '-At', '-f', VERIFY)
    m = re.search(r'WATCHLISTS_PIN_PROBE (\{.*\})', v.stdout + v.stderr, re.S)
    if not m: return ['the probe gave no verdict: ' + (v.stdout + v.stderr).strip()[:200]], True
    j = json.loads(m.group(1))
    if j['all_pass']: return [], True
    return ['probe: ' + '; '.join(f"{f['step'][:60]} (got {str(f['got'])[:40]})" for f in j['failed'][:2]) + (f" (+{len(j['failed']) - 2})" if len(j['failed']) > 2 else '')], True

if '--list' in sys.argv: print('\n'.join(M)); sys.exit(0)
only = [a for a in sys.argv[1:] if not a.startswith('--')]
try:
    problems, applied = check(MIG)
    if problems:
        print('BASELINE FAILS —', '; '.join(problems)); sys.exit(2)
    print('baseline: desk_029 applies after desk_028 and the probe passes\n')
    n = caught = 0; bad = []
    for name, (a, b) in M.items():
        if only and not any(o in name for o in only): continue
        if not a or MIG.count(a) != 1: print(f'INVALID   {name}  (the anchor is found {MIG.count(a) if a else 0}x, not once)'); bad.append(name); continue
        n += 1
        problems, applied = check(MIG.replace(a, b))
        if applied is None: print(f'ERROR     {name}  <- the harness could not run: {problems[0][:110]}'); bad.append(name)   # not a catch
        elif problems: caught += 1; print(f'caught    {name}  <- {problems[0][:130]}')
        else: print(f'SURVIVED  {name}'); bad.append(name)
    print(f'\nmutants caught: {caught}/{n}' + (f'   NOT caught / invalid: {bad}' if bad else ''))
    sys.exit(1 if bad else 0)
finally:
    psql('postgres', '-c', f'drop database if exists {DB}')
