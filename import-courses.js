/**
 * 로컬 DB → Railway 서버 강좌 동기화 스크립트
 *
 * 사용법:
 *   RAILWAY_URL=https://your-app.up.railway.app node import-courses.js
 *   RAILWAY_URL=https://your-app.up.railway.app ADMIN_PASS=비밀번호 node import-courses.js
 *
 * 동작:
 *   - 로컬 courses.db의 강좌 목록을 서버에 업로드
 *   - 서버에 수강신청자가 없는 강좌는 삭제 후 재생성
 *   - 수강신청자가 있는 강좌는 내용만 업데이트 (삭제 안 함)
 */

const Database = require('better-sqlite3');
const path = require('path');

const RAILWAY_URL = (process.env.RAILWAY_URL || '').replace(/\/$/, '');
const ADMIN_PASS  = process.env.ADMIN_PASS || '000000';
const DB_PATH     = process.env.DB_PATH || path.join(__dirname, 'courses.db');

if (!RAILWAY_URL) {
  console.error('RAILWAY_URL 환경변수가 필요합니다.');
  console.error('  예: RAILWAY_URL=https://soogang-production.up.railway.app node import-courses.js');
  process.exit(1);
}

let cookie = '';

async function req(method, endpoint, body) {
  const res = await fetch(`${RAILWAY_URL}${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (endpoint === '/api/login' && res.headers.get('set-cookie')) {
    cookie = res.headers.get('set-cookie').split(';')[0];
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`API 오류 ${res.status} (${endpoint}): ${json.error || ''}`);
  return json;
}

async function main() {
  // 1. 로컬 강좌 읽기
  const db = new Database(DB_PATH, { readonly: true });
  const localCourses = db.prepare('SELECT * FROM courses ORDER BY sort_order, id').all();
  db.close();
  console.log(`로컬 강좌: ${localCourses.length}개`);

  if (localCourses.length === 0) {
    console.log('로컬에 강좌가 없습니다. 종료합니다.');
    return;
  }

  // 2. 로그인
  console.log('로그인 중...');
  await req('POST', '/api/login', { name: 'admin', birth: ADMIN_PASS });
  console.log('로그인 성공');

  // 3. 서버 강좌 및 수강신청 현황 조회
  const serverCourses = await req('GET', '/api/admin/courses');
  const enrollmentCounts = {};
  await Promise.all(
    serverCourses.map(async (c) => {
      const list = await req('GET', `/api/admin/courses/${c.id}/enrollments`);
      enrollmentCounts[c.id] = list.length;
    })
  );
  console.log(`서버 강좌: ${serverCourses.length}개`);

  const serverByName = Object.fromEntries(serverCourses.map(c => [c.name, c]));

  let created = 0, updated = 0, skipped = 0;

  for (const c of localCourses) {
    const payload = {
      name:            c.name,
      description:     c.description || '',
      instructor:      c.instructor || '',
      capacity:        c.capacity,
      capacity_male:   c.capacity_male || 0,
      capacity_female: c.capacity_female || 0,
      schedule:        c.schedule || '',
      days:            c.days || '',
      start_time:      c.start_time || '',
      end_time:        c.end_time || '',
    };

    const existing = serverByName[c.name];

    if (existing) {
      // 이름이 같은 강좌가 서버에 있으면 업데이트
      await req('PUT', `/api/admin/courses/${existing.id}`, payload);
      console.log(`  업데이트: ${c.name}`);
      updated++;
    } else {
      // 새 강좌 생성
      await req('POST', '/api/admin/courses', payload);
      console.log(`  생성: ${c.name}`);
      created++;
    }
  }

  // 서버에만 있고 로컬에 없는 강좌 처리
  const localNames = new Set(localCourses.map(c => c.name));
  for (const sc of serverCourses) {
    if (!localNames.has(sc.name)) {
      const count = enrollmentCounts[sc.id] || 0;
      if (count === 0) {
        await req('DELETE', `/api/admin/courses/${sc.id}`);
        console.log(`  삭제 (로컬에 없음): ${sc.name}`);
      } else {
        console.log(`  유지 (수강신청자 ${count}명 있음, 로컬에 없음): ${sc.name}`);
        skipped++;
      }
    }
  }

  console.log(`\n완료 — 생성 ${created}개 / 업데이트 ${updated}개 / 유지 ${skipped}개`);
}

main().catch(err => { console.error('오류:', err.message); process.exit(1); });
