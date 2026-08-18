const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'service-reports.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'pending',
  submitter_name TEXT NOT NULL,
  submitter_email TEXT,
  date_of_service TEXT NOT NULL,
  organization_or_community TEXT NOT NULL,
  activity_description TEXT NOT NULL,
  proposed_description TEXT,
  volunteer_hours REAL NOT NULL DEFAULT 0,
  miles_traveled REAL NOT NULL DEFAULT 0,
  money_or_donations REAL NOT NULL DEFAULT 0,
  vfw_members_participating INTEGER NOT NULL DEFAULT 1,
  organization_contact_or_verifier TEXT,
  additional_notes TEXT,
  reviewer_notes TEXT,
  approved_at TEXT,
  submitted_at TEXT,
  state_result TEXT,
  state_confirmation TEXT,
  last_error TEXT,
  prepared_screenshot TEXT,
  raw_payload TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  action TEXT NOT NULL,
  details TEXT,
  FOREIGN KEY(report_id) REFERENCES reports(id)
);
`);

function log(reportId, action, details='') {
  db.prepare('INSERT INTO audit_log (report_id, action, details) VALUES (?, ?, ?)')
    .run(reportId || null, action, details);
}

module.exports = { db, log };
