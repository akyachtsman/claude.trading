#!/usr/bin/env python3
"""Checks for supabase/migrations/desk_026_pin_lockout.sql (the lockout on every PIN door), against a SCRATCH Postgres.

    python3 tools/pin-lockout-check.py             # baseline checks, then every mutant of the migration
    python3 tools/pin-lockout-check.py --list
    python3 tools/pin-lockout-check.py row_lock    # only mutants whose name contains "row_lock"

What it proves, on a FRESH database each time (supabase/migrations/desk_001..desk_025 replayed, then the migration):
  1. tools/pin-lockout-verify.sql passes (grants, every door counted once, the lock, the read-only refusal);
  2. a BURST: 30 parallel sessions each send one wrong PIN to desk_login as anon. Exactly 9 are refused plainly, the
     10th and every later one name the lock, and the guard counts exactly 10. The probe is one transaction and cannot
     show this: a helper that reads the count without locking the row passes it and still lets a burst through.
A mutant is CAUGHT when either fails, or when the migration no longer applies (its own DO block refuses to commit).

The replay skips desk_004 and desk_005 (pg_net and pg_cron are not on a plain Postgres) and, below Postgres 17,
desk_025 (it names the MAINTAIN privilege). On 2026-11-11 every PIN function the replay builds had the same body
(md5, CR stripped) as the live project's, which is what makes this a test of the live starting point.

Needs a scratch Postgres 16+ you may freely create databases in, reached through the usual libpq environment (PGHOST /
PGPORT / PGUSER; trust auth is fine) and the `psql` client. It never touches a Supabase project. As root, Postgres refuses
to run, so:
    install -d -o postgres /var/lib/postgresql/pgscratch && runuser -u postgres -- /usr/lib/postgresql/16/bin/initdb -D /var/lib/postgresql/pgscratch/data -A trust -U postgres
    runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_ctl -D /var/lib/postgresql/pgscratch/data -o "-p 54398 -k /var/lib/postgresql/pgscratch -c listen_addresses=" -l /var/lib/postgresql/pgscratch/log -w start
    PGHOST=/var/lib/postgresql/pgscratch PGPORT=54398 PGUSER=postgres python3 tools/pin-lockout-check.py
Run by CI: qa.yml's news-checks job, against its postgres:16 service container."""
import glob, json, os, re, subprocess, sys
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
MIG_PATH = os.path.join(ROOT, 'supabase/migrations/desk_026_pin_lockout.sql')
MIG = open(MIG_PATH).read()
VERIFY = os.path.join(ROOT, 'tools/pin-lockout-verify.sql')
DB = 'pin_lockout_chk'
BURST = 30
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
 # the row lock is what serializes a burst and refuses a read-only call; the sleep widens the race the way a busy server does
 'no_row_lock': ("select * into g from public.desk_pin_guard where id = 1 for update;",
                 "select * into g from public.desk_pin_guard where id = 1; perform pg_sleep(0.05);"),
 'lock_not_checked': (between("  if g.locked_until > now() then", "\n  select u.id, u.is_test"), ""),
 'lock_checked_after_the_hash': (between("  if g.locked_until > now() then", "\n  select u.id, u.is_test") + "\n  select u.id, u.is_test into v_id, v_test\n    from public.desk_users u\n   where u.pin_hash = encode(extensions.digest(u.salt || pin, 'sha256'), 'hex')\n   limit 1;\n  if v_id is not null then\n    return jsonb_build_object('ok', true, 'id', v_id, 'is_test', v_test);\n  end if;",
   "  select u.id, u.is_test into v_id, v_test\n    from public.desk_users u\n   where u.pin_hash = encode(extensions.digest(u.salt || pin, 'sha256'), 'hex')\n   limit 1;\n  if v_id is not null then\n    return jsonb_build_object('ok', true, 'id', v_id, 'is_test', v_test);\n  end if;\n" + between("  if g.locked_until > now() then", "\n  select u.id, u.is_test")),
 'success_resets_the_count': ("  if v_id is not null then\n    return",
                              "  if v_id is not null then\n    update public.desk_pin_guard set fails = 0 where id = 1;\n    return"),
 'locked_still_counts': ("    return jsonb_build_object('ok', false, 'locked_until', g.locked_until);",
                         "    update public.desk_pin_guard set total_fails = total_fails + 1 where id = 1;\n    return jsonb_build_object('ok', false, 'locked_until', g.locked_until);"),
 'threshold_11': ("when g.fails >= 10 then", "when g.fails >= 11 then"),
 'threshold_9': ("when g.fails >= 10 then", "when g.fails >= 9 then"),
 'lock_one_minute': ("then now() + interval '1 hour' end;", "then now() + interval '1 minute' end;"),
 'window_never_resets': (between("  if g.window_start <= now() - interval '1 hour' then", "\n  g.fails := g.fails + 1;"), ""),
 'window_resets_early': ("if g.window_start <= now() - interval '1 hour' then", "if g.window_start <= now() - interval '30 minutes' then"),
 'login_hides_the_lock': ("else jsonb_strip_nulls(jsonb_build_object('ok', false, 'locked_until', w.j->'locked_until'))",
                          "else jsonb_build_object('ok', false)"),
 'test_pin_reaches_the_prompt': ("""create or replace function public.desk_get_system_prompt(pin text)
 returns jsonb
 language sql
 security definer
 set search_path to 'public'
as $function$
  with me as (
    select (w.j->>'id')::uuid as id
      from public.desk_pin_who(pin) as w(j)
     where (w.j->>'ok')::boolean
       and not (w.j->>'is_test')::boolean""", """create or replace function public.desk_get_system_prompt(pin text)
 returns jsonb
 language sql
 security definer
 set search_path to 'public'
as $function$
  with me as (
    select (w.j->>'id')::uuid as id
      from public.desk_pin_who(pin) as w(j)
     where (w.j->>'ok')::boolean"""),
 # a door that hashes for itself: the migration's own DO block must refuse to commit
 'dashboard_bypasses_the_helper': ("""  with me as (
    select (w.j->>'id')::uuid as id
      from public.desk_pin_who(pin) as w(j)
     where (w.j->>'ok')::boolean
  ),
  latest as (""", """  with me as (
    select u.id from public.desk_users u
    where u.pin_hash = encode(extensions.digest(u.salt || pin, 'sha256'), 'hex')
    limit 1
  ),
  latest as ("""),
 'helper_open_to_anon': ("grant execute on function public.desk_pin_who(text) to service_role;",
                         "grant execute on function public.desk_pin_who(text) to service_role, anon;"),
 'helper_closed_to_service_role': ("grant execute on function public.desk_pin_who(text) to service_role;\n", ""),
 'helper_not_security_definer': (" language plpgsql\n security definer\n set search_path to 'public'\nas $function$\ndeclare\n  g ",
                                 " language plpgsql\n security invoker\n set search_path to 'public'\nas $function$\ndeclare\n  g "),
 'guard_left_to_the_api_roles': ("revoke all on table public.desk_pin_guard from public, anon, authenticated, service_role;",
                                 "revoke all on table public.desk_pin_guard from public;"),
 'guard_rls_off': ("alter table public.desk_pin_guard enable row level security;", ""),
 'legacy_door_left_open': ("revoke execute on function public.desk_set_watchlists(text, jsonb) from public, anon, authenticated, service_role;\n", ""),
}

def psql(db, *args, **kw):
    return subprocess.run(['psql', '-q', '-X', '-d', db, *args], capture_output=True, text=True, **kw)

def server_major():
    r = psql('postgres', '-At', '-c', 'show server_version_num')
    return int(r.stdout.strip()) // 10000

def fresh(mig_text):
    """a new scratch database with the roles, desk_001..025 and `mig_text`; returns (applied_ok, message)"""
    psql('postgres', '-c', f'drop database if exists {DB}')
    r = psql('postgres', '-c', f'create database {DB}')
    if r.returncode: return None, 'cannot create a scratch database: ' + r.stderr.strip()[:200]
    r = subprocess.run(['psql', '-q', '-X', '-d', DB, '-v', 'ON_ERROR_STOP=1'], input=ROLES, capture_output=True, text=True)
    if r.returncode: return None, 'the roles failed: ' + r.stderr.strip()[:300]
    skip = {'desk_004', 'desk_005'} | ({'desk_025'} if server_major() < 17 else set())
    for f in sorted(glob.glob(os.path.join(ROOT, 'supabase/migrations/desk_0*.sql'))):
        name = os.path.basename(f)
        if name[:8] in skip or name[:8] >= 'desk_026': continue   # the migration under test and anything after it
        r = psql(DB, '-v', 'ON_ERROR_STOP=1', '-f', f)
        if r.returncode: return None, f'{name} failed: ' + r.stderr.strip()[:300]
    r = subprocess.run(['psql', '-q', '-X', '-d', DB, '-v', 'ON_ERROR_STOP=1'], input=mig_text, capture_output=True, text=True)
    return (r.returncode == 0 and 'ERROR' not in r.stderr), r.stderr.strip()[:200]

def probe():
    v = psql(DB, '-At', '-f', VERIFY)
    m = re.search(r'PIN_LOCKOUT_PROBE (\{.*\})', v.stdout + v.stderr, re.S)
    return json.loads(m.group(1)) if m else None

def burst():
    """BURST parallel anon sessions, one wrong PIN each; returns (plain refusals, lock-naming refusals, other, guard fails)"""
    psql(DB, '-c', 'update public.desk_pin_guard set window_start = now(), fails = 0, total_fails = 0, locked_until = null')
    stmt = "set role anon; select public.desk_login('burst-wrong-pin');"
    ps = [subprocess.Popen(['psql', '-At', '-X', '-d', DB, '-c', stmt], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(BURST)]
    outs = [p.communicate()[0].strip().splitlines() for p in ps]
    last = [o[-1] if o else '' for o in outs]
    plain = sum(1 for o in last if o == '{"ok": false}')
    locked = sum(1 for o in last if o.startswith('{"ok": false, "locked_until": "'))
    g = psql(DB, '-At', '-c', 'select fails || \' \' || total_fails from public.desk_pin_guard').stdout.split()
    return plain, locked, BURST - plain - locked, g

def check(mig_text):
    """run every check on a fresh database; returns (problems, applied)"""
    ok, msg = fresh(mig_text)
    if ok is None: return [msg], None
    if not ok: return ['the migration did not apply: ' + msg], False
    problems = []
    j = probe()
    if j is None: problems.append('the probe gave no verdict')
    elif not j['all_pass']: problems.append('probe: ' + '; '.join(f['step'][:60] for f in j['failed'][:2]) + (f" (+{len(j['failed']) - 2})" if len(j['failed']) > 2 else ''))
    plain, locked, odd, g = burst()
    if (plain, locked, odd) != (9, BURST - 9, 0) or g != ['10', '10']:
        problems.append(f'burst: {plain} plain refusals, {locked} naming the lock, {odd} other, guard fails/total {g} (want 9, {BURST - 9}, 0, [10, 10])')
    return problems, True

if '--list' in sys.argv: print('\n'.join(M)); sys.exit(0)
only = [a for a in sys.argv[1:] if not a.startswith('--')]
try:
    problems, applied = check(MIG)
    if problems:
        print('BASELINE FAILS —', '; '.join(problems)); sys.exit(2)
    print(f'baseline: the probe passes, and of {BURST} parallel wrong PINs 9 are refused, the rest name the lock, 10 counted\n')
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
