/**
 * Railway 서버 → 로컬 DB 동기화 스크립트
 *
 * 사용법:
 *   RAILWAY_URL=https://your-app.up.railway.app ADMIN_PASS=비밀번호 node export-remote-db.js
 */

const Database = require('better-sqlite3');
const path = require('path');

const RAILWAY_URL = (process.env.RAILWAY_URL || '').replace(/\/$/, '');
const ADMIN_PASS  = process.env.ADMIN_PASS || '000000';
const OUT_PATH    = process.env.OUT_PATH || path.join(__dirname, 'courses.db');

if (!RAILWAY_URL) {
  console.error('❌ RAILWAY_URL 환경변수가 필요합니다.');
  console.error('   예: RAILWAY_URL=https://soogang-production.up.railway.app ADMIN_PASS=비밀번호 node export-remote-db.js');
  process.exit(1);
}

let cookie = '';

async function api(method, path) {
  const res = await fetch(`${RAILWAY_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
  });
  if (path === '/api/login' && res.headers.get('set-cookie')) {
    cookie = res.headers.get('set-cookie').split(';')[0];
  }
  if (!res.ok) throw new Error(`API 오류 ${res.status}: ${path}`);
  return res.json();
}

async function main() {
  // 1. 로그인
  console.log('🔑 로그인 중...');
  await fetch(`${RAILWAY_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'admin', birth: ADMIN_PASS }),
  }).then(res => {
    if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    if (!res.ok) throw new Error('로그인 실패 — 어드민 비밀번호를 확인하세요.');
    return res.json();
  });
  console.log('✅ 로그인 성공');

  // 2. 데이터 가져오기
  console.log('\n📥 데이터 가져오는 중...');
  const [courses, users] = await Promise.all([
    api('GET', '/api/admin/courses'),
    api('GET', '/api/admin/users'),
  ]);
  console.log(`   강좌: ${courses.length}개`);
  console.log(`   유저: ${users.length}명`);

  // 3. 강좌별 수강신청 목록 가져오기
  const enrollmentsByCourse = await Promise.all(
    courses.map(c => api('GET', `/api/admin/courses/${c.id}/enrollments`).then(list => ({ courseId: c.id, list })))
  );
  const totalEnrollments = enrollmentsByCourse.reduce((s, e) => s + e.list.length, 0);
  console.log(`   수강신청: ${totalEnrollments}건`);

  // 4. 로컬 DB에 쓰기
  console.log(`\n💾 로컬 DB 저장 중... (${OUT_PATH})`);
  const db = new Database(OUT_PATH);
  db.pragma('foreign_keys = OFF');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      birth TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      gender TEXT,
      ranch TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      instructor TEXT,
      capacity INTEGER DEFAULT 30,
      capacity_male INTEGER DEFAULT 0,
      capacity_female INTEGER DEFAULT 0,
      schedule TEXT,
      days TEXT,
      start_time TEXT,
      end_time TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS enrollments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      course_id INTEGER,
      enrolled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, course_id)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT DEFAULT ''
    );
  `);

  db.exec('DELETE FROM enrollments; DELETE FROM users; DELETE FROM courses;');

  // users (birth 해시 없음 — 로그인 불가, 열람/분석용)
  const insertUser = db.prepare(
    'INSERT OR REPLACE INTO users (id, name, birth, role, gender, ranch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const insertCourse = db.prepare(
    'INSERT OR REPLACE INTO courses (id, name, description, instructor, capacity, capacity_male, capacity_female, schedule, days, start_time, end_time, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertEnrollment = db.prepare(
    'INSERT OR IGNORE INTO enrollments (user_id, course_id, enrolled_at) VALUES (?, ?, ?)'
  );

  // 유저 이름→id 매핑 (enrollment 연결용)
  const userIdByName = {};

  db.transaction(() => {
    for (const u of users) {
      insertUser.run(u.id, u.name, '[exported]', u.role, u.gender, u.ranch, u.created_at);
      userIdByName[u.name] = u.id;
    }
    for (const c of courses) {
      insertCourse.run(c.id, c.name, c.description, c.instructor, c.capacity,
        c.capacity_male, c.capacity_female, c.schedule, c.days,
        c.start_time, c.end_time, c.sort_order, c.created_at);
    }
    for (const { courseId, list } of enrollmentsByCourse) {
      for (const e of list) {
        insertEnrollment.run(e.id ?? userIdByName[e.name], courseId, e.enrolled_at);
      }
    }
  })();

  db.close();

  console.log('\n✅ 완료!');
  console.log('   ※ birth(생년월일) 해시는 API로 노출되지 않아 "[exported]"로 저장됩니다.');
  console.log('     → 로컬 로그인은 불가하지만 수강신청 현황 열람은 가능합니다.');
}

main().catch(err => { console.error('❌ 오류:', err.message); process.exit(1); });
