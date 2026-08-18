require('dotenv').config();

const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const path = require('path');
const crypto = require('crypto');
const { db, log } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use(session({
  name: 'vfw10003.sid',
  secret: process.env.SESSION_SECRET || 'change-this-session-secret-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000
  }
}));

app.use('/screenshots', express.static(path.join(__dirname, 'screenshots')));
app.use(express.static(path.join(__dirname, 'public')));

function adminOnly(req, res, next) {
  if (req.session && req.session.admin === true) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

function agentOnly(req, res, next) {
  const configured = String(process.env.LOCAL_AGENT_TOKEN || '');
  const supplied = String(req.get('x-agent-token') || '');
  if (!configured) return res.status(503).json({ error: 'LOCAL_AGENT_TOKEN is not configured on Render.' });
  const a = Buffer.from(configured);
  const b = Buffer.from(supplied);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Invalid agent token' });
  next();
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
  return (`${p.vfw_members_participating} VFW Post 10003 member${p.vfw_members_participating === 1 ? '' : 's'} performed community service${org}. ${desc}`).trim();
}

async function forwardToFormspree(body) {
  const endpoint = process.env.FORMSPREE_ENDPOINT;
  if (!endpoint) return { skipped: true };
  const form = new URLSearchParams();
  Object.entries(body).forEach(([k, v]) => form.append(k, String(v ?? '')));
  form.append('_subject', 'VFW Post 10003 Community Service Report');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  if (!response.ok) throw new Error(`Formspree forward failed: ${response.status}`);
  return { ok: true };
}

app.post('/api/intake', async (req, res) => {
  const p = cleanPayload(req.body);
  const required = ['submitter_name', 'date_of_service', 'organization_or_community', 'activity_description'];
  const missing = required.filter(k => !p[k]);
  if (missing.length || p.volunteer_hours < 0) return res.status(400).json({ error: `Missing or invalid fields: ${missing.join(', ')}` });
  const proposed = makeProposedDescription(p);
  const info = db.prepare(`INSERT INTO reports (submitter_name,submitter_email,date_of_service,organization_or_community,activity_description,proposed_description,volunteer_hours,miles_traveled,money_or_donations,vfw_members_participating,organization_contact_or_verifier,additional_notes,raw_payload) VALUES (@submitter_name,@submitter_email,@date_of_service,@organization_or_community,@activity_description,@proposed_description,@volunteer_hours,@miles_traveled,@money_or_donations,@vfw_members_participating,@organization_contact_or_verifier,@additional_notes,@raw_payload)`).run({ ...p, proposed_description: proposed, raw_payload: JSON.stringify(req.body) });
  log(info.lastInsertRowid, 'INTAKE_RECEIVED', `Report received from ${p.submitter_name}`);
  try {
    await forwardToFormspree(req.body);
    log(info.lastInsertRowid, 'FORMSPREE_FORWARDED', 'Forwarded to existing Formspree endpoint for email notification.');
  } catch (err) {
    log(info.lastInsertRowid, 'FORMSPREE_FORWARD_FAILED', err.message);
  }
  res.json({ ok: true, report_id: info.lastInsertRowid, message: 'Thank you. Your community service report has been received for Post review.' });
});

app.post('/api/login', (req, res) => {
  if (!process.env.ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD is not configured.' });
  if (req.body.password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Unable to create login session.' });
    req.session.admin = true;
    req.session.save(saveErr => {
      if (saveErr) return res.status(500).json({ error: 'Unable to save login session.' });
      res.json({ ok: true, authenticated: true });
    });
  });
});

app.post('/api/logout', (req, res) => req.session.destroy(() => { res.clearCookie('vfw10003.sid'); res.json({ ok: true }); }));
app.get('/api/me', (req, res) => res.json({ authenticated: !!(req.session && req.session.admin === true) }));

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
  const allowed = ['submitter_name','submitter_email','date_of_service','organization_or_community','activity_description','proposed_description','volunteer_hours','miles_traveled','money_or_donations','vfw_members_participating','organization_contact_or_verifier','additional_notes','reviewer_notes'];
  const sets = [];
  const params = { id: req.params.id };
  for (const k of allowed) if (Object.prototype.hasOwnProperty.call(req.body, k)) { sets.push(`${k}=@${k}`); params[k] = req.body[k]; }
  if (!sets.length) return res.json({ ok: true });
  sets.push('updated_at=CURRENT_TIMESTAMP');
  db.prepare(`UPDATE reports SET ${sets.join(', ')} WHERE id=@id`).run(params);
  log(req.params.id, 'REPORT_EDITED', 'Report fields edited in review dashboard.');
  res.json({ ok: true });
});

app.post('/api/reports/:id/reject', adminOnly, (req, res) => {
  const reason = String(req.body.reason || '');
  db.prepare("UPDATE reports SET status='rejected', reviewer_notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(reason, req.params.id);
  log(req.params.id, 'REJECTED', reason);
  res.json({ ok: true });
});

app.post('/api/reports/:id/reset', adminOnly, (req, res) => {
  db.prepare("UPDATE reports SET status='pending', last_error=NULL, state_result=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(req.params.id);
  log(req.params.id, 'RESET_TO_PENDING', 'Report returned to pending review.');
  res.json({ ok: true });
});

// Approval now QUEUES the report. Render no longer logs into VFW Indiana.
app.post('/api/reports/:id/approve', adminOnly, (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id=?').get(req.params.id);
  if (!report) return res.status(404).json({ error: 'Not found' });
  if (report.status === 'submitted') return res.status(409).json({ error: 'This report has already been submitted.' });
  db.prepare("UPDATE reports SET status='approved', approved_at=CURRENT_TIMESTAMP, last_error=NULL, state_result='Waiting for Windows VFW Submit Agent', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(req.params.id);
  log(req.params.id, 'APPROVED_FOR_LOCAL_AGENT', 'Human reviewer approved report. Queued for the local Windows VFW Submit Agent.');
  res.json({ ok: true, mode: 'queued', message: 'Approved. This report is queued for the Windows VFW Submit Agent.' });
});

// Local agent: obtain one approved report.
app.get('/api/agent/next', agentOnly, (req, res) => {
  const report = db.prepare("SELECT * FROM reports WHERE status='approved' ORDER BY approved_at ASC, id ASC LIMIT 1").get();
  if (!report) return res.status(204).end();
  res.json({ ok: true, report });
});

// Local agent: report successful VFW submission.
app.post('/api/agent/reports/:id/submitted', agentOnly, (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id=?').get(req.params.id);
  if (!report) return res.status(404).json({ error: 'Not found' });
  const confirmation = String(req.body.confirmation || 'Submitted by local Windows VFW Submit Agent');
  db.prepare("UPDATE reports SET status='submitted', submitted_at=CURRENT_TIMESTAMP, state_result='Submitted by Windows VFW Submit Agent', state_confirmation=?, last_error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(confirmation, req.params.id);
  log(req.params.id, 'STATE_SUBMITTED_LOCAL_AGENT', confirmation);
  res.json({ ok: true });
});

// Local agent: report an error without discarding approval.
app.post('/api/agent/reports/:id/error', agentOnly, (req, res) => {
  const message = String(req.body.error || 'Unknown local agent error').slice(0, 4000);
  db.prepare("UPDATE reports SET last_error=?, state_result='Local agent needs attention', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(message, req.params.id);
  log(req.params.id, 'LOCAL_AGENT_ERROR', message);
  res.json({ ok: true });
});

app.get('/api/stats', adminOnly, (req, res) => {
  const totals = db.prepare(`SELECT COUNT(*) total_reports,
    SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,
    SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) approved,
    SUM(CASE WHEN status='prepared' THEN 1 ELSE 0 END) prepared,
    SUM(CASE WHEN status='submitted' THEN 1 ELSE 0 END) submitted,
    COALESCE(SUM(volunteer_hours),0) hours, COALESCE(SUM(miles_traveled),0) miles, COALESCE(SUM(money_or_donations),0) dollars
    FROM reports WHERE status != 'rejected'`).get();
  res.json(totals);
});

app.post('/api/dev/seed', adminOnly, (req, res) => {
  if (process.env.ENABLE_TEST_REPORTS !== 'true') return res.status(403).json({ error: 'Test reports are disabled. Set ENABLE_TEST_REPORTS=true temporarily in Render.' });
  const p = { name:'Test Comrade', email:'test@example.com', date_of_service:new Date().toISOString().slice(0,10), organization_or_community:'Hamilton County Food Pantry', activity_description:'Assisted with food distribution to local families.', volunteer_hours:4, miles_traveled:12, money_or_donations:25, vfw_members_participating:2, organization_contact_or_verifier:'Sample Verifier', additional_notes:'Development test record.' };
  const clean = cleanPayload(p);
  const proposed = makeProposedDescription(clean);
  const info = db.prepare('INSERT INTO reports (submitter_name,submitter_email,date_of_service,organization_or_community,activity_description,proposed_description,volunteer_hours,miles_traveled,money_or_donations,vfw_members_participating,organization_contact_or_verifier,additional_notes,raw_payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(clean.submitter_name,clean.submitter_email,clean.date_of_service,clean.organization_or_community,clean.activity_description,proposed,clean.volunteer_hours,clean.miles_traveled,clean.money_or_donations,clean.vfw_members_participating,clean.organization_contact_or_verifier,clean.additional_notes,JSON.stringify(p));
  log(info.lastInsertRowid, 'DEV_SEED', 'Development sample record created.');
  res.json({ ok: true, report_id: info.lastInsertRowid });
});

app.listen(PORT, () => console.log(`VFW Community Service Manager running on port ${PORT}`));
