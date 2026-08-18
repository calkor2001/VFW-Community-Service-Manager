const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

/*
|--------------------------------------------------------------------------
| CONFIG
|--------------------------------------------------------------------------
*/

const MEMBERS_URL =
  process.env.VFW_MEMBERS_URL;

const PROGRAM_REPORTING_URL =
  process.env.VFW_PROGRAM_REPORTING_URL;

const MEMBER_ID =
  process.env.VFW_MEMBER_ID;

const PASSWORD =
  process.env.VFW_PASSWORD;

const POST =
  process.env.VFW_POST || '10003';

const DISTRICT =
  process.env.VFW_DISTRICT || '6';

const SUBMITTER_EMAIL =
  process.env.VFW_SUBMITTER_EMAIL ||
  'vfwcarmel@yahoo.com';

const ALLOW_FINAL_SUBMIT =
  String(
    process.env.VFW_ALLOW_FINAL_SUBMIT || 'false'
  ).toLowerCase() === 'true';


/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function requireEnv(name, value) {
  if (!value) {
    throw new Error(
      `${name} environment variable is not configured.`
    );
  }
}


async function firstVisible(locators) {
  for (const locator of locators) {
    try {
      if (
        await locator.count() > 0 &&
        await locator.first().isVisible()
      ) {
        return locator.first();
      }
    } catch (_) {
      // Try next locator.
    }
  }

  return null;
}


async function fillFirst(
  page,
  description,
  locators,
  value
) {
  const locator =
    await firstVisible(locators);

  if (!locator) {
    throw new Error(
      `Could not find field: ${description}`
    );
  }

  await locator.fill(
    String(value ?? '')
  );

  return locator;
}


async function clickFirst(
  page,
  description,
  locators
) {
  const locator =
    await firstVisible(locators);

  if (!locator) {
    throw new Error(
      `Could not find control: ${description}`
    );
  }

  await locator.click();

  return locator;
}


async function selectFirst(
  page,
  description,
  locators,
  value
) {
  const locator =
    await firstVisible(locators);

  if (!locator) {
    throw new Error(
      `Could not find select: ${description}`
    );
  }

  try {
    await locator.selectOption({
      value: String(value)
    });

    return locator;
  } catch (_) {
    try {
      await locator.selectOption({
        label: String(value)
      });

      return locator;
    } catch (err) {
      throw new Error(
        `Could not select ${description} value "${value}": ${err.message}`
      );
    }
  }
}


async function screenshot(
  page,
  reportId,
  suffix
) {
  const dir =
    path.join(
      __dirname,
      'screenshots'
    );

  fs.mkdirSync(
    dir,
    { recursive: true }
  );

  const filename =
    `report-${reportId}-${suffix}-${Date.now()}.png`;

  const fullPath =
    path.join(
      dir,
      filename
    );

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
  requireEnv(
    'VFW_MEMBERS_URL',
    MEMBERS_URL
  );

  requireEnv(
    'VFW_MEMBER_ID',
    MEMBER_ID
  );

  requireEnv(
    'VFW_PASSWORD',
    PASSWORD
  );

  await page.goto(
    MEMBERS_URL,
    {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    }
  );

  /*
  |--------------------------------------------------------------------------
  | MEMBER ID
  |--------------------------------------------------------------------------
  */

  const memberInput =
    await firstVisible([
      page.getByLabel(
        /member.*id/i
      ),

      page.getByPlaceholder(
        /member.*id/i
      ),

      page.locator(
        'input[name*="member" i]'
      ),

      page.locator(
        'input[id*="member" i]'
      ),

      page.locator(
        'input[type="text"]'
      )
    ]);

  /*
  |--------------------------------------------------------------------------
  | PASSWORD
  |--------------------------------------------------------------------------
  */

  const passwordInput =
    await firstVisible([
      page.getByLabel(
        /password/i
      ),

      page.getByPlaceholder(
        /password/i
      ),

      page.locator(
        'input[type="password"]'
      )
    ]);

  if (
    memberInput &&
    passwordInput
  ) {
    await memberInput.fill(
      MEMBER_ID
    );

    await passwordInput.fill(
      PASSWORD
    );

    const loginButton =
      await firstVisible([
        page.getByRole(
          'button',
          {
            name:
              /login|log in|sign in/i
          }
        ),

        page.locator(
          'input[type="submit"]'
        ),

        page.locator(
          'button[type="submit"]'
        )
      ]);

    if (!loginButton) {
      throw new Error(
        'Could not find VFW Indiana login button.'
      );
    }

    await Promise.all([
      page.waitForLoadState(
        'domcontentloaded'
      ).catch(() => {}),

      loginButton.click()
    ]);
  }

  /*
  |--------------------------------------------------------------------------
  | VERIFY LOGIN
  |--------------------------------------------------------------------------
  */

  await page.waitForTimeout(
    1000
  );

  const bodyText =
    await page.locator(
      'body'
    ).innerText();

  if (
    /invalid.*password|login failed|incorrect/i.test(
      bodyText
    )
  ) {
    throw new Error(
      'VFW Indiana login failed. Check member ID and password.'
    );
  }
}


/*
|--------------------------------------------------------------------------
| OPEN PROGRAM REPORTING
|--------------------------------------------------------------------------
*/

async function openProgramReporting(
  page
) {
  requireEnv(
    'VFW_PROGRAM_REPORTING_URL',
    PROGRAM_REPORTING_URL
  );

  await page.goto(
    PROGRAM_REPORTING_URL,
    {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    }
  );

  await page.waitForTimeout(
    750
  );

  const text =
    await page.locator(
      'body'
    ).innerText();

  if (
    !/program reporting/i.test(
      text
    )
  ) {
    throw new Error(
      'Indiana Program Reporting page did not load as expected.'
    );
  }
}


/*
|--------------------------------------------------------------------------
| POST AND DISTRICT
|--------------------------------------------------------------------------
*/

async function verifyPostAndDistrict(
  page
) {
  const selects =
    page.locator(
      'select'
    );

  const count =
    await selects.count();

  /*
  |--------------------------------------------------------------------------
  | POST
  |--------------------------------------------------------------------------
  */

  let postVerified = false;

  for (
    let i = 0;
    i < count;
    i++
  ) {
    const select =
      selects.nth(i);

    try {
      const value =
        await select.inputValue();

      const selectedText =
        await select
          .locator(
            'option:checked'
          )
          .textContent();

      if (
        String(value).trim() ===
          String(POST) ||
        String(
          selectedText || ''
        ).trim() ===
          String(POST)
      ) {
        postVerified = true;
        break;
      }
    } catch (_) {}
  }

  /*
  |--------------------------------------------------------------------------
  | DISTRICT
  |--------------------------------------------------------------------------
  */

  let districtVerified = false;

  for (
    let i = 0;
    i < count;
    i++
  ) {
    const select =
      selects.nth(i);

    try {
      const value =
        await select.inputValue();

      const selectedText =
        await select
          .locator(
            'option:checked'
          )
          .textContent();

      if (
        String(value).trim() ===
          String(DISTRICT) ||
        String(
          selectedText || ''
        ).trim() ===
          String(DISTRICT)
      ) {
        districtVerified =
          true;
        break;
      }
    } catch (_) {}
  }

  /*
  |--------------------------------------------------------------------------
  | FALLBACK: TRY TO SELECT VALUES
  |--------------------------------------------------------------------------
  */

  if (
    !postVerified &&
    count >= 1
  ) {
    try {
      await selects
        .nth(0)
        .selectOption(
          String(POST)
        );

      postVerified = true;
    } catch (_) {}
  }

  if (
    !districtVerified &&
    count >= 2
  ) {
    try {
      await selects
        .nth(1)
        .selectOption(
          String(DISTRICT)
        );

      districtVerified = true;
    } catch (_) {}
  }

  if (!postVerified) {
    console.warn(
      `Unable to positively verify Post ${POST}.`
    );
  }

  if (!districtVerified) {
    console.warn(
      `Unable to positively verify District ${DISTRICT}.`
    );
  }
}


/*
|--------------------------------------------------------------------------
| COMMUNITY SERVICE PROGRAM RADIO
|--------------------------------------------------------------------------
*/

async function selectCommunityService(
  page
) {
  const radio =
    await firstVisible([
      page.getByRole(
        'radio',
        {
          name:
            /community service/i
        }
      ),

      page.locator(
        'input[type="radio"]'
      )
    ]);

  if (!radio) {
    throw new Error(
      'Could not locate Community Service program option.'
    );
  }

  try {
    await radio.check();
  } catch (_) {
    await radio.click();
  }
}


/*
|--------------------------------------------------------------------------
| FILL PROGRAM REPORT
|--------------------------------------------------------------------------
*/

async function fillProgramReport(
  page,
  report
) {
  /*
  |--------------------------------------------------------------------------
  | SUBMITTER EMAIL
  |--------------------------------------------------------------------------
  */

  await fillFirst(
    page,
    'Submitter Email',
    [
      page.getByLabel(
        /submitter email/i
      ),

      page.getByPlaceholder(
        /email/i
      ),

      page.locator(
        'input[type="email"]'
      ),

      page.locator(
        'input[name*="email" i]'
      ),

      page.locator(
        'input[id*="email" i]'
      )
    ],
    SUBMITTER_EMAIL
  );


  /*
  |--------------------------------------------------------------------------
  | DATE OF ACTIVITY
  |--------------------------------------------------------------------------
  */

  await fillFirst(
    page,
    'Date of Activity',
    [
      page.getByLabel(
        /date of activity/i
      ),

      page.locator(
        'input[type="date"]'
      ),

      page.locator(
        'input[name*="date" i]'
      ),

      page.locator(
        'input[id*="date" i]'
      )
    ],
    report.date_of_service
  );


  /*
  |--------------------------------------------------------------------------
  | PROGRAM
  |--------------------------------------------------------------------------
  */

  await selectCommunityService(
    page
  );


  /*
  |--------------------------------------------------------------------------
  | NUMERIC FIELDS
  |--------------------------------------------------------------------------
  |
  | We first try semantic/name selectors.
  | If those fail, we fall back to numeric input order visible on the
  | Indiana Program Reporting form:
  |
  | 0 = Cumulative Hours
  | 1 = Miles
  | 2 = Members
  | 3 = Dollars Spent/Donated
  |--------------------------------------------------------------------------
  */

  const numericInputs =
    page.locator(
      'input[type="number"]'
    );


  /*
  |--------------------------------------------------------------------------
  | HOURS
  |--------------------------------------------------------------------------
  */

  let hours =
    await firstVisible([
      page.getByLabel(
        /cumulative hours|hours/i
      ),

      page.locator(
        'input[name*="hour" i]'
      ),

      page.locator(
        'input[id*="hour" i]'
      )
    ]);

  if (
    !hours &&
    await numericInputs.count() >= 1
  ) {
    hours =
      numericInputs.nth(0);
  }

  if (!hours) {
    throw new Error(
      'Could not locate Cumulative Hours field.'
    );
  }

  await hours.fill(
    String(
      report.volunteer_hours ??
      0
    )
  );


  /*
  |--------------------------------------------------------------------------
  | MILES
  |--------------------------------------------------------------------------
  */

  let miles =
    await firstVisible([
      page.getByLabel(
        /miles/i
      ),

      page.locator(
        'input[name*="mile" i]'
      ),

      page.locator(
        'input[id*="mile" i]'
      )
    ]);

  if (
    !miles &&
    await numericInputs.count() >= 2
  ) {
    miles =
      numericInputs.nth(1);
  }

  if (!miles) {
    throw new Error(
      'Could not locate Miles field.'
    );
  }

  await miles.fill(
    String(
      report.miles_traveled ??
      0
    )
  );


  /*
  |--------------------------------------------------------------------------
  | MEMBERS
  |--------------------------------------------------------------------------
  */

  let members =
    await firstVisible([
      page.getByLabel(
        /members/i
      ),

      page.locator(
        'input[name*="member" i]'
      ),

      page.locator(
        'input[id*="member" i]'
      )
    ]);

  if (
    !members &&
    await numericInputs.count() >= 3
  ) {
    members =
      numericInputs.nth(2);
  }

  if (!members) {
    throw new Error(
      'Could not locate Members field.'
    );
  }

  await members.fill(
    String(
      report
        .vfw_members_participating ??
      1
    )
  );


  /*
  |--------------------------------------------------------------------------
  | DOLLARS
  |--------------------------------------------------------------------------
  */

  let dollars =
    await firstVisible([
      page.getByLabel(
        /dollars.*spent|dollars.*donated|spent.*donated/i
      ),

      page.locator(
        'input[name*="dollar" i]'
      ),

      page.locator(
        'input[id*="dollar" i]'
      )
    ]);

  if (
    !dollars &&
    await numericInputs.count() >= 4
  ) {
    dollars =
      numericInputs.nth(3);
  }

  if (!dollars) {
    throw new Error(
      'Could not locate Dollars Spent/Donated field.'
    );
  }

  await dollars.fill(
    String(
      report.money_or_donations ??
      0
    )
  );


  /*
  |--------------------------------------------------------------------------
  | DESCRIPTION
  |--------------------------------------------------------------------------
  */

  const description =
    report.proposed_description ||
    report.activity_description ||
    '';

  await fillFirst(
    page,
    'Description',
    [
      page.getByLabel(
        /description/i
      ),

      page.locator(
        'textarea'
      ),

      page.locator(
        '[contenteditable="true"]'
      )
    ],
    description
  );
}


/*
|--------------------------------------------------------------------------
| VERIFY FORM VALUES
|--------------------------------------------------------------------------
*/

async function verifyFilledValues(
  page,
  report
) {
  const body =
    await page.locator(
      'body'
    ).innerText();

  if (
    !/community service/i.test(
      body
    )
  ) {
    throw new Error(
      'Community Service option is not visible after form preparation.'
    );
  }

  const descriptionText =
    report.proposed_description ||
    report.activity_description ||
    '';

  const textarea =
    await firstVisible([
      page.locator(
        'textarea'
      )
    ]);

  if (textarea) {
    const value =
      await textarea.inputValue();

    if (
      descriptionText &&
      value.trim() !==
        descriptionText.trim()
    ) {
      throw new Error(
        'Description field did not retain the expected value.'
      );
    }
  }
}


/*
|--------------------------------------------------------------------------
| FIND FINAL SUBMIT BUTTON
|--------------------------------------------------------------------------
*/

async function findSubmitButton(
  page
) {
  return firstVisible([
    page.getByRole(
      'button',
      {
        name:
          /^submit$/i
      }
    ),

    page.locator(
      'input[type="submit"]'
    ),

    page.locator(
      'button[type="submit"]'
    )
  ]);
}


/*
|--------------------------------------------------------------------------
| MAIN AUTOMATION
|--------------------------------------------------------------------------
*/

async function prepareOrSubmit(
  report
) {
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
    | LOGIN
    |--------------------------------------------------------------------------
    */

    await login(page);


    /*
    |--------------------------------------------------------------------------
    | PROGRAM REPORTING PAGE
    |--------------------------------------------------------------------------
    */

    await openProgramReporting(
      page
    );


    /*
    |--------------------------------------------------------------------------
    | VERIFY POST / DISTRICT
    |--------------------------------------------------------------------------
    */

    await verifyPostAndDistrict(
      page
    );


    /*
    |--------------------------------------------------------------------------
    | FILL REPORT
    |--------------------------------------------------------------------------
    */

    await fillProgramReport(
      page,
      report
    );


    /*
    |--------------------------------------------------------------------------
    | VERIFY DATA
    |--------------------------------------------------------------------------
    */

    await verifyFilledValues(
      page,
      report
    );


    /*
    |--------------------------------------------------------------------------
    | SCREENSHOT BEFORE ANY FINAL SUBMIT
    |--------------------------------------------------------------------------
    */

    const preparedScreenshot =
      await screenshot(
        page,
        report.id,
        'prepared'
      );


    /*
    |--------------------------------------------------------------------------
    | DRY RUN
    |--------------------------------------------------------------------------
    */

    if (
      !ALLOW_FINAL_SUBMIT
    ) {
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
    | FINAL SUBMIT
    |--------------------------------------------------------------------------
    |
    | This block only runs if:
    |
    | VFW_ALLOW_FINAL_SUBMIT=true
    |--------------------------------------------------------------------------
    */

    const submitButton =
      await findSubmitButton(
        page
      );

    if (!submitButton) {
      throw new Error(
        'Could not locate Indiana final Submit button.'
      );
    }

    await submitButton.click();

    await page.waitForLoadState(
      'domcontentloaded'
    ).catch(() => {});

    await page.waitForTimeout(
      1000
    );


    /*
    |--------------------------------------------------------------------------
    | CAPTURE RESULT
    |--------------------------------------------------------------------------
    */

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


    /*
    |--------------------------------------------------------------------------
    | BASIC SUCCESS CHECK
    |--------------------------------------------------------------------------
    */

    const success =
      /thank|success|submitted|report.*received|activity.*entered/i.test(
        resultText
      );

    if (!success) {
      throw new Error(
        'Indiana form was submitted, but a clear success confirmation could not be detected. Review the captured screenshot before treating this report as successfully submitted.'
      );
    }

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
    /*
    |--------------------------------------------------------------------------
    | ERROR SCREENSHOT
    |--------------------------------------------------------------------------
    */

    let errorScreenshot = '';

    try {
      if (page) {
        errorScreenshot =
          await screenshot(
            page,
            report.id,
            'error'
          );
      }
    } catch (_) {}

    const wrapped =
      new Error(
        err.message
      );

    wrapped.screenshot =
      errorScreenshot;

    throw wrapped;

  } finally {
    await browser.close();
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
