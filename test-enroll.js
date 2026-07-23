/**
 * 가상 유저 200명 동시 수강신청 부하 테스트
 *
 * 사용법:
 *   node test-enroll.js                             → 로컬 서버 (http://localhost:3000), 200명 전체 동시
 *   TEST_URL=https://soogang-production.up.railway.app node test-enroll.js
 *   BATCH=30 node test-enroll.js                   → 30명씩 배치로 동시 실행
 *   COUNT=50 node test-enroll.js                   → 유저 수 조정
 *   node test-enroll.js --clean                     → 테스트 데이터 삭제
 *
 * 동작:
 *   Phase 1 (준비): 200명 회원가입 + 로그인 → 세션 쿠키 수집 (순차)
 *   Phase 2 (동시): 모든 유저가 동시에 수강신청 요청 발사 (Promise.all)
 */

const BASE_URL    = (process.env.TEST_URL || 'http://localhost:3000').replace(/\/$/, '');
const CLEAN       = process.argv.includes('--clean');
const COUNT       = parseInt(process.env.COUNT  || '200');
const BATCH_SIZE  = parseInt(process.env.BATCH  || '0'); // 0 = 전체 동시

const LAST_NAMES  = ['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임'];
const FIRST_NAMES = ['민준', '서준', '도윤', '예준', '시우', '하준', '지후', '준서', '승현', '태양',
                     '서연', '서윤', '지우', '서현', '하은', '하윤', '민서', '채원', '수아', '지민'];
const RANCHES  = ['1-1', '1-2', '1-3', '2-1', '2-2', '2-3', '3-1', '3-2', '4-1', '4-2'];
const GENDERS  = ['남', '여'];
const BIRTH_PW = '000000';

function makeName(i) {
  return `테스트_${LAST_NAMES[i % LAST_NAMES.length]}${FIRST_NAMES[i % FIRST_NAMES.length]}${i + 1}`;
}

async function api(method, path, body, cookie) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data: json, cookie: setCookie ? setCookie.split(';')[0] : cookie };
}

async function cleanUp() {
  console.log('테스트 데이터 삭제 중...');
  const login = await api('POST', '/api/login', { name: 'admin', birth: '000000' });
  if (!login.ok) { console.error('관리자 로그인 실패'); process.exit(1); }
  const adminCookie = login.cookie;

  const users = await api('GET', '/api/admin/users', null, adminCookie);
  if (!users.ok) {
    console.log('관리자 유저 API 없음 — DB에서 직접 삭제하세요:');
    console.log("  DELETE FROM enrollments WHERE user_id IN (SELECT id FROM users WHERE name LIKE '테스트_%');");
    console.log("  DELETE FROM users WHERE name LIKE '테스트_%';");
    return;
  }

  const testUsers = users.data.filter(u => u.name.startsWith('테스트_'));
  console.log(`테스트 유저 ${testUsers.length}명 발견`);
  for (const u of testUsers) {
    await api('DELETE', `/api/admin/users/${u.id}`, null, adminCookie);
  }
  console.log(`완료 — ${testUsers.length}명 삭제`);
}

async function runTest() {
  const stats = { signup: 0, signupFail: 0, enrolled: 0, full: 0, conflict: 0, otherFail: 0 };

  // ── Phase 1: 회원가입 + 로그인 (순차) ──────────────────────────────────────
  console.log(`\nPhase 1: ${COUNT}명 회원가입 + 로그인 준비 중...`);
  const sessions = []; // [{ cookie, courseIds }]

  // 강좌 목록은 한 번만 조회 (어드민 계정으로)
  const adminLogin = await api('POST', '/api/login', { name: 'admin', birth: '000000' });
  if (!adminLogin.ok) { console.error('관리자 로그인 실패'); process.exit(1); }
  const allCourses = await api('GET', '/api/admin/courses', null, adminLogin.cookie);
  if (!allCourses.ok || !Array.isArray(allCourses.data) || allCourses.data.length === 0) {
    console.error('강좌가 없습니다. 먼저 강좌를 등록하세요.');
    process.exit(1);
  }
  console.log(`강좌 ${allCourses.data.length}개 발견: ${allCourses.data.map(c => c.name).join(', ')}`);

  for (let i = 0; i < COUNT; i++) {
    process.stdout.write(`\r  [${i + 1}/${COUNT}] 준비 중...`);
    const name   = makeName(i);
    const gender = GENDERS[i % 2];
    const ranch  = RANCHES[i % RANCHES.length];

    const signup = await api('POST', '/api/signup', { name, birth: BIRTH_PW, ranch, gender });
    if (signup.ok) {
      stats.signup++;
    } else if (!signup.data.error?.includes('이미 존재')) {
      stats.signupFail++;
      continue;
    }

    const login = await api('POST', '/api/login', { name, birth: BIRTH_PW });
    if (!login.ok) { stats.signupFail++; continue; }

    // 무작위로 신청할 강좌 1~2개 미리 선택
    const shuffled = [...allCourses.data].sort(() => Math.random() - 0.5);
    const picks    = shuffled.slice(0, Math.floor(Math.random() * 2) + 1).map(c => c.id);
    sessions.push({ cookie: login.cookie, courseIds: picks, name });
  }

  console.log(`\n  준비 완료 — ${sessions.length}명 세션 확보\n`);

  // ── Phase 2: 동시 수강신청 ──────────────────────────────────────────────────
  const batchSize = BATCH_SIZE > 0 ? BATCH_SIZE : sessions.length;
  const batchCount = Math.ceil(sessions.length / batchSize);
  console.log(`Phase 2: 동시 수강신청 시작 (${batchSize === sessions.length ? '전체 동시' : `${batchSize}명씩 ${batchCount}배치`})`);

  const enrollResults = [];

  for (let b = 0; b < batchCount; b++) {
    const batch = sessions.slice(b * batchSize, (b + 1) * batchSize);
    if (batchCount > 1) process.stdout.write(`\r  배치 [${b + 1}/${batchCount}] 실행 중...`);

    const startTime = Date.now();

    const results = await Promise.all(
      batch.flatMap(({ cookie, courseIds, name }) =>
        courseIds.map(courseId =>
          api('POST', `/api/courses/${courseId}/enroll`, {}, cookie)
            .then(res => ({ name, courseId, ok: res.ok, error: res.data.error || '' }))
        )
      )
    );

    const elapsed = Date.now() - startTime;
    if (batchCount > 1) console.log(` (${elapsed}ms)`);
    else console.log(`  전체 ${results.length}건 완료 — ${elapsed}ms 소요`);

    enrollResults.push(...results);
  }

  // ── 결과 집계 ───────────────────────────────────────────────────────────────
  for (const r of enrollResults) {
    if (r.ok) {
      stats.enrolled++;
    } else if (r.error.includes('정원')) {
      stats.full++;
    } else if (r.error.includes('시간')) {
      stats.conflict++;
    } else {
      stats.otherFail++;
    }
  }

  console.log('\n══════════════════════════════════');
  console.log(`  동시 수강신청 테스트 완료 (${COUNT}명)`);
  console.log('──────────────────────────────────');
  console.log(`  회원가입 성공:      ${stats.signup}명`);
  console.log(`  회원가입 실패:      ${stats.signupFail}명`);
  console.log(`  수강신청 성공:      ${stats.enrolled}건`);
  console.log(`  정원 초과 거부:     ${stats.full}건`);
  console.log(`  시간 충돌 거부:     ${stats.conflict}건`);
  console.log(`  기타 실패:          ${stats.otherFail}건`);
  console.log('══════════════════════════════════');
  console.log('\n테스트 데이터 삭제:');
  console.log('  node test-enroll.js --clean');
}

async function main() {
  console.log(`대상 서버: ${BASE_URL}`);
  try {
    await fetch(`${BASE_URL}/api/courses`);
  } catch {
    console.error(`서버에 연결할 수 없습니다: ${BASE_URL}`);
    console.error('서버를 먼저 실행하세요: node server.js');
    process.exit(1);
  }

  if (CLEAN) {
    await cleanUp();
  } else {
    await runTest();
  }
}

main().catch(err => { console.error('\n오류:', err.message); process.exit(1); });
