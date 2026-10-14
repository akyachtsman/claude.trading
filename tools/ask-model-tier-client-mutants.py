#!/usr/bin/env python3
"""Mutation run for the Ask model switch's CLIENT guards: delete or invert each guard in scripts/app.js,
scripts/data.js, styles/components.css or styles/layout.css, run scenario S69 on the desktop project, and require it
to FAIL. A guard whose removal leaves S69 green is a guard nothing checks.

    python3 tools/ask-model-tier-client-mutants.py            # every mutant
    python3 tools/ask-model-tier-client-mutants.py --list     # names only
    python3 tools/ask-model-tier-client-mutants.py focus      # only mutants whose name contains "focus"

Projects: desktop, mobile-chrome and tablet-chromium (the kit's tablet project's iPad descriptor run as CHROMIUM — the
sandbox cannot launch WebKit; it stands in for the tightest stacked width, 810px). MUT_PROJECTS overrides the list.
Needs: the kit's node_modules (`npm ci --prefix .github/scripts/ui-tests`) and a Chromium. The UI suite's own
Playwright download may not run in a sandbox; set PW_CHROMIUM to a browser binary (default
/opt/pw-browsers/chromium). The runner starts its own static server on MUT_PORT (default 8791) and writes a
throwaway config next to the kit's playwright.config.js (removed afterwards). Each file is restored after every
mutant, also on an error. WebKit is not used: this checks the guards, not the cross-browser look.
Not run by CI. The counts quoted in docs/architecture/desk-ask-and-cron.md come from this file."""
import os, re, subprocess, sys, tempfile, time
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
KIT = os.path.join(ROOT, '.github/scripts/ui-tests')
F = {'app': 'scripts/app.js', 'data': 'scripts/data.js', 'css': 'styles/components.css', 'layout': 'styles/layout.css',
     'spec': '.github/scripts/ui-tests/tests/app.spec.js'}   # the shared sweep helper blockRosterWrites lives in the spec file
PORT = os.environ.get('MUT_PORT', '8791')
CHROMIUM = os.environ.get('PW_CHROMIUM', '/opt/pw-browsers/chromium')
PROJECTS = os.environ.get('MUT_PROJECTS', 'desktop,mobile-chrome,tablet-chromium').split(',')

M = [
 ('handler guard removed (askTierWrite no longer asks the guard)', 'app', [("  if (!askTierCanChoose(askTier)) return;\n  if (!ASK_MODELS.some(m => m.id === id) || id === askTier.stored) return;", "  if (!ASK_MODELS.some(m => m.id === id) || id === askTier.stored) return;")]),
 ('guard always says yes', 'app', [("const askTierCanChoose = t => t.phase === 'stored';", "const askTierCanChoose = t => true;")]),
 ('guard also allows the unread phase', 'app', [("const askTierCanChoose = t => t.phase === 'stored';", "const askTierCanChoose = t => t.phase === 'stored' || t.phase === 'unread';")]),
 ('guard also allows the failed phase', 'app', [("const askTierCanChoose = t => t.phase === 'stored';", "const askTierCanChoose = t => t.phase === 'stored' || t.phase === 'failed';")]),
 ('saving does not disable the control', 'app', [("askTierSet({ phase: 'saving', note: 'Saving…' });", "askTierSet({ note: 'Saving…' });")]),
 ('optimistic selection (the clicked model is drawn before the server answers)', 'app', [("askTierSet({ phase: 'saving', note: 'Saving…' });", "askTierSet({ phase: 'saving', stored: id, note: 'Saving…' });")]),
 ('selection follows the clicked model, not the one the server stored', 'app', [("askTierSet({ phase: 'stored', stored: out.model, note: 'Saved — applies from your next question.' });", "askTierSet({ phase: 'stored', stored: id, note: 'Saved — applies from your next question.' });")]),
 ('saved wording claims the model is in use', 'app', [("'Saved — applies from your next question.'", "'Saved — now in use.'")]),
 ('a refused write does not re-read (it just stops)', 'app', [("    await askTierRead(pin, true);\n  }\n}", "    askTierSet({ phase: 'stored', note: 'Not saved.' });\n  }\n}")]),
 ('the built-in default is drawn as if stored when the row is empty', 'app', [("askTierSet({ phase: 'empty', stored: null, note: lead + 'No model setting", "askTierSet({ phase: 'stored', stored: ASK_MODELS[0].id, note: lead + 'No model setting")]),
 ('a stored model the page does not offer is accepted', 'app', [("} else if (ASK_MODELS.some(m => m.id === out.model)) {", "} else if (true) {")]),
 ('read generation guard removed', 'app', [("  const out = await deskGetAskModel(pin);\n  if (gen !== askTierGen) return;", "  const out = await deskGetAskModel(pin);")]),
 ('write generation guard removed', 'app', [("  const out = await deskSetAskModel(pin, id);\n  if (gen !== askTierGen) {", "  const out = await deskSetAskModel(pin, id);\n  if (false) {")]),
 ('a superseded save does not re-read the row (the rebuild\'s stale read is the last word)', 'app', [("    if (askTierPaint) askTierRead(pin);\n    return;", "    return;")]),
 ('a superseded save re-reads even after a Lock (no panel, no PIN)', 'app', [("    if (askTierPaint) askTierRead(pin);\n    return;", "    askTierRead(pin);\n    return;")]),
 ('renderAsk no longer resets the switch state', 'app', [("  askTierReset();   /* an unlocked render re-reads below; a demo, open or locked one leaves nothing behind */\n", "")]),
 ('the switch is drawn for a visitor', 'app', [("if (authed) body.appendChild(tierBox);", "body.appendChild(tierBox);")]),
 ('the database is read for a visitor', 'app', [("if (authed) { askTierPaint = paintTier; paintTier(); askTierRead(pin); }", "{ askTierPaint = paintTier; paintTier(); askTierRead(pin); }")]),
 ('the proof line is drawn for a visitor', 'app', [("if (!authed || !res || typeof res.model !== 'string' || !res.model) return;", "if (!res || typeof res.model !== 'string' || !res.model) return;")]),
 ('a fallback is claimed when the server named no source', 'app', [("const fallback = !!named && named !== 'row';", "const fallback = named !== 'row';")]),
 ('a fallback is never claimed', 'app', [("const fallback = !!named && named !== 'row';", "const fallback = false;")]),
 ('a failed question does not name its model', 'app', [("|| 'Something went wrong — try again.') + askedModelTag(res);", "|| 'Something went wrong — try again.');")]),
 ('the retry button is never shown', 'app', [("tierRetry.hidden = !(askTier.phase === 'failed' || askTier.phase === 'empty');", "tierRetry.hidden = true;")]),
 ('the switch is put inside .ask-toolbar (hidden on a desk with no history)', 'app', [("body.appendChild(thread); if (authed) body.appendChild(tierBox); body.appendChild(form);", "body.appendChild(thread); if (authed) toolbar.appendChild(tierBox); body.appendChild(form);")]),
 ('`disabled` is never set from the guard', 'app', [("      b.disabled = !can;\n", "      b.disabled = false;\n")]),
 ('aria-pressed is never set from the state', 'app', [("b.setAttribute('aria-pressed', b.dataset.model === shown ? 'true' : 'false');", "b.setAttribute('aria-pressed', 'false');")]),
 ('the group has no accessible name', 'app', [("tierGroup.setAttribute('role', 'group'); tierGroup.setAttribute('aria-label', 'Ask-the-desk model');", "tierGroup.setAttribute('role', 'group');")]),
 ('no read at render', 'app', [("paintTier(); askTierRead(pin); }", "paintTier(); }")]),
 ('the read is sent without the PIN', 'app', [("const out = await deskGetAskModel(pin);", "const out = await deskGetAskModel(null);")]),
 ('the write is sent without the PIN', 'app', [("const out = await deskSetAskModel(pin, id);", "const out = await deskSetAskModel(null, id);")]),
 ('the note is not announced', 'app', [("tierNote.setAttribute('role', 'status');", "")]),
 ('the standing caption is gone', 'app', [("  tierBox.appendChild(el('span', 'ask-tier-cap', 'Applies to every question, visitors included.'));\n", "")]),
 ('the proof line is never drawn', 'app', [("      appendModelProof(res);\n", "")]),
 ('choosing the already-chosen model writes', 'app', [("  if (!ASK_MODELS.some(m => m.id === id) || id === askTier.stored) return;", "  if (!ASK_MODELS.some(m => m.id === id)) return;")]),
 ('an unknown model id can be written', 'app', [("  if (!ASK_MODELS.some(m => m.id === id) || id === askTier.stored) return;", "  if (id === askTier.stored) return;")]),
 ('keyboard focus is not given back after a save', 'app', [("f.focus({ preventScroll: true });", "void 0;")]),
 ('a failed save or retry leaves focus on <body> (Try again is not given focus)', 'app', [("tierRetry.focus({ preventScroll: true });", "void 0;")]),
 ('a click that writes nothing arms the focus return', 'app', [("if (askTierCanChoose(askTier) && m.id !== askTier.stored) tierRefocus = m.id;", "tierRefocus = m.id;")]),
 ('Try again does not hand focus on', 'app', [("tierRetry.addEventListener('click', () => { tierRefocus = '*'; askTierRead(pin); });", "tierRetry.addEventListener('click', () => { askTierRead(pin); });")]),
 ('wrong function name on the read', 'data', [("deskRpcOk('desk_get_ask_model', pin)", "deskRpcOk('desk_get_askmodel', pin)")]),
 ('wrong function name on the write', 'data', [("deskRpcOk('desk_set_ask_model', pin,", "deskRpcOk('desk_set_askmodel', pin,")]),
 ('wrong argument name on the write', 'data', [("{ new_model: model }", "{ model }")]),
 ('askModelLabel ignores a dated id', 'data', [(" || ASK_MODELS.find(m => s.startsWith(m.id + '-'))", "")]),
 ('askModelLabel matches a prefix without the dash', 'data', [("s.startsWith(m.id + '-')", "s.startsWith(m.id)")]),
 ('ASK_MODELS order swapped (parity and the labels)', 'data', [("  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },\n  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },", "  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },\n  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },")]),
 ('ASK_MODELS offers a fourth model', 'data', [("  { id: 'claude-opus-5-5', label: 'Opus 5.5' },\n];", "  { id: 'claude-opus-5-5', label: 'Opus 5.5' },\n  { id: 'claude-fable-5-1', label: 'Fable 5.1' },\n];")]),
 ('ASK_MODELS drops Opus', 'data', [("  { id: 'claude-opus-5-5', label: 'Opus 5.5' },\n];", "];")]),
 ('CSS: a class that sets display outranks [hidden] on the retry button', 'css', [(".ask-tier-retry { min-height: 30px;", ".ask-tier-retry { display: inline-flex; min-height: 30px;")]),
 ('CSS: the options lose their tap-target height', 'css', [(" min-height: 30px; cursor: pointer; }\n.ask-tier-opt + .ask-tier-opt", " cursor: pointer; }\n.ask-tier-opt + .ask-tier-opt")]),
 ('CSS: the touch target is no taller than the desktop one', 'css', [("@media (hover: none) { .ask-tier-opt { min-height: 40px; } }\n", "")]),
 ('layout: the stacked cap is not raised for the owner\'s switch row (answers squeezed to 0px at 810)', 'layout', [("  @media (max-width: 1119px) { .top-boxes > .col-rail > .panel:has(.ask-tier) { max-height: 560px; } }\n", "")]),
 # ── ui-tester round 3 and the coverage review ──
 ('the thread is not kept at its end when the switch row\'s note changes (the newest proof line slides out of view)', 'app', [("    tierNote.textContent = askTier.note;\n    if (atEnd) thread.scrollTop = thread.scrollHeight;\n", "    tierNote.textContent = askTier.note;\n")]),
 ('a thread the owner scrolled UP is dragged to its end by every note', 'app', [("const atEnd = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 4;", "const atEnd = true;")]),
 ('CSS: a long unbroken provider path in the error line is not wrapped (sideways page scroll at phone width)', 'css', [("margin: var(--space-2) 0 0; overflow-wrap: anywhere; }", "margin: var(--space-2) 0 0; }")]),
 ('CSS: the options give no hover feedback', 'css', [(".ask-tier-opt:hover:not(:disabled):not([aria-pressed=\"true\"]) { background: var(--color-surface-2); }\n", "")]),
 ('CSS: the chosen model is not marked in forced-colours mode', 'css', [("@media (forced-colors: active) { .ask-tier-opt[aria-pressed=\"true\"] { text-decoration: underline; text-underline-offset: 3px; } }\n", "")]),
 ('a visitor is told which model a failed question asked for', 'app', [("const askedModelTag = res => (authed && res && typeof res.model === 'string' && res.model)", "const askedModelTag = res => (res && typeof res.model === 'string' && res.model)")]),
 ('deskAsk rebuilds its result and drops the owner\'s proof fields', 'data', [("which this function must never rebuild away. */\n  return out;", "which this function must never rebuild away. */\n  return { ok: out.ok, answer: out.answer, sources: out.sources, error: out.error };")]),
 ('a control that became disabled but is still REPORTED as the active element does not count as lost focus (engines differ; CI caught it)', 'app', [("const lost = !a || a === document.body || (tierBox.contains(a) && (a.disabled || a.hidden));", "const lost = !a || a === document.body || (a === tierRetry && tierRetry.hidden);")]),
 ('the sweeps\' shared guard no longer intercepts a write of the model tier', 'spec', [("  await page.route('**/rest/v1/rpc/desk_set_ask_model*', (route) => {\n    blocked.tierWrites++;\n    return route.fulfill({ status: 200, contentType: 'application/json',\n      body: JSON.stringify({ ok: false }) });\n  });\n", "")]),
]

def run_s69(env):
    try:
        return subprocess.run(['node_modules/.bin/playwright', 'test', '-c', '.pw-mutants.config.mjs', '-g', 'S69', *[f'--project={x}' for x in PROJECTS], '--output', OUT],
                              cwd=KIT, env=env, capture_output=True, text=True, timeout=170)
    except subprocess.TimeoutExpired as e:
        return subprocess.CompletedProcess(e.cmd, 124, (e.stdout or b'').decode() if isinstance(e.stdout, bytes) else (e.stdout or ''), 'HARNESS TIMEOUT')

# A non-zero exit only counts as a catch when Playwright reports a FAILED TEST: a browser that would not launch, a server that was
# not listening or a timeout of the whole run says nothing about the guard.
INFRA = re.compile(r"browserType\.launch|Executable doesn't exist|ERR_CONNECTION_REFUSED|ECONNREFUSED|No tests found|HARNESS TIMEOUT|Cannot find module")
def is_catch(out):
    return bool(re.search(r'\b\d+ failed\b', out)) and not INFRA.search(out)

if '--list' in sys.argv:
    print('\n'.join(n for n, *_ in M)); sys.exit(0)
only = [a for a in sys.argv[1:] if not a.startswith('--')]
OUT = tempfile.mkdtemp(prefix='ask-tier-mut-')
cfg = os.path.join(KIT, '.pw-mutants.config.mjs')
open(cfg, 'w').write(f"""import base from './playwright.config.js';
const by = (n) => base.projects.find((p) => p.name === n);
const chromium = (p, name) => ({{ ...p, name, use: {{ ...p.use, browserName: 'chromium', defaultBrowserType: 'chromium', launchOptions: {{ executablePath: {CHROMIUM!r}, args: ['--no-sandbox'] }} }} }});
export default {{ ...base, retries: 0, reporter: [['list']],
  projects: [chromium(by('desktop'), 'desktop'), chromium(by('mobile-chrome'), 'mobile-chrome'), chromium(by('tablet'), 'tablet-chromium'), chromium(by('iphone'), 'iphone-chromium')] }};
""")
server = subprocess.Popen([os.path.join(KIT, 'node_modules/.bin/http-server'), '-p', PORT, '-c-1', '-s', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
env = dict(os.environ, APP_URL=f'http://127.0.0.1:{PORT}/')
n = caught = 0; bad = []
try:
    time.sleep(1.5)
    base = run_s69(env)
    if base.returncode != 0:
        print('BASELINE FAILS — S69 is not green on the unmutated tree; fix that first.\n' + (base.stdout + base.stderr)[-1500:]); sys.exit(2)
    print('baseline: S69 green on ' + ', '.join(PROJECTS) + '\n')
    for name, key, edits in M:
        if only and not any(o in name for o in only): continue
        path = os.path.join(ROOT, F[key]); orig = open(path).read(); mut = orig; ok = True
        for a, b in edits:
            if mut.count(a) != 1: ok = False; print(f'INVALID   {name}  (anchor x{mut.count(a)})'); bad.append(name); break
            mut = mut.replace(a, b)
        if not ok: continue
        n += 1
        try:
            open(path, 'w').write(mut); r = run_s69(env)
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
print(f'\nmutants caught: {caught}/{n}' + (f'   NOT caught / invalid: {bad}' if bad else ''))
sys.exit(1 if bad else 0)
