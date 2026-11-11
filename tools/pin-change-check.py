#!/usr/bin/env python3
"""Checks for supabase/migrations/desk_027_change_pin.sql (the owner changes the desk PIN to a passphrase), against a
SCRATCH Postgres.

    python3 tools/pin-change-check.py             # the baseline, then every mutant of the migration
    python3 tools/pin-change-check.py --list
    python3 tools/pin-change-check.py salt        # only mutants whose name contains "salt"

What it proves, on a FRESH database each time (supabase/migrations/desk_001..desk_026 replayed, then the migration):
tools/pin-change-verify.sql passes. A mutant is CAUGHT when the probe fails or the migration no longer applies (its own
DO block refuses to commit).

The replay skips desk_004 and desk_005 (pg_net and pg_cron are not on a plain Postgres) and, below Postgres 17,
desk_025 (it names the MAINTAIN privilege) — as tools/pin-lockout-check.py does, which also says how to start a
scratch Postgres. It never touches a Supabase project. Run by CI: qa.yml's news-checks job, beside the lockout check."""
import glob, json, os, re, subprocess, sys
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
MIG = open(os.path.join(ROOT, 'supabase/migrations/desk_027_change_pin.sql')).read()
VERIFY = os.path.join(ROOT, 'tools/pin-change-verify.sql')
DB = 'pin_change_chk'
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
 # the door must ask the helper: without it a wrong PIN changes the owner's passphrase and nothing is counted
 'helper_bypassed': ("w     jsonb := public.desk_pin_who(pin);",
                     "w     jsonb := jsonb_build_object('ok', true, 'id', (select id from public.desk_users where not is_test and label = 'probe-owner'), 'is_test', false); -- public.desk_pin_who(pin)"),
 'test_user_allowed': (between("  if coalesce((w->>'is_test')::boolean, true) then", "  v_id := (w->>'id')::uuid;"), ""),
 'min_15': ("char_length(new_pin) < 16", "char_length(new_pin) < 15"),
 'min_17': ("char_length(new_pin) < 16", "char_length(new_pin) < 17"),
 'max_201': ("char_length(new_pin) > 200", "char_length(new_pin) > 201"),
 'max_199': ("char_length(new_pin) > 200", "char_length(new_pin) > 199"),
 'spaces_allowed_at_the_ends': (between("  if new_pin <> btrim(new_pin, E' \\t\\r\\n') then", "  if new_pin = pin then"), ""),
 'same_passphrase_allowed': (between("  if new_pin = pin then", "  -- another desk user's PIN"), ""),
 'another_users_pin_allowed': (between("  if public.desk_pin_taken(v_id, new_pin) then", "\n  if not public.desk_pin_set(v_id, new_pin) then"), ""),
 'salt_reused': ("v_salt text := encode(extensions.gen_random_bytes(16), 'hex');",
                 "v_salt text := (select u.salt from public.desk_users u where u.id = p_id);"),
 'every_row_rewritten': ("         pin_hash = encode(extensions.digest(v_salt || new_pin, 'sha256'), 'hex')\n   where id = p_id;",
                         "         pin_hash = encode(extensions.digest(v_salt || new_pin, 'sha256'), 'hex')\n   where id = p_id or true;"),
 'setter_open_to_the_api': ("revoke all on function public.desk_pin_set(uuid, text) from public, anon, authenticated, service_role;",
                            "revoke all on function public.desk_pin_set(uuid, text) from public;"),
 'taken_open_to_the_api': ("revoke all on function public.desk_pin_taken(uuid, text) from public, anon, authenticated, service_role;",
                           "revoke all on function public.desk_pin_taken(uuid, text) from public;"),
 # the explicit grant alone is not a mutant: the default privileges (here and on Supabase) already give anon EXECUTE.
 # What can go wrong is the door closed like the two helpers above it — the page then cannot change the passphrase.
 'door_closed_to_anon': ("grant execute on function public.desk_change_pin(text, text) to anon, authenticated, service_role;",
                         "revoke all on function public.desk_change_pin(text, text) from public, anon, authenticated;"),
 'door_not_definer': (" language plpgsql\n security definer\n set search_path to 'public'\nas $function$\ndeclare\n  w ",
                      " language plpgsql\n security invoker\n set search_path to 'public'\nas $function$\ndeclare\n  w "),
 'null_not_refused': ("  if new_pin is null or char_length(new_pin) < 16 then", "  if char_length(new_pin) < 16 then"),
 'lock_ignored': ("  if not coalesce((w->>'ok')::boolean, false) then\n    return jsonb_strip_nulls(",
                  "  if not coalesce((w->>'ok')::boolean, false) and (w->>'locked_until') is null then\n    return jsonb_strip_nulls("),
}

def psql(db, *args, **kw):
    return subprocess.run(['psql', '-q', '-X', '-d', db, *args], capture_output=True, text=True, **kw)

def server_major():
    return int(psql('postgres', '-At', '-c', 'show server_version_num').stdout.strip()) // 10000

def fresh(mig_text):
    """a new scratch database with the roles, desk_001..026 and `mig_text`; returns (applied_ok, message)"""
    psql('postgres', '-c', f'drop database if exists {DB}')
    r = psql('postgres', '-c', f'create database {DB}')
    if r.returncode: return None, 'cannot create a scratch database: ' + r.stderr.strip()[:200]
    r = subprocess.run(['psql', '-q', '-X', '-d', DB, '-v', 'ON_ERROR_STOP=1'], input=ROLES, capture_output=True, text=True)
    if r.returncode: return None, 'the roles failed: ' + r.stderr.strip()[:300]
    skip = {'desk_004', 'desk_005'} | ({'desk_025'} if server_major() < 17 else set())
    for f in sorted(glob.glob(os.path.join(ROOT, 'supabase/migrations/desk_0*.sql'))):
        name = os.path.basename(f)
        if name[:8] in skip or name[:8] >= 'desk_027': continue
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
    m = re.search(r'PIN_CHANGE_PROBE (\{.*\})', v.stdout + v.stderr, re.S)
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
    print('baseline: desk_027 applies after desk_026 and the probe passes\n')
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
