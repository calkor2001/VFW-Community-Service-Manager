const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const MEMBERS_URL = process.env.VFW_MEMBERS_URL;
const PROGRAM_REPORTING_URL = process.env.VFW_PROGRAM_REPORTING_URL;
const MEMBER_ID = process.env.VFW_MEMBER_ID;
const PASSWORD = process.env.VFW_PASSWORD;
const POST = process.env.VFW_POST || '10003';
const DISTRICT = process.env.VFW_DISTRICT || '6';
const SUBMITTER_EMAIL = process.env.VFW_SUBMITTER_EMAIL || 'vfwcarmel@yahoo.com';
const ALLOW_FINAL_SUBMIT = String(process.env.VFW_ALLOW_FINAL_SUBMIT || 'false').toLowerCase() === 'true';

function requireEnv(name, value) {
  if (!value) throw new Error(`${name} environment variable is not configured.`);
}

async function firstVisible(locators) {
  for (const locator of locators) {
    try {
      if ((await locator.count()) > 0 && (await locator.first().isVisible())) return locator.first();
    } catch (_) {}
  }
  return null;
}

async function screenshot(page, reportId, suffix) {
  const dir = path.join(__dirname, 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  const filename = `report-${reportId}-${suffix}-${Date.now()}.png`;
  await page.screenshot({ path: path.join(dir, filename), fullPage: true });
  return `/screenshots/${filename}`;
}

async function getPasswordField(page) {
  return firstVisible([
    page.locator('input[type="password"]'),
    page.getByLabel(/password/i),
    page.getByPlaceholder(/password/i),
    page.locator('input[name*="pass" i]'),
    page.locator('input[id*="pass" i]')
  ]);
}

function sanitizeText(text, limit = 1200) {
  let out = String(text || '');
  if (MEMBER_ID) out = out.split(MEMBER_ID).join('[MEMBER_ID]');
  if (PASSWORD) out = out.split(PASSWORD).join('[PASSWORD]');
  return out.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function sanitizeUrl(url) {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (/pass|password|member|user|login|credential/i.test(key)) {
        u.searchParams.set(key, '[REDACTED]');
      }
    }
    return u.toString();
  } catch (_) {
    return sanitizeText(url, 500);
  }
}

function sanitizePostData(postData) {
  if (!postData) return '[none]';
  try {
    const params = new URLSearchParams(postData);
    const safe = [];
    for (const [key, value] of params.entries()) {
      if (/pass|password|user|username|member|credential/i.test(key)) {
        safe.push([key, `[REDACTED len=${String(value).length}]`]);
      } else {
        safe.push([key, sanitizeText(value, 120)]);
      }
    }
    return safe.map(([k, v]) => `${k}=${v}`).join('&');
  } catch (_) {
    return sanitizeText(postData, 1000);
  }
}

function safeRequestHeaders(headers) {
  const allowed = [
    'content-type',
    'content-length',
    'origin',
    'referer',
    'user-agent',
    'accept',
    'accept-language',
    'sec-fetch-dest',
    'sec-fetch-mode',
    'sec-fetch-site',
    'sec-fetch-user'
  ];
  const out = {};
  for (const key of allowed) {
    if (headers[key]) out[key] = sanitizeText(headers[key], 500);
  }
  return out;
}

async function logLoginFormDiagnostics(page, loginForm) {
  try {
    const info = await loginForm.evaluate(form => ({
      actionAttribute: form.getAttribute('action') || '',
      resolvedAction: form.action || '',
      method: (form.getAttribute('method') || 'GET').toUpperCase(),
      enctype: form.getAttribute('enctype') || '',
      target: form.getAttribute('target') || '',
      inputs: [...form.querySelectorAll('input,button,select,textarea')].map(el => ({
        tag: el.tagName.toLowerCase(),
        type: (el.getAttribute('type') || '').toLowerCase(),
        name: el.getAttribute('name') || '',
        id: el.getAttribute('id') || '',
        src: el.getAttribute('src') || '',
        valuePresent: Boolean(el.value),
        valueLength: String(el.value || '').length
      }))
    }));

    console.log('LOGIN FORM ACTION ATTRIBUTE:', sanitizeUrl(info.actionAttribute || page.url()));
    console.log('LOGIN FORM RESOLVED ACTION:', sanitizeUrl(info.resolvedAction || page.url()));
    console.log('LOGIN FORM METHOD:', info.method);
    console.log('LOGIN FORM ENCTYPE:', info.enctype || '[default application/x-www-form-urlencoded]');
    console.log('LOGIN FORM TARGET:', info.target || '[same browsing context]');
    console.log('LOGIN FORM FIELD METADATA:', JSON.stringify(info.inputs));
  } catch (err) {
    console.log('LOGIN FORM DIAGNOSTIC ERROR:', err.message);
  }
}

async function login(page) {
  requireEnv('VFW_MEMBERS_URL', MEMBERS_URL);
  requireEnv('VFW_MEMBER_ID', MEMBER_ID);
  requireEnv('VFW_PASSWORD', PASSWORD);

  console.log('Opening VFW Indiana members page...');
  await page.goto(MEMBERS_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1000);

  let passwordInput = await getPasswordField(page);
  let bodyText = await page.locator('body').innerText();

  if (!passwordInput) {
    if (/change profile|program reporting|log out/i.test(bodyText)) {
      console.log('No password field is visible; authenticated VFW Indiana session detected.');
      return;
    }
    throw new Error('Could not find either the VFW login form or a confirmed authenticated member page.');
  }

  console.log('VFW login form detected. Authentication is required.');

  const loginForm = passwordInput.locator('xpath=ancestor::form[1]');
  if ((await loginForm.count()) === 0) {
    throw new Error('Could not locate the VFW Indiana login form containing the password field.');
  }

  await logLoginFormDiagnostics(page, loginForm);

  const memberInput = await firstVisible([
    loginForm.locator('input[name="username" i]'),
    loginForm.locator('input[name*="member" i]'),
    loginForm.locator('input[id*="member" i]'),
    loginForm.locator('input[name*="user" i]'),
    loginForm.locator('input[id*="user" i]'),
    loginForm.locator('input[type="text"]')
  ]);

  if (!memberInput) throw new Error('Could not locate the Member ID field inside the VFW login form.');

  await memberInput.fill(MEMBER_ID);
  await passwordInput.fill(PASSWORD);
  console.log('VFW credentials entered.');

  const context = page.context();
  const cookiesBefore = await context.cookies('https://vfwin.org');
  console.log('PRE-LOGIN VFW COOKIE NAMES:', cookiesBefore.map(c => `${c.name}@${c.domain}`).join(', ') || '[none]');

  const requestDiagnostics = [];
  const responseDiagnostics = [];

  const onRequest = request => {
    try {
      if (!/vfwin\.org/i.test(request.url())) return;
      if (request.method() !== 'POST') return;

      requestDiagnostics.push({
        method: request.method(),
        url: sanitizeUrl(request.url()),
        navigation: request.isNavigationRequest(),
        resourceType: request.resourceType(),
        headers: safeRequestHeaders(request.headers()),
        postData: sanitizePostData(request.postData())
      });
    } catch (err) {
      console.log('LOGIN REQUEST DIAGNOSTIC ERROR:', err.message);
    }
  };

  const onResponse = response => {
    try {
      if (!/vfwin\.org/i.test(response.url())) return;
      const req = response.request();
      if (req.method() !== 'POST' && !req.isNavigationRequest()) return;

      responseDiagnostics.push({
        status: response.status(),
        statusText: response.statusText(),
        method: req.method(),
        url: sanitizeUrl(response.url()),
        location: response.headers()['location'] || '',
        server: response.headers()['server'] || '',
        contentType: response.headers()['content-type'] || ''
      });
    } catch (_) {}
  };

  page.on('request', onRequest);
  page.on('response', onResponse);

  const imageLogin = await firstVisible([
    loginForm.locator('input[type="image"][name="login" i]'),
    loginForm.locator('input[type="image"]')
  ]);

  const normalSubmit = await firstVisible([
    loginForm.locator('input[type="submit"]'),
    loginForm.locator('button[type="submit"]'),
    loginForm.locator('button').filter({ hasText: /login|log in|sign in|submit/i })
  ]);

  console.log('LOGIN SUBMIT CONTROL:', imageLogin ? 'image input' : normalSubmit ? 'normal submit' : 'Enter-key fallback');
  console.log('Submitting VFW Indiana login form...');

  if (imageLogin) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
      imageLogin.click({ position: { x: 5, y: 5 } })
    ]);
  } else if (normalSubmit) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
      normalSubmit.click()
    ]);
  } else {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
      passwordInput.press('Enter')
    ]);
  }

  await page.waitForTimeout(1800);
  page.off('request', onRequest);
  page.off('response', onResponse);

  bodyText = await page.locator('body').innerText();
  passwordInput = await getPasswordField(page);
  const title = await page.title();
  const cookiesAfter = await context.cookies('https://vfwin.org');

  console.log('LOGIN POST REQUEST DIAGNOSTICS:', JSON.stringify(requestDiagnostics.slice(-10)));
  console.log('LOGIN RESPONSE DIAGNOSTICS:', JSON.stringify(responseDiagnostics.slice(-20)));
  console.log('POST-LOGIN URL:', sanitizeUrl(page.url()));
  console.log('POST-LOGIN TITLE:', sanitizeText(title));
  console.log('POST-LOGIN PASSWORD FIELD VISIBLE:', Boolean(passwordInput));
  console.log('POST-LOGIN VFW COOKIE NAMES:', cookiesAfter.map(c => `${c.name}@${c.domain}`).join(', ') || '[none]');
  console.log('POST-LOGIN TEXT PREVIEW:', sanitizeText(bodyText));

  if (/invalid.*password|incorrect.*password|login failed|invalid.*member/i.test(bodyText)) {
    throw new Error('VFW Indiana rejected the login credentials.');
  }

  if (/500\s*-?\s*internal server error/i.test(`${title} ${bodyText}`)) {
    throw new Error('VFW Indiana returned HTTP 500 immediately after login. The sanitized POST request diagnostics are now available in Render logs.');
  }

  if (passwordInput) {
    throw new Error('The VFW Indiana login form is still visible after the login attempt. Authentication did not complete.');
  }

  if (/change profile|program reporting|log out|members only/i.test(bodyText)) {
    console.log('VFW Indiana authentication successful.');
    return;
  }

  throw new Error('VFW Indiana login completed, but an authenticated member page could not be positively confirmed.');
}

async function openProgramReporting(page) {
  requireEnv('VFW_PROGRAM_REPORTING_URL', PROGRAM_REPORTING_URL);
  console.log('Opening VFW Indiana Program Reporting page...');
  await page.goto(PROGRAM_REPORTING_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1000);
  if (await getPasswordField(page)) {
    throw new Error('VFW Indiana redirected the automation back to login. The authenticated session was not retained.');
  }
  const text = await page.locator('body').innerText();
  if (!/program reporting/i.test(text)) {
    throw new Error(`Indiana Program Reporting page did not load as expected. Current URL: ${page.url()}`);
  }
}

async function verifyPostAndDistrict(page) {
  const selects = page.locator('select');
  const count = await selects.count();
  if (count >= 1) {
    try {
      if (String(await selects.nth(0).inputValue()) !== String(POST)) await selects.nth(0).selectOption(String(POST));
    } catch (_) {}
  }
  if (count >= 2) {
    try {
      if (String(await selects.nth(1).inputValue()) !== String(DISTRICT)) await selects.nth(1).selectOption(String(DISTRICT));
    } catch (_) {}
  }
}

async function fillSubmitterEmail(page) {
  let input = await firstVisible([
    page.getByLabel(/submitter email/i),
    page.getByPlaceholder(/email/i),
    page.locator('input[type="email"]'),
    page.locator('input[name*="email" i]'),
    page.locator('input[id*="email" i]')
  ]);
  if (!input) {
    const texts = page.locator('input[type="text"]');
    if ((await texts.count()) > 0) input = texts.first();
  }
  if (!input) throw new Error('Could not locate Submitter Email input on Indiana reporting page.');
  await input.fill(SUBMITTER_EMAIL);
}

async function fillDate(page, report) {
  const input = await firstVisible([
    page.getByLabel(/date of activity/i),
    page.locator('input[type="date"]'),
    page.locator('input[name*="date" i]'),
    page.locator('input[id*="date" i]')
  ]);
  if (!input) throw new Error('Could not locate Date of Activity field.');
  await input.fill(String(report.date_of_service || ''));
}

async function selectCommunityService(page) {
  const radio = await firstVisible([
    page.getByRole('radio', { name: /community service/i }),
    page.locator('input[type="radio"]')
  ]);
  if (radio) {
    try { await radio.check(); } catch (_) { await radio.click(); }
    return;
  }
  const text = page.getByText('Community Service', { exact: true });
  if ((await text.count()) > 0) {
    await text.first().click();
    return;
  }
  throw new Error('Could not locate Community Service program option.');
}

async function fillNumericFields(page, report) {
  const numeric = page.locator('input[type="number"]');
  const count = await numeric.count();

  let hours = await firstVisible([page.getByLabel(/cumulative hours|hours/i), page.locator('input[name*="hour" i]'), page.locator('input[id*="hour" i]')]);
  let miles = await firstVisible([page.getByLabel(/miles/i), page.locator('input[name*="mile" i]'), page.locator('input[id*="mile" i]')]);
  let members = await firstVisible([page.getByLabel(/^members$/i), page.locator('input[name*="member" i]'), page.locator('input[id*="member" i]')]);
  let dollars = await firstVisible([page.getByLabel(/dollars.*spent|dollars.*donated|spent.*donated/i), page.locator('input[name*="dollar" i]'), page.locator('input[id*="dollar" i]')]);

  if (!hours && count >= 1) hours = numeric.nth(0);
  if (!miles && count >= 2) miles = numeric.nth(1);
  if (!members && count >= 3) members = numeric.nth(2);
  if (!dollars && count >= 4) dollars = numeric.nth(3);

  if (!hours || !miles || !members || !dollars) throw new Error('Could not locate all Indiana numeric fields.');

  await hours.fill(String(report.volunteer_hours ?? 0));
  await miles.fill(String(report.miles_traveled ?? 0));
  await members.fill(String(report.vfw_members_participating ?? 1));
  await dollars.fill(String(report.money_or_donations ?? 0));
}

async function fillDescription(page, report) {
  const textarea = await firstVisible([page.getByLabel(/description/i), page.locator('textarea')]);
  if (!textarea) throw new Error('Could not locate Description field.');
  await textarea.fill(report.proposed_description || report.activity_description || '');
}

async function fillProgramReport(page, report) {
  await fillSubmitterEmail(page);
  await fillDate(page, report);
  await selectCommunityService(page);
  await fillNumericFields(page, report);
  await fillDescription(page, report);
}

async function verifyFilledValues(page, report) {
  const textarea = await firstVisible([page.locator('textarea')]);
  if (!textarea) throw new Error('Unable to verify Indiana Description field.');
  const expected = String(report.proposed_description || report.activity_description || '').trim();
  const actual = String(await textarea.inputValue()).trim();
  if (expected && actual !== expected) {
    throw new Error('Indiana Description field did not retain the expected value.');
  }
}

async function findSubmitButton(page) {
  return firstVisible([
    page.getByRole('button', { name: /^submit$/i }),
    page.locator('input[type="submit"]'),
    page.locator('button[type="submit"]'),
    page.locator('input[value="SUBMIT" i]')
  ]);
}

async function prepareOrSubmit(report) {
  requireEnv('VFW_MEMBERS_URL', MEMBERS_URL);
  requireEnv('VFW_PROGRAM_REPORTING_URL', PROGRAM_REPORTING_URL);
  requireEnv('VFW_MEMBER_ID', MEMBER_ID);
  requireEnv('VFW_PASSWORD', PASSWORD);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  let page;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    page = await context.newPage();
    page.setDefaultTimeout(15000);

    console.log('STEP 1: Authenticating with VFW Indiana...');
    await login(page);

    console.log('STEP 2: Opening Program Reporting...');
    await openProgramReporting(page);

    await verifyPostAndDistrict(page);
    await fillProgramReport(page, report);
    await verifyFilledValues(page, report);

    const preparedScreenshot = await screenshot(page, report.id, 'prepared');

    if (!ALLOW_FINAL_SUBMIT) {
      return {
        mode: 'prepared',
        message: 'VFW Indiana Program Reporting form was populated successfully. Final state submission was NOT clicked because VFW_ALLOW_FINAL_SUBMIT=false.',
        screenshot: preparedScreenshot
      };
    }

    const submitButton = await findSubmitButton(page);
    if (!submitButton) throw new Error('Could not locate Indiana final Submit button.');

    await submitButton.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1500);

    const resultText = (await page.locator('body').innerText()).slice(0, 4000);
    const submittedScreenshot = await screenshot(page, report.id, 'submitted');
    const success = /thank|success|submitted|report.*received|activity.*entered/i.test(resultText);

    if (!success) {
      throw new Error('Indiana form was submitted, but a clear success confirmation could not be detected. Review the captured screenshot before treating this report as successfully submitted.');
    }

    return {
      mode: 'submitted',
      message: 'VFW Indiana Community Service report submitted successfully.',
      confirmation: resultText,
      screenshot: submittedScreenshot
    };
  } catch (err) {
    console.error('VFW AUTOMATION ERROR:', err.message);
    let errorScreenshot = '';
    try {
      if (page) errorScreenshot = await screenshot(page, report.id, 'error');
    } catch (_) {}

    const wrapped = new Error(err.message);
    wrapped.screenshot = errorScreenshot;
    throw wrapped;
  } finally {
    await browser.close();
    console.log('Chromium closed.');
  }
}

module.exports = { prepareOrSubmit };
