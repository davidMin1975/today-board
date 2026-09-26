/**
 * Today Board ↔ Notion 양방향 동기화 Cloudflare Worker
 *
 * 엔드포인트
 *   GET  /health        상태 확인
 *   GET  /pull          할일 DB + 일정 DB(예정 21일) 를 대시보드 스키마로 반환
 *   POST /push          대시보드의 변경(상태/우선순위/기한) 및 신규 할일을 Notion 에 반영
 *
 * 시크릿 (wrangler secret put)
 *   NOTION_TOKEN        Notion 내부 통합(integration) 토큰
 *   SYNC_KEY            (선택) 공유 키 — 설정 시 ?key= 또는 x-sync-key 헤더 필요
 *
 * 변수 (wrangler.toml [vars])
 *   TODO_DB             할일 DB ID
 *   SCHED_DB            일정 DB ID
 *   UNIFIED_WORK_DB     통합 업무 실행 DB ID (읽기 전용)
 *                      진행상태=STATUS 속성, 업무구분=SELECT, 고객사/다음 행동 표시
 *   ALLOW_ORIGIN        대시보드 오리진 (CORS)
 *   EXCLUDED_PROJECT_IDS (선택, 콤마 구분) 할일 DB의 "업무 프로젝트" 관계가 이 프로젝트
 *                      페이지 ID를 가리키면 대시보드에서 제외한다(개인/행정 준비 프로젝트 등
 *                      브리핑에는 이미 나오지 않는 항목을 대시보드에서도 동일하게 숨기기 위함).
 */

const NOTION = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const PRIO_TO_NOTION = { P1: '높음', P2: '보통', P3: '낮음' };
const PRIO_FROM_NOTION = { 높음: 'P1', 보통: 'P2', 낮음: 'P3' };
const STATUS_TO_NOTION = { todo: '해야 함', doing: '진행 중', done: '완료' };
const STATUS_FROM_NOTION = { '해야 함': 'todo', '진행 중': 'doing', 대기: 'todo', 완료: 'done' };
const UNIFIED_STATUS_FROM_NOTION = { '진행 중': 'doing', 진행: 'doing', 대기: 'todo', '시작 전': 'todo', 보류: 'todo', 완료: 'done' };
const UNIFIED_STATUS_TO_NOTION = { todo: '시작 전', doing: '진행 중', done: '완료' };
const FIELD_TO_CAT = { 법률: 'field', 업무: 'bid', 수영: 'life', 금융: 'life', 개인: 'life', 여행: 'life', 공부: 'dev' };
const CAT_TO_FIELD = { bid: '업무', field: '업무', dev: '업무', life: '개인' };
// 통합 업무 실행 DB 의 실제 "업무구분" 값 → 대시보드 카테고리
const WORK_TYPE_TO_CAT = {
  '영업 후속': 'field',
  '납품·설치': 'field',
  '고객 회신': 'field',
  '정산·증빙': 'bid',
  '법률·행정': 'bid',
  '내부 운영': 'dev',
  // 레거시 값 호환
  견적: 'bid', 제안: 'bid', 개발: 'dev', 자동화: 'dev', 교육: 'field',
};
const SCHED_TYPE_TO_CAT = {
  법원: 'field', 미팅: 'field', '서류 마감': 'bid', 강습: 'life', 여행: 'life',
  병원: 'life', 은행: 'life', '가족·기념일': 'life', 공휴일: 'life', 개인: 'life', 기타: 'dev',
};

function cors(env, extra) {
  return {
    'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-sync-key',
    'Access-Control-Max-Age': '86400',
    ...(extra || {}),
  };
}
function json(obj, status, env) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(env) },
  });
}

async function notion(env, path, method, body) {
  const r = await fetch(NOTION + path, {
    method: method || 'GET',
    headers: {
      Authorization: 'Bearer ' + env.NOTION_TOKEN,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Notion ' + r.status + ': ' + (j.message || JSON.stringify(j)).slice(0, 300));
  return j;
}

const plain = (rich) => (rich || []).map((t) => t.plain_text).join('').trim();

// 속성 타입에 상관없이 사람이 읽을 수 있는 텍스트를 뽑아낸다.
// (고객사·다음 행동 등이 rich_text / select / formula / rollup 어느 쪽이든 대응)
function anyText(prop) {
  if (!prop) return '';
  switch (prop.type) {
    case 'title': return plain(prop.title);
    case 'rich_text': return plain(prop.rich_text);
    case 'select': return prop.select?.name || '';
    case 'status': return prop.status?.name || '';
    case 'multi_select': return (prop.multi_select || []).map((s) => s.name).join(', ');
    case 'people': return (prop.people || []).map((p) => p.name).filter(Boolean).join(', ');
    case 'number': return prop.number != null ? String(prop.number) : '';
    case 'formula':
      return prop.formula?.string
        || (prop.formula?.number != null ? String(prop.formula.number) : '')
        || (prop.formula?.date?.start ? String(prop.formula.date.start).slice(0, 10) : '');
    case 'rollup':
      return (prop.rollup?.array || []).map((x) => anyText(x)).filter(Boolean).join(', ');
    default: return '';
  }
}

async function queryAll(env, dbId, filter, sorts) {
  const out = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (sorts) body.sorts = sorts;
    if (cursor) body.start_cursor = cursor;
    const j = await notion(env, `/databases/${dbId}/query`, 'POST', body);
    out.push(...j.results);
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return out;
}

async function optionalQueryAll(env, dbId, filter, sorts, label) {
  try {
    return { pages: await queryAll(env, dbId, filter, sorts), warning: '' };
  } catch (e) {
    // 선택 원본의 권한·스키마 문제는 기존 할일·일정 동기화를 중단시키지 않는다.
    return { pages: [], warning: `${label}: ${String(e.message || e).slice(0, 200)}` };
  }
}

function taskFromPage(p) {
  const P = p.properties || {};
  const status = STATUS_FROM_NOTION[P['상태']?.select?.name] || 'todo';
  return {
    notionId: p.id,
    notionUrl: p.url,
    title: plain(P['할일']?.title) || '(제목 없음)',
    status,
    done: status === 'done',
    prio: PRIO_FROM_NOTION[P['우선순위']?.select?.name] || 'P3',
    due: P['기한']?.date?.start ? String(P['기한'].date.start).slice(0, 10) : '',
    cat: FIELD_TO_CAT[P['분야']?.select?.name] || 'bid',
    nextAction: plain(P['다음 행동']?.rich_text),
  };
}

function unifiedWorkFromPage(p) {
  const P = p.properties || {};
  // "진행상태" 는 Notion STATUS 속성이다 (SELECT 아님) → .status.name 으로 읽는다.
  const status = UNIFIED_STATUS_FROM_NOTION[P['진행상태']?.status?.name] || 'todo';
  const workType = anyText(P['업무구분']);
  return {
    notionId: p.id,
    notionUrl: p.url,
    title: plain(P['업무명']?.title) || '(제목 없음)',
    status,
    done: status === 'done',
    prio: PRIO_FROM_NOTION[anyText(P['우선순위'])] || 'P3',
    due: P['마감일']?.date?.start ? String(P['마감일'].date.start).slice(0, 10) : '',
    cat: WORK_TYPE_TO_CAT[workType] || 'bid',
    workType,
    customer: anyText(P['고객사']),
    nextAction: anyText(P['다음 행동']),
    briefing: P['브리핑 포함']?.checkbox === true,
    notionReadOnly: true,
    source: 'unified-work',
  };
}

// "오늘의 한 줄 목표" 자동 제안: 브리핑 포함 + 미완료, 우선순위(긴급→보통→낮음) 우선 · 동순위는 마감 빠른 순, 상위 3건
const PRIO_RANK = { P1: 0, P2: 1, P3: 2 };
function briefingGoal(items) {
  const picked = items
    .filter((t) => t.briefing && t.status !== 'done')
    .sort((a, b) => {
      const pr = (PRIO_RANK[a.prio] ?? 9) - (PRIO_RANK[b.prio] ?? 9);
      if (pr !== 0) return pr;
      return String(a.due || '9999-99-99').localeCompare(String(b.due || '9999-99-99'));
    })
    .slice(0, 3);
  return picked.map((t) => ({ title: t.title, customer: t.customer, due: t.due, notionUrl: t.notionUrl }));
}

function schedFromPage(p) {
  const P = p.properties || {};
  return {
    notionId: p.id,
    notionUrl: p.url,
    notionSched: true,
    title: plain(P['일정명']?.title) || '(일정)',
    status: 'todo',
    done: false,
    prio: 'P3',
    due: P['일시']?.date?.start ? String(P['일시'].date.start).slice(0, 10) : '',
    cat: SCHED_TYPE_TO_CAT[P['유형']?.select?.name] || 'life',
    schedType: P['유형']?.select?.name || '',
    place: plain(P['장소']?.rich_text),
  };
}

async function pull(env) {
  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10);
  const recent = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);

  // 진행 중인 할일 + 최근(기한 3일 이내) 완료 건만. 오래된 완료 건은 Notion에만 두고 대시보드로 내려보내지 않음.
  // [2026-09-23] 법인 설립 준비(개인 행정 프로젝트) 관련 할일은 브리핑(아침/저녁)에서 이미
  // 제외돼 왔으나 대시보드에는 필터가 없어 그대로 노출되던 불일치를 여기서 맞춘다.
  // EXCLUDED_PROJECT_IDS(콤마 구분, 없으면 미필터)에 걸린 "업무 프로젝트" 관계를 가진 할일은 제외.
  const excludedProjectIds = (env.EXCLUDED_PROJECT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const todoStatusFilter = {
    or: [
      { property: '상태', select: { does_not_equal: '완료' } },
      {
        and: [
          { property: '상태', select: { equals: '완료' } },
          { property: '기한', date: { on_or_after: recent } },
        ],
      },
    ],
  };
  const todoFilter = excludedProjectIds.length
    ? {
      and: [
        todoStatusFilter,
        ...excludedProjectIds.map((id) => ({
          property: '업무 프로젝트',
          relation: { does_not_contain: id },
        })),
      ],
    }
    : todoStatusFilter;
  const todoPages = await queryAll(
    env,
    env.TODO_DB,
    todoFilter,
    [{ property: '기한', direction: 'ascending' }],
  );

  // [2026-09-26] 통합 업무 실행 DB에도 할일 DB와 같은 EXCLUDED_PROJECT_IDS 필터를 적용한다.
  // 지금은 이 DB에 법인 설립 준비 관련 행이 없어 눈에 띄는 차이가 없지만, 필터가 한쪽에만
  // 있으면 새 행이 생기는 순간 대시보드·브리핑이 다시 어긋난다(2026-09-23 할일 DB 불일치와
  // 같은 유형 — briefing-dashboard-display-parity 메모 참고).
  const unifiedWorkStatusFilter = { property: '진행상태', status: { does_not_equal: '완료' } };
  const unifiedWorkFilter = excludedProjectIds.length
    ? {
      and: [
        unifiedWorkStatusFilter,
        ...excludedProjectIds.map((id) => ({
          property: '업무 프로젝트',
          relation: { does_not_contain: id },
        })),
      ],
    }
    : unifiedWorkStatusFilter;
  const unifiedWork = env.UNIFIED_WORK_DB
    ? await optionalQueryAll(
      env,
      env.UNIFIED_WORK_DB,
      unifiedWorkFilter,
      [{ property: '마감일', direction: 'ascending' }],
      '통합 업무 실행 DB',
    )
    : { pages: [], warning: '' };

  const schedPages = await queryAll(
    env,
    env.SCHED_DB,
    {
      and: [
        { property: '상태', select: { does_not_equal: '완료' } },
        { property: '상태', select: { does_not_equal: '취소' } },
        { property: '중복 보관', checkbox: { equals: false } },
        { property: '일시', date: { on_or_after: today } },
        { property: '일시', date: { on_or_before: horizon } },
      ],
    },
    [{ property: '일시', direction: 'ascending' }],
  );

  const unifiedItems = unifiedWork.pages.map(unifiedWorkFromPage);

  return {
    tasks: [...todoPages.map(taskFromPage), ...unifiedItems],
    sched: schedPages.map(schedFromPage),
    briefingP1: briefingGoal(unifiedItems),
    warnings: unifiedWork.warning ? [unifiedWork.warning] : [],
    pulledAt: new Date().toISOString(),
  };
}

async function push(env, payload) {
  const res = { updated: [], created: [], errors: [] };

  for (const u of payload.updates || []) {
    try {
      // 통합 업무 실행 DB(읽기 전용 원본)는 "진행상태"(STATUS 속성)만 보드 체크에서 반영
      if (u.source === 'unified-work') {
        const props = {};
        if (u.status) props['진행상태'] = { status: { name: UNIFIED_STATUS_TO_NOTION[u.status] || '시작 전' } };
        await notion(env, `/pages/${u.notionId}`, 'PATCH', { properties: props });
        res.updated.push(u.notionId);
        continue;
      }
      const props = {};
      if (u.status) props['상태'] = { select: { name: STATUS_TO_NOTION[u.status] || '해야 함' } };
      if (u.prio) props['우선순위'] = { select: { name: PRIO_TO_NOTION[u.prio] || '보통' } };
      if (u.due !== undefined) props['기한'] = u.due ? { date: { start: u.due } } : { date: null };
      await notion(env, `/pages/${u.notionId}`, 'PATCH', { properties: props });
      res.updated.push(u.notionId);
    } catch (e) {
      res.errors.push({ id: u.notionId, error: String(e.message || e) });
    }
  }

  for (const c of payload.creates || []) {
    try {
      const props = {
        '할일': { title: [{ text: { content: (c.title || '(제목 없음)').slice(0, 1800) } }] },
        '상태': { select: { name: STATUS_TO_NOTION[c.status] || '해야 함' } },
        '우선순위': { select: { name: PRIO_TO_NOTION[c.prio] || '보통' } },
      };
      if (c.due) props['기한'] = { date: { start: c.due } };
      if (CAT_TO_FIELD[c.cat]) props['분야'] = { select: { name: CAT_TO_FIELD[c.cat] } };
      const page = await notion(env, '/pages', 'POST', {
        parent: { database_id: env.TODO_DB },
        properties: props,
      });
      res.created.push({ tempId: c.tempId, notionId: page.id, notionUrl: page.url });
    } catch (e) {
      res.errors.push({ tempId: c.tempId, error: String(e.message || e) });
    }
  }

  return res;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(env) });

    if (env.SYNC_KEY) {
      const k = url.searchParams.get('key') || req.headers.get('x-sync-key');
      if (k !== env.SYNC_KEY) return json({ error: 'unauthorized' }, 401, env);
    }

    try {
      if (url.pathname === '/' || url.pathname === '/health') {
        return json(
          {
            ok: true,
            service: 'today-board notion sync',
            endpoints: ['/pull (GET)', '/push (POST)'],
            notionToken: env.NOTION_TOKEN ? 'set' : 'MISSING',
            syncKey: env.SYNC_KEY ? 'set' : 'none',
          },
          200,
          env,
        );
      }

      if (!env.NOTION_TOKEN) return json({ error: 'NOTION_TOKEN 시크릿이 설정되지 않았습니다' }, 500, env);

      if (url.pathname === '/pull' && req.method === 'GET') {
        return json(await pull(env), 200, env);
      }
      if (url.pathname === '/push' && req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        return json(await push(env, body), 200, env);
      }
      return json({ error: 'not found', path: url.pathname }, 404, env);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500, env);
    }
  },
};
