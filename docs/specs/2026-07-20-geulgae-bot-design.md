# 글개 봇 설계 문서

- 작성일: 2026-07-20
- 상태: 설계 승인 완료 (구현 전)
- 선행 프로젝트: manage-writing-discord-bot (참고용, 로컬 경로 `~/dev/personal/manage-writing-discord-bot`)

## 1. 배경과 목적

글쓰기 스터디 "글개"의 기존 봇 운영자가 채널을 떠나면서, 같은 역할을 하는 봇을 새로 만들어 직접 운영한다. 기존 구조에 얽매이지 않고 처음부터 다시 설계한다.

핵심 역할: **매주 참여자를 정해 블로그 글 목표를 설정하고, 일요일 마감까지 목표를 달성하지 못한 참여자에게 벌금을 부과·집계한다.**

기존 봇에서 얻은 교훈과 새 설계의 대응:

| 기존 봇의 문제 | 원인 | 새 설계의 대응 |
|---|---|---|
| LIVE/REFRESH/TRUST 3단계 검증 모드 등 복잡한 복원 로직 | 상시 서버·DB 없이 GitHub Actions 재기동 + 채널 히스토리 재생으로 상태 복원 | 모든 상태를 D1(SQLite)에 저장. 히스토리 재생 자체가 사라짐 |
| 멀쩡히 인증된 글이 재검증 실패로 미인증 처리되는 "억울한 벌금" | 재기동 때마다 HTTP 재검증, Medium 등의 봇 차단 | 검증은 제출 시 1회 best-effort. 실패해도 인증은 유효 |
| 메시지 줄 번호 하드코딩 파싱의 취약성 | `!목표` 자유 텍스트 포맷 | 슬래시 커맨드의 구조화된 옵션으로 파싱 자체가 불필요 |
| 전체 히스토리 순회로 인한 성능·rate limit 위험 | 채널 히스토리가 곧 DB | DB 쿼리로 대체 |

## 2. 확정 요구사항

- **인프라**: 완전 무료 운영. Cloudflare Workers(HTTP Interactions) + D1 + Cron Triggers, TypeScript
- **주간 사이클**: 월요일 시작 → 일요일 23:59(KST) 마감
- **참여자 지정**: 평소엔 수동(`/목표설정`), 화요일 10시까지 미설정 시 봇이 **[참여하기] 버튼이 달린 공지**를 올려 자동 모집
- **목표량**: 주당 글 개수 지정 가능(기본 1개), 미달 개수 × 벌금 단가(기본 10,000원, 설정 가능)
- **링크 검증**: URL 형식·중복 검사는 필수, HTTP 접속 확인은 best-effort(실패해도 등록 유지, 표시만)
- **리마인더**: 일요일 오전 10시, 미달성 참여자만 멘션
- **벌금 관리**: 조회·조정 누구나 가능, 모든 내역은 append-only 원장에 기록되어 공개
- **벌금 조정**: 대상과 금액만 필수, 사유는 선택
- **참여 취소**: 누구나 대상 지정 가능(기본값 본인), 마감 전 + 해당 사이클 제출물이 없을 때만
- **사이클마다 새 스레드** 생성, 스레드 안에서 인증하면 그 스레드의 사이클로 귀속 (다음 주 목표를 미리 만들어 미리 인증하는 것도 가능)

## 3. 아키텍처

### 3.1 구성 요소

```
디스코드 서버 (글개)
   │  슬래시 커맨드 / 버튼 클릭  (웹훅 POST, Ed25519 서명)
   ▼
Cloudflare Worker ──────────── D1 (SQLite, 단일 진실 공급원)
   │  ▲
   │  └─ Cron Triggers (정산 sweep · 안전망 공지 · 리마인더)
   ▼
Discord REST API  (공지, 스레드 생성, 후속 메시지)
```

- **Worker 1개, 진입점 2개**: `fetch`(인터랙션 웹훅 처리), `scheduled`(cron 잡 분기 — `event.cron` 문자열로 어떤 잡인지 판별)
- **게이트웨이(웹소켓) 미사용**: 일반 메시지 감청 불가, 슬래시 커맨드·버튼·cron만으로 동작. 이 봇의 모든 기능은 이 세 가지로 충분하다
- **시간 처리**: DB에는 UTC ISO 8601로 저장하고, 주차·마감 판정은 도메인 함수에서 KST(UTC+9 고정, 한국은 서머타임 없음)로 변환해 수행. `week_start`만 예외로 KST 달력 날짜(`YYYY-MM-DD`, 그 주 월요일)

### 3.2 주간 타임라인 (KST)

| 시점 | 주체 | 동작 |
|---|---|---|
| 매일 00:01 | 봇 (정산 sweep) | 마감 지났고 미정산인 사이클 전부 정산. 사실상 월요일 새벽에 지난주 정산 |
| 월~일 수시 | 사람 | `/목표설정`으로 사이클 생성·갱신, `/인증`으로 글 제출 |
| 화 10:00 | 봇 (안전망) | 이번 주 사이클이 없으면 기본값으로 생성 + [참여하기] 버튼 공지 |
| 일 10:00 | 봇 (리마인더) | 미달성 참여자만 멘션 |
| 일 23:59 | — | 마감. 정확히는 "월요일 00:00부터 제출 불가·정산 대상" |

### 3.3 프로젝트 구조

```
src/
├── index.ts              # 진입점: fetch(서명 검증→라우팅) + scheduled(cron 분기)
├── router.ts             # 명령 이름/custom_id → 핸들러 매핑
├── interactions/         # 요청당 핸들러 하나
│   ├── goal.ts           #   /목표설정
│   ├── submit.ts         #   /인증
│   ├── status.ts         #   /현황
│   ├── penalty.ts        #   /벌금현황, /벌금조정
│   ├── withdraw.ts       #   /참여취소
│   └── join-button.ts    #   [참여하기] 버튼
├── domain/               # 순수 함수만 (Discord도 DB도 모름)
│   ├── cycle.ts          #   주차 계산, 마감 판정, 사이클 귀속
│   ├── settlement.ts     #   (참여자, 제출 수) → 벌금 엔트리 목록
│   └── url.ts            #   URL 형식 검사·정규화
├── jobs/
│   ├── settle.ts         #   정산 sweep
│   ├── fallback-notice.ts#   안전망 공지
│   └── reminder.ts       #   리마인더
├── discord/
│   ├── api.ts            #   Discord REST 래퍼 (메시지·스레드·팔로업)
│   └── replies.ts        #   인터랙션 응답 JSON 빌더 (ephemeral 등)
└── db/
    └── queries.ts        #   D1 쿼리 함수
migrations/               # D1 마이그레이션 (0001_init.sql, ...)
scripts/
└── register.ts           # 슬래시 커맨드 등록 (길드 커맨드, 1회 실행)
wrangler.toml
```

**의존성 정책**: 런타임 의존성은 `discord-interactions`(서명 검증) 하나만. 프레임워크 없이 직접 라우팅한다. 개발 의존성: `wrangler`, `typescript`, `vitest`, `@cloudflare/vitest-pool-workers`.

## 4. 데이터 모델 (D1)

```sql
CREATE TABLE cycles (                     -- 주간 사이클 (주당 1행)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT NOT NULL UNIQUE,        -- 'YYYY-MM-DD' 그 주 월요일 (KST 달력 날짜)
  goal_count INTEGER NOT NULL DEFAULT 1,
  penalty_per_post INTEGER NOT NULL DEFAULT 10000,
  channel_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,                -- 이 사이클 전용 스레드
  created_by TEXT NOT NULL,               -- 'user:<discord_id>' | 'bot:fallback'
  created_at TEXT NOT NULL,               -- UTC ISO 8601 (이하 동일)
  settled_at TEXT                         -- NULL이면 미정산
);

CREATE TABLE participants (               -- 사이클별 참여자
  cycle_id INTEGER NOT NULL REFERENCES cycles(id),
  user_id TEXT NOT NULL,
  joined_via TEXT NOT NULL,               -- 'manual' | 'button' | 'submit'
  joined_at TEXT NOT NULL,
  PRIMARY KEY (cycle_id, user_id)
);

CREATE TABLE submissions (                -- 인증된 글
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id INTEGER NOT NULL REFERENCES cycles(id),
  user_id TEXT NOT NULL,
  url TEXT NOT NULL,                      -- 정규화된 URL
  submitted_at TEXT NOT NULL,
  fetch_status TEXT,                      -- NULL(확인 전) | 'ok' | 'failed'
  fetch_title TEXT,
  UNIQUE (user_id, url)                   -- 전 기간에 걸쳐 같은 글 재제출 방지
);

CREATE TABLE penalty_entries (            -- 벌금 원장 (append-only, 수정·삭제 없음)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,                -- 부과 +, 삭감·납부 -
  kind TEXT NOT NULL,                     -- 'settlement' | 'adjustment'
  cycle_id INTEGER REFERENCES cycles(id), -- settlement일 때만 필수
  reason TEXT,                            -- 선택
  created_by TEXT NOT NULL,               -- 'bot:settlement' | 'user:<discord_id>'
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX ux_settlement_once    -- 사이클당·유저당 자동 정산 1회 보장 (멱등 장치)
  ON penalty_entries (cycle_id, user_id) WHERE kind = 'settlement';
```

핵심 성질:

- **현재 벌금 = `SUM(amount)` per user.** 자동 부과, 수동 조정, 납부 처리, 기존 봇 벌금 이월이 전부 같은 테이블의 행이다
- **중복 제출 방지는 DB 유니크 제약**으로 강제 (코드 로직 버그로 뚫릴 수 없음)
- **정산 멱등성은 partial unique index**로 강제 — cron이 중복 실행돼도 이중 부과 불가
- 정산 완료된 사이클(`settled_at NOT NULL`)은 불변. 이의는 `/벌금조정`으로 해결

## 5. 명령 체계

명령 이름은 한글을 사용한다 (Discord는 커맨드 이름에 한글 허용). 커맨드는 **길드(서버) 커맨드**로 등록한다 — 반영이 즉시라 운영·테스트 모두 편하다.

### 5.1 명령 목록

| 명령 | 옵션 | 동작 |
|---|---|---|
| `/목표설정` | `참여자`(문자열, 필수, 멘션 파싱) · `개수`(정수, 기본 1) · `벌금`(정수, 기본 10000) · `주차`(이번주\|다음주, 기본 이번주) | 사이클 생성 + 채널에 목표 공지 + 스레드 생성 + 스레드에 시작 안내. 이미 있으면 참여자 합집합 추가·명시된 설정만 갱신 |
| `/인증` | `링크`(문자열, 필수) | 형식·중복 검사 → 저장 → 즉시 "현재 N/M개" 공개 응답. HTTP 확인은 백그라운드 |
| `/현황` | — | 귀속 사이클의 참여자별 진행률(N/M)과 마감까지 남은 시간 |
| `/벌금현황` | — | 멤버별 벌금 잔액과 총액 (원장 합산) |
| `/벌금조정` | `대상`(유저, 필수) · `금액`(정수, 필수, 양수=부과·음수=삭감) · `사유`(문자열, 선택) | 원장에 adjustment 행 추가, 공개 응답 |
| `/참여취소` | `대상`(유저, 선택, 기본 본인) | 참여자에서 제거. 조건: 마감 전 + 그 사이클 제출물 0개 |
| [참여하기] 버튼 | `custom_id = join:<week_start>` | 그 사이클 참여자로 등록. 마감 전까지 유효. (cycle_id가 아닌 week_start를 쓰는 이유: 공지 메시지 → 스레드 → 사이클 행 순서로 생성되므로 버튼 전송 시점에 cycle_id가 아직 없다) |

### 5.2 사이클 귀속 규칙

`/인증`, `/현황`, `/참여취소`가 어느 사이클에 대해 동작하는지:

1. **사이클 스레드 안에서 실행** → 그 스레드의 사이클 (인터랙션의 `channel_id`가 `cycles.thread_id`와 일치)
2. **인증 채널에서 실행** → 현재 주차(KST 기준 이번 주 월요일) 사이클
3. 쓰기 동작(`/인증`, `/참여취소`, 버튼 참여)은 **마감이 지난 사이클이면 거부** ("이미 마감된 주차예요"). 조회(`/현황`)는 마감 후에도 허용

이 규칙 덕에 `/목표설정 주차:다음주`로 다음 주 사이클을 미리 만들면, 격주로 쓰는 사람이 글을 미리 완성해 **다음 주 스레드에서 미리 인증**해도 정확히 그 주에 반영된다.

### 5.3 `/인증` 상세 흐름

1. 형식 검사: `https://`로 시작하는 유효한 URL인지 (아니면 ephemeral 거부)
2. 정규화: 호스트 소문자화, fragment 제거, 트래킹 쿼리 파라미터 제거(`utm_*`, `fbclid`, `gclid` 등), 경로 끝 슬래시 제거
3. 사이클 귀속 결정 (5.2). 사이클이 없으면 ephemeral 안내: "이번 주 목표가 아직 없어요. `/목표설정`을 먼저 해주세요" (자동 생성하지 않음 — 목표 조건은 사람이 정한다)
4. INSERT — 유니크 충돌 시 ephemeral "이미 인증한 링크예요" 후 즉시 종료 (참여 등록 없이 — 거부된 제출이 사람을 참여자로 만들어 벌금 대상이 되는 일을 구조적으로 막는다)
5. 저장 성공 시, 참여자가 아니면 **자동으로 참여자 등록**(`joined_via='submit'`) — 실제로 글을 낸 사람이라 벌금 리스크가 없다
6. 즉시 공개 응답: "OO님 인증 완료! 현재 N/M개" (3초 규칙 내 D1만으로 응답)
7. `waitUntil` 백그라운드: 5초 타임아웃으로 1회 fetch → `fetch_status`/`fetch_title` 기록 → 스레드에 후속 메시지(제목 또는 "접속 확인은 실패했지만 인증은 유효해요")

### 5.4 응답 공개 정책

- **공개**: 인증 성공, 현황, 벌금현황, 벌금조정 결과, 참여/취소 알림 — 링크와 벌금이 다 보여야 사회적 검증이 된다
- **본인만(ephemeral)**: 형식 오류, 중복 링크, 마감된 주차, 권한 밖 동작 등 모든 에러·안내

### 5.5 채널 제약

봇은 지정된 인증 채널(`CHANNEL_ID`)과 그 하위 스레드에서만 동작한다. 다른 채널에서 명령 실행 시 ephemeral로 인증 채널 안내만 한다.

## 6. 자동화 잡

Workers cron 3개. `scheduled` 핸들러에서 `event.cron` 문자열로 분기한다. cron은 UTC로 등록한다 (KST = UTC+9).

| 잡 | KST | cron (UTC) | 동작 |
|---|---|---|---|
| 정산 sweep | 매일 00:01 | `1 15 * * *` | `마감 지남 AND settled_at IS NULL`인 사이클 전부: 참여자별 제출 수 집계 → `max(0, 목표 - 제출 수) × 단가`를 원장에 INSERT → 스레드에 결과 공지 (미달자 멘션 + 금액, 전원 달성이면 축하, 참여자 0명이면 공지 생략) → `settled_at` 기록 |
| 안전망 공지 | 화 10:00 | `0 1 * * TUE` | 이번 주 사이클이 없으면: 기본값(1개/10,000원)으로 사이클 + 스레드 생성, `created_by='bot:fallback'`, [참여하기] 버튼 공지 |
| 리마인더 | 일 10:00 | `0 1 * * SUN` | 이번 주 사이클이 있으면: 미달성 참여자만 멘션해 스레드에 "오늘 마감! 현재 N/M개". 전원 달성이면 침묵 |

정산을 주 1회가 아니라 **매일 sweep**으로 돌리는 이유: 어쩌다 한 번 실행이 실패해도 다음 날 자동으로 따라잡는다. 멱등 장치(partial unique index + `settled_at`)가 있어 여러 번 돌아도 안전하다. 기존 봇의 "재기동 시 밀린 작업 처리" 아이디어에서 좋은 부분만 남긴 것.

## 7. 에러 처리

- **3초 응답 규칙**: 인터랙션 응답은 D1과 Discord REST 호출만으로 3초 안에 완성한다. 느린 외부 fetch(`/인증`의 best-effort 확인)는 반드시 응답 이후 `waitUntil`에서 실행한다. `/목표설정`과 안전망 공지는 공지·스레드 생성을 위해 Discord REST를 응답 전에 호출하며(평시 1초 미만), Discord 장애로 3초를 넘길 가능성은 낮은 빈도를 감안해 수용한다
- **fetch 실패는 인증에 영향 없음**: `fetch_status='failed'` 기록만. "억울한 벌금" 시나리오가 구조적으로 불가능
- **봇 발신 메시지(공지·리마인더) 실패**: Discord REST 1회 재시도, 끝내 실패하면 로그만 남긴다 (그 주 한정 불편)
- **정산 순서와 실패 복구**: "원장 기록 → 정산 공지 → `settled_at` 기록" 순서로 진행한다. 공지까지 성공해야 `settled_at`이 찍히므로, 중간에 실패하면 다음 날 sweep이 그 사이클을 다시 집어 처음부터 재시도한다 — 원장 INSERT는 유니크 제약 덕에 중복되지 않고, 공지만 다시 시도되는 셈이다
- **cron 중복·재실행**: 유니크 제약으로 안전
- **알 수 없는 명령/만료된 버튼**: ephemeral 안내
- **관측**: `wrangler tail`과 Cloudflare 대시보드 로그. 에러 채널 알림은 필요해지면 추가 (범위 외)

## 8. 테스트 전략

- **도메인 유닛 테스트** (vitest, DB 불필요) — 핵심 규칙을 순수 함수로 검증:
  - 주차 계산: KST 기준 임의 시각 → 그 주 월요일, 일요일 23:59:59는 유효·월요일 00:00:00은 마감
  - 정산 계산: 미달 2개 → 2 × 단가, 초과 달성 → 0원, 참여자 0명 → 빈 결과
  - URL 정규화: 트래킹 파라미터 제거, 대소문자, 슬래시 처리
  - 사이클 귀속: 스레드/채널/마감 조합
- **핸들러 테스트**: 가짜 인터랙션 페이로드 → 응답 JSON 검증. `@cloudflare/vitest-pool-workers`로 로컬 D1 포함 통합 테스트
- **실기기 확인**: 테스트용 디스코드 서버에 길드 커맨드 등록(즉시 반영) 후 수동 시나리오 테스트

## 9. 배포와 운영

- **배포**: `wrangler deploy`. GitHub Actions CI(push → test → deploy)는 선택 사항
- **설정값**: `DISCORD_TOKEN`(secret), `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID`, `CHANNEL_ID`(wrangler.toml vars)
- **초기 설정 절차**: Discord 개발자 포털에서 앱 생성 → Interactions Endpoint URL에 Worker URL 등록 → `scripts/register.ts`로 커맨드 등록 → 봇 초대(권한: 메시지 전송, 스레드 생성/전송, 멘션)
- **기존 벌금 이월**: `/벌금조정`으로 멤버별 입력 (원장에 이월 기록이 남음)
- **무료 한도**: Workers 10만 요청/일, D1 읽기 500만 행/일 — 소규모 스터디 사용량 대비 압도적 여유. 과금 없음

## 10. 범위 제외 (Out of Scope)

- 기존 봇의 재미 명령어(멤버별 이스터에그) — 원하면 추후 추가
- 관리자 권한 체계 (모든 명령은 누구나, 공개 기록으로 견제)
- 글 콘텐츠 품질 검증 (기존 봇의 "의미 있는 텍스트 줄 수" 검사 등)
- 다중 서버·다중 채널 지원 (단일 서버, 단일 인증 채널 전제)
- 에러 알림 채널, 통계/스트릭 기능, 휴식권 — 운영해보고 필요하면 추가
