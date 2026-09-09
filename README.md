# Today Board

기술영업 · 사업관리 업무를 **한 화면에서** 관리하는 고밀도 다크 대시보드.
프레임워크 · 빌드 · 서버 없이 **단일 HTML 파일** 하나로 동작합니다.

**🔗 라이브: https://davidmin1975.github.io/today-board/**

---

## 특징 요약

- **의존성 제로 배포** — `index.html` 한 장. Tailwind / Alpine.js는 CDN, 폰트는 Google Fonts.
- **오프라인 완전 지원** — Service Worker(`sw.js`)가 첫 방문 후 모든 자산(HTML·CDN·폰트)을 캐시. 비행기모드에서도 새로 띄워집니다.
- **PWA 설치 가능** — `manifest.webmanifest` + 아이콘. "홈 화면에 추가" → 앱처럼 실행(standalone).
- **로컬 우선 저장** — 모든 데이터는 브라우저 `localStorage`에 자동 저장. 서버·계정 없음.
- **미니멀 다크 UI** — Slate/Zinc 기반, 앰버골드 액센트, 데스크톱 2열 / 모바일 1열 반응형.

---

## 기능

### 1. 상단 헤더 & 퀵 스테이터스
- 요일 포함 오늘 날짜
- **오늘의 한 줄 목표** (인라인 수정), 완료율 진행바
- 시스템 상태 인디케이터 — 자동화 봇 / 알림 연동 / CRM 동기화 (클릭 토글, 초록·빨강 뱃지)
- **백업 / 복구** 버튼 (아래 참조)

### 2. 메인 업무 보드
- **칸반 ↔ 리스트** 뷰 토글
- 칸반 **그룹 기준**: 상태(진행 전 / 진행 중 / 완료) · 우선순위(P1–P3) · 카테고리
- **드래그 앤 드롭** (HTML5 Native) — 카드를 끌어 상태 · 우선순위 · 카테고리 간 이동
- 카테고리 태그: `제안/입찰` `현장/기술영업` `개발/자동화` `개인/운동`
- **실시간 검색** — 제목 · 카테고리 · 우선순위 동시 매칭
- **정렬** — 마감 임박순 / 등록순 / 우선순위순
- 우선순위 필터(P1/P2/P3, 잔여 건수 표시), 완료 체크박스, 카드별 마감일(지남=빨강 · 오늘=앰버)
- **빠른 추가** — 제목 입력 후 `Enter`, 카테고리 · 우선순위 · 마감일 지정
- **지난 업무 아카이브** — 완료 후 24시간 경과 또는 `보관` 클릭 시 접이식 섹션으로 이동, `다시 열기` / 영구 삭제

### 3. 오늘의 일정 (Notion 연동)
- Notion `일정 DB`의 예정 일정(21일)이 보드에 읽기 전용 카드로 표시됨 (`일정` 배지)
- `통합 업무 실행 DB` 항목도 읽기 전용 카드로 병합 (`업무` 배지, `업무구분` · `고객사` · `다음 행동` 표시)

### 4. 퀵 링크 (사이드 패널)
- **퀵 링크** — 업무 링크 바로가기
  - **URL · 이름 기반 자동 아이콘 감지**: 커스텀값 → 키워드 매칭 → 사이트 파비콘(Google) → 기본 아이콘
  - 키워드 매핑 예: `카탈로그`→책, `견적/invoice`→문서, `pythonanywhere`→터미널, `notion`→노션, `투자/증권`→차트, `github` `메일` `텔레그램` `캘린더` `CRM` …
  - **링크 편집**: 이모지 직접 입력 또는 프리셋 아이콘 선택, 추가 / 삭제 / 순서 변경

### 5. 데이터 백업 / 복구 (샌드박스 안전)
- **내보내기** — 현재 데이터 JSON을 클립보드 복사 / 파일 저장(`.json`)
- **불러오기** — 백업 텍스트 붙여넣기 또는 파일 선택 → 유효성 검사 후 복원
- **텔레그램 전송** — 봇 토큰 · Chat ID 입력 시, 현재 데이터를 텔레그램 봇으로 파일 전송
  (토큰은 이 브라우저에만 저장. GitHub Pages·자체 호스팅 환경에서 동작)

### 6. 오프라인 인디케이터
- 연결 끊김 감지 시 좌하단 `오프라인 모드` 뱃지, 재연결 시 자동 해제
- SW 업데이트 대기 시 `새 버전 준비됨 · 눌러서 새로고침` 뱃지

---

## 파일 구성

| 파일 | 역할 |
|---|---|
| `index.html` | 앱 본체 (단일 파일 · Tailwind CDN + Alpine.js) |
| `today-board.html` | `index.html`과 동일한 원본 사본 |
| `sw.js` | Service Worker — Cache-First 오프라인 캐싱 |
| `manifest.webmanifest` | PWA 매니페스트 |
| `icon.svg` | 앱 아이콘 |

---

## 로컬 실행

```bash
# 그냥 파일을 브라우저로 열기 (Service Worker 제외한 전 기능 동작)
open index.html

# Service Worker · PWA까지 테스트하려면 로컬 HTTPS/localhost 서버 필요
npx serve .
# 또는
python3 -m http.server 8000
```

> Service Worker는 **HTTPS 또는 `localhost`** 에서만 동작합니다. `file://` 로 열면 오프라인 캐싱만 비활성이고 나머지 기능은 정상입니다.

---

## 배포

GitHub Pages (`main` 브랜치 `/` 루트)로 서비스 중입니다. `main`에 푸시하면 자동 재배포됩니다.

```bash
git add -A && git commit -m "..." && git push origin main
```

`sw.js` 상단의 `VERSION` 값을 올리면 배포 후 클라이언트 캐시가 강제 갱신됩니다.

**Cloudflare Pages / Vercel** 로도 배포 가능 — 저장소 연결 후 빌드 설정을 모두 비우고 출력 디렉터리를 루트(`/`)로 지정하면 됩니다.

---

## 기술 스택

- **UI**: HTML + [Tailwind CSS](https://tailwindcss.com/) (CDN) + [Alpine.js](https://alpinejs.dev/) 3.14
- **폰트**: Bricolage Grotesque · IBM Plex Sans KR · IBM Plex Mono (Google Fonts)
- **아이콘**: [Lucide](https://lucide.dev/) 스타일 인라인 SVG (MIT)
- **저장소**: 브라우저 `localStorage`
- **오프라인**: Service Worker + Cache Storage API
- 빌드 도구 · 번들러 · 백엔드 **없음**

---

## 라이선스

개인용 프로젝트. 아이콘 패스는 Lucide(MIT) 기반.
