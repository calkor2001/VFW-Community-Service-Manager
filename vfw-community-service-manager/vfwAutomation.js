const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

/*
|--------------------------------------------------------------------------
| CONFIGURATION
|--------------------------------------------------------------------------
*/

const MEMBERS_URL = process.env.VFW_MEMBERS_URL;
const PROGRAM_REPORTING_URL = process.env.VFW_PROGRAM_REPORTING_URL;

const MEMBER_ID = process.env.VFW_MEMBER_ID;
const PASSWORD = process.env.VFW_PASSWORD;

const POST = process.env.VFW_POST || '10003';
const DISTRICT = process.env.VFW_DISTRICT || '6';

const SUBMITTER_EMAIL =
  process.env.VFW_SUBMITTER_EMAIL || 'vfwcarmel@yahoo.com';

const ALLOW_FINAL_SUBMIT =
  String(process.env.VFW_ALLOW_FINAL_SUBMIT || 'false').toLowerCase() ===
  'true';

/*
|--------------------------------------------------------------------------
| ENVIRONMENT VALIDATION
|--------------------------------------------------------------------------
*/

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`${name} environment variable is not configured.`);
  }
}

/*
|--------------------------------------------------------------------------
| LOCATOR HELPERS
|--------------------------------------------------------------------------
*/

async function firstVisible(locators) {
  for (const locator of locators) {
    try {
      if (
        (await locator.count()) > 0 &&
        (await locator.first().isVisible())
      ) {
        return locator.first();
      }
    } catch (_) {
      // Try next locator
    }
  }

  return null;
}

/*
|--------------------------------------------------------------------------
| SCREENSHOT HELPER
|--------------------------------------------------------------------------
*/

async function screenshot(page, reportId, suffix) {
  const dir = path.join(__dirname, 'screenshots');

  fs.mkdirSync(dir, {
    recursive: true
  });

  const filename =
    `report-${reportId}-${suffix}-${Date.now()}.png`;

  const fullPath = path.join(dir, filename);

  await page.screenshot({
    path: fullPath,
    fullPage: true
  });

  return `/screenshots/${filename}`;
}

/*
|--------------------------------------------------------------------------
| LOGIN
|--------------------------------------------------------------------------
*/

async function login(page) {
  requireEnv('VFW_MEMBERS_URL', MEMBERS_URL);
  requireEnv('VFW_MEMBER_ID', MEMBER_ID);
  requireEnv('VFW_PASSWORD', PASSWORD);

  console.log('Opening VFW Indiana login page...');

  await page.goto(MEMBERS_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 45000
  });

  await page.waitForTimeout(1000);

  let bodyText = await page.locator('body').innerText();

  /*
  |--------------------------------------------------------------------------
  | ALREADY AUTHENTICATED?
  |--------------------------------------------------------------------------
  */

  if (
    /log out/i.test(bodyText) ||
    /change profile/i.test(bodyText)
  ) {
    console.log('Already authenticated with VFW Indiana.');
    return;
  }

  /*
  |--------------------------------------------------------------------------
  | FIND PASSWORD FIELD
  |--------------------------------------------------------------------------
  */

  const passwordInput = await firstVisible([
    page.locator('input[type="password"]'),
    page.getByLabel(/password/i),
    page.getByPlaceholder(/password/i),
    page.locator('input[name*="pass" i]'),
    page.locator('input[id*="pass" i]')
  ]);

  if (!passwordInput) {
    throw new Error(
      'Could not locate VFW Indiana password field.'
    );
  }

  /*
  |--------------------------------------------------------------------------
  | FIND LOGIN FORM CONTAINING PASSWORD FIELD
  |--------------------------------------------------------------------------
  */

  const loginForm =
    passwordInput.locator('xpath=ancestor::form[1]');

  if ((await loginForm.count()) === 0) {
    throw new Error(
      'Could not locate the VFW Indiana login form.'
    );
  }

  /*
  |--------------------------------------------------------------------------
  | FIND MEMBER ID INSIDE SAME FORM
  |--------------------------------------------------------------------------
  */

  const memberInput = await firstVisible([
    loginForm.locator('input[name*="member" i]'),
    loginForm.locator('input[id*="member" i]'),
    loginForm.locator('input[type="text"]'),
    loginForm.locator('input:not([type])')
  ]);

  if (!memberInput) {
    throw new Error(
      'Could not locate Member ID field inside the VFW login form.'
    );
  }

  /*
  |--------------------------------------------------------------------------
  | ENTER CREDENTIALS
  |--------------------------------------------------------------------------
  */

  await memberInput.fill(MEMBER_ID);
  await passwordInput.fill(PASSWORD);

  console.log('VFW credentials entered.');

  /*
  |--------------------------------------------------------------------------
  | FIND SUBMIT CONTROL INSIDE LOGIN FORM ONLY
  |--------------------------------------------------------------------------
  */

  const submitControl = await firstVisible([
    loginForm.locator('input[type="submit"]'),
    loginForm.locator('button[type="submit"]'),
    loginForm.locator('input[type="image"]'),
    loginForm.locator('input[value*="login" i]'),
    loginForm.locator('input[value*="log in" i]'),
    loginForm.locator('button').filter({
      hasText: /login|log in|sign in|submit/i
    })
  ]);

  /*
  |--------------------------------------------------------------------------
  | SUBMIT LOGIN
  |--------------------------------------------------------------------------
  */

  if (submitControl) {
    console.log('Submitting VFW login form...');

    await Promise.all([
      page
        .waitForLoadState('domcontentloaded')
        .catch(() => {}),

      submitControl.click()
    ]);
  } else {
    console.log(
      'No submit control found inside login form. Pressing Enter in password field.'
    );

    await passwordInput.press('Enter');

    await page
      .waitForLoadState('domcontentloaded')
      .catch(() => {});
  }

  await page.waitForTimeout(1800);

  /*
  |--------------------------------------------------------------------------
  | VERIFY LOGIN RESULT
  |--------------------------------------------------------------------------
  */

  bodyText = await page.locator('body').innerText();

  if (
    /invalid.*password/i.test(bodyText) ||
    /incorrect.*password/i.test(bodyText) ||
    /login failed/i.test(bodyText) ||
    /invalid.*member/i.test(bodyText)
  ) {
    throw new Error(
      'VFW Indiana rejected the login credentials.'
    );
  }

  /*
  |--------------------------------------------------------------------------
  | STRONG AUTHENTICATION CHECK
  |--------------------------------------------------------------------------
  */

  if (
    /log out/i.test(bodyText) ||
    /change profile/i.test(bodyText)
  ) {
    console.log('VFW Indiana authentication successful.');
    return;
  }

  console.log(
    'URL after login attempt:',
    page.url()
  );

  throw new Error(
    'VFW Indiana login form was submitted, but an authenticated session could not be confirmed.'
  );
}

/*
|--------------------------------------------------------------------------
| OPEN PROGRAM REPORTING PAGE
|--------------------------------------------------------------------------
*/

async function openProgramReporting(page) {
  requireEnv(
    'VFW_PROGRAM_REPORTING_URL',
    PROGRAM_REPORTING_URL
  );

  console.log(
    'Opening VFW Indiana Program Reporting page...'
  );

  await page.goto(PROGRAM_REPORTING_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 45000
  });

  await page.waitForTimeout(1000);

  const text =
    await page.locator('body').innerText();

  /*
  |--------------------------------------------------------------------------
  | DETECT LOGIN REDIRECT
  |--------------------------------------------------------------------------
  */

  if (
    /password/i.test(text) &&
    /member.*id/i.test(text) &&
    !/program reporting/i.test(text)
  ) {
    throw new Error(
      'VFW Indiana redirected the automation back to login. The authenticated session was not retained.'
    );
  }

  if (!/program reporting/i.test(text)) {
    throw new Error(
      'Indiana Program Reporting page did not load as expected.'
    );
  }

  console.log(
    'VFW Indiana Program Reporting page loaded.'
  );
}

/*
|--------------------------------------------------------------------------
| VERIFY POST AND DISTRICT
|--------------------------------------------------------------------------
*/

async function verifyPostAndDistrict(page) {
  const selects = page.locator('select');
  const count = await selects.count();

  console.log(
    `Found ${count} select controls on Indiana reporting form.`
  );

  let postVerified = false;
  let districtVerified = false;

  for (let i = 0; i < count; i++) {
    const select = selects.nth(i);

    try {
      const value =
        String(await select.inputValue()).trim();

      const selectedText =
        String(
          (await select
            .locator('option:checked')
            .textContent()) || ''
        ).trim();

      if (
        value === String(POST) ||
        selectedText === String(POST)
      ) {
        postVerified = true;
      }

      if (
        value === String(DISTRICT) ||
        selectedText === String(DISTRICT)
      ) {
        districtVerified = true;
      }
    } catch (_) {}
  }

  if (!postVerified && count >= 1) {
    try {
      await selects
        .nth(0)
        .selectOption(String(POST));

      postVerified = true;
    } catch (_) {
      console.warn(
        `Could not automatically select Post ${POST}.`
      );
    }
  }

  if (!districtVerified && count >= 2) {
    try {
      await selects
        .nth(1)
        .selectOption(String(DISTRICT));

      districtVerified = true;
    } catch (_) {
      console.warn(
        `Could not automatically select District ${DISTRICT}.`
      );
    }
  }

  if (postVerified) {
    console.log(`Post ${POST} verified.`);
  } else {
    console.warn(
      `Unable to positively verify Post ${POST}.`
    );
  }

  if (districtVerified) {
    console.log(`District ${DISTRICT} verified.`);
  } else {
    console.warn(
      `Unable to positively verify District ${DISTRICT}.`
    );
  }
}

/*
|--------------------------------------------------------------------------
| FILL SUBMITTER EMAIL
|--------------------------------------------------------------------------
*/

async function fillSubmitterEmail(page) {
  let emailInput = await firstVisible([
    page.getByLabel(/submitter email/i),
    page.getByPlaceholder(/email/i),
    page.locator('input[type="email"]'),
    page.locator('input[name*="email" i]'),
    page.locator('input[id*="email" i]')
  ]);

  if (!emailInput) {
    const textInputs =
      page.locator('input[type="text"]');

    const count =
      await textInputs.count();

    if (count > 0) {
      emailInput = textInputs.first();
    }
  }

  if (!emailInput) {
    throw new Error(
      'Could not locate Submitter Email input on Indiana reporting page.'
    );
  }

  await emailInput.fill(
    SUBMITTER_EMAIL
  );

  console.log('Submitter Email filled.');
}

/*
|--------------------------------------------------------------------------
| FILL DATE
|--------------------------------------------------------------------------
*/

async function fillDate(page, report) {
  const dateInput = await firstVisible([
    page.getByLabel(/date of activity/i),
    page.locator('input[type="date"]'),
    page.locator('input[name*="date" i]'),
    page.locator('input[id*="date" i]')
  ]);

  if (!dateInput) {
    throw new Error(
      'Could not locate Date of Activity field.'
    );
  }

  await dateInput.fill(
    String(report.date_of_service || '')
  );

  console.log('Date of Activity filled.');
}

/*
|--------------------------------------------------------------------------
| SELECT COMMUNITY SERVICE
|--------------------------------------------------------------------------
*/

async function selectCommunityService(page) {
  let radio = await firstVisible([
    page.getByRole('radio', {
      name: /community service/i
    }),

    page.locator('input[type="radio"]')
  ]);

  if (radio) {
    try {
      await radio.check();
    } catch (_) {
      await radio.click();
    }

    console.log('Community Service selected.');
    return;
  }

  const text =
    page.getByText(
      'Community Service',
      {
        exact: true
      }
    );

  if ((await text.count()) > 0) {
    await text.first().click();

    console.log(
      'Community Service selected using text fallback.'
    );

    return;
  }

  throw new Error(
    'Could not locate Community Service program option.'
  );
}

/*
|--------------------------------------------------------------------------
| FILL NUMERIC FIELDS
|--------------------------------------------------------------------------
*/

async function fillNumericFields(
  page,
  report
) {
  let hours = await firstVisible([
    page.getByLabel(/cumulative hours|hours/i),
    page.locator('input[name*="hour" i]'),
    page.locator('input[id*="hour" i]')
  ]);

  let miles = await firstVisible([
    page.getByLabel(/miles/i),
    page.locator('input[name*="mile" i]'),
    page.locator('input[id*="mile" i]')
  ]);

  let members = await firstVisible([
    page.getByLabel(/^members$/i),
    page.locator('input[name*="member" i]'),
    page.locator('input[id*="member" i]')
  ]);

  let dollars = await firstVisible([
    page.getByLabel(
      /dollars.*spent|dollars.*donated|spent.*donated/i
    ),
    page.locator('input[name*="dollar" i]'),
    page.locator('input[id*="dollar" i]')
  ]);

  /*
  |--------------------------------------------------------------------------
  | FALLBACK TO INPUT ORDER
  |--------------------------------------------------------------------------
  */

  const numericInputs =
    page.locator('input[type="number"]');

  const numericCount =
    await numericInputs.count();

  if (!hours && numericCount >= 1) {
    hours = numericInputs.nth(0);
  }

  if (!miles && numericCount >= 2) {
    miles = numericInputs.nth(1);
  }

  if (!members && numericCount >= 3) {
    members = numericInputs.nth(2);
  }

  if (!dollars && numericCount >= 4) {
    dollars = numericInputs.nth(3);
  }

  if (!hours) {
    throw new Error(
      'Could not locate Cumulative Hours field.'
    );
  }

  if (!miles) {
    throw new Error(
      'Could not locate Miles field.'
    );
  }

  if (!members) {
    throw new Error(
      'Could not locate Members field.'
    );
  }

  if (!dollars) {
    throw new Error(
      'Could not locate Dollars Spent/Donated field.'
    );
  }

  await hours.fill(
    String(report.volunteer_hours ?? 0)
  );

  await miles.fill(
    String(report.miles_traveled ?? 0)
  );

  await members.fill(
    String(
      report.vfw_members_participating ?? 1
    )
  );

  await dollars.fill(
    String(report.money_or_donations ?? 0)
  );

  console.log(
    'Hours, Miles, Members, and Dollars filled.'
  );
}

/*
|--------------------------------------------------------------------------
| FILL DESCRIPTION
|--------------------------------------------------------------------------
*/

async function fillDescription(
  page,
  report
) {
  const description =
    report.proposed_description ||
    report.activity_description ||
    '';

  const textarea = await firstVisible([
    page.getByLabel(/description/i),
    page.locator('textarea')
  ]);

  if (!textarea) {
    throw new Error(
      'Could not locate Description field.'
    );
  }

  await textarea.fill(description);

  console.log('Description filled.');
}

/*
|--------------------------------------------------------------------------
| FILL ENTIRE PROGRAM REPORT
|--------------------------------------------------------------------------
*/

async function fillProgramReport(
  page,
  report
) {
  await fillSubmitterEmail(page);
  await fillDate(page, report);
  await selectCommunityService(page);

  await fillNumericFields(
    page,
    report
  );

  await fillDescription(
    page,
    report
  );
}

/*
|--------------------------------------------------------------------------
| VERIFY PREPARED FORM
|--------------------------------------------------------------------------
*/

async function verifyFilledValues(
  page,
  report
) {
  const expectedDescription =
    String(
      report.proposed_description ||
      report.activity_description ||
      ''
    ).trim();

  const textarea = await firstVisible([
    page.locator('textarea')
  ]);

  if (!textarea) {
    throw new Error(
      'Unable to verify Indiana Description field.'
    );
  }

  const actualDescription =
    String(
      await textarea.inputValue()
    ).trim();

  if (
    expectedDescription &&
    actualDescription !==
      expectedDescription
  ) {
    throw new Error(
      'Indiana Description field did not retain the expected value.'
    );
  }

  const radios =
    page.locator(
      'input[type="radio"]'
    );

  const radioCount =
    await radios.count();

  if (radioCount > 0) {
    let checked = false;

    for (
      let i = 0;
      i < radioCount;
      i++
    ) {
      try {
        if (
          await radios.nth(i).isChecked()
        ) {
          checked = true;
          break;
        }
      } catch (_) {}
    }

    if (!checked) {
      throw new Error(
        'Community Service program selection could not be verified.'
      );
    }
  }

  console.log(
    'Prepared Indiana form passed verification.'
  );
}

/*
|--------------------------------------------------------------------------
| FIND FINAL SUBMIT BUTTON
|--------------------------------------------------------------------------
*/

async function findSubmitButton(page) {
  return firstVisible([
    page.getByRole('button', {
      name: /^submit$/i
    }),

    page.locator(
      'input[type="submit"]'
    ),

    page.locator(
      'button[type="submit"]'
    ),

    page.locator(
      'input[value="SUBMIT" i]'
    )
  ]);
}

/*
|--------------------------------------------------------------------------
| MAIN AUTOMATION
|--------------------------------------------------------------------------
*/

async function prepareOrSubmit(report) {
  requireEnv(
    'VFW_MEMBERS_URL',
    MEMBERS_URL
  );

  requireEnv(
    'VFW_PROGRAM_REPORTING_URL',
    PROGRAM_REPORTING_URL
  );

  requireEnv(
    'VFW_MEMBER_ID',
    MEMBER_ID
  );

  requireEnv(
    'VFW_PASSWORD',
    PASSWORD
  );

  const browser =
    await chromium.launch({
      headless: true,

      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    });

  let page;

  try {
    const context =
      await browser.newContext({
        viewport: {
          width: 1440,
          height: 1100
        }
      });

    page =
      await context.newPage();

    page.setDefaultTimeout(
      15000
    );

    /*
    |--------------------------------------------------------------------------
    | STEP 1 — LOGIN
    |--------------------------------------------------------------------------
    */

    console.log(
      'STEP 1: Authenticating with VFW Indiana...'
    );

    await login(page);

    /*
    |--------------------------------------------------------------------------
    | STEP 2 — OPEN PROGRAM REPORTING
    |--------------------------------------------------------------------------
    */

    console.log(
      'STEP 2: Opening Program Reporting...'
    );

    await openProgramReporting(
      page
    );

    /*
    |--------------------------------------------------------------------------
    | STEP 3 — VERIFY POST / DISTRICT
    |--------------------------------------------------------------------------
    */

    console.log(
      'STEP 3: Verifying Post and District...'
    );

    await verifyPostAndDistrict(
      page
    );

    /*
    |--------------------------------------------------------------------------
    | STEP 4 — FILL FORM
    |--------------------------------------------------------------------------
    */

    console.log(
      'STEP 4: Populating Indiana report...'
    );

    await fillProgramReport(
      page,
      report
    );

    /*
    |--------------------------------------------------------------------------
    | STEP 5 — VERIFY FORM
    |--------------------------------------------------------------------------
    */

    console.log(
      'STEP 5: Verifying prepared report...'
    );

    await verifyFilledValues(
      page,
      report
    );

    /*
    |--------------------------------------------------------------------------
    | STEP 6 — CAPTURE SCREENSHOT
    |--------------------------------------------------------------------------
    */

    console.log(
      'STEP 6: Capturing prepared report screenshot...'
    );

    const preparedScreenshot =
      await screenshot(
        page,
        report.id,
        'prepared'
      );

    /*
    |--------------------------------------------------------------------------
    | SAFETY GATE
    |--------------------------------------------------------------------------
    */

    if (!ALLOW_FINAL_SUBMIT) {
      console.log(
        'DRY RUN COMPLETE. Final Indiana submission is disabled.'
      );

      return {
        mode: 'prepared',

        message:
          'VFW Indiana Program Reporting form was populated successfully. Final state submission was NOT clicked because VFW_ALLOW_FINAL_SUBMIT=false.',

        screenshot:
          preparedScreenshot
      };
    }

    /*
    |--------------------------------------------------------------------------
    | FINAL SUBMISSION ENABLED
    |--------------------------------------------------------------------------
    */

    console.log(
      'STEP 7: Final submission has been enabled.'
    );

    const submitButton =
      await findSubmitButton(
        page
      );

    if (!submitButton) {
      throw new Error(
        'Could not locate Indiana final Submit button.'
      );
    }

    console.log(
      'STEP 8: Submitting report to VFW Indiana...'
    );

    await submitButton.click();

    await page
      .waitForLoadState(
        'domcontentloaded'
      )
      .catch(() => {});

    await page.waitForTimeout(
      1500
    );

    const resultText =
      (
        await page
          .locator('body')
          .innerText()
      ).slice(
        0,
        4000
      );

    const submittedScreenshot =
      await screenshot(
        page,
        report.id,
        'submitted'
      );

    const success =
      /thank|success|submitted|report.*received|activity.*entered/i.test(
        resultText
      );

    if (!success) {
      throw new Error(
        'Indiana form was submitted, but a clear success confirmation could not be detected. Review the captured screenshot before treating this report as successfully submitted.'
      );
    }

    console.log(
      'VFW Indiana report submission successful.'
    );

    return {
      mode: 'submitted',

      message:
        'VFW Indiana Community Service report submitted successfully.',

      confirmation:
        resultText,

      screenshot:
        submittedScreenshot
    };

  } catch (err) {
    console.error(
      'VFW AUTOMATION ERROR:',
      err.message
    );

    let errorScreenshot = '';

    try {
      if (page) {
        errorScreenshot =
          await screenshot(
            page,
            report.id,
            'error'
          );

        console.error(
          'Error screenshot:',
          errorScreenshot
        );
      }
    } catch (
      screenshotError
    ) {
      console.error(
        'Could not capture error screenshot:',
        screenshotError.message
      );
    }

    const wrapped =
      new Error(err.message);

    wrapped.screenshot =
      errorScreenshot;

    throw wrapped;

  } finally {
    await browser.close();

    console.log(
      'Chromium closed.'
    );
  }
}

/*
|--------------------------------------------------------------------------
| EXPORT
|--------------------------------------------------------------------------
*/

module.exports = {
  prepareOrSubmit
};
