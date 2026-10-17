#!/usr/bin/env python3
"""Mutation run for the News topic AI helper's CLIENT guards (specs/news-topic-ai): break each guard in scripts/app.js,
index.html or styles/components.css, run scenario S75 on the desktop project, and require it to FAIL. A guard whose removal
leaves S75 green is a guard nothing checks.

    python3 tools/news-topic-client-mutants.py            # every mutant
    python3 tools/news-topic-client-mutants.py --list     # names only
    python3 tools/news-topic-client-mutants.py yesterday  # only mutants whose name contains "yesterday"

Projects: desktop (MUT_PROJECTS overrides, comma-separated; mobile-chrome, tablet-chromium and iphone-chromium are the kit's
other projects run as CHROMIUM — the sandbox cannot launch WebKit). Needs the kit's node_modules
(`npm ci --prefix .github/scripts/ui-tests`) and a Chromium: set PW_CHROMIUM to a browser binary (default
/opt/pw-browsers/chromium). The runner starts its own static server on MUT_PORT (default 8792) and writes a throwaway
config next to the kit's playwright.config.js (removed afterwards). Each file is restored after every mutant, also on an
error, and checked byte-identical at the end. Not run by CI. The count quoted in docs/architecture/edge-feeds-and-heatmap.md
comes from this file."""
import hashlib, os, re, subprocess, sys, tempfile, time
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
KIT = os.path.join(ROOT, '.github/scripts/ui-tests')
F = {'app': 'scripts/app.js', 'html': 'index.html', 'css': 'styles/components.css'}
PORT = os.environ.get('MUT_PORT', '8792')
CHROMIUM = os.environ.get('PW_CHROMIUM', '/opt/pw-browsers/chromium')
PROJECTS = os.environ.get('MUT_PROJECTS', 'desktop').split(',')
SCEN = 'S75'

M = [
 ('a stored reading is ignored: every refresh asks again', 'app', [("  if (newsInterpFor(topic)) return null;\n", "")]),
 ('no single-flight: overlapping refreshes each ask', 'app', [("  if (newsInterpFlight && newsInterpFlight.t === topic) return newsInterpFlight.p;\n", "")]),
 ('the search never sends the phrase it was given', 'app', [("    if (topic && query && query !== cleanNewsTopic(topic)) body.query = query;\n", "")]),
 ('the interpret request carries more than {action, topic}', 'app', [("{ action: 'interpret', topic }", "{ action: 'interpret', topic, force: true }")]),
 ('a stored reading is trusted for another topic', 'app', [("if (!v || !topic || v.t !== topic || !v.q) return null;", "if (!v || !topic || !v.q) return null;")]),
 ("yesterday's failure is trusted", 'app', [("  if (!NEWS_AI_KEEP.includes(v.ai) && v.day !== ptDateKey(new Date())) return null;\n", "")]),
 ("`none` (an old server) is kept across days", 'app', [("const NEWS_AI_KEEP = ['rewrote', 'same'];", "const NEWS_AI_KEEP = ['rewrote', 'same', 'none'];")]),
 ('storage is the source of truth (a failed write makes every poll ask again)', 'app', [("  if (!newsInterpLoaded) { newsInterp = readNewsInterp(); newsInterpLoaded = true; }", "  { newsInterp = readNewsInterp(); newsInterpLoaded = true; }")]),
 ('a reading that lands after a retype is stored', 'app', [("      if (cleanNewsTopic(readNewsTopic()) !== topic) return null;     /* retyped while it was out: not this topic's reading any more */\n", "")]),
 ('a reply with no `ai` is kept as `same`, not `none`', 'app', [("let ai = typeof r.ai === 'string' && r.ai ? r.ai : 'none';", "let ai = typeof r.ai === 'string' && r.ai ? r.ai : 'same';")]),
 ('a rewrite with no phrase is accepted', 'app', [("      if (ai === 'rewrote' && !q) ai = 'unusable';                    /* a rewrite with no phrase is no rewrite */\n", "")]),
 ('a late search reply for a replaced phrase repaints', 'app', [("    if (news.query !== undefined && (news.query || '') !== newsQueryInForce()) return;\n", "")]),
 ('a new typing keeps the old reading', 'app', [("    setNewsInterp(null);   /* a reading belongs to ONE typing; the next refresh asks for this topic's */\n", "")]),
 ('"Search as typed" does nothing', 'app', [("    b.addEventListener('click', searchNewsAsTyped);\n", "")]),
 ('"Search as typed" does not stick (the next refresh goes back to the rewrite)', 'app', [("  setNewsInterp({ t, q: t, ai: 'same', day: ptDateKey(new Date()) });\n  paintNewsNote();\n  const list", "  setNewsInterp(null);\n  paintNewsNote();\n  const list")]),
 ('focus is dropped when the button leaves the page', 'app', [("  if (list) list.focus({ preventScroll: true });", "")]),
 ('the empty state names the typed topic, not the phrase searched', 'app', [("const t = DESK.data.newsQuery || DESK.data.newsTopic;", "const t = DESK.data.newsTopic;")]),
 ('demo asks the helper', 'app', [("  if (!topic || DESK.mode === 'demo') return null;\n  if (newsInterpFor(topic)) return null;", "  if (!topic) return null;\n  if (newsInterpFor(topic)) return null;")]),
 ('demo shows a stored reading', 'app', [("const v = t && DESK.mode !== 'demo' ? newsInterpFor(t) : null;", "const v = t ? newsInterpFor(t) : null;")]),
 ('an unknown verdict code reads as nothing', 'app', [("${NEWS_AI_WHY[v.ai] || NEWS_AI_WHY.unavailable}", "${NEWS_AI_WHY[v.ai] || ''}")]),
 ('the note is toggled with `hidden` (a live region that comes and goes)', 'html', [('<p id="newsTopicNote" class="stamp news-topic-note" role="status"></p>', '<p id="newsTopicNote" class="stamp news-topic-note" role="status" hidden></p>')]),
 ('the note is painted in the loss colour', 'css', [(".news-topic-note { margin: 4px 10px 0;", ".news-topic-note { color: var(--color-loss); margin: 4px 10px 0;")]),
 ('the note cannot wrap (it overruns the rail)', 'css', [("overflow-wrap: anywhere; }\n.news-topic-note:empty", "overflow-wrap: anywhere; white-space: nowrap; }\n.news-topic-note:empty")]),
]

if '--list' in sys.argv:
    print('\n'.join(n for n, *_ in M)); sys.exit(0)

def run(env):
    try:
        return subprocess.run(['node_modules/.bin/playwright', 'test', '-c', '.pw-mutants.config.mjs', '-g', SCEN, *[f'--project={x}' for x in PROJECTS], '--output', OUT],
                              cwd=KIT, env=env, capture_output=True, text=True, timeout=170)
    except subprocess.TimeoutExpired as e:
        return subprocess.CompletedProcess(e.cmd, 124, (e.stdout or b'').decode() if isinstance(e.stdout, bytes) else (e.stdout or ''), 'HARNESS TIMEOUT')

# A non-zero exit only counts as a catch when Playwright reports a FAILED TEST: a browser that would not launch, a server that was
# not listening or a timeout of the whole run says nothing about the guard.
INFRA = re.compile(r"browserType\.launch|Executable doesn't exist|ERR_CONNECTION_REFUSED|ECONNREFUSED|No tests found|HARNESS TIMEOUT|Cannot find module")
def is_catch(out):
    return bool(re.search(r'\b\d+ failed\b', out)) and not INFRA.search(out)
md5 = lambda p: hashlib.md5(open(p, 'rb').read()).hexdigest()

only = [a for a in sys.argv[1:] if not a.startswith('--')]
OUT = tempfile.mkdtemp(prefix='news-topic-mut-')
cfg = os.path.join(KIT, '.pw-mutants.config.mjs')
open(cfg, 'w').write(f"""import base from './playwright.config.js';
const by = (n) => base.projects.find((p) => p.name === n);
const chromium = (p, name) => ({{ ...p, name, use: {{ ...p.use, browserName: 'chromium', defaultBrowserType: 'chromium', launchOptions: {{ executablePath: {CHROMIUM!r}, args: ['--no-sandbox'] }} }} }});
export default {{ ...base, retries: 0, reporter: [['list']],
  projects: [chromium(by('desktop'), 'desktop'), chromium(by('mobile-chrome'), 'mobile-chrome'), chromium(by('tablet'), 'tablet-chromium'), chromium(by('iphone'), 'iphone-chromium')] }};
""")
before = {k: md5(os.path.join(ROOT, v)) for k, v in F.items()}
server = subprocess.Popen([os.path.join(KIT, 'node_modules/.bin/http-server'), '-p', PORT, '-c-1', '-s', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
env = dict(os.environ, APP_URL=f'http://127.0.0.1:{PORT}/')
n = caught = 0; bad = []
try:
    time.sleep(1.5)
    base = run(env)
    if base.returncode != 0:
        print(f'BASELINE FAILS — {SCEN} is not green on the unmutated tree; fix that first.\n' + (base.stdout + base.stderr)[-1500:]); sys.exit(2)
    print(f'baseline: {SCEN} green on ' + ', '.join(PROJECTS) + '\n')
    for name, key, edits in M:
        if only and not any(o in name for o in only): continue
        path = os.path.join(ROOT, F[key]); orig = open(path).read(); mut = orig; ok = True
        for a, b in edits:
            if mut.count(a) != 1: ok = False; print(f'INVALID   {name}  (anchor x{mut.count(a)})'); bad.append(name); break
            mut = mut.replace(a, b)
        if not ok: continue
        n += 1
        try:
            open(path, 'w').write(mut); r = run(env)
        finally:
            open(path, 'w').write(orig)
        out = r.stdout + r.stderr
        if r.returncode == 0: print(f'SURVIVED  {name}'); bad.append(name)
        elif not is_catch(out): print(f'ERROR     {name}  (the run failed without a failing test — not counted as a catch)'); bad.append(name)
        else:
            caught += 1; m = re.search(r'Error: ([^\n]{0,100})', out)
            print(f'caught    {name}  <- {m.group(1) if m else "failed"}')
finally:
    server.terminate(); server.wait(timeout=10)
    if os.path.exists(cfg): os.remove(cfg)
after = {k: md5(os.path.join(ROOT, v)) for k, v in F.items()}
if after != before: print('FILES NOT RESTORED:', [k for k in F if after[k] != before[k]]); sys.exit(3)
print(f'\nmutants caught: {caught}/{n}   (every file restored byte-identical)' + (f'   NOT caught / invalid: {bad}' if bad else ''))
sys.exit(1 if bad else 0)
