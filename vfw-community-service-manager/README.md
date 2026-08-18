# VFW Post 10003 Community Service Manager

A private, human-in-the-loop review system that sits behind the existing public Community Service page.

## What Version 1 does

- Keeps the current public reporting webpage and Formspree email workflow.
- Receives structured reports at `POST /api/intake`.
- Stores reports in SQLite with Pending / Prepared / Submitted / Rejected statuses.
- Provides a password-protected review dashboard.
- Lets the reviewer edit the proposed Indiana description and all numeric values.
- Requires an explicit human click on **APPROVE & PREPARE VFW SUBMISSION**.
- Uses Playwright to log into the Indiana VFW members-only site and populate the Program Reporting form.
- Defaults to **dry-run mode**: it saves a screenshot of the filled official form and does **not** click the state SUBMIT button.
- Maintains an audit trail.
- Can forward the intake to the existing Formspree endpoint so the Yahoo notification still arrives.

## Security model

Never put a real VFW password in source code, Netlify HTML, GitHub, or this repository. Store it as the deployment platform's encrypted environment secret.

The package intentionally ships with `VFW_ALLOW_FINAL_SUBMIT=false`. Keep it false while validating the state form mapping.

## Local setup

```bash
npm install
cp .env.example .env
# Fill in your environment variables locally.
npm run install-browser
npm start
```

Open `http://localhost:3000`.

## Connect the current public webpage

The public page can remain visually unchanged. Once this manager is deployed, change only the form submission logic so the same fields go to:

`https://YOUR-MANAGER-HOST/api/intake`

The manager records the report first, then forwards the same payload to the existing Formspree endpoint (`xnpagjag`) so the current email notification can continue.

This avoids requiring a paid Formspree webhook plan.

### Why not use a Formspree webhook by default?

Formspree documents Webhooks and its Form Submissions API as Professional/Business-plan features. Routing through this manager first lets the existing Formspree email workflow continue without depending on those paid features.

## Indiana field mapping

- Post → `10003` (environment setting)
- District → `6` (environment setting)
- Submitter Email → environment setting
- Date of Activity → `date_of_service`
- Program → Community Service
- Cumulative Hours → `volunteer_hours`
- Miles → `miles_traveled`
- Members → `vfw_members_participating`
- Dollars Spent/Donated → `money_or_donations`
- Description → reviewer-approved `proposed_description`

## Dry-run validation

For the first several reports, leave:

`VFW_ALLOW_FINAL_SUBMIT=false`

After approval, Playwright will populate the official state form and save a screenshot. Compare that screenshot against the report before enabling final submission.

Only after the mapping is proven reliable should you consider setting:

`VFW_ALLOW_FINAL_SUBMIT=true`

At that point, your click in the dashboard becomes the authorization to click Indiana's final SUBMIT button.

## Deployment notes

This app needs:

1. A Node.js host that supports Playwright/Chromium.
2. Persistent storage for the SQLite database and screenshots, or a managed database/object store.
3. Environment secrets for admin password, session secret, and VFW credentials.

A simple static Netlify site by itself is not enough for the private manager because browser automation requires a server runtime with Chromium.
