/**
 * 로컬 courses DB → Railway 강의 동기화 스크립트
 *
 * 사용법:
 *   RAILWAY_URL=https://your-app.railway.app node sync-courses.js
 *
 * 선택 옵션:
 *   ADMIN_PASS=비밀번호  (기본값: 000000)
 *   DRY_RUN=1           (실제 변경 없이 diff만 출력)
 */

const Database = require('better-sqlite3');
const path = require('path');

const RAILWAY_URL = process.env.RAILWAY_URL?.replace(/\/$/, '');
const ADMIN_PASS = process.env.ADMIN_PASS || '000000';
const DRY_RUN = process.env.DRY_RUN === '1';

if (!RAILWAY_URL) {
  console.error('❌ RAILWAY_URL 환경변수가 필요합니다.');
  console.error('   예: RAILWAY_URL=https://your-app.railway.app node sync-courses.js');
  process.exit(1);
}

const COURSE_FIELDS = [
  'name', 'description', 'instructor', 'capacity', 'schedule',
  'days', 'start_time', 'end_time', 'capacity_male', 'capacity_female',
];

// ── 로컬 DB에서 강의 목록 읽기 ─────────────────────────────────────────────
const dbPath = process.env.DB_PATH || path.join(__dirname, 'courses.db');
const db = new Database(dbPath, { readonly: true });
const localCourses = db.prepare(
  `SELECT ${COURSE_FIELDS.join(', ')}, sort_order FROM courses ORDER BY sort_order ASC, id ASC`
).all();
db.close();

console.log(`📦 로컬 강의 수: ${localCourses.length}개`);
localCourses.forEach((c, i) => console.log(`   ${i + 1}. ${c.name}`));

// ── Railway API 헬퍼 ────────────────────────────────────────────────────────
let cookie = '';

async function api(method, path, body) {
  const res = await fetch(`${RAILWAY_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (path === '/api/login' && res.headers.get('set-cookie')) {
    cookie = res.headers.get('set-cookie').split(';')[0];
  }
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, data: text }; }
}

// ── 메인 ────────────────────────────────────────────────────────────────────
async function main() {
  // 1. 로그인
  console.log('\n🔑 Railway 로그인 중...');
  const login = await api('POST', '/api/login', { name: 'admin', birth: ADMIN_PASS });
  if (!login.ok) {
    console.error('❌ 로그인 실패:', login.data?.error || login.data);
    process.exit(1);
  }
  console.log('✅ 로그인 성공');

  // 2. Railway 강의 목록 조회
  const remote = await api('GET', '/api/admin/courses');
  if (!remote.ok) {
    console.error('❌ 강의 목록 조회 실패:', remote.data);
    process.exit(1);
  }
  const remoteCourses = remote.data;
  console.log(`\n☁️  Railway 강의 수: ${remoteCourses.length}개`);

  // 3. 이름 기준으로 매칭해서 diff 계산
  const remoteByName = Object.fromEntries(remoteCourses.map(c => [c.name, c]));
  const localNames = new Set(localCourses.map(c => c.name));

  const toCreate = localCourses.filter(c => !remoteByName[c.name]);
  const toUpdate = localCourses.filter(c => {
    const r = remoteByName[c.name];
    if (!r) return false;
    return COURSE_FIELDS.some(f => String(c[f] ?? '') !== String(r[f] ?? ''));
  });
  const toDelete = remoteCourses.filter(c => !localNames.has(c.name));

  console.log(`\n📋 변경 사항:`);
  console.log(`   추가: ${toCreate.length}개`);
  toCreate.forEach(c => console.log(`     + ${c.name}`));
  console.log(`   수정: ${toUpdate.length}개`);
  toUpdate.forEach(c => console.log(`     ~ ${c.name}`));
  console.log(`   삭제: ${toDelete.length}개`);
  toDelete.forEach(c => console.log(`     - ${c.name}`));

  if (DRY_RUN) {
    console.log('\n🔍 DRY_RUN 모드 — 실제 변경 없음');
    return;
  }

  if (toCreate.length + toUpdate.length + toDelete.length === 0) {
    console.log('\n✅ 이미 동기화됨 — 변경 없음');
    return;
  }

  // 4. 삭제
  for (const c of toDelete) {
    const r = await api('DELETE', `/api/admin/courses/${c.id}`);
    console.log(r.ok ? `🗑  삭제: ${c.name}` : `❌ 삭제 실패 (${c.name}): ${r.data?.error}`);
  }

  // 5. 수정
  for (const c of toUpdate) {
    const remoteId = remoteByName[c.name].id;
    const r = await api('PUT', `/api/admin/courses/${remoteId}`, c);
    console.log(r.ok ? `✏️  수정: ${c.name}` : `❌ 수정 실패 (${c.name}): ${r.data?.error}`);
  }

  // 6. 추가
  for (const c of toCreate) {
    const r = await api('POST', '/api/admin/courses', c);
    console.log(r.ok ? `➕ 추가: ${c.name}` : `❌ 추가 실패 (${c.name}): ${r.data?.error}`);
  }

  // 7. 순서 동기화
  const remoteAfter = await api('GET', '/api/admin/courses');
  if (remoteAfter.ok) {
    const remoteByName2 = Object.fromEntries(remoteAfter.data.map(c => [c.name, c]));
    const orderedIds = localCourses
      .map(c => remoteByName2[c.name]?.id)
      .filter(Boolean);
    if (orderedIds.length > 0) {
      const r = await api('PUT', '/api/admin/courses/reorder', { ids: orderedIds });
      console.log(r.ok ? '🔢 순서 동기화 완료' : `❌ 순서 동기화 실패: ${r.data?.error}`);
    }
  }

  console.log('\n✅ 동기화 완료');
}

main().catch(err => { console.error('❌ 오류:', err.message); process.exit(1); });
