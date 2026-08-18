const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const screenshotDir = path.join(__dirname, 'screenshots');
fs.mkdirSync(screenshotDir, { recursive: true });

async function fillByLabelOrNearby(page, labelText, value) {
  const byLabel = page.getByLabel(labelText, { exact: false }).first();
  if (await byLabel.count()) {
    await byLabel.fill(String(value ?? ''));
    return;
  }
  const label = page.locator('label').filter({ hasText: labelText }).first();
  if (await label.count()) {
    const forId = await label.getAttribute('for');
    if (forId) {
      await page.locator(`#${CSS.escape(forId)}`).fill(String(value ?? ''));
      return;
    }
    const input = label.locator('xpath=following::input[1]');
    if (await input.count()) {
      await input.fill(String(value ?? ''));
      return;
    }
  }
  throw new Error(`Could not find field labeled: ${labelText}`);
}

async function selectByLabel(page, labelText, optionValue) {
  const byLabel = page.getByLabel(labelText, { exact: false }).first();
  if (await byLabel.count()) {
    await byLabel.selectOption({ label: String(optionValue) }).catch(async () => {
      await byLabel.selectOption(String(optionValue));
    });
    return;
  }
  throw new Error(`Could not find select labeled: ${labelText}`);
}

async function loginIfNeeded(page) {
  const memberId = process.env.VFW_MEMBER_ID;
  const password = process.env.VFW_PASSWORD;
  if (!memberId || !password) throw new Error('VFW_MEMBER_ID and VFW_PASSWORD must be configured as environment secrets.');

  await page.goto(process.env.VFW_MEMBERS_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

  // If already authenticated, a Members Only / Log Out page is usually visible.
  if (await page.getByText(/Log Out/i).count()) return;

  // Try common member login labels/names. Site markup may change, so selectors are intentionally flexible.
  const idCandidates = [
    page.getByLabel(/Member ID/i).first(),
    page.locator('input[name*="member" i]').first(),
    page.locator('input[type="text"]').first()
  ];
  let idField;
  for (const c of idCandidates) { if (await c.count()) { idField = c; break; } }

  const pwField = page.getByLabel(/Password/i).first().or(page.locator('input[type="password"]').first());
  if (!idField || !(await pwField.count())) {
    throw new Error('Could not locate the Indiana VFW login fields. The site layout may have changed.');
  }

  await idField.fill(memberId);
  await pwField.fill(password);

  const loginButton = page.getByRole('button', { name: /log ?in|sign ?in|submit/i }).first();
  if (await loginButton.count()) await loginButton.click();
  else await pwField.press('Enter');

  await page.waitForLoadState('domcontentloaded');
  if (!(await page.getByText(/Log Out/i).count())) {
    throw new Error('Indiana VFW login did not reach an authenticated page. Check credentials or any new login challenge.');
  }
}

async function prepareOrSubmit(report) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
  const page = await context.newPage();
  try {
    await loginIfNeeded(page);
    await page.goto(process.env.VFW_PROGRAM_REPORTING_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Post and District may already be preselected. Select if the controls are present.
    try { await selectByLabel(page, 'Post', process.env.VFW_POST || '10003'); } catch (_) {}
    try { await selectByLabel(page, 'District', process.env.VFW_DISTRICT || '6'); } catch (_) {}

    await fillByLabelOrNearby(page, 'Submitter Email', process.env.VFW_SUBMITTER_EMAIL || 'vfwcarmel@yahoo.com');
    await fillByLabelOrNearby(page, 'Date of Activity', report.date_of_service);

    // Community Service radio button.
    const community = page.getByLabel(/Community Service/i).first();
    if (await community.count()) await community.check();
    else {
      const textRadio = page.locator('input[type="radio"]').first();
      if (await textRadio.count()) await textRadio.check();
      else throw new Error('Could not locate Community Service program selector.');
    }

    await fillByLabelOrNearby(page, 'Cumulative Hours', report.volunteer_hours);
    await fillByLabelOrNearby(page, 'Miles', report.miles_traveled || 0);
    await fillByLabelOrNearby(page, 'Members', report.vfw_members_participating || 1);
    await fillByLabelOrNearby(page, 'Dollars Spent/Donated', report.money_or_donations || 0);
    await fillByLabelOrNearby(page, 'Description', report.proposed_description || report.activity_description);

    const shotName = `report-${report.id}-${Date.now()}.png`;
    const shotPath = path.join(screenshotDir, shotName);
    await page.screenshot({ path: shotPath, fullPage: true });

    const allowSubmit = String(process.env.VFW_ALLOW_FINAL_SUBMIT).toLowerCase() === 'true';
    if (!allowSubmit) {
      return {
        mode: 'prepared',
        screenshot: `/screenshots/${shotName}`,
        message: 'Official VFW Indiana form was filled in dry-run mode. Final SUBMIT was not clicked.'
      };
    }

    const submitButton = page.getByRole('button', { name: /^submit$/i }).first();
    if (!(await submitButton.count())) throw new Error('Could not locate the final Indiana SUBMIT button.');
    await submitButton.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    const bodyText = await page.locator('body').innerText();
    const confirmation = bodyText.slice(0, 4000);
    return {
      mode: 'submitted',
      screenshot: `/screenshots/${shotName}`,
      message: 'The approved report was submitted to VFW Indiana.',
      confirmation
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

module.exports = { prepareOrSubmit };
