require('dotenv').config();
const { chromium } = require('playwright');

const MANAGER_URL = String(process.env.MANAGER_URL || '').replace(/\/$/, '');
const AGENT_TOKEN = String(process.env.LOCAL_AGENT_TOKEN || '');
const POLL_SECONDS = Math.max(15, Number(process.env.POLL_SECONDS || 30));

if (!MANAGER_URL || !AGENT_TOKEN) {
  console.error('MANAGER_URL and LOCAL_AGENT_TOKEN are required in .env');
  process.exit(1);
}

async function manager(path, options = {}) {
  const r = await fetch(MANAGER_URL + path, {
    ...options,
    headers: { 'x-agent-token': AGENT_TOKEN, 'content-type': 'application/json', ...(options.headers || {}) }
  });
  if (r.status === 204) return null;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Manager HTTP ${r.status}`);
  return data;
}

async function reportError(id, err) {
  try { await manager(`/api/agent/reports/${id}/error`, { method:'POST', body:JSON.stringify({ error: err.message || String(err) }) }); } catch (_) {}
}

async function submitToVfw(report) {
  // This intentionally uses a visible, installed Chrome on the user's Windows PC.
  // The next setup step will map the live VFW Indiana form fields after a successful local login.
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    console.log(`Opening VFW Indiana locally for approved report #${report.id}...`);
    await page.goto('https://vfwin.org/di/vfw/v2/default.asp?nid=10', { waitUntil:'domcontentloaded', timeout:60000 });
    console.log('Chrome is open locally. This first agent version stops before entering credentials or submitting data.');
    console.log('Once local connectivity/login is confirmed, the form mapping can be completed safely.');
    await page.waitForTimeout(15000);
    throw new Error('LOCAL_AGENT_SETUP_REQUIRED: Local Chrome launch succeeded. VFW login/form mapping still needs to be completed before automatic submission is enabled.');
  } finally {
    await browser.close();
  }
}

async function tick() {
  let job;
  try {
    job = await manager('/api/agent/next');
    if (!job) return;
    console.log(`Found approved report #${job.report.id}: ${job.report.submitter_name}`);
    await submitToVfw(job.report);
    await manager(`/api/agent/reports/${job.report.id}/submitted`, { method:'POST', body:JSON.stringify({ confirmation:'Submitted from local Windows agent.' }) });
    console.log(`Report #${job.report.id} marked submitted.`);
  } catch (err) {
    console.error(err.message || err);
    if (job && job.report) await reportError(job.report.id, err);
  }
}

console.log(`VFW Windows Submit Agent started. Polling ${MANAGER_URL} every ${POLL_SECONDS}s.`);
tick();
setInterval(tick, POLL_SECONDS * 1000);
