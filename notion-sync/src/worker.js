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
 *   ALLOW_ORIGIN        대시보드 오리진 (CORS)
 */

const NOTION = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const PRIO_TO_NOTION = { P1: '높음', P2: '보통', P3: '낮음' };
const PRIO_FROM_NOTION = { 높음: 'P1', 보통: 'P2', 낮음: 'P3' };
const STATUS_TO_NOTION = { todo: '해야 함', doing: '진행 중', done: '완료' };
const STATUS_FROM_NOTION = { '해야 함': 'todo', '진행 중': 'doing', 대기: 'todo', 완료: 'done' };
const UNIFIED_STATUS_FROM_NOTION = { '진행 중': 'doing', 대기: 'todo', 보류: 'todo', 완료: 'done' };
const FIELD_TO_CAT = { 법률: 'field', 업무: 'bid', 수영: 'life', 금융: 'life', 개인: 'life', 여행: 'life', 공부: 'dev' };
const CAT_TO_FIELD = { bid: '업무', field: '업무', dev: '업무', life: '개인' };
const WORK_TYPE_TO_CAT = { '납품·설치': 'field', 견적: 'bid', 제안: 'bid', 개발: 'dev', 자동화: 'dev', 교육: 'field' };
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
  const status = UNIFIED_STATUS_FROM_NOTION[P['진행상태']?.select?.name] || 'todo';
  const workType = P['업무구분']?.select?.name || '';
  return {
    notionId: p.id,
    notionUrl: p.url,
    title: plain(P['업무명']?.title) || '(제목 없음)',
    status,
    done: status === 'done',
    prio: PRIO_FROM_NOTION[P['우선순위']?.select?.name] || 'P3',
    due: P['마감일']?.date?.start ? String(P['마감일'].date.start).slice(0, 10) : '',
    cat: WORK_TYPE_TO_CAT[workType] || 'bid',
    nextAction: plain(P['다음 행동']?.rich_text),
    notionReadOnly: true,
    source: 'unified-work',
  };
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
  const todoPages = await queryAll(
    env,
    env.TODO_DB,
    {
      or: [
        { property: '상태', select: { does_not_equal: '완료' } },
        {
          and: [
            { property: '상태', select: { equals: '완료' } },
            { property: '기한', date: { on_or_after: recent } },
          ],
        },
      ],
    },
    [{ property: '기한', direction: 'ascending' }],
  );

  const unifiedWorkPages = env.UNIFIED_WORK_DB
    ? await queryAll(
      env,
      env.UNIFIED_WORK_DB,
      { property: '진행상태', select: { does_not_equal: '완료' } },
      [{ property: '마감일', direction: 'ascending' }],
    )
    : [];

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

  return {
    tasks: [...todoPages.map(taskFromPage), ...unifiedWorkPages.map(unifiedWorkFromPage)],
    sched: schedPages.map(schedFromPage),
    pulledAt: new Date().toISOString(),
  };
}

async function push(env, payload) {
  const res = { updated: [], created: [], errors: [] };

  for (const u of payload.updates || []) {
    try {
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
