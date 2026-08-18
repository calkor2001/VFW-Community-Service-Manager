require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const path = require('path');
const { db, log } = require('./db');
const { prepareOrSubmit } = require('./vfwAutomation');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 }
}));

app.use('/screenshots', express.static(path.join(__dirname, 'screenshots')));
app.use(express.static(path.join(__dirname, 'public')));

function adminOnly(req, res, next) {
  if (req.session && req.session.admin === true) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

function num(v, fallback = 0) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function cleanPayload(body) {
  return {
    submitter_name: String(body.name || body.submitter_name || '').trim(),
    submitter_email: String(body.email || body.submitter_email || '').trim(),
    date_of_service: String(body.date_of_service || '').trim(),
    organization_or_community: String(body.organization_or_community || '').trim(),
    activity_description: String(body.activity_description || '').trim(),
    volunteer_hours: num(body.volunteer_hours),
    miles_traveled: num(body.miles_traveled),
    money_or_donations: num(body.money_or_donations),
    vfw_members_participating: Math.max(1, Math.round(num(body.vfw_members_participating, 1))),
    organization_contact_or_verifier: String(body.organization_contact_or_verifier || '').trim(),
    additional_notes: String(body.additional_notes || '').trim()
  };
}

function makeProposedDescription(p) {
  const org = p.organization_or_community ? ` for ${p.organization_or_community}` : '';
  const desc = p.activity_description.replace(/\s+/g, ' ').trim();
  return `${p.vfw_members_participating} VFW Post 10003 member${p.vfw_members_participating === 1 ? '' : 's'} performed community service${org}. ${desc}`.trim();
}

async function forwardToFormspree(body) {
  const endpoint = process.env.FORMSPREE_ENDPOINT;
  if (!endpoint) return { skipped: true };
  const form = new URLSearchParams();
  Object.entries(body).forEach(([k, v]) => form.append(k, String(v ?? '')));
  form.append('_subject', 'VFW Post 10003 Community Service Report');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  if (!response.ok) throw new Error(`Formspree forward failed: ${response.status}`);
  return { ok: true };
}

app.post('/api/intake', async (req, res) => {
  const p = cleanPayload(req.body);
  const required = ['submitter_name', 'date_of_service', 'organization_or_community', 'activity_description'];
  const missing = required.filter(k => !p[k]);
  if (missing.length || p.volunteer_hours < 0) {
    return res.status(400).json({ error: `Missing or invalid fields: ${missing.join(', ')}` });
  }

  const proposed = makeProposedDescription(p);
  const stmt = db.prepare(`
    INSERT INTO reports (
      submitter_name, submitter_email, date_of_service, organization_or_community,
      activity_description, proposed_description, volunteer_hours, miles_traveled,
      money_or_donations, vfw_members_participating, organization_contact_or_verifier,
      additional_notes, raw_payload
    ) VALUES (@submitter_name, @submitter_email, @date_of_service, @organization_or_community,
      @activity_description, @proposed_description, @volunteer_hours, @miles_traveled,
      @money_or_donations, @vfw_members_participating, @organization_contact_or_verifier,
      @additional_notes, @raw_payload)`);

  const info = stmt.run({ ...p, proposed_description: proposed, raw_payload: JSON.stringify(req.body) });
  log(info.lastInsertRowid, 'INTAKE_RECEIVED', `Report received from ${p.submitter_name}`);

  try {
    await forwardToFormspree(req.body);
    log(info.lastInsertRowid, 'FORMSPREE_FORWARDED', 'Forwarded to existing Formspree endpoint for email notification.');
  } catch (err) {
    log(info.lastInsertRowid, 'FORMSPREE_FORWARD_FAILED', err.message);
    // Do not lose the report just because notification forwarding failed.
  }

  res.json({ ok: true, report_id: info.lastInsertRowid, message: 'Thank you. Your community service report has been received for Post review.' });
});

app.post('/api/login', (req, res) => {
  if (!process.env.ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD is not configured.' });
  if (req.body.password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  req.session.admin = true;
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', (req, res) => res.json({ authenticated: !!(req.session && req.session.admin) }));

app.get('/api/reports', adminOnly, (req, res) => {
  const status = req.query.status;
  const rows = status && status !== 'all'
    ? db.prepare('SELECT * FROM reports WHERE status = ? ORDER BY created_at DESC').all(status)
    : db.prepare('SELECT * FROM reports ORDER BY created_at DESC').all();
  res.json(rows);
});

app.get('/api/reports/:id', adminOnly, (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ error: 'Not found' });
  const audit = db.prepare('SELECT * FROM audit_log WHERE report_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json({ report, audit });
});

app.put('/api/reports/:id', adminOnly, (req, res) => {
  const allowed = [
    'submitter_name','submitter_email','date_of_service','organization_or_community','activity_description',
    'proposed_description','volunteer_hours','miles_traveled','money_or_donations','vfw_members_participating',
    'organization_contact_or_verifier','additional_notes','reviewer_notes'
  ];
  const sets = [];
  const params = { id: req.params.id };
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body, k)) { sets.push(`${k}=@${k}`); params[k] = req.body[k]; }
  }
  if (!sets.length) return res.json({ ok: true });
  sets.push('updated_at=CURRENT_TIMESTAMP');
  db.prepare(`UPDATE reports SET ${sets.join(', ')} WHERE id=@id`).run(params);
  log(req.params.id, 'REPORT_EDITED', 'Report fields edited in review dashboard.');
  res.json({ ok: true });
});

app.post('/api/reports/:id/reject', adminOnly, (req, res) => {
  db.prepare("UPDATE reports SET status='rejected', reviewer_notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(String(req.body.reason || ''), req.params.id);
  log(req.params.id, 'REJECTED', String(req.body.reason || ''));
  res.json({ ok: true });
});

app.post('/api/reports/:id/reset', adminOnly, (req, res) => {
  db.prepare("UPDATE reports SET status='pending', last_error=NULL, state_result=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(req.params.id);
  log(req.params.id, 'RESET_TO_PENDING', 'Report returned to pending review.');
  res.json({ ok: true });
});

app.post('/api/reports/:id/approve', adminOnly, async (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id=?').get(req.params.id);
  if (!report) return res.status(404).json({ error: 'Not found' });
  if (report.status === 'submitted') return res.status(409).json({ error: 'This report has already been submitted.' });

  db.prepare("UPDATE reports SET status='approved', approved_at=CURRENT_TIMESTAMP, last_error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(req.params.id);
  log(req.params.id, 'APPROVED', 'Human reviewer approved official VFW preparation/submission.');

  try {
    const result = await prepareOrSubmit({ ...report, status: 'approved' });
    if (result.mode === 'submitted') {
      db.prepare("UPDATE reports SET status='submitted', submitted_at=CURRENT_TIMESTAMP, state_result=?, state_confirmation=?, prepared_screenshot=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(result.message, result.confirmation || '', result.screenshot || '', req.params.id);
      log(req.params.id, 'STATE_SUBMITTED', result.message);
    } else {
      db.prepare("UPDATE reports SET status='prepared', state_result=?, prepared_screenshot=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(result.message, result.screenshot || '', req.params.id);
      log(req.params.id, 'STATE_PREPARED_DRY_RUN', result.message);
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    db.prepare("UPDATE reports SET status='pending', last_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(err.message, req.params.id);
    log(req.params.id, 'AUTOMATION_FAILED', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', adminOnly, (req, res) => {
  const totals = db.prepare(`SELECT
    COUNT(*) total_reports,
    SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,
    SUM(CASE WHEN status='prepared' THEN 1 ELSE 0 END) prepared,
    SUM(CASE WHEN status='submitted' THEN 1 ELSE 0 END) submitted,
    COALESCE(SUM(volunteer_hours),0) hours,
    COALESCE(SUM(miles_traveled),0) miles,
    COALESCE(SUM(money_or_donations),0) dollars
    FROM reports WHERE status != 'rejected'`).get();
  res.json(totals);
});

app.post('/api/dev/seed', adminOnly, (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(403).json({ error: 'Disabled in production' });
  const p = {
    name:'Test Comrade', email:'test@example.com', date_of_service:new Date().toISOString().slice(0,10),
    organization_or_community:'Hamilton County Food Pantry', activity_description:'Assisted with food distribution to local families.',
    volunteer_hours:4, miles_traveled:12, money_or_donations:25, vfw_members_participating:2,
    organization_contact_or_verifier:'Sample Verifier', additional_notes:'Development test record.'
  };
  req.body = p;
  const clean = cleanPayload(p);
  const proposed = makeProposedDescription(clean);
  const info = db.prepare(`INSERT INTO reports (submitter_name,submitter_email,date_of_service,organization_or_community,activity_description,proposed_description,volunteer_hours,miles_traveled,money_or_donations,vfw_members_participating,organization_contact_or_verifier,additional_notes,raw_payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(clean.submitter_name,clean.submitter_email,clean.date_of_service,clean.organization_or_community,clean.activity_description,proposed,clean.volunteer_hours,clean.miles_traveled,clean.money_or_donations,clean.vfw_members_participating,clean.organization_contact_or_verifier,clean.additional_notes,JSON.stringify(p));
  log(info.lastInsertRowid, 'DEV_SEED', 'Development sample record created.');
  res.json({ ok:true, report_id:info.lastInsertRowid });
});

app.listen(PORT, () => console.log(`VFW Community Service Manager running on http://localhost:${PORT}`));
