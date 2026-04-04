const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const db = new Database(path.join(__dirname, 'courses.db'));

// Enable foreign keys
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    birth TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(name, birth)
  );

  CREATE TABLE IF NOT EXISTS courses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    instructor TEXT DEFAULT '',
    capacity INTEGER DEFAULT 30,
    schedule TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS enrollments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    course_id INTEGER NOT NULL,
    enrolled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (course_id) REFERENCES courses(id),
    UNIQUE(user_id, course_id)
  );
`);

// Migrations for existing DBs
try { db.exec("ALTER TABLE users ADD COLUMN ranch TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE courses ADD COLUMN days TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE courses ADD COLUMN start_time TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE courses ADD COLUMN end_time TEXT DEFAULT ''"); } catch {}

// Seed default admin account
const admin = db.prepare("SELECT id FROM users WHERE name = 'admin' AND role = 'admin'").get();
if (!admin) {
  const hashed = bcrypt.hashSync('000000', 10);
  db.prepare("INSERT INTO users (name, birth, role) VALUES ('admin', ?, 'admin')").run(hashed);
  console.log('Default admin created  →  name: admin  |  birth: 000000');
}

module.exports = db;
