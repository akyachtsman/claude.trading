'use strict';
// Default scheduled-task entry point — runs from .github/scripts/ via cron-notify.yml.
// Ships in every project; replace the marked section with your real notification.
//
// Mandatory repo setup (NEW-REPO-USER-INSTRUCTIONS Step 1): SMTP_HOST, SMTP_USER,
// ALERT_TO (Variables) + SMTP_PASS (Secret). If any is missing, this emits a
// GitHub Actions notice and exits 0 — a misconfigured repo is then obvious in the
// Actions log instead of crashing cryptically.
const { sendEmail } = require('./notify-email.js'); // ready for your logic below

const REQUIRED = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'ALERT_TO'];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.log(
    `::warning title=Email alerts not configured::Set ${missing.join(', ')} in ` +
      `Settings → Secrets and variables → Actions (see docs/guides/cron-email-notifications.md). Skipping.`
  );
  process.exit(0);
}

async function main() {
  // ── Replace with your project's notification logic ──────────────────────────
  // Transport is configured and verified above. Example:
  //   await sendEmail({ subject: 'Daily summary', text: buildSummary() });
  console.log('Email transport configured. Add your scheduled notification in notify-task.js.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
