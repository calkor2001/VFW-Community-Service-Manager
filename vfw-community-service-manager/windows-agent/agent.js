require('dotenv').config();
const { chromium } = require('playwright');

const MANAGER_URL = String(process.env.MANAGER_URL || '').replace(/\/$/, '');
const AGENT_TOKEN = String(process.env.LOCAL_AGENT_TOKEN || '');
const POLL_SECONDS = Math.max(15, Number(process.env.POLL_SECONDS || 30));
const VFW_MEMBER_ID = String(process.env.VFW_MEMBER_ID || '');
const VFW_PASSWORD = String(process.env.VFW_PASSWORD || '');
const VFW_SUBMITTER_EMAIL = String(process.env.VFW_SUBMITTER_EMAIL || 'vfwcarmel@yahoo.com');
const MEMBERS_URL = 'https://vfwin.org/di/vfw/v2/default.asp?nid=10';
const REPORTING_URL = 'https://vfwin.org/di/vfw/v2/default.asp?nid=10&cmr=INCSR#c';

if (!MANAGER_URL || !AGENT_TOKEN) {
  console.error('MANAGER_URL and LOCAL_AGENT_TOKEN are required in .env');
  process.exit(1);
}
if (!VFW_MEMBER_ID || !VFW_PASSWORD) {
  console.error('VFW_MEMBER_ID and VFW_PASSWORD are required in the local .env file.');
  process.exit(1);
}

let busy = false;

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
  try {
    await manager(`/api/agent/reports/${id}/error`, {
      method: 'POST',
      body: JSON.stringify({ error: err.message || String(err) })
    });
  } catch (_) {}
}

async function firstVisible(locators) {
  for (const locator of locators) {
    try {
      if ((await locator.count()) > 0 && (await locator.first().isVisible())) return locator.first();
    } catch (_) {}
  }
  return null;
}

async function login(page) {
  console.log('Opening VFW Indiana Members Only page...');
  await page.goto(MEMBERS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1000);

  const username = page.locator('input[name="username"]').first();
  const password = page.locator('input[name="password"]').first();
  const loginButton = page.locator('input[type="image"][name="login"]').first();

  const usernameCount = await username.count();
  const passwordCount = await password.count();
  const loginCount = await loginButton.count();

  if (passwordCount === 0) {
    const programLink = page.getByText('Program Reporting', { exact: true });
    if ((await programLink.count()) > 0) {
      console.log('Existing authenticated VFW Indiana session detected.');
      return;
    }
    throw new Error('Could not find the VFW login form or an authenticated member page.');
  }

  if (usernameCount === 0 || passwordCount === 0 || loginCount === 0) {
    const inputs = await page.locator('input').evaluateAll(nodes => nodes.map(n => ({
      type: n.type || '',
      name: n.name || '',
      id: n.id || '',
      src: n.getAttribute('src') || ''
    })));
    console.log('LOGIN FIELD DEBUG:', JSON.stringify(inputs));
    throw new Error('Could not map the VFW Indiana login controls.');
  }

  await username.fill(VFW_MEMBER_ID, { force: true });
  await password.fill(VFW_PASSWORD, { force: true });
  console.log('VFW credentials entered locally.');

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
    loginButton.click({ position: { x: 5, y: 5 }, force: true })
  ]);
  await page.waitForTimeout(1500);

  const body = await page.locator('body').innerText();
  if (/500\s*-?\s*internal server error/i.test(body)) throw new Error('VFW Indiana returned an HTTP 500 during local login.');
  if (/invalid.*password|incorrect.*password|login failed|invalid.*member/i.test(body)) throw new Error('VFW Indiana rejected the local login credentials.');

  const programLink = page.getByText('Program Reporting', { exact: true });
  if ((await programLink.count()) === 0) {
    console.log('POST-LOGIN URL:', page.url());
    throw new Error('Local VFW login completed, but Program Reporting was not found.');
  }
  console.log('VFW Indiana login successful.');
}

async function openReporting(page) {
  console.log('Opening Program Reporting...');
  await page.goto(REPORTING_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1000);
  const body = await page.locator('body').innerText();
  if (!/VFW Department of Indiana\s+Program Reporting/i.test(body) && !/Program Reporting/i.test(body)) {
    throw new Error('Program Reporting page did not load as expected.');
  }
}

async function fillReportingForm(page, report) {
  const selects = page.locator('select');
  if ((await selects.count()) >= 1) {
    try { if (String(await selects.nth(0).inputValue()) !== '10003') await selects.nth(0).selectOption('10003'); } catch (_) {}
  }
  if ((await selects.count()) >= 2) {
    try { if (String(await selects.nth(1).inputValue()) !== '6') await selects.nth(1).selectOption('6'); } catch (_) {}
  }

  let email = await firstVisible([
    page.getByLabel(/submitter email/i),
    page.locator('input[type="email"]'),
    page.locator('input[name*="email" i]'),
    page.locator('input[id*="email" i]')
  ]);
  const visibleTextInputs = page.locator('input[type="text"]:visible');
  if (!email && (await visibleTextInputs.count()) > 0) email = visibleTextInputs.nth(0);
  if (!email) throw new Error('Could not locate Submitter Email field.');
  await email.fill(VFW_SUBMITTER_EMAIL);

  const date = await firstVisible([
    page.getByLabel(/date of activity/i),
    page.locator('input[type="date"]')
  ]);
  if (!date) throw new Error('Could not locate Date of Activity field.');
  await date.fill(String(report.date_of_service || ''));

  const radio = await firstVisible([
    page.getByRole('radio', { name: /community service/i }),
    page.locator('input[type="radio"]')
  ]);
  if (!radio) throw new Error('Could not locate Community Service program radio button.');
  try { await radio.check(); } catch (_) { await radio.click(); }

  let hours = await firstVisible([
    page.getByLabel(/cumulative hours/i),
    page.locator('input[name*="hour" i]'),
    page.locator('input[id*="hour" i]')
  ]);
  let miles = await firstVisible([
    page.getByLabel(/^miles/i),
    page.locator('input[name*="mile" i]'),
    page.locator('input[id*="mile" i]')
  ]);
  let members = await firstVisible([
    page.getByLabel(/^members/i),
    page.locator('input[name*="member" i]'),
    page.locator('input[id*="member" i]')
  ]);
  let dollars = await firstVisible([
    page.getByLabel(/dollars.*spent|dollars.*donated|spent.*donated/i),
    page.locator('input[name*="dollar" i]'),
    page.locator('input[id*="dollar" i]')
  ]);

  const numberInputs = page.locator('input[type="number"]:visible');
  if (!hours && (await numberInputs.count()) >= 1) hours = numberInputs.nth(0);
  if (!miles && (await numberInputs.count()) >= 2) miles = numberInputs.nth(1);
  if (!members && (await numberInputs.count()) >= 3) members = numberInputs.nth(2);
  if (!dollars && (await numberInputs.count()) >= 4) dollars = numberInputs.nth(3);

  if (!hours || !miles || !members || !dollars) {
    const textInputs = page.locator('input[type="text"]:visible');
    const count = await textInputs.count();
    if (!hours && count >= 2) hours = textInputs.nth(1);
    if (!miles && count >= 3) miles = textInputs.nth(2);
    if (!members && count >= 4) members = textInputs.nth(3);
    if (!dollars && count >= 5) dollars = textInputs.nth(4);
  }

  if (!hours || !miles || !members || !dollars) throw new Error('Could not map all four numeric Program Reporting fields.');

  await hours.fill(String(report.volunteer_hours ?? 0));
  await miles.fill(String(report.miles_traveled ?? 0));
  await members.fill(String(report.vfw_members_participating ?? 1));
  await dollars.fill(String(report.money_or_donations ?? 0));

  const description = await firstVisible([
    page.getByLabel(/description/i),
    page.locator('textarea')
  ]);
  if (!description) throw new Error('Could not locate Description field.');
  await description.fill(String(report.proposed_description || report.activity_description || ''));

  console.log('VFW Indiana form populated successfully. FINAL SUBMIT WAS NOT CLICKED.');
}

async function prepareInVfw(report) {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chrome',
    headless: false,
    viewport: null
  });
  const pages = context.pages();
  const page = pages.length ? pages[0] : await context.newPage();

  try {
    console.log(`Preparing VFW Indiana form locally for report #${report.id}...`);
    await login(page);
    await openReporting(page);
    await fillReportingForm(page, report);

    try {
      await manager(`/api/agent/reports/${report.id}/prepared`, {
        method: 'POST',
        body: JSON.stringify({ note: 'VFW Indiana form populated locally. Awaiting human review; final SUBMIT was not clicked.' })
      });
      console.log(`Report #${report.id} marked PREPARED in the dashboard.`);
    } catch (callbackErr) {
      console.error('Could not mark report Prepared in dashboard:', callbackErr.message || callbackErr);
    }

    console.log('Chrome will remain open for review. Close that Chrome window when you are finished.');
    await new Promise(resolve => context.on('close', resolve));
  } catch (err) {
    console.error(err.message || err);
    console.log('Keeping Chrome open for manual review despite the error. Close the Chrome window when finished.');
    await new Promise(resolve => context.on('close', resolve));
    throw err;
  }
}

async function tick() {
  if (busy) return;
  busy = true;
  let job;
  try {
    job = await manager('/api/agent/next');
    if (!job) return;
    console.log(`Found approved report #${job.report.id}: ${job.report.submitter_name}`);
    await prepareInVfw(job.report);
  } catch (err) {
    console.error(err.message || err);
    if (job && job.report) await reportError(job.report.id, err);
  } finally {
    busy = false;
  }
}

console.log(`VFW Windows Submit Agent started. Polling ${MANAGER_URL} every ${POLL_SECONDS}s.`);
tick();
setInterval(tick, POLL_SECONDS * 1000);
