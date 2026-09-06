# Today Board ↔ Notion 동기화 Worker

Today Board 대시보드와 Notion(`할일 DB`, `일정 DB`)을 **양방향 동기화**하는 Cloudflare Worker.

```
대시보드 ──▶ /push ──▶ Notion    (상태·우선순위·기한 변경, 신규 할일 생성)
대시보드 ◀── /pull ◀── Notion    (할일 + 통합 업무 실행 DB + 예정 일정 21일)
```

- `할일 DB` ↔ 대시보드 카드 **양방향**
- `통합 업무 실행 DB` → 대시보드 카드 **읽기 전용** (브리핑·영업 실행 업무 포함, 보드의 값이 원본을 덮어쓰지 않음)
  - Notion에서 이 DB를 기존 Worker 연동 계정에 공유해야 한다. 공유 전에는 기존 할일·일정 동기화는 유지하고 보드에 접근 필요 경고를 표시한다.
  - `진행상태`는 Notion **STATUS** 속성으로 읽고(`status` 필터로 질의), `업무구분`은 SELECT (`영업 후속`·`납품·설치`·`정산·증빙`·`고객 회신`·`내부 운영`·`법률·행정`).
  - `고객사`, `다음 행동` 값을 카드에 함께 표시한다.
- `일정 DB` → 대시보드 카드 **읽기 전용** (`notionSched` 태그, 기한 있는 P3 항목으로 표시)
- 퀵링크·목표는 동기화하지 않음 (대시보드 로컬 관리)

---

## 1. Notion 내부 통합 만들기

1. https://www.notion.so/my-integrations → **New integration**
   - 이름: `Today Board Sync`, 워크스페이스 선택
   - Capabilities: **Read content**, **Update content**, **Insert content** 체크
2. 발급된 **Internal Integration Secret**(`ntn_...`) 복사 — 잠시 뒤 사용
3. 아래 **3개 DB 모두**에 이 통합을 연결해야 한다. 각 DB 페이지 → 우상단 `···` → **연결(Connections)** → 통합 선택 → **페이지에 추가**
   - **할일 DB** (`a3f4897d…`)
   - **일정 DB** (`86fccaac…`)
   - **✅ 통합 업무 실행 DB** (`543f140a…`) ← 업무 보드의 원본. 빠지면 pull 시 404 → 보드에 업무 0건.

> DB ID는 `wrangler.toml`에 이미 넣어놨습니다. DB가 다르면 URL의 32자리 hex로 교체하세요.
> 현재 운영 중인 통합 이름은 **`견적서 자동화`** 이며, 위 3개 DB에 연결돼 있어야 정상 동작한다.

## 2. 배포

```bash
cd notion-sync
npm i -g wrangler        # 또는 npx wrangler 사용
wrangler login           # Cloudflare 계정 로그인 (브라우저)

wrangler secret put NOTION_TOKEN
# → 1번에서 복사한 ntn_... 붙여넣기

wrangler secret put SYNC_KEY
# → 아무 긴 랜덤 문자열 (예: openssl rand -hex 16 결과). 대시보드에도 같은 값 입력.

wrangler deploy
```

배포되면 `https://today-board-notion-sync.<계정>.workers.dev` 형태의 URL이 출력됩니다.

## 3. 확인

```bash
curl "https://today-board-notion-sync.<계정>.workers.dev/health?key=<SYNC_KEY>"
curl "https://today-board-notion-sync.<계정>.workers.dev/pull?key=<SYNC_KEY>" | jq '.tasks | length'
```

## 4. 대시보드 연결

대시보드 → **불러오기** 버튼 → **Notion 동기화** 탭:
- **Worker URL**: 위 workers.dev 주소
- **Sync Key**: `SYNC_KEY` 값
- **지금 동기화** 클릭 → 첫 동기화는 **pull 전용**(Notion → 대시보드). 기존 로컬 카드는 `로컬` 배지로 표시.
- **열 때 자동 동기화** 켜면 페이지 로드 후 자동 pull/push.

---

## 엔드포인트

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/health` | 상태 |
| GET | `/pull` | `{ tasks:[...], sched:[...], pulledAt }` |
| POST | `/push` | body `{ updates:[{notionId,status,prio,due}], creates:[{tempId,title,status,prio,due,cat}] }` → `{ updated, created:[{tempId,notionId,notionUrl}], errors }` |

`SYNC_KEY` 설정 시 모든 요청에 `?key=` 쿼리 또는 `x-sync-key` 헤더 필요.

## 매핑

| 대시보드 | Notion 할일 DB |
|---|---|
| status: todo / doing / done | 상태: 해야 함 / 진행 중 / 완료 |
| prio: P1 / P2 / P3 | 우선순위: 높음 / 보통 / 낮음 |
| due | 기한 (start, 날짜) |
| cat: bid·field·dev → 업무 / life → 개인 | 분야 (신규 생성 시) |
| cat ← 분야: 법률→field, 업무→bid, 공부→dev, 그 외→life | 분야 |

| 대시보드 (읽기 전용) | Notion 통합 업무 실행 DB |
|---|---|
| status ← 진행상태 (**STATUS** 속성): 진행 중→doing, 대기·보류→todo, 완료→done |
| cat ← 업무구분: 영업 후속·납품·설치·고객 회신→field, 정산·증빙·법률·행정→bid, 내부 운영→dev |
| customer ← 고객사 · nextAction ← 다음 행동 (카드에 표시) |

## 비용·보안

- Cloudflare Workers 무료 플랜(10만 req/일)으로 충분.
- `NOTION_TOKEN`은 Worker 시크릿에만 저장 — 저장소·대시보드·브라우저에 노출되지 않음.
- `SYNC_KEY`로 Worker 접근 제한. 대시보드는 이 키를 브라우저 localStorage에 보관하므로 공용 PC 주의.
- `ALLOW_ORIGIN`으로 대시보드 도메인만 CORS 허용.
