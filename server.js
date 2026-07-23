const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.warn('WARNING: SESSION_SECRET env var not set. Using insecure default — set it in production.');
}
app.use(session({
  secret: SESSION_SECRET || 'dev-only-insecure-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true }
}));

// ── Middleware ────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  // Re-verify user still exists in DB
  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.session.userId);
  if (!user) { req.session.destroy(); return res.status(401).json({ error: 'Not authenticated' }); }
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.session.userId);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  req.user = user;
  next();
}

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/signup', (req, res) => {
  const { name, birth, ranch, gender } = req.body;
  if (!name?.trim() || !birth) return res.status(400).json({ error: '이름과 생년월일을 입력하세요.' });
  if (!/^\d{6}$/.test(birth)) return res.status(400).json({ error: '생년월일은 6자리 숫자여야 합니다. (예: 001204)' });
  if (!ranch?.trim()) return res.status(400).json({ error: '목장을 입력하세요.' });
  if (!/^\d+-\d+$/.test(ranch.trim())) return res.status(400).json({ error: '목장은 숫자-숫자 형식이어야 합니다. (예: 1-1)' });
  if (!gender || !['남', '여'].includes(gender)) return res.status(400).json({ error: '성별을 선택하세요.' });

  // Check duplicate by name only (birth will be hashed, so compare before hashing)
  const existing = db.prepare('SELECT id, birth FROM users WHERE name = ?').all(name.trim());
  for (const u of existing) {
    if (bcrypt.compareSync(birth, u.birth)) return res.status(400).json({ error: '이미 존재하는 계정입니다.' });
  }

  const hashed = bcrypt.hashSync(birth, 10);
  try {
    const result = db.prepare('INSERT INTO users (name, birth, ranch, gender, role) VALUES (?, ?, ?, ?, ?)').run(name.trim(), hashed, ranch.trim(), gender, 'user');
    req.session.userId = result.lastInsertRowid;
    res.json({ success: true, role: 'user', name: name.trim() });
  } catch {
    res.status(400).json({ error: '이미 존재하는 계정입니다.' });
  }
});

app.post('/api/login', (req, res) => {
  const { name, birth } = req.body;
  if (!name?.trim() || !birth) return res.status(400).json({ error: '이름과 생년월일을 입력하세요.' });
  if (!/^\d{6}$/.test(birth)) return res.status(400).json({ error: '생년월일은 6자리 숫자여야 합니다.' });

  // Fetch all users with that name (could be multiple — find matching hash)
  const candidates = db.prepare('SELECT * FROM users WHERE name = ?').all(name.trim());
  const user = candidates.find(u => bcrypt.compareSync(birth, u.birth));
  if (!user) return res.status(401).json({ error: '이름 또는 생년월일이 올바르지 않습니다.' });

  req.session.userId = user.id;
  res.json({ success: true, role: user.role, name: user.name });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, name, ranch, role, created_at FROM users WHERE id = ?').get(req.session.userId);
  res.json(user);
});

// ── Schedule conflict helper ──────────────────────────────────────────────────
// Uses structured days/start_time/end_time fields — no text parsing needed
function timesConflict(a, b) {
  if (!a.days || !b.days || !a.start_time || !b.start_time) return false;
  // Check shared day (each Korean char = one day)
  const daysA = [...a.days];
  const daysB = [...b.days];
  if (!daysA.some(d => daysB.includes(d))) return false;
  // Interval overlap: [s1, e1) ∩ [s2, e2) ≠ ∅  ⟺  s1 < e2 AND s2 < e1
  const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const s1 = toMin(a.start_time), e1 = toMin(a.end_time);
  const s2 = toMin(b.start_time), e2 = toMin(b.end_time);
  return s1 < e2 && s2 < e1;
}

// ── Settings ─────────────────────────────────────────────────────────────────
function getSetting(key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? '';
}
function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

app.get('/api/settings/registration', (req, res) => {
  res.json({
    enabled: getSetting('reg_enabled') === 'true',
    start: getSetting('reg_start'),
    end: getSetting('reg_end')
  });
});

app.put('/api/admin/settings/registration', requireAdmin, (req, res) => {
  const { enabled, start, end } = req.body;
  if (enabled && start && end && new Date(start) >= new Date(end))
    return res.status(400).json({ error: '종료 시간은 시작 시간보다 늦어야 합니다.' });
  db.transaction(() => {
    setSetting('reg_enabled', enabled ? 'true' : 'false');
    setSetting('reg_start', start || '');
    setSetting('reg_end', end || '');
  })();
  res.json({ success: true });
});

// ── Courses (user) ────────────────────────────────────────────────────────────
app.get('/api/courses', requireAuth, (req, res) => {
  const currentUser = db.prepare('SELECT gender FROM users WHERE id = ?').get(req.session.userId);
  const courses = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM enrollments WHERE course_id = c.id) AS enrolled_count,
      (SELECT COUNT(*) FROM enrollments WHERE course_id = c.id AND user_id = ?) AS is_enrolled,
      (SELECT COUNT(*) FROM enrollments e JOIN users u ON e.user_id = u.id WHERE e.course_id = c.id AND u.gender = '남') AS enrolled_male,
      (SELECT COUNT(*) FROM enrollments e JOIN users u ON e.user_id = u.id WHERE e.course_id = c.id AND u.gender = '여') AS enrolled_female
    FROM courses c ORDER BY c.sort_order ASC, c.id ASC
  `).all(req.session.userId);

  // Compute gender_full for each course based on current user's gender
  const genderCountStmt = db.prepare(`
    SELECT COUNT(*) AS cnt FROM enrollments e
    JOIN users u ON e.user_id = u.id
    WHERE e.course_id = ? AND u.gender = ?
  `);
  const enriched = courses.map(c => {
    let gender_full = false;
    if (currentUser?.gender === '남' && c.capacity_male > 0) {
      const cnt = genderCountStmt.get(c.id, '남').cnt;
      if (cnt >= c.capacity_male) gender_full = true;
    }
    if (currentUser?.gender === '여' && c.capacity_female > 0) {
      const cnt = genderCountStmt.get(c.id, '여').cnt;
      if (cnt >= c.capacity_female) gender_full = true;
    }
    return { ...c, gender_full };
  });
  res.json(enriched);
});

app.post('/api/courses/:id/enroll', requireAuth, (req, res) => {
  const courseId = req.params.id;

  // Check registration period
  if (getSetting('reg_enabled') === 'true') {
    const start = getSetting('reg_start');
    const end   = getSetting('reg_end');
    const now   = new Date();
    if (start && now < new Date(start)) return res.status(400).json({ error: '아직 수강신청 기간이 시작되지 않았습니다.' });
    if (end   && now > new Date(end))   return res.status(400).json({ error: '수강신청 기간이 종료되었습니다.' });
  }

  // Use a transaction to prevent race conditions on capacity check
  const enroll = db.transaction(() => {
    const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(courseId);
    if (!course) return { status: 404, error: '강좌를 찾을 수 없습니다.' };

    const enrolledCount = db.prepare('SELECT COUNT(*) AS cnt FROM enrollments WHERE course_id = ?').get(courseId).cnt;
    if (enrolledCount >= course.capacity) return { status: 400, error: '정원이 초과되었습니다.' };

    // Check gender-specific capacity
    const currentUser = db.prepare('SELECT gender FROM users WHERE id = ?').get(req.session.userId);
    const genderCountStmt = db.prepare(`
      SELECT COUNT(*) AS cnt FROM enrollments e
      JOIN users u ON e.user_id = u.id
      WHERE e.course_id = ? AND u.gender = ?
    `);
    if (currentUser?.gender === '남' && course.capacity_male > 0) {
      const cnt = genderCountStmt.get(courseId, '남').cnt;
      if (cnt >= course.capacity_male) return { status: 400, error: `남자 정원(${course.capacity_male}명)이 마감되었습니다.` };
    }
    if (currentUser?.gender === '여' && course.capacity_female > 0) {
      const cnt = genderCountStmt.get(courseId, '여').cnt;
      if (cnt >= course.capacity_female) return { status: 400, error: `여자 정원(${course.capacity_female}명)이 마감되었습니다.` };
    }

    // Check schedule conflict using structured time fields
    if (course.start_time && course.end_time) {
      const myEnrolled = db.prepare(`
        SELECT c.name, c.days, c.start_time, c.end_time FROM enrollments e
        JOIN courses c ON e.course_id = c.id
        WHERE e.user_id = ?
      `).all(req.session.userId);

      for (const ec of myEnrolled) {
        if (timesConflict(course, ec)) {
          return { status: 400, error: `'${ec.name}'과(와) 시간이 겹칩니다. (${ec.days} ${ec.start_time}~${ec.end_time})` };
        }
      }
    }

    try {
      db.prepare('INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)').run(req.session.userId, courseId);
      return { success: true };
    } catch {
      return { status: 400, error: '이미 수강 신청한 강좌입니다.' };
    }
  });

  const result = enroll();
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json({ success: true });
});

app.delete('/api/courses/:id/enroll', requireAuth, (req, res) => {
  const result = db.prepare('DELETE FROM enrollments WHERE user_id = ? AND course_id = ?').run(req.session.userId, req.params.id);
  if (result.changes === 0) return res.status(400).json({ error: '수강 신청 내역이 없습니다.' });
  res.json({ success: true });
});

app.get('/api/my-enrollments', requireAuth, (req, res) => {
  const enrollments = db.prepare(`
    SELECT c.id, c.name, c.instructor, c.schedule, c.days, c.start_time, c.end_time, e.enrolled_at
    FROM enrollments e JOIN courses c ON e.course_id = c.id
    WHERE e.user_id = ? ORDER BY e.enrolled_at DESC
  `).all(req.session.userId);
  res.json(enrollments);
});

// ── Admin: Courses ────────────────────────────────────────────────────────────
app.get('/api/admin/courses', requireAdmin, (req, res) => {
  const courses = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM enrollments WHERE course_id = c.id) AS enrolled_count,
      (SELECT COUNT(*) FROM enrollments e JOIN users u ON e.user_id = u.id WHERE e.course_id = c.id AND u.gender = '남') AS enrolled_male,
      (SELECT COUNT(*) FROM enrollments e JOIN users u ON e.user_id = u.id WHERE e.course_id = c.id AND u.gender = '여') AS enrolled_female
    FROM courses c ORDER BY c.sort_order ASC, c.id ASC
  `).all();
  res.json(courses);
});

app.put('/api/admin/courses/reorder', requireAdmin, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: '잘못된 요청입니다.' });
  const update = db.prepare('UPDATE courses SET sort_order = ? WHERE id = ?');
  const updateAll = db.transaction((ids) => {
    ids.forEach((id, idx) => update.run(idx, id));
  });
  updateAll(ids);
  res.json({ success: true });
});

app.post('/api/admin/courses', requireAdmin, (req, res) => {
  const { name, description, instructor, capacity, schedule, days, start_time, end_time, capacity_male, capacity_female } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: '강좌명을 입력하세요.' });
  const cap = parseInt(capacity);
  if (!cap || cap < 1) return res.status(400).json({ error: '정원은 1 이상이어야 합니다.' });
  if ((start_time && !end_time) || (!start_time && end_time))
    return res.status(400).json({ error: '시작시간과 종료시간을 모두 입력하세요.' });
  if (start_time && end_time && start_time >= end_time)
    return res.status(400).json({ error: '종료시간은 시작시간보다 늦어야 합니다.' });
  const capM = parseInt(capacity_male) || 0;
  const capF = parseInt(capacity_female) || 0;
  if (capM < 0 || capF < 0) return res.status(400).json({ error: '성별 정원은 0 이상이어야 합니다.' });
  if (capM > cap) return res.status(400).json({ error: `남자 정원(${capM})은 전체 정원(${cap})을 초과할 수 없습니다.` });
  if (capF > cap) return res.status(400).json({ error: `여자 정원(${capF})은 전체 정원(${cap})을 초과할 수 없습니다.` });
  if (capM > 0 && capF > 0 && capM + capF > cap)
    return res.status(400).json({ error: `남자 정원(${capM}) + 여자 정원(${capF})이 전체 정원(${cap})을 초과합니다.` });

  const result = db.prepare(
    'INSERT INTO courses (name, description, instructor, capacity, schedule, days, start_time, end_time, capacity_male, capacity_female) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(name.trim(), description?.trim() || '', instructor?.trim() || '', cap,
        schedule?.trim() || '', days?.trim() || '', start_time || '', end_time || '', capM, capF);
  res.json({ success: true, id: result.lastInsertRowid });
});

app.put('/api/admin/courses/:id', requireAdmin, (req, res) => {
  const { name, description, instructor, capacity, schedule, days, start_time, end_time, capacity_male, capacity_female } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: '강좌명을 입력하세요.' });
  const cap = parseInt(capacity);
  if (!cap || cap < 1) return res.status(400).json({ error: '정원은 1 이상이어야 합니다.' });
  if ((start_time && !end_time) || (!start_time && end_time))
    return res.status(400).json({ error: '시작시간과 종료시간을 모두 입력하세요.' });
  if (start_time && end_time && start_time >= end_time)
    return res.status(400).json({ error: '종료시간은 시작시간보다 늦어야 합니다.' });
  const capM = parseInt(capacity_male) || 0;
  const capF = parseInt(capacity_female) || 0;
  if (capM < 0 || capF < 0) return res.status(400).json({ error: '성별 정원은 0 이상이어야 합니다.' });
  if (capM > cap) return res.status(400).json({ error: `남자 정원(${capM})은 전체 정원(${cap})을 초과할 수 없습니다.` });
  if (capF > cap) return res.status(400).json({ error: `여자 정원(${capF})은 전체 정원(${cap})을 초과할 수 없습니다.` });
  if (capM > 0 && capF > 0 && capM + capF > cap)
    return res.status(400).json({ error: `남자 정원(${capM}) + 여자 정원(${capF})이 전체 정원(${cap})을 초과합니다.` });

  const enrolled = db.prepare('SELECT COUNT(*) AS cnt FROM enrollments WHERE course_id = ?').get(req.params.id).cnt;
  if (cap < enrolled) return res.status(400).json({ error: `현재 ${enrolled}명이 신청 중입니다. 정원을 ${enrolled} 이상으로 설정하세요.` });

  // Check gender-specific capacity against current enrollments
  if (capM > 0) {
    const enrolledM = db.prepare(`SELECT COUNT(*) AS cnt FROM enrollments e JOIN users u ON e.user_id = u.id WHERE e.course_id = ? AND u.gender = '남'`).get(req.params.id).cnt;
    if (capM < enrolledM) return res.status(400).json({ error: `현재 남자 ${enrolledM}명이 신청 중입니다. 남자 정원을 ${enrolledM} 이상으로 설정하세요.` });
  }
  if (capF > 0) {
    const enrolledF = db.prepare(`SELECT COUNT(*) AS cnt FROM enrollments e JOIN users u ON e.user_id = u.id WHERE e.course_id = ? AND u.gender = '여'`).get(req.params.id).cnt;
    if (capF < enrolledF) return res.status(400).json({ error: `현재 여자 ${enrolledF}명이 신청 중입니다. 여자 정원을 ${enrolledF} 이상으로 설정하세요.` });
  }

  const result = db.prepare(
    'UPDATE courses SET name=?, description=?, instructor=?, capacity=?, schedule=?, days=?, start_time=?, end_time=?, capacity_male=?, capacity_female=? WHERE id=?'
  ).run(name.trim(), description?.trim() || '', instructor?.trim() || '', cap,
        schedule?.trim() || '', days?.trim() || '', start_time || '', end_time || '', capM, capF, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: '강좌를 찾을 수 없습니다.' });
  res.json({ success: true });
});

app.delete('/api/admin/courses/:id', requireAdmin, (req, res) => {
  // Wrap in transaction so both deletes succeed or both fail
  const deleteCourse = db.transaction((id) => {
    db.prepare('DELETE FROM enrollments WHERE course_id = ?').run(id);
    db.prepare('DELETE FROM courses WHERE id = ?').run(id);
  });
  deleteCourse(req.params.id);
  res.json({ success: true });
});

app.get('/api/admin/courses/:id/enrollments', requireAdmin, (req, res) => {
  const list = db.prepare(`
    SELECT u.id, u.name, u.gender, e.enrolled_at
    FROM enrollments e JOIN users u ON e.user_id = u.id
    WHERE e.course_id = ? ORDER BY e.enrolled_at ASC
  `).all(req.params.id);
  res.json(list);
});

// ── Admin: Users ──────────────────────────────────────────────────────────────
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.name, u.ranch, u.role, u.gender, u.created_at,
      (SELECT COUNT(*) FROM enrollments WHERE user_id = u.id) AS enrollment_count
    FROM users u ORDER BY u.ranch ASC, u.name ASC
  `).all();
  res.json(users);
});

app.get('/api/admin/users/:id/enrollments', requireAdmin, (req, res) => {
  const enrollments = db.prepare(`
    SELECT c.id, c.name, c.instructor, c.schedule, c.days, c.start_time, c.end_time, e.enrolled_at
    FROM enrollments e JOIN courses c ON e.course_id = c.id
    WHERE e.user_id = ? ORDER BY e.enrolled_at DESC
  `).all(req.params.id);
  res.json(enrollments);
});

app.put('/api/admin/users/:id/role', requireAdmin, (req, res) => {
  const { role } = req.body;
  if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: '잘못된 역할입니다.' });
  if (String(req.params.id) === String(req.session.userId)) return res.status(400).json({ error: '자신의 역할은 변경할 수 없습니다.' });
  const result = db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  res.json({ success: true });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  if (String(req.params.id) === String(req.session.userId)) return res.status(400).json({ error: '자신의 계정은 삭제할 수 없습니다.' });

  const deleteUser = db.transaction((id) => {
    db.prepare('DELETE FROM enrollments WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });
  deleteUser(req.params.id);
  res.json({ success: true });
});

// ── Admin: DB download ────────────────────────────────────────────────────────
app.get('/api/admin/download-db', requireAdmin, (req, res) => {
  const dbPath = process.env.DB_PATH || path.join(__dirname, 'courses.db');
  res.download(dbPath, 'courses.db');
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nCourse Registration Server running → http://localhost:${PORT}`);
});
