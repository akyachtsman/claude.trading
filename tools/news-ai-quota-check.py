#!/usr/bin/env python3
"""Checks for supabase/migrations/desk_023_news_ai_quota.sql (the News topic AI cleanup's daily limit), against a SCRATCH Postgres.

    python3 tools/news-ai-quota-check.py             # baseline checks, then every mutant of the migration
    python3 tools/news-ai-quota-check.py --list
    python3 tools/news-ai-quota-check.py cap_guard   # only mutants whose name contains "cap_guard"

What it proves, on a FRESH database each time (stub schema + desk_020 + the migration):
  1. tools/news-ai-quota-verify.sql passes (privileges, denials, the cap, refusals that write nothing);
  2. ATOMICITY: 20 parallel sessions each take a unit against a cap of 5 and EXACTLY 5 get `true`. The probe above is one
     transaction and cannot show this: a counter that reads and then writes passes it and still lets a burst through
     (that mutant is below, and only this check catches it);
  3. INDEPENDENCE (spec SC6): the Ask-the-desk visitor counter (desk_020) and this one never spend each other, even for the same day.
A mutant is CAUGHT when any of the three fails (or the migration no longer applies). A guard nothing checks is not a guard.

Needs a scratch Postgres 16+ you may freely create databases in, reached through the usual libpq environment (PGHOST / PGPORT /
PGUSER; trust auth is fine) and the `psql` client. It never touches a Supabase project. As root, Postgres refuses to run, so:
    install -d -o postgres /tmp/pgscratch && runuser -u postgres -- /usr/lib/postgresql/16/bin/initdb -D /tmp/pgscratch/data -A trust -U postgres
    runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pgscratch/data -o "-p 54398 -k /tmp/pgscratch -c listen_addresses=" -l /tmp/pgscratch/log -w start
    PGHOST=/tmp/pgscratch PGPORT=54398 PGUSER=postgres python3 tools/news-ai-quota-check.py
Not run by CI."""
import json, os, re, subprocess, sys
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
MIG = open(os.path.join(ROOT, 'supabase/migrations/desk_023_news_ai_quota.sql')).read()
ASK = os.path.join(ROOT, 'supabase/migrations/desk_020_open_ask_quota.sql')
STUB = os.path.join(ROOT, 'tools/ask-model-tier-sql-stub.sql')
VERIFY = os.path.join(ROOT, 'tools/news-ai-quota-verify.sql')
DB = 'news_ai_quota_chk'
BURST, CAP = 20, 5

M = {
 'no_cap_guard': ("on conflict (day) do update set n = q.n + 1 where q.n < p_cap", "on conflict (day) do update set n = q.n + 1"),
 'cap_guard_off_by_one': ("where q.n < p_cap", "where q.n <= p_cap"),
 'no_cap_below_1_guard': ("  if p_cap is null or p_cap < 1 then return false; end if;\n", ""),
 'no_day_shape_check': ("  if p_day is null or p_day !~ '^\\d{4}-\\d{2}-\\d{2}$' then return false; end if;\n", ""),
 'day_shape_not_anchored_at_the_end': ("'^\\d{4}-\\d{2}-\\d{2}$'", "'^\\d{4}-\\d{2}-\\d{2}'"),
 'service_role_keeps_table_privileges': ("from public, anon, authenticated, service_role;\n\ncreate or replace", "from public, anon, authenticated;\n\ncreate or replace"),
 'anon_may_execute': ("to service_role;\n\ncommit;", "to service_role, anon;\n\ncommit;"),
 'public_may_execute': ("from public, anon, authenticated;\ngrant execute", "from anon, authenticated;\ngrant execute"),
 'not_security_definer': (" security definer\n", " security invoker\n"),
 'rls_off': ("alter table public.desk_news_ai_quota enable row level security;\n", ""),
 'shares_the_ask_counter': ("insert into public.desk_news_ai_quota as q (day, n)", "insert into public.desk_open_ask_quota as q (day, n)"),
 # the classic: read, decide, THEN write. Every probe step passes (one session at a time); only the burst check can see it.
 'read_then_write_not_atomic': ("  insert into public.desk_news_ai_quota as q (day, n)\n  values (p_day, 1)\n  on conflict (day) do update set n = q.n + 1 where q.n < p_cap\n  returning q.n into v;\n\n  return v is not null;",
   "  select n into v from public.desk_news_ai_quota where day = p_day;\n  if coalesce(v, 0) >= p_cap then return false; end if;\n  perform pg_sleep(0.05);\n  insert into public.desk_news_ai_quota as q (day, n) values (p_day, 1)\n  on conflict (day) do update set n = q.n + 1;\n  return true;"),
}

def psql(db, *args, **kw):
    return subprocess.run(['psql', '-q', '-X', '-d', db, *args], capture_output=True, text=True, **kw)

def fresh(mig_text):
    """a new scratch database with the stub, desk_020 and `mig_text` applied; returns (applied_ok, message)"""
    psql('postgres', '-c', f'drop database if exists {DB}')
    r = psql('postgres', '-c', f'create database {DB}')
    if r.returncode: return None, 'cannot create a scratch database: ' + r.stderr.strip()[:200]
    r = psql(DB, '-v', 'ON_ERROR_STOP=1', '-f', STUB)
    if r.returncode: return None, 'the stub failed: ' + r.stderr.strip()[:300]
    r = psql(DB, '-v', 'ON_ERROR_STOP=1', '-f', ASK)
    if r.returncode: return None, 'desk_020 failed: ' + r.stderr.strip()[:300]
    r = subprocess.run(['psql', '-q', '-X', '-d', DB], input=mig_text, capture_output=True, text=True)
    return (r.returncode == 0 and 'ERROR' not in r.stderr), r.stderr.strip()[:160]

def probe():
    v = psql(DB, '-At', '-f', VERIFY)
    m = re.search(r'NEWS_AI_QUOTA_PROBE (\{.*\})', v.stdout + v.stderr, re.S)
    return json.loads(m.group(1)) if m else None

def burst():
    """BURST parallel sessions as service_role, each taking one unit of a CAP-sized day; returns how many got true"""
    stmt = f"set role service_role; select public.desk_news_ai_take('2099-06-01', {CAP});"
    ps = [subprocess.Popen(['psql', '-At', '-X', '-d', DB, '-c', stmt], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(BURST)]
    outs = [p.communicate()[0].split() for p in ps]
    return sum(1 for o in outs if o and o[-1] == 't'), sum(1 for o in outs if not o or o[-1] not in ('t', 'f'))

def independent():
    """the Ask counter and this one never spend each other for the same day; returns a list of problems (empty = fine)"""
    def take(fn, cap):
        r = psql(DB, '-At', '-c', f"set role service_role; select public.{fn}('2099-07-01', {cap});")
        o = r.stdout.split(); return o[-1] if o else 'err:' + r.stderr.strip()[:80]
    got = [take('desk_open_ask_take', 2), take('desk_open_ask_take', 2), take('desk_news_ai_take', 2), take('desk_news_ai_take', 2)]
    full = [take('desk_open_ask_take', 2), take('desk_news_ai_take', 2)]
    bad = []
    if got != ['t', 't', 't', 't']: bad.append(f'taking 2 of the Ask counter then 2 of this one gave {got}, want all t')
    if full != ['f', 'f']: bad.append(f'both counters are full after 2 each, but the 3rd takes gave {full}, want f, f')
    return bad

def check(mig_text):
    """run every check on a fresh database; returns (problems, applied)"""
    ok, msg = fresh(mig_text)
    if ok is None: return [msg], None
    if not ok: return ['the migration did not apply: ' + msg], False
    problems = []
    j = probe()
    if j is None: problems.append('the probe gave no verdict')
    elif not j['all_pass']: problems.append('probe: ' + '; '.join(f['step'][:50] for f in j['failed'][:2]) + (f" (+{len(j['failed']) - 2})" if len(j['failed']) > 2 else ''))
    got, odd = burst()
    if odd: problems.append(f'burst: {odd} of {BURST} sessions did not answer t/f')
    if got != CAP: problems.append(f'burst: {got} of {BURST} parallel takes got true against a cap of {CAP} (must be exactly {CAP})')
    problems += ['independence: ' + p for p in independent()]
    return problems, True

if '--list' in sys.argv: print('\n'.join(M)); sys.exit(0)
only = [a for a in sys.argv[1:] if not a.startswith('--')]
try:
    problems, applied = check(MIG)
    if problems:
        print('BASELINE FAILS —', '; '.join(problems)); sys.exit(2)
    print(f'baseline: the probe passes, {CAP} of {BURST} parallel takes got true, and the Ask counter is independent\n')
    n = caught = 0; bad = []
    for name, (a, b) in M.items():
        if only and not any(o in name for o in only): continue
        if MIG.count(a) != 1: print(f'INVALID   {name}  (the anchor is found {MIG.count(a)}x, not once)'); bad.append(name); continue
        n += 1
        problems, applied = check(MIG.replace(a, b))
        if applied is None: print(f'ERROR     {name}  <- the harness could not run: {problems[0][:110]}'); bad.append(name)   # not a catch
        elif problems: caught += 1; print(f'caught    {name}  <- {problems[0][:120]}')
        else: print(f'SURVIVED  {name}'); bad.append(name)
    print(f'\nmutants caught: {caught}/{n}' + (f'   NOT caught / invalid: {bad}' if bad else ''))
    sys.exit(1 if bad else 0)
finally:
    psql('postgres', '-c', f'drop database if exists {DB}')
