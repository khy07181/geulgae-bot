# 글개 봇 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 주간 글쓰기 목표·벌금을 관리하는 디스코드 봇을 Cloudflare Workers 위에 구축한다.

**Architecture:** Worker 하나가 `fetch`(Discord HTTP Interactions 웹훅)와 `scheduled`(cron 3개)를 처리한다. 상태는 D1(SQLite)에 저장하고, 벌금은 append-only 원장으로 기록한다. 도메인 로직은 Discord도 DB도 모르는 순수 함수로 분리한다.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, `discord-interactions`(유일한 런타임 의존성), vitest + `@cloudflare/vitest-pool-workers`

**스펙:** `docs/specs/2026-07-20-geulgae-bot-design.md` — 모든 규칙의 원본. 이 계획과 스펙이 충돌하면 스펙이 이긴다.

## Global Constraints

- 런타임 의존성은 `discord-interactions` 하나만. 프레임워크 금지
- TypeScript strict 모드
- 시간: DB 저장은 UTC ISO 8601 문자열, 주차·마감 판정은 KST(UTC+9 고정) 변환 순수 함수로. `cycles.week_start`만 KST 달력 날짜 `'YYYY-MM-DD'`(그 주 월요일)
- 마감 규칙: 일요일 23:59:59(KST)까지 유효, 월요일 00:00:00(KST)부터 마감
- 인터랙션 응답 경로에서 외부 HTTP 금지 (D1만 사용, 3초 규칙). 외부 fetch는 `ctx.waitUntil`에서만
- `penalty_entries`는 append-only — UPDATE/DELETE 쿼리를 절대 작성하지 않는다
- 사용자에게 보이는 모든 문구는 한국어, 명령 이름도 한글
- 에러·거절 응답은 전부 ephemeral(flags 64), 성공·현황 응답은 공개
- 모든 커밋 메시지 끝에 붙인다: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- 각 태스크는 TDD로: 실패하는 테스트 → 실행해 실패 확인 → 최소 구현 → 통과 확인 → 커밋

## 파일 구조 (전체 지도)

```
wrangler.toml                     # Workers 설정: cron 3개, D1 바인딩, vars
package.json / tsconfig.json / vitest.config.ts
migrations/0001_init.sql          # D1 스키마 (스펙 §4 그대로)
src/
├── index.ts                      # 진입점: fetch(서명 검증→라우팅) + scheduled(cron 분기)
├── router.ts                     # PING/채널 제한/명령·버튼 분기
├── types.ts                      # Env, Interaction 최소 타입, 옵션 파서
├── interactions/
│   ├── goal.ts                   # /목표설정
│   ├── submit.ts                 # /인증 (+ waitUntil 검증)
│   ├── status.ts                 # /현황
│   ├── penalty.ts                # /벌금현황, /벌금조정
│   ├── withdraw.ts               # /참여취소
│   ├── join-button.ts            # [참여하기] 버튼
│   └── resolve-cycle.ts          # 사이클 귀속 규칙 (스레드→그 사이클, 채널→이번 주)
├── domain/
│   ├── cycle.ts                  # 주차 계산·마감 판정·주차 라벨 (순수 함수)
│   ├── settlement.ts             # 정산 계산 (순수 함수)
│   └── url.ts                    # URL 검사·정규화 (순수 함수)
├── jobs/
│   ├── settle.ts                 # 정산 sweep (매일 00:05 KST)
│   ├── fallback-notice.ts        # 안전망 공지 (화 10:00 KST)
│   └── reminder.ts               # 리마인더 (일 10:00 KST)
├── discord/
│   ├── api.ts                    # Discord REST 래퍼 (1회 재시도)
│   └── replies.ts                # 인터랙션 응답 JSON 빌더
└── db/
    └── queries.ts                # D1 쿼리 함수 전부
scripts/register.ts               # 길드 슬래시 커맨드 등록 (tsx로 실행)
test/
├── apply-migrations.ts           # 테스트 셋업: D1 마이그레이션 적용
├── env.d.ts                      # cloudflare:test 타입 선언
├── helpers.ts                    # fakeApi, seedCycle 등 테스트 헬퍼
└── *.test.ts                     # 모듈별 테스트
README.md                         # 설치·배포·운영 가이드
```

의존 방향: `interactions/`·`jobs/` → `domain/`·`db/`·`discord/`. `domain/`은 아무것도 import하지 않는다.

---

### Task 1: 프로젝트 스캐폴딩 + D1 스키마

**Files:**
- Create: `package.json`, `tsconfig.json`, `wrangler.toml`, `vitest.config.ts`, `.gitignore`
- Create: `migrations/0001_init.sql`
- Create: `test/apply-migrations.ts`, `test/env.d.ts`
- Test: `test/schema.test.ts`

**Interfaces:**
- Consumes: 없음 (최초 태스크)
- Produces: 이후 모든 태스크의 실행 기반 — `npm test`(vitest + 로컬 D1, 마이그레이션 자동 적용), `npm run typecheck`. 테스트에서 `import { env } from "cloudflare:test"`로 `env.DB`(D1Database) 사용 가능

- [ ] **Step 1: npm 초기화 및 의존성 설치**

```bash
npm init -y
npm i discord-interactions
npm i -D wrangler typescript vitest @cloudflare/vitest-pool-workers @cloudflare/workers-types tsx
```

- [ ] **Step 2: 설정 파일 작성**

`package.json`의 다음 필드를 수정/추가 (나머지 npm init 기본값 유지):

```json
{
  "name": "geulgae-bot",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "register": "tsx scripts/register.ts",
    "migrate:local": "wrangler d1 migrations apply geulgae-bot-db --local",
    "migrate:remote": "wrangler d1 migrations apply geulgae-bot-db --remote"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src", "test", "scripts"]
}
```

`wrangler.toml` (database_id는 배포 태스크 전까지 더미 UUID를 유지 — 로컬 테스트에는 영향 없음):

```toml
name = "geulgae-bot"
main = "src/index.ts"
compatibility_date = "2026-07-01"

[triggers]
crons = ["5 15 * * *", "0 1 * * 2", "0 1 * * 0"]

[[d1_databases]]
binding = "DB"
database_name = "geulgae-bot-db"
database_id = "00000000-0000-0000-0000-000000000000"

[vars]
DISCORD_PUBLIC_KEY = "REPLACE_ME"
DISCORD_APPLICATION_ID = "REPLACE_ME"
DISCORD_GUILD_ID = "REPLACE_ME"
CHANNEL_ID = "REPLACE_ME"
```

`vitest.config.ts`:

```ts
import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(process.cwd(), "migrations"));
  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          wrangler: { configPath: "./wrangler.toml" },
          miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
        },
      },
    },
  };
});
```

`.gitignore`:

```
node_modules/
.wrangler/
.dev.vars
```

- [ ] **Step 3: D1 스키마 마이그레이션 작성**

`migrations/0001_init.sql` (스펙 §4의 DDL 그대로):

```sql
CREATE TABLE cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT NOT NULL UNIQUE,
  goal_count INTEGER NOT NULL DEFAULT 1,
  penalty_per_post INTEGER NOT NULL DEFAULT 10000,
  channel_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  settled_at TEXT
);

CREATE TABLE participants (
  cycle_id INTEGER NOT NULL REFERENCES cycles(id),
  user_id TEXT NOT NULL,
  joined_via TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (cycle_id, user_id)
);

CREATE TABLE submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id INTEGER NOT NULL REFERENCES cycles(id),
  user_id TEXT NOT NULL,
  url TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  fetch_status TEXT,
  fetch_title TEXT,
  UNIQUE (user_id, url)
);

CREATE TABLE penalty_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  kind TEXT NOT NULL,
  cycle_id INTEGER REFERENCES cycles(id),
  reason TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX ux_settlement_once
  ON penalty_entries (cycle_id, user_id) WHERE kind = 'settlement';
```

- [ ] **Step 4: 테스트 셋업 파일 작성**

`test/apply-migrations.ts`:

```ts
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

`test/env.d.ts`:

```ts
declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  }
}
```

- [ ] **Step 5: 스키마 검증 테스트 작성**

`test/schema.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("D1 스키마", () => {
  it("테이블 4개가 생성된다", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf%' AND name != 'd1_migrations' ORDER BY name"
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(["cycles", "participants", "penalty_entries", "submissions"]);
  });

  it("정산 멱등 인덱스: 같은 (cycle, user)의 settlement 이중 INSERT는 거부된다", async () => {
    await env.DB.prepare(
      "INSERT INTO cycles (week_start, channel_id, thread_id, created_by, created_at) VALUES ('2026-07-13','c','t','user:1','2026-07-13T00:00:00Z')"
    ).run();
    const insert =
      "INSERT INTO penalty_entries (user_id, amount, kind, cycle_id, created_by, created_at) VALUES ('u1', 10000, 'settlement', 1, 'bot:settlement', '2026-07-20T00:00:00Z')";
    await env.DB.prepare(insert).run();
    await expect(env.DB.prepare(insert).run()).rejects.toThrow();
    // adjustment는 cycle_id 없이 여러 번 가능
    const adj =
      "INSERT INTO penalty_entries (user_id, amount, kind, reason, created_by, created_at) VALUES ('u1', -5000, 'adjustment', NULL, 'user:2', '2026-07-20T00:00:00Z')";
    await env.DB.prepare(adj).run();
    await env.DB.prepare(adj).run(); // 두 번째도 성공해야 함
  });
});
```

참고: 각 테스트 파일은 격리된 D1 인스턴스를 받으므로(pool-workers 기본 동작) 테스트 간 데이터 간섭을 걱정하지 않는다. 같은 파일 안에서는 위처럼 순서 의존이 없도록 한 테스트 안에서 시드한다.

- [ ] **Step 6: 테스트 실행 → 통과 확인**

Run: `npm test`
Expected: PASS 2건. (마이그레이션 파일이 없거나 SQL 오류면 여기서 실패한다 — 실패 시 `migrations/0001_init.sql`부터 의심)

Run: `npm run typecheck`
Expected: 에러 0건

- [ ] **Step 7: 커밋**

```bash
git add package.json package-lock.json tsconfig.json wrangler.toml vitest.config.ts .gitignore migrations/ test/
git commit -m "chore: 프로젝트 스캐폴딩 + D1 스키마

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: domain/cycle.ts — 주차 계산·마감 판정

**Files:**
- Create: `src/domain/cycle.ts`
- Test: `test/cycle.test.ts`

**Interfaces:**
- Consumes: 없음 (순수 함수, import 없음)
- Produces:
  - `weekStartOf(now: Date): string` — now가 속한 KST 주의 월요일 `'YYYY-MM-DD'`
  - `nextWeekStartOf(now: Date): string` — 다음 주 월요일
  - `deadlineOf(weekStart: string): Date` — 마감 경계의 UTC 순간 (KST 월요일+7일 00:00:00)
  - `isPastDeadline(weekStart: string, now: Date): boolean` — `now >= deadline`
  - `weekLabel(weekStart: string): string` — `"7월 3주차"` 형식
  - `formatRemaining(weekStart: string, now: Date): string` — `"2일 5시간"` / `"3시간 12분"` / `"45분"` / `"마감됨"`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/cycle.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  deadlineOf,
  formatRemaining,
  isPastDeadline,
  nextWeekStartOf,
  weekLabel,
  weekStartOf,
} from "../src/domain/cycle";

// 기준: 2026-07-20은 월요일(KST). KST = UTC+9이므로
// KST 2026-07-20 00:00:00 == UTC 2026-07-19T15:00:00Z

describe("weekStartOf", () => {
  it("KST 월요일 0시 정각은 그 날이 주 시작", () => {
    expect(weekStartOf(new Date("2026-07-19T15:00:00Z"))).toBe("2026-07-20");
  });
  it("직전 1초는 이전 주(일요일 23:59:59 KST)", () => {
    expect(weekStartOf(new Date("2026-07-19T14:59:59Z"))).toBe("2026-07-13");
  });
  it("주 중간(수요일 낮)도 같은 월요일", () => {
    expect(weekStartOf(new Date("2026-07-22T03:00:00Z"))).toBe("2026-07-20");
  });
  it("월말·월초 경계를 넘는 주도 정확하다", () => {
    // 2026-08-01(토) KST 낮 → 그 주 월요일은 2026-07-27
    expect(weekStartOf(new Date("2026-08-01T03:00:00Z"))).toBe("2026-07-27");
  });
});

describe("nextWeekStartOf", () => {
  it("다음 주 월요일을 돌려준다", () => {
    expect(nextWeekStartOf(new Date("2026-07-22T03:00:00Z"))).toBe("2026-07-27");
  });
});

describe("마감 판정", () => {
  it("deadlineOf는 KST 다음 주 월요일 0시의 UTC 순간", () => {
    expect(deadlineOf("2026-07-13").toISOString()).toBe("2026-07-19T15:00:00.000Z");
  });
  it("일요일 23:59:59 KST는 마감 전", () => {
    expect(isPastDeadline("2026-07-13", new Date("2026-07-19T14:59:59Z"))).toBe(false);
  });
  it("월요일 00:00:00 KST부터 마감", () => {
    expect(isPastDeadline("2026-07-13", new Date("2026-07-19T15:00:00Z"))).toBe(true);
  });
});

describe("weekLabel", () => {
  it("월요일 날짜 기준 n주차", () => {
    expect(weekLabel("2026-07-20")).toBe("7월 3주차"); // ceil(20/7) = 3
    expect(weekLabel("2026-07-06")).toBe("7월 1주차"); // ceil(6/7) = 1
  });
});

describe("formatRemaining", () => {
  it("일 단위가 남으면 '일 시간'", () => {
    // 마감(2026-07-19T15:00Z)까지 2일 5시간 전
    expect(formatRemaining("2026-07-13", new Date("2026-07-17T10:00:00Z"))).toBe("2일 5시간");
  });
  it("한 시간 미만이면 '분'", () => {
    expect(formatRemaining("2026-07-13", new Date("2026-07-19T14:15:00Z"))).toBe("45분");
  });
  it("마감 후에는 '마감됨'", () => {
    expect(formatRemaining("2026-07-13", new Date("2026-07-19T15:00:00Z"))).toBe("마감됨");
  });
});
```

- [ ] **Step 2: 실행해 실패 확인**

Run: `npx vitest run test/cycle.test.ts`
Expected: FAIL — `Cannot find module '../src/domain/cycle'`

- [ ] **Step 3: 구현**

`src/domain/cycle.ts`:

```ts
// KST(UTC+9) 고정 오프셋. 한국은 서머타임이 없어 안전하다.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function toDateString(utcMs: number): string {
  return new Date(utcMs).toISOString().slice(0, 10);
}

export function weekStartOf(now: Date): string {
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  const daysFromMonday = (kst.getUTCDay() + 6) % 7; // 월=0 … 일=6
  return toDateString(
    Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() - daysFromMonday)
  );
}

export function nextWeekStartOf(now: Date): string {
  const [y, m, d] = weekStartOf(now).split("-").map(Number);
  return toDateString(Date.UTC(y, m - 1, d + 7));
}

export function deadlineOf(weekStart: string): Date {
  const [y, m, d] = weekStart.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 7) - KST_OFFSET_MS);
}

export function isPastDeadline(weekStart: string, now: Date): boolean {
  return now.getTime() >= deadlineOf(weekStart).getTime();
}

export function weekLabel(weekStart: string): string {
  const [, m, d] = weekStart.split("-").map(Number);
  return `${m}월 ${Math.ceil(d / 7)}주차`;
}

export function formatRemaining(weekStart: string, now: Date): string {
  const ms = deadlineOf(weekStart).getTime() - now.getTime();
  if (ms <= 0) return "마감됨";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}일 ${hours}시간`;
  if (hours > 0) return `${hours}시간 ${minutes}분`;
  return `${minutes}분`;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run test/cycle.test.ts`
Expected: PASS 전체 (11건)

- [ ] **Step 5: 커밋**

```bash
git add src/domain/cycle.ts test/cycle.test.ts
git commit -m "feat: KST 주차 계산·마감 판정 도메인 함수

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: domain/url.ts — URL 검사·정규화

**Files:**
- Create: `src/domain/url.ts`
- Test: `test/url.test.ts`

**Interfaces:**
- Consumes: 없음 (순수 함수)
- Produces:
  - `type UrlResult = { ok: true; url: string } | { ok: false; reason: string }`
  - `normalizeUrl(raw: string): UrlResult` — https 강제, 호스트 소문자화, fragment 제거, 트래킹 파라미터(`utm_*`, `fbclid`, `gclid`, `igshid`) 제거, 경로 끝 슬래시 제거. `reason`은 사용자에게 그대로 보여줄 한국어 문구

- [ ] **Step 1: 실패하는 테스트 작성**

`test/url.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeUrl } from "../src/domain/url";

describe("normalizeUrl", () => {
  it("URL이 아니면 거부", () => {
    const r = normalizeUrl("그냥 텍스트");
    expect(r.ok).toBe(false);
  });
  it("http는 거부", () => {
    const r = normalizeUrl("http://example.com/post");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("https");
  });
  it("호스트 소문자화 + 경로 끝 슬래시 제거", () => {
    const r = normalizeUrl("https://Medium.com/@user/my-post/");
    expect(r).toEqual({ ok: true, url: "https://medium.com/@user/my-post" });
  });
  it("트래킹 파라미터와 fragment 제거, 나머지 쿼리는 유지", () => {
    const r = normalizeUrl("https://blog.com/p?utm_source=x&utm_medium=y&id=3&fbclid=abc#section");
    expect(r).toEqual({ ok: true, url: "https://blog.com/p?id=3" });
  });
  it("루트 경로는 슬래시 없이 정규화", () => {
    const r = normalizeUrl("https://example.com/");
    expect(r).toEqual({ ok: true, url: "https://example.com" });
  });
  it("같은 글의 변형 표기는 같은 URL로 수렴 (중복 판정의 근거)", () => {
    const a = normalizeUrl("https://Blog.com/post/?utm_source=discord");
    const b = normalizeUrl("https://blog.com/post");
    expect(a).toEqual(b);
  });
  it("앞뒤 공백은 무시", () => {
    const r = normalizeUrl("  https://blog.com/p  ");
    expect(r).toEqual({ ok: true, url: "https://blog.com/p" });
  });
});
```

- [ ] **Step 2: 실행해 실패 확인**

Run: `npx vitest run test/url.test.ts`
Expected: FAIL — `Cannot find module '../src/domain/url'`

- [ ] **Step 3: 구현**

`src/domain/url.ts`:

```ts
const TRACKING_PARAMS = new Set(["fbclid", "gclid", "igshid"]);

export type UrlResult = { ok: true; url: string } | { ok: false; reason: string };

export function normalizeUrl(raw: string): UrlResult {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "URL 형식이 아니에요. 전체 주소를 붙여넣어 주세요." };
  }
  if (u.protocol !== "https:") {
    return { ok: false, reason: "https:// 로 시작하는 링크만 인증할 수 있어요." };
  }
  for (const key of [...u.searchParams.keys()]) {
    if (key.startsWith("utm_") || TRACKING_PARAMS.has(key)) u.searchParams.delete(key);
  }
  let path = u.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (path === "/") path = "";
  const query = u.searchParams.toString();
  const host = u.hostname.toLowerCase() + (u.port ? `:${u.port}` : "");
  return { ok: true, url: `https://${host}${path}${query ? `?${query}` : ""}` };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run test/url.test.ts`
Expected: PASS 7건

- [ ] **Step 5: 커밋**

```bash
git add src/domain/url.ts test/url.test.ts
git commit -m "feat: URL 검사·정규화 도메인 함수

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: domain/settlement.ts — 정산 계산

**Files:**
- Create: `src/domain/settlement.ts`
- Test: `test/settlement.test.ts`

**Interfaces:**
- Consumes: 없음 (순수 함수)
- Produces:
  - `interface SettlementInput { goalCount: number; penaltyPerPost: number; participants: { userId: string; submissionCount: number }[] }`
  - `interface PenaltyCharge { userId: string; shortfall: number; amount: number }`
  - `calculateSettlement(input: SettlementInput): PenaltyCharge[]` — 미달자만 반환(달성자는 제외), `amount = shortfall × penaltyPerPost`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/settlement.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { calculateSettlement } from "../src/domain/settlement";

describe("calculateSettlement", () => {
  it("미달 개수 × 단가를 부과하고, 달성자는 결과에서 제외한다", () => {
    const charges = calculateSettlement({
      goalCount: 2,
      penaltyPerPost: 10000,
      participants: [
        { userId: "u1", submissionCount: 0 }, // 2개 미달
        { userId: "u2", submissionCount: 1 }, // 1개 미달
        { userId: "u3", submissionCount: 2 }, // 달성
        { userId: "u4", submissionCount: 5 }, // 초과 달성
      ],
    });
    expect(charges).toEqual([
      { userId: "u1", shortfall: 2, amount: 20000 },
      { userId: "u2", shortfall: 1, amount: 10000 },
    ]);
  });
  it("전원 달성이면 빈 배열", () => {
    expect(
      calculateSettlement({
        goalCount: 1,
        penaltyPerPost: 10000,
        participants: [{ userId: "u1", submissionCount: 1 }],
      })
    ).toEqual([]);
  });
  it("참여자가 없으면 빈 배열", () => {
    expect(
      calculateSettlement({ goalCount: 1, penaltyPerPost: 10000, participants: [] })
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: 실행해 실패 확인**

Run: `npx vitest run test/settlement.test.ts`
Expected: FAIL — `Cannot find module '../src/domain/settlement'`

- [ ] **Step 3: 구현**

`src/domain/settlement.ts`:

```ts
export interface SettlementInput {
  goalCount: number;
  penaltyPerPost: number;
  participants: { userId: string; submissionCount: number }[];
}

export interface PenaltyCharge {
  userId: string;
  shortfall: number;
  amount: number;
}

export function calculateSettlement(input: SettlementInput): PenaltyCharge[] {
  return input.participants
    .map((p) => {
      const shortfall = Math.max(0, input.goalCount - p.submissionCount);
      return { userId: p.userId, shortfall, amount: shortfall * input.penaltyPerPost };
    })
    .filter((c) => c.shortfall > 0);
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run test/settlement.test.ts`
Expected: PASS 3건

- [ ] **Step 5: 커밋**

```bash
git add src/domain/settlement.ts test/settlement.test.ts
git commit -m "feat: 정산 계산 도메인 함수

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: db/queries.ts — D1 쿼리 계층

**Files:**
- Create: `src/db/queries.ts`
- Test: `test/db.test.ts`

**Interfaces:**
- Consumes: Task 1의 D1 스키마
- Produces (모든 함수 첫 인자는 `db: D1Database`):
  - `interface CycleRow { id: number; week_start: string; goal_count: number; penalty_per_post: number; channel_id: string; thread_id: string; created_by: string; created_at: string; settled_at: string | null }`
  - `createCycle(db, c: { weekStart: string; goalCount: number; penaltyPerPost: number; channelId: string; threadId: string; createdBy: string; createdAt: string }): Promise<CycleRow>`
  - `getCycleByWeekStart(db, weekStart: string): Promise<CycleRow | null>`
  - `getCycleByThreadId(db, threadId: string): Promise<CycleRow | null>`
  - `updateCycleSettings(db, cycleId: number, s: { goalCount?: number; penaltyPerPost?: number }): Promise<void>`
  - `addParticipant(db, cycleId: number, userId: string, joinedVia: "manual" | "button" | "submit", joinedAt: string): Promise<boolean>` — 이미 있으면 `false`
  - `removeParticipant(db, cycleId: number, userId: string): Promise<void>`
  - `listParticipants(db, cycleId: number): Promise<{ user_id: string; joined_via: string }[]>` — joined_at 순
  - `insertSubmission(db, s: { cycleId: number; userId: string; url: string; submittedAt: string }): Promise<{ id: number } | "duplicate">`
  - `setSubmissionFetchResult(db, submissionId: number, status: "ok" | "failed", title: string | null): Promise<void>`
  - `countSubmissionsByUser(db, cycleId: number): Promise<Map<string, number>>`
  - `insertSettlementEntries(db, cycleId: number, entries: { userId: string; amount: number; reason: string }[], createdAt: string): Promise<void>` — `INSERT OR IGNORE` (멱등)
  - `insertAdjustment(db, a: { userId: string; amount: number; reason: string | null; createdBy: string; createdAt: string }): Promise<void>`
  - `getPenaltyBalance(db, userId: string): Promise<number>`
  - `getPenaltyBalances(db): Promise<{ user_id: string; balance: number }[]>` — 잔액 0은 제외, 잔액 큰 순
  - `listUnsettledCycles(db): Promise<CycleRow[]>`
  - `markSettled(db, cycleId: number, settledAt: string): Promise<void>`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/db.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as q from "../src/db/queries";

const NOW = "2026-07-20T03:00:00.000Z";

async function seedCycle(weekStart = "2026-07-20") {
  return q.createCycle(env.DB, {
    weekStart,
    goalCount: 1,
    penaltyPerPost: 10000,
    channelId: "chan-1",
    threadId: `thread-${weekStart}`,
    createdBy: "user:u1",
    createdAt: NOW,
  });
}

describe("cycles", () => {
  it("createCycle 후 week_start와 thread_id로 조회된다", async () => {
    const c = await seedCycle();
    expect(c.id).toBeGreaterThan(0);
    expect((await q.getCycleByWeekStart(env.DB, "2026-07-20"))?.id).toBe(c.id);
    expect((await q.getCycleByThreadId(env.DB, "thread-2026-07-20"))?.id).toBe(c.id);
    expect(await q.getCycleByWeekStart(env.DB, "2000-01-03")).toBeNull();
  });
  it("updateCycleSettings는 준 값만 갱신한다", async () => {
    const c = await seedCycle("2026-07-27");
    await q.updateCycleSettings(env.DB, c.id, { goalCount: 3 });
    const after = await q.getCycleByWeekStart(env.DB, "2026-07-27");
    expect(after?.goal_count).toBe(3);
    expect(after?.penalty_per_post).toBe(10000); // 안 준 값은 유지
  });
});

describe("participants", () => {
  it("addParticipant는 최초 true, 중복 false", async () => {
    const c = await seedCycle("2026-08-03");
    expect(await q.addParticipant(env.DB, c.id, "u1", "manual", NOW)).toBe(true);
    expect(await q.addParticipant(env.DB, c.id, "u1", "button", NOW)).toBe(false);
    await q.addParticipant(env.DB, c.id, "u2", "button", NOW);
    expect((await q.listParticipants(env.DB, c.id)).map((p) => p.user_id)).toEqual(["u1", "u2"]);
    await q.removeParticipant(env.DB, c.id, "u1");
    expect((await q.listParticipants(env.DB, c.id)).map((p) => p.user_id)).toEqual(["u2"]);
  });
});

describe("submissions", () => {
  it("insertSubmission은 같은 (user, url) 중복 시 'duplicate'", async () => {
    const c = await seedCycle("2026-08-10");
    const r1 = await q.insertSubmission(env.DB, {
      cycleId: c.id, userId: "u1", url: "https://a.com/p", submittedAt: NOW,
    });
    expect(r1).not.toBe("duplicate");
    const r2 = await q.insertSubmission(env.DB, {
      cycleId: c.id, userId: "u1", url: "https://a.com/p", submittedAt: NOW,
    });
    expect(r2).toBe("duplicate");
    // 다른 유저의 같은 URL은 허용
    const r3 = await q.insertSubmission(env.DB, {
      cycleId: c.id, userId: "u2", url: "https://a.com/p", submittedAt: NOW,
    });
    expect(r3).not.toBe("duplicate");
    const counts = await q.countSubmissionsByUser(env.DB, c.id);
    expect(counts.get("u1")).toBe(1);
    expect(counts.get("u2")).toBe(1);
  });
  it("setSubmissionFetchResult가 상태·제목을 기록한다", async () => {
    const c = await seedCycle("2026-08-17");
    const r = await q.insertSubmission(env.DB, {
      cycleId: c.id, userId: "u1", url: "https://b.com/p", submittedAt: NOW,
    });
    if (r === "duplicate") throw new Error("unreachable");
    await q.setSubmissionFetchResult(env.DB, r.id, "ok", "글 제목");
    const row = await env.DB.prepare("SELECT fetch_status, fetch_title FROM submissions WHERE id = ?")
      .bind(r.id).first<{ fetch_status: string; fetch_title: string }>();
    expect(row).toEqual({ fetch_status: "ok", fetch_title: "글 제목" });
  });
});

describe("penalty ledger", () => {
  it("정산+조정을 합산하고, 정산 재실행은 무시된다(멱등)", async () => {
    const c = await seedCycle("2026-08-24");
    const entries = [{ userId: "u1", amount: 20000, reason: "2026-08-24 주차 정산" }];
    await q.insertSettlementEntries(env.DB, c.id, entries, NOW);
    await q.insertSettlementEntries(env.DB, c.id, entries, NOW); // 재실행 → OR IGNORE
    await q.insertAdjustment(env.DB, {
      userId: "u1", amount: -5000, reason: null, createdBy: "user:u2", createdAt: NOW,
    });
    expect(await q.getPenaltyBalance(env.DB, "u1")).toBe(15000);
    expect(await q.getPenaltyBalance(env.DB, "없는사람")).toBe(0);
    expect(await q.getPenaltyBalances(env.DB)).toEqual([{ user_id: "u1", balance: 15000 }]);
  });
  it("listUnsettledCycles / markSettled", async () => {
    const c = await seedCycle("2026-08-31");
    expect((await q.listUnsettledCycles(env.DB)).some((x) => x.id === c.id)).toBe(true);
    await q.markSettled(env.DB, c.id, NOW);
    expect((await q.listUnsettledCycles(env.DB)).some((x) => x.id === c.id)).toBe(false);
  });
});
```

- [ ] **Step 2: 실행해 실패 확인**

Run: `npx vitest run test/db.test.ts`
Expected: FAIL — `Cannot find module '../src/db/queries'`

- [ ] **Step 3: 구현**

`src/db/queries.ts`:

```ts
export interface CycleRow {
  id: number;
  week_start: string;
  goal_count: number;
  penalty_per_post: number;
  channel_id: string;
  thread_id: string;
  created_by: string;
  created_at: string;
  settled_at: string | null;
}

export async function createCycle(
  db: D1Database,
  c: { weekStart: string; goalCount: number; penaltyPerPost: number; channelId: string; threadId: string; createdBy: string; createdAt: string }
): Promise<CycleRow> {
  const row = await db
    .prepare(
      `INSERT INTO cycles (week_start, goal_count, penalty_per_post, channel_id, thread_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`
    )
    .bind(c.weekStart, c.goalCount, c.penaltyPerPost, c.channelId, c.threadId, c.createdBy, c.createdAt)
    .first<CycleRow>();
  if (!row) throw new Error("createCycle: INSERT가 행을 돌려주지 않음");
  return row;
}

export async function getCycleByWeekStart(db: D1Database, weekStart: string): Promise<CycleRow | null> {
  return db.prepare("SELECT * FROM cycles WHERE week_start = ?").bind(weekStart).first<CycleRow>();
}

export async function getCycleByThreadId(db: D1Database, threadId: string): Promise<CycleRow | null> {
  return db.prepare("SELECT * FROM cycles WHERE thread_id = ?").bind(threadId).first<CycleRow>();
}

export async function updateCycleSettings(
  db: D1Database,
  cycleId: number,
  s: { goalCount?: number; penaltyPerPost?: number }
): Promise<void> {
  await db
    .prepare("UPDATE cycles SET goal_count = COALESCE(?, goal_count), penalty_per_post = COALESCE(?, penalty_per_post) WHERE id = ?")
    .bind(s.goalCount ?? null, s.penaltyPerPost ?? null, cycleId)
    .run();
}

export async function addParticipant(
  db: D1Database,
  cycleId: number,
  userId: string,
  joinedVia: "manual" | "button" | "submit",
  joinedAt: string
): Promise<boolean> {
  const res = await db
    .prepare("INSERT OR IGNORE INTO participants (cycle_id, user_id, joined_via, joined_at) VALUES (?, ?, ?, ?)")
    .bind(cycleId, userId, joinedVia, joinedAt)
    .run();
  return res.meta.changes > 0;
}

export async function removeParticipant(db: D1Database, cycleId: number, userId: string): Promise<void> {
  await db.prepare("DELETE FROM participants WHERE cycle_id = ? AND user_id = ?").bind(cycleId, userId).run();
}

export async function listParticipants(
  db: D1Database,
  cycleId: number
): Promise<{ user_id: string; joined_via: string }[]> {
  const { results } = await db
    .prepare("SELECT user_id, joined_via FROM participants WHERE cycle_id = ? ORDER BY joined_at, user_id")
    .bind(cycleId)
    .all<{ user_id: string; joined_via: string }>();
  return results;
}

export async function insertSubmission(
  db: D1Database,
  s: { cycleId: number; userId: string; url: string; submittedAt: string }
): Promise<{ id: number } | "duplicate"> {
  const res = await db
    .prepare("INSERT OR IGNORE INTO submissions (cycle_id, user_id, url, submitted_at) VALUES (?, ?, ?, ?)")
    .bind(s.cycleId, s.userId, s.url, s.submittedAt)
    .run();
  if (res.meta.changes === 0) return "duplicate";
  return { id: Number(res.meta.last_row_id) };
}

export async function setSubmissionFetchResult(
  db: D1Database,
  submissionId: number,
  status: "ok" | "failed",
  title: string | null
): Promise<void> {
  await db
    .prepare("UPDATE submissions SET fetch_status = ?, fetch_title = ? WHERE id = ?")
    .bind(status, title, submissionId)
    .run();
}

export async function countSubmissionsByUser(db: D1Database, cycleId: number): Promise<Map<string, number>> {
  const { results } = await db
    .prepare("SELECT user_id, COUNT(*) AS n FROM submissions WHERE cycle_id = ? GROUP BY user_id")
    .bind(cycleId)
    .all<{ user_id: string; n: number }>();
  return new Map(results.map((r) => [r.user_id, r.n]));
}

export async function insertSettlementEntries(
  db: D1Database,
  cycleId: number,
  entries: { userId: string; amount: number; reason: string }[],
  createdAt: string
): Promise<void> {
  if (entries.length === 0) return;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO penalty_entries (user_id, amount, kind, cycle_id, reason, created_by, created_at)
     VALUES (?, ?, 'settlement', ?, ?, 'bot:settlement', ?)`
  );
  await db.batch(entries.map((e) => stmt.bind(e.userId, e.amount, cycleId, e.reason, createdAt)));
}

export async function insertAdjustment(
  db: D1Database,
  a: { userId: string; amount: number; reason: string | null; createdBy: string; createdAt: string }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO penalty_entries (user_id, amount, kind, cycle_id, reason, created_by, created_at)
       VALUES (?, ?, 'adjustment', NULL, ?, ?, ?)`
    )
    .bind(a.userId, a.amount, a.reason, a.createdBy, a.createdAt)
    .run();
}

export async function getPenaltyBalance(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(SUM(amount), 0) AS balance FROM penalty_entries WHERE user_id = ?")
    .bind(userId)
    .first<{ balance: number }>();
  return row?.balance ?? 0;
}

export async function getPenaltyBalances(db: D1Database): Promise<{ user_id: string; balance: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT user_id, SUM(amount) AS balance FROM penalty_entries
       GROUP BY user_id HAVING SUM(amount) != 0 ORDER BY balance DESC, user_id`
    )
    .all<{ user_id: string; balance: number }>();
  return results;
}

export async function listUnsettledCycles(db: D1Database): Promise<CycleRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM cycles WHERE settled_at IS NULL ORDER BY week_start")
    .all<CycleRow>();
  return results;
}

export async function markSettled(db: D1Database, cycleId: number, settledAt: string): Promise<void> {
  await db.prepare("UPDATE cycles SET settled_at = ? WHERE id = ?").bind(settledAt, cycleId).run();
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run test/db.test.ts`
Expected: PASS 7건

Run: `npm test` && `npm run typecheck`
Expected: 전체 PASS, 타입 에러 0건

- [ ] **Step 5: 커밋**

```bash
git add src/db/queries.ts test/db.test.ts
git commit -m "feat: D1 쿼리 계층

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: types.ts + discord/ — 타입, 응답 빌더, REST 래퍼

**Files:**
- Create: `src/types.ts`, `src/discord/replies.ts`, `src/discord/api.ts`
- Test: `test/replies.test.ts`, `test/api.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `interface Env { DB: D1Database; DISCORD_TOKEN: string; DISCORD_PUBLIC_KEY: string; DISCORD_APPLICATION_ID: string; DISCORD_GUILD_ID: string; CHANNEL_ID: string }`
  - `const InteractionType = { PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3 }`
  - `interface Interaction { id; type; token; channel_id?; channel?: { id; parent_id? }; member?: { user: { id } }; user?: { id }; data?: { name?; custom_id?; options? } }` (모든 필드 string 기반)
  - `interactionUserId(i: Interaction): string` / `getStringOption(i, name): string | null` / `getIntegerOption(i, name): number | null`
  - `pong(): Response` — `{type:1}`
  - `publicMessage(content: string, extra?: Record<string, unknown>): Response` — `{type:4, data:{content, ...extra}}`
  - `ephemeral(content: string): Response` — `{type:4, data:{content, flags:64}}`
  - `class DiscordApi { constructor(token: string, fetcher?: Fetcher); sendMessage(channelId, payload: { content: string; components?: unknown[]; allowed_mentions?: unknown }): Promise<{id: string}>; createThread(channelId, messageId, name): Promise<{id: string}> }` — 네트워크 오류·429·5xx에 1회 재시도

- [ ] **Step 1: 실패하는 테스트 작성**

`test/replies.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ephemeral, pong, publicMessage } from "../src/discord/replies";

async function body(res: Response) {
  expect(res.headers.get("content-type")).toContain("application/json");
  return JSON.parse(await res.text());
}

describe("replies", () => {
  it("pong은 type 1", async () => {
    expect(await body(pong())).toEqual({ type: 1 });
  });
  it("publicMessage는 type 4 공개 메시지, extra 병합", async () => {
    expect(await body(publicMessage("안녕", { allowed_mentions: { parse: [] } }))).toEqual({
      type: 4,
      data: { content: "안녕", allowed_mentions: { parse: [] } },
    });
  });
  it("ephemeral은 flags 64", async () => {
    expect(await body(ephemeral("에러"))).toEqual({ type: 4, data: { content: "에러", flags: 64 } });
  });
});
```

`test/api.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DiscordApi, type Fetcher } from "../src/discord/api";

function fetcherWithStatuses(statuses: number[]) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetcher: Fetcher = async (input, init) => {
    seen.push({ url: String(input), init: init ?? {} });
    const status = statuses[Math.min(seen.length - 1, statuses.length - 1)];
    return new Response(status === 204 ? null : JSON.stringify({ id: "42" }), { status });
  };
  return { fetcher, seen };
}

describe("DiscordApi", () => {
  it("성공 시 Bot 토큰 헤더로 호출하고 JSON을 돌려준다", async () => {
    const { fetcher, seen } = fetcherWithStatuses([200]);
    const api = new DiscordApi("tok", fetcher);
    const msg = await api.sendMessage("chan-1", { content: "hi" });
    expect(msg).toEqual({ id: "42" });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://discord.com/api/v10/channels/chan-1/messages");
    expect((seen[0].init.headers as Record<string, string>).authorization).toBe("Bot tok");
  });
  it("5xx면 1회 재시도 후 성공", async () => {
    const { fetcher, seen } = fetcherWithStatuses([500, 200]);
    const api = new DiscordApi("tok", fetcher);
    await api.sendMessage("chan-1", { content: "hi" });
    expect(seen).toHaveLength(2);
  });
  it("재시도까지 실패하면 throw", async () => {
    const { fetcher, seen } = fetcherWithStatuses([500, 500]);
    const api = new DiscordApi("tok", fetcher);
    await expect(api.sendMessage("chan-1", { content: "hi" })).rejects.toThrow("실패: 500");
    expect(seen).toHaveLength(2);
  });
  it("4xx(429 제외)는 재시도 없이 즉시 throw", async () => {
    const { fetcher, seen } = fetcherWithStatuses([404]);
    const api = new DiscordApi("tok", fetcher);
    await expect(api.sendMessage("chan-1", { content: "hi" })).rejects.toThrow("실패: 404");
    expect(seen).toHaveLength(1);
  });
  it("createThread는 메시지에 스레드를 만든다", async () => {
    const { fetcher, seen } = fetcherWithStatuses([200]);
    const api = new DiscordApi("tok", fetcher);
    await api.createThread("chan-1", "msg-9", "7월 3주차 글쓰기");
    expect(seen[0].url).toBe("https://discord.com/api/v10/channels/chan-1/messages/msg-9/threads");
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ name: "7월 3주차 글쓰기", auto_archive_duration: 10080 });
  });
});
```

- [ ] **Step 2: 실행해 실패 확인**

Run: `npx vitest run test/replies.test.ts test/api.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`src/types.ts`:

```ts
export interface Env {
  DB: D1Database;
  DISCORD_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APPLICATION_ID: string;
  DISCORD_GUILD_ID: string;
  CHANNEL_ID: string;
}

export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
} as const;

export interface InteractionOption {
  name: string;
  type: number;
  value?: string | number | boolean;
}

export interface Interaction {
  id: string;
  type: number;
  token: string;
  channel_id?: string;
  channel?: { id: string; parent_id?: string };
  member?: { user: { id: string } };
  user?: { id: string };
  data?: { name?: string; custom_id?: string; options?: InteractionOption[] };
}

export function interactionUserId(i: Interaction): string {
  const id = i.member?.user.id ?? i.user?.id;
  if (!id) throw new Error("인터랙션에 유저 정보가 없음");
  return id;
}

export function getStringOption(i: Interaction, name: string): string | null {
  const opt = i.data?.options?.find((o) => o.name === name);
  return typeof opt?.value === "string" ? opt.value : null;
}

export function getIntegerOption(i: Interaction, name: string): number | null {
  const opt = i.data?.options?.find((o) => o.name === name);
  return typeof opt?.value === "number" ? opt.value : null;
}
```

`src/discord/replies.ts`:

```ts
const EPHEMERAL_FLAG = 64;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

export function pong(): Response {
  return json({ type: 1 });
}

export function publicMessage(content: string, extra: Record<string, unknown> = {}): Response {
  return json({ type: 4, data: { content, ...extra } });
}

export function ephemeral(content: string): Response {
  return json({ type: 4, data: { content, flags: EPHEMERAL_FLAG } });
}
```

`src/discord/api.ts`:

```ts
const BASE = "https://discord.com/api/v10";

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class DiscordApi {
  constructor(
    private token: string,
    private fetcher: Fetcher = fetch
  ) {}

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const doFetch = () =>
      this.fetcher(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bot ${this.token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    let res: Response | undefined;
    try {
      res = await doFetch();
    } catch {
      // 네트워크 오류 → 아래에서 1회 재시도
    }
    if (!res || res.status >= 500 || res.status === 429) {
      await new Promise((r) => setTimeout(r, 300));
      res = await doFetch();
    }
    if (!res.ok) throw new Error(`Discord API ${method} ${path} 실패: ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  sendMessage(
    channelId: string,
    payload: { content: string; components?: unknown[]; allowed_mentions?: unknown }
  ): Promise<{ id: string }> {
    return this.request("POST", `/channels/${channelId}/messages`, payload) as Promise<{ id: string }>;
  }

  createThread(channelId: string, messageId: string, name: string): Promise<{ id: string }> {
    return this.request("POST", `/channels/${channelId}/messages/${messageId}/threads`, {
      name,
      auto_archive_duration: 10080,
    }) as Promise<{ id: string }>;
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run test/replies.test.ts test/api.test.ts`
Expected: PASS 8건

- [ ] **Step 5: 커밋**

```bash
git add src/types.ts src/discord/ test/replies.test.ts test/api.test.ts
git commit -m "feat: 인터랙션 타입, 응답 빌더, Discord REST 래퍼

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: router.ts + index.ts — 서명 검증과 라우팅 골격

**Files:**
- Create: `src/router.ts`, `src/index.ts`
- Create: `test/helpers.ts`
- Test: `test/router.test.ts`, `test/index.test.ts`

**Interfaces:**
- Consumes: Task 6의 `Env`, `Interaction`, `pong`/`ephemeral`, `DiscordApi`
- Produces:
  - `interface Deps { env: Env; db: D1Database; api: DiscordApi; ctx: ExecutionContext; now: () => Date; fetcher: Fetcher }` — `now`와 `fetcher`를 주입식으로 두는 이유: 테스트에서 시각 고정·외부 HTTP 차단
  - `type Handler = (interaction: Interaction, deps: Deps) => Promise<Response>`
  - `routeInteraction(interaction: Interaction, deps: Deps): Promise<Response>` — PING 응답, 채널 제한, 명령/버튼 분기. **명령 핸들러 레지스트리는 이 태스크에서는 비어 있고, Task 8~12가 각자 자기 항목을 추가한다**
  - `src/index.ts`의 default export `fetch` — 서명 검증 후 `routeInteraction` 위임 (`scheduled`는 Task 13에서 추가)
  - `test/helpers.ts`: `CHANNEL_ID`, `makeEnv(overrides?)`, `fakeApi(): { calls, api }`, `makeDeps(overrides?): Deps & { calls }`, `makeCommandInteraction(name, options?, opts?)`, `makeComponentInteraction(customId, opts?)`, `readJson(res)` — 이후 모든 핸들러 테스트가 사용

- [ ] **Step 1: 테스트 헬퍼 작성**

`test/helpers.ts`:

```ts
import { createExecutionContext, env as testEnv } from "cloudflare:test";
import type { DiscordApi, Fetcher } from "../src/discord/api";
import type { Deps } from "../src/router";
import type { Env, Interaction, InteractionOption } from "../src/types";

export const CHANNEL_ID = "chan-1";

export function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: testEnv.DB,
    DISCORD_TOKEN: "test-token",
    DISCORD_PUBLIC_KEY: "unused",
    DISCORD_APPLICATION_ID: "app-1",
    DISCORD_GUILD_ID: "guild-1",
    CHANNEL_ID,
    ...overrides,
  };
}

export interface ApiCall {
  method: string;
  args: unknown[];
}

export function fakeApi(): { calls: ApiCall[]; api: DiscordApi } {
  const calls: ApiCall[] = [];
  let nextId = 100;
  const api = {
    async sendMessage(channelId: string, payload: unknown) {
      calls.push({ method: "sendMessage", args: [channelId, payload] });
      return { id: String(++nextId) };
    },
    async createThread(channelId: string, messageId: string, name: string) {
      calls.push({ method: "createThread", args: [channelId, messageId, name] });
      return { id: `thread-${++nextId}` };
    },
  };
  return { calls, api: api as unknown as DiscordApi };
}

// 기본 now: 2026-07-22 수요일 낮(KST) → week_start는 2026-07-20
export const DEFAULT_NOW = new Date("2026-07-22T03:00:00Z");

export function fetcherReturning(status: number, body = ""): Fetcher {
  return async () => new Response(body, { status });
}

export function makeDeps(overrides: Partial<Deps> = {}): Deps & { calls: ApiCall[] } {
  const { calls, api } = fakeApi();
  const deps: Deps = {
    env: makeEnv(),
    db: testEnv.DB,
    api,
    ctx: createExecutionContext(),
    now: () => DEFAULT_NOW,
    fetcher: fetcherReturning(200, "<html><head><title>테스트 글</title></head><body>본문</body></html>"),
    ...overrides,
  };
  return Object.assign(deps, { calls });
}

export function makeCommandInteraction(
  name: string,
  options: InteractionOption[] = [],
  opts: { channelId?: string; parentId?: string; userId?: string } = {}
): Interaction {
  const channelId = opts.channelId ?? CHANNEL_ID;
  return {
    id: "inter-1",
    type: 2,
    token: "inter-token",
    channel_id: channelId,
    channel: { id: channelId, ...(opts.parentId ? { parent_id: opts.parentId } : {}) },
    member: { user: { id: opts.userId ?? "u1" } },
    data: { name, options },
  };
}

export function makeComponentInteraction(
  customId: string,
  opts: { channelId?: string; parentId?: string; userId?: string } = {}
): Interaction {
  const i = makeCommandInteraction("", [], opts);
  i.type = 3;
  i.data = { custom_id: customId };
  return i;
}

export async function readJson(res: Response): Promise<any> {
  return JSON.parse(await res.text());
}
```

- [ ] **Step 2: 실패하는 테스트 작성**

`test/router.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { routeInteraction } from "../src/router";
import { makeCommandInteraction, makeDeps, readJson } from "./helpers";

describe("routeInteraction", () => {
  it("PING에 PONG으로 답한다", async () => {
    const res = await routeInteraction({ id: "1", type: 1, token: "t" }, makeDeps());
    expect(await readJson(res)).toEqual({ type: 1 });
  });
  it("인증 채널 밖에서는 ephemeral 안내", async () => {
    const i = makeCommandInteraction("현황", [], { channelId: "다른채널" });
    const body = await readJson(await routeInteraction(i, makeDeps()));
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain("인증 채널");
  });
  it("인증 채널의 하위 스레드는 허용된다 (알 수 없는 명령 응답이 나와야 함)", async () => {
    const i = makeCommandInteraction("없는명령", [], { channelId: "thread-x", parentId: "chan-1" });
    const body = await readJson(await routeInteraction(i, makeDeps()));
    expect(body.data.content).toContain("알 수 없는 명령");
  });
  it("알 수 없는 버튼은 ephemeral", async () => {
    const i = makeCommandInteraction("", []);
    i.type = 3;
    i.data = { custom_id: "mystery:1" };
    const body = await readJson(await routeInteraction(i, makeDeps()));
    expect(body.data.flags).toBe(64);
  });
});
```

`test/index.test.ts`:

```ts
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { makeEnv } from "./helpers";

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function makeKeys() {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { pair, publicKeyHex: toHex(raw) };
}

async function signedRequest(pair: CryptoKeyPair, body: string, tamper = false) {
  const timestamp = "1721000000";
  const data = new TextEncoder().encode(timestamp + body);
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, data));
  if (tamper) sig[0] ^= 0xff;
  return new Request("https://bot.test/", {
    method: "POST",
    headers: { "x-signature-ed25519": toHex(sig), "x-signature-timestamp": timestamp },
    body,
  });
}

describe("index.fetch", () => {
  it("올바른 서명의 PING에 200 {type:1}", async () => {
    const { pair, publicKeyHex } = await makeKeys();
    const env = makeEnv({ DISCORD_PUBLIC_KEY: publicKeyHex });
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      await signedRequest(pair, JSON.stringify({ id: "1", type: 1, token: "t" })),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toEqual({ type: 1 });
  });
  it("잘못된 서명은 401", async () => {
    const { pair, publicKeyHex } = await makeKeys();
    const env = makeEnv({ DISCORD_PUBLIC_KEY: publicKeyHex });
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      await signedRequest(pair, JSON.stringify({ id: "1", type: 1, token: "t" }), true),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 3: 실행해 실패 확인**

Run: `npx vitest run test/router.test.ts test/index.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 4: 구현**

`src/router.ts`:

```ts
import type { DiscordApi, Fetcher } from "./discord/api";
import { ephemeral, pong } from "./discord/replies";
import { InteractionType, type Env, type Interaction } from "./types";

export interface Deps {
  env: Env;
  db: D1Database;
  api: DiscordApi;
  ctx: ExecutionContext;
  now: () => Date;
  fetcher: Fetcher;
}

export type Handler = (interaction: Interaction, deps: Deps) => Promise<Response>;

// Task 8~12에서 핸들러가 한 항목씩 추가된다.
const commandHandlers: Record<string, Handler> = {};

// custom_id의 ':' 앞부분(prefix)으로 매칭. Task 11에서 "join"이 추가된다.
const componentHandlers: Record<string, Handler> = {};

export async function routeInteraction(interaction: Interaction, deps: Deps): Promise<Response> {
  if (interaction.type === InteractionType.PING) return pong();

  const ch = interaction.channel;
  const channelId = ch?.id ?? interaction.channel_id;
  const allowed = channelId === deps.env.CHANNEL_ID || ch?.parent_id === deps.env.CHANNEL_ID;
  if (!allowed) return ephemeral("이 봇은 인증 채널에서만 사용할 수 있어요.");

  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const handler = commandHandlers[interaction.data?.name ?? ""];
    if (!handler) return ephemeral("알 수 없는 명령이에요.");
    return handler(interaction, deps);
  }

  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    const prefix = (interaction.data?.custom_id ?? "").split(":")[0];
    const handler = componentHandlers[prefix];
    if (!handler) return ephemeral("만료됐거나 알 수 없는 버튼이에요.");
    return handler(interaction, deps);
  }

  return ephemeral("처리할 수 없는 요청이에요.");
}
```

`src/index.ts`:

```ts
import { verifyKey } from "discord-interactions";
import { DiscordApi } from "./discord/api";
import { routeInteraction, type Deps } from "./router";
import type { Env, Interaction } from "./types";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (request.method !== "POST") return new Response("geulgae-bot", { status: 200 });

    const signature = request.headers.get("x-signature-ed25519");
    const timestamp = request.headers.get("x-signature-timestamp");
    const body = await request.text();
    const valid =
      signature !== null &&
      timestamp !== null &&
      (await verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY));
    if (!valid) return new Response("invalid request signature", { status: 401 });

    const interaction = JSON.parse(body) as Interaction;
    const deps: Deps = {
      env,
      db: env.DB,
      api: new DiscordApi(env.DISCORD_TOKEN),
      ctx,
      now: () => new Date(),
      fetcher: fetch,
    };
    return routeInteraction(interaction, deps);
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npm test` && `npm run typecheck`
Expected: 전체 PASS (서명 검증 2건 포함), 타입 에러 0건

- [ ] **Step 6: 커밋**

```bash
git add src/router.ts src/index.ts test/helpers.ts test/router.test.ts test/index.test.ts
git commit -m "feat: 서명 검증과 인터랙션 라우팅 골격

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: /인증 — 글 제출 (+ 사이클 귀속, 백그라운드 검증)

**Files:**
- Create: `src/interactions/resolve-cycle.ts`, `src/interactions/submit.ts`
- Modify: `src/router.ts` (commandHandlers에 `인증` 등록)
- Test: `test/submit.test.ts`

**Interfaces:**
- Consumes: Task 2 `weekStartOf`/`isPastDeadline`, Task 3 `normalizeUrl`, Task 5 쿼리 전반, Task 6 응답 빌더, Task 7 `Deps`/`Handler`/헬퍼
- Produces:
  - `resolveCycle(db: D1Database, interaction: Interaction, now: Date): Promise<CycleRow | null>` — 스펙 §5.2 귀속 규칙. Task 10·11도 사용
  - `handleSubmit: Handler`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/submit.test.ts`:

```ts
import { env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as q from "../src/db/queries";
import { handleSubmit } from "../src/interactions/submit";
import {
  CHANNEL_ID, DEFAULT_NOW, fetcherReturning, makeCommandInteraction, makeDeps, readJson,
} from "./helpers";

const NOW_ISO = DEFAULT_NOW.toISOString();

async function seedCycle(weekStart: string, threadId: string, goalCount = 1) {
  return q.createCycle(env.DB, {
    weekStart, goalCount, penaltyPerPost: 10000,
    channelId: CHANNEL_ID, threadId, createdBy: "user:u1", createdAt: NOW_ISO,
  });
}

function submitInteraction(url: string, opts: Parameters<typeof makeCommandInteraction>[2] = {}) {
  return makeCommandInteraction("인증", [{ name: "링크", type: 3, value: url }], opts);
}

describe("/인증", () => {
  it("참여자의 인증: 공개 응답 + 저장 + 백그라운드 검증 후 스레드 후속 메시지", async () => {
    const c = await seedCycle("2026-07-20", "thread-A");
    await q.addParticipant(env.DB, c.id, "u1", "manual", NOW_ISO);
    const deps = makeDeps();
    const res = await handleSubmit(submitInteraction("https://Blog.com/post/"), deps);
    const body = await readJson(res);
    expect(body.data.flags).toBeUndefined(); // 공개
    expect(body.data.content).toContain("1/1개");

    await waitOnExecutionContext(deps.ctx);
    const row = await env.DB.prepare("SELECT * FROM submissions WHERE user_id = 'u1'")
      .first<{ url: string; fetch_status: string; fetch_title: string }>();
    expect(row?.url).toBe("https://blog.com/post"); // 정규화 저장
    expect(row?.fetch_status).toBe("ok");
    expect(row?.fetch_title).toBe("테스트 글");
    const followup = deps.calls.find((c2) => c2.method === "sendMessage");
    expect(followup?.args[0]).toBe("thread-A");
  });

  it("같은 링크 재제출은 ephemeral 거부", async () => {
    const c = await seedCycle("2026-07-20", "thread-A");
    await q.addParticipant(env.DB, c.id, "u1", "manual", NOW_ISO);
    await handleSubmit(submitInteraction("https://a.com/p"), makeDeps());
    const body = await readJson(await handleSubmit(submitInteraction("https://a.com/p"), makeDeps()));
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain("이미 인증한 링크");
  });

  it("비참여자는 자동으로 참여자 등록 후 인증된다", async () => {
    await seedCycle("2026-07-20", "thread-A");
    const body = await readJson(
      await handleSubmit(submitInteraction("https://a.com/p2", { userId: "u9" }), makeDeps())
    );
    expect(body.data.content).toContain("자동 등록");
    const parts = await q.listParticipants(env.DB, (await q.getCycleByWeekStart(env.DB, "2026-07-20"))!.id);
    expect(parts).toEqual([{ user_id: "u9", joined_via: "submit" }]);
  });

  it("사이클이 없으면 ephemeral 안내", async () => {
    const body = await readJson(await handleSubmit(submitInteraction("https://a.com/p"), makeDeps()));
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain("/목표설정");
  });

  it("다음 주 스레드 안에서 인증하면 그 주에 귀속된다 (미리 인증)", async () => {
    await seedCycle("2026-07-20", "thread-A");
    const next = await seedCycle("2026-07-27", "thread-B");
    const i = submitInteraction("https://a.com/next-week", { channelId: "thread-B", parentId: CHANNEL_ID });
    const body = await readJson(await handleSubmit(i, makeDeps()));
    expect(body.data.flags).toBeUndefined();
    const counts = await q.countSubmissionsByUser(env.DB, next.id);
    expect(counts.get("u1")).toBe(1);
  });

  it("마감이 지난 주차의 스레드에서는 거부", async () => {
    await seedCycle("2026-07-13", "thread-OLD"); // 지난주 (DEFAULT_NOW 기준 마감 지남)
    const i = submitInteraction("https://a.com/late", { channelId: "thread-OLD", parentId: CHANNEL_ID });
    const body = await readJson(await handleSubmit(i, makeDeps()));
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain("마감");
  });

  it("링크 접속 실패여도 인증은 유효, 스레드에 실패 안내", async () => {
    const c = await seedCycle("2026-07-20", "thread-A");
    await q.addParticipant(env.DB, c.id, "u1", "manual", NOW_ISO);
    const deps = makeDeps({ fetcher: fetcherReturning(500) });
    const body = await readJson(await handleSubmit(submitInteraction("https://dead.com/p"), deps));
    expect(body.data.content).toContain("1/1개"); // 인증 자체는 성공
    await waitOnExecutionContext(deps.ctx);
    const row = await env.DB.prepare("SELECT fetch_status FROM submissions WHERE url = 'https://dead.com/p'")
      .first<{ fetch_status: string }>();
    expect(row?.fetch_status).toBe("failed");
    const followup = deps.calls.find((c2) => c2.method === "sendMessage");
    expect(JSON.stringify(followup?.args[1])).toContain("인증은 유효");
  });

  it("http 링크는 ephemeral 거부", async () => {
    await seedCycle("2026-07-20", "thread-A");
    const body = await readJson(await handleSubmit(submitInteraction("http://a.com/p"), makeDeps()));
    expect(body.data.flags).toBe(64);
  });
});
```

- [ ] **Step 2: 실행해 실패 확인**

Run: `npx vitest run test/submit.test.ts`
Expected: FAIL — `Cannot find module '../src/interactions/submit'`

- [ ] **Step 3: 구현**

`src/interactions/resolve-cycle.ts`:

```ts
import { getCycleByThreadId, getCycleByWeekStart, type CycleRow } from "../db/queries";
import { weekStartOf } from "../domain/cycle";
import type { Interaction } from "../types";

// 사이클 귀속 규칙(스펙 §5.2): 스레드 안 → 그 스레드의 사이클, 채널 → 현재 주차
export async function resolveCycle(
  db: D1Database,
  interaction: Interaction,
  now: Date
): Promise<CycleRow | null> {
  const ch = interaction.channel;
  if (ch?.parent_id) return getCycleByThreadId(db, ch.id);
  return getCycleByWeekStart(db, weekStartOf(now));
}
```

`src/interactions/submit.ts`:

```ts
import {
  addParticipant, countSubmissionsByUser, insertSubmission, setSubmissionFetchResult, type CycleRow,
} from "../db/queries";
import { isPastDeadline } from "../domain/cycle";
import { normalizeUrl } from "../domain/url";
import { ephemeral, publicMessage } from "../discord/replies";
import type { Deps, Handler } from "../router";
import { getStringOption, interactionUserId } from "../types";
import { resolveCycle } from "./resolve-cycle";

export const handleSubmit: Handler = async (interaction, deps) => {
  const raw = getStringOption(interaction, "링크");
  if (!raw) return ephemeral("링크를 입력해주세요.");
  const norm = normalizeUrl(raw);
  if (!norm.ok) return ephemeral(norm.reason);

  const now = deps.now();
  const cycle = await resolveCycle(deps.db, interaction, now);
  if (!cycle) return ephemeral("이번 주 목표가 아직 없어요. `/목표설정`을 먼저 해주세요.");
  if (isPastDeadline(cycle.week_start, now)) return ephemeral("이미 마감된 주차예요.");

  const userId = interactionUserId(interaction);
  const nowIso = now.toISOString();
  const newlyJoined = await addParticipant(deps.db, cycle.id, userId, "submit", nowIso);
  const inserted = await insertSubmission(deps.db, {
    cycleId: cycle.id, userId, url: norm.url, submittedAt: nowIso,
  });
  if (inserted === "duplicate") return ephemeral("이미 인증한 링크예요.");

  const count = (await countSubmissionsByUser(deps.db, cycle.id)).get(userId) ?? 0;
  deps.ctx.waitUntil(verifyAndReport(deps, cycle, inserted.id, norm.url));

  const joinedNote = newlyJoined ? " (참여자로 자동 등록했어요)" : "";
  return publicMessage(
    `<@${userId}>님 인증 완료! 현재 ${count}/${cycle.goal_count}개${joinedNote}\n${norm.url}`
  );
};

// 스펙 §5.3-7: best-effort 검증. 실패해도 인증에 영향 없음.
async function verifyAndReport(
  deps: Deps,
  cycle: CycleRow,
  submissionId: number,
  url: string
): Promise<void> {
  let status: "ok" | "failed" = "failed";
  let title: string | null = null;
  try {
    const res = await deps.fetcher(url, { signal: AbortSignal.timeout(5000), redirect: "follow" });
    if (res.ok) {
      status = "ok";
      const html = await res.text();
      const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
      title = m ? m[1].trim().slice(0, 100) || null : null;
    }
  } catch {
    // 타임아웃·네트워크 오류 → failed 기록만
  }
  await setSubmissionFetchResult(deps.db, submissionId, status, title);
  const note =
    status === "ok"
      ? `🔗 ${title ?? "(제목 없음)"}`
      : "⚠️ 링크 접속 확인은 실패했지만 인증은 유효해요.";
  await deps.api.sendMessage(cycle.thread_id, { content: note, allowed_mentions: { parse: [] } });
}
```

`src/router.ts` 수정 — import 추가와 레지스트리 등록:

```ts
import { handleSubmit } from "./interactions/submit";
```

```ts
const commandHandlers: Record<string, Handler> = {
  인증: handleSubmit,
};
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test` && `npm run typecheck`
Expected: 전체 PASS (신규 8건 포함)

- [ ] **Step 5: 커밋**

```bash
git add src/interactions/resolve-cycle.ts src/interactions/submit.ts src/router.ts test/submit.test.ts
git commit -m "feat: /인증 — 제출·귀속 규칙·백그라운드 검증

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: /목표설정 — 사이클 생성·갱신

**Files:**
- Create: `src/interactions/goal.ts`
- Modify: `src/router.ts` (commandHandlers에 `목표설정` 등록)
- Test: `test/goal.test.ts`

**Interfaces:**
- Consumes: Task 2 `weekStartOf`/`nextWeekStartOf`/`weekLabel`, Task 5 `createCycle`/`getCycleByWeekStart`/`updateCycleSettings`/`addParticipant`, Task 6·7 공통
- Produces:
  - `parseMentions(text: string): string[]` — `<@id>`·`<@!id>` 파싱, 중복 제거, 순서 유지
  - `handleGoal: Handler` — 없으면 생성(공지 메시지 → 스레드 → 사이클 행 → 스레드 시작 안내), 있으면 참여자 추가 + 명시된 설정만 갱신

- [ ] **Step 1: 실패하는 테스트 작성**

`test/goal.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as q from "../src/db/queries";
import { handleGoal, parseMentions } from "../src/interactions/goal";
import { CHANNEL_ID, makeCommandInteraction, makeDeps, readJson } from "./helpers";

function goalInteraction(
  참여자: string,
  extra: { 개수?: number; 벌금?: number; 주차?: string } = {}
) {
  const options = [{ name: "참여자", type: 3, value: 참여자 }];
  if (extra.개수 !== undefined) options.push({ name: "개수", type: 4, value: extra.개수 } as never);
  if (extra.벌금 !== undefined) options.push({ name: "벌금", type: 4, value: extra.벌금 } as never);
  if (extra.주차 !== undefined) options.push({ name: "주차", type: 3, value: extra.주차 } as never);
  return makeCommandInteraction("목표설정", options);
}

describe("parseMentions", () => {
  it("<@id>와 <@!id>를 파싱하고 중복 제거", () => {
    expect(parseMentions("<@111> 글 <@!222> <@111>")).toEqual(["111", "222"]);
    expect(parseMentions("멘션 없음")).toEqual([]);
  });
});

describe("/목표설정", () => {
  it("신규: 공지 → 스레드 → 사이클 → 시작 안내 순으로 생성", async () => {
    const deps = makeDeps();
    const body = await readJson(await handleGoal(goalInteraction("<@111> <@222>", { 개수: 2 }), deps));
    expect(body.data.content).toContain("참여자 2명");

    expect(deps.calls.map((c) => c.method)).toEqual(["sendMessage", "createThread", "sendMessage"]);
    expect(deps.calls[0].args[0]).toBe(CHANNEL_ID); // 목표 공지는 채널에
    expect(deps.calls[1].args[2]).toBe("7월 3주차 글쓰기"); // weekLabel("2026-07-20") = "7월 3주차"

    const cycle = await q.getCycleByWeekStart(env.DB, "2026-07-20");
    expect(cycle?.goal_count).toBe(2);
    expect(cycle?.penalty_per_post).toBe(10000);
    expect(cycle?.thread_id).toMatch(/^thread-/); // fakeApi가 만든 스레드 id
    expect((await q.listParticipants(env.DB, cycle!.id)).map((p) => p.user_id)).toEqual(["111", "222"]);
    // 시작 안내는 스레드에, 참여자 멘션 포함
    expect(deps.calls[2].args[0]).toBe(cycle!.thread_id);
    expect(JSON.stringify(deps.calls[2].args[1])).toContain("<@111>");
  });

  it("기존 주차: 참여자 추가 + 명시한 설정만 갱신", async () => {
    await handleGoal(goalInteraction("<@111>"), makeDeps());
    const deps = makeDeps();
    await handleGoal(goalInteraction("<@111> <@333>", { 개수: 3 }), deps);
    const cycle = await q.getCycleByWeekStart(env.DB, "2026-07-20");
    expect(cycle?.goal_count).toBe(3);
    expect(cycle?.penalty_per_post).toBe(10000); // 벌금은 안 줬으니 유지
    expect((await q.listParticipants(env.DB, cycle!.id)).map((p) => p.user_id)).toEqual(["111", "333"]);
    // 새로 합류한 333만 스레드에 안내
    const notice = deps.calls.find((c) => c.method === "sendMessage");
    expect(JSON.stringify(notice?.args[1])).toContain("<@333>");
    expect(JSON.stringify(notice?.args[1])).not.toContain("<@111>");
  });

  it("주차:다음주는 다음 주 월요일로 생성", async () => {
    await handleGoal(goalInteraction("<@111>", { 주차: "다음주" }), makeDeps());
    expect(await q.getCycleByWeekStart(env.DB, "2026-07-27")).not.toBeNull();
  });

  it("참여자 멘션이 없으면 ephemeral", async () => {
    const body = await readJson(await handleGoal(goalInteraction("아무도 없음"), makeDeps()));
    expect(body.data.flags).toBe(64);
  });

  it("개수 0은 거부", async () => {
    const body = await readJson(await handleGoal(goalInteraction("<@111>", { 개수: 0 }), makeDeps()));
    expect(body.data.flags).toBe(64);
  });
});
```

- [ ] **Step 2: 실행해 실패 확인**

Run: `npx vitest run test/goal.test.ts`
Expected: FAIL — `Cannot find module '../src/interactions/goal'`

- [ ] **Step 3: 구현**

`src/interactions/goal.ts`:

```ts
import { addParticipant, createCycle, getCycleByWeekStart, updateCycleSettings } from "../db/queries";
import { nextWeekStartOf, weekLabel, weekStartOf } from "../domain/cycle";
import { ephemeral, publicMessage } from "../discord/replies";
import type { Handler } from "../router";
import { getIntegerOption, getStringOption, interactionUserId } from "../types";

export function parseMentions(text: string): string[] {
  return [...new Set([...text.matchAll(/<@!?(\d+)>/g)].map((m) => m[1]))];
}

export const handleGoal: Handler = async (interaction, deps) => {
  const mentions = parseMentions(getStringOption(interaction, "참여자") ?? "");
  if (mentions.length === 0) {
    return ephemeral("참여자를 한 명 이상 멘션해주세요. 예: `/목표설정 참여자:@하영 @민희`");
  }
  const goalOpt = getIntegerOption(interaction, "개수");
  const penaltyOpt = getIntegerOption(interaction, "벌금");
  if (goalOpt !== null && goalOpt < 1) return ephemeral("개수는 1 이상이어야 해요.");
  if (penaltyOpt !== null && penaltyOpt < 0) return ephemeral("벌금은 0 이상이어야 해요.");

  const now = deps.now();
  const weekStart =
    (getStringOption(interaction, "주차") ?? "이번주") === "다음주"
      ? nextWeekStartOf(now)
      : weekStartOf(now);
  const label = weekLabel(weekStart);
  const nowIso = now.toISOString();

  const existing = await getCycleByWeekStart(deps.db, weekStart);
  if (!existing) {
    const goalCount = goalOpt ?? 1;
    const penaltyPerPost = penaltyOpt ?? 10000;
    const msg = await deps.api.sendMessage(deps.env.CHANNEL_ID, {
      content:
        `📝 **${label} 목표** (${weekStart} 시작)\n` +
        `목표 주당 ${goalCount}개 · 미달 1개당 ${penaltyPerPost.toLocaleString("ko-KR")}원 · 일요일 23:59 마감`,
    });
    const thread = await deps.api.createThread(deps.env.CHANNEL_ID, msg.id, `${label} 글쓰기`);
    const cycle = await createCycle(deps.db, {
      weekStart, goalCount, penaltyPerPost,
      channelId: deps.env.CHANNEL_ID, threadId: thread.id,
      createdBy: `user:${interactionUserId(interaction)}`, createdAt: nowIso,
    });
    for (const id of mentions) await addParticipant(deps.db, cycle.id, id, "manual", nowIso);
    await deps.api.sendMessage(thread.id, {
      content:
        `${mentions.map((id) => `<@${id}>`).join(" ")}\n` +
        `${label} 목표 시작! 이 스레드에서 \`/인증\`으로 글을 인증해주세요.`,
    });
    return publicMessage(`${label} 목표를 설정했어요. 참여자 ${mentions.length}명 · 주당 ${goalCount}개.`);
  }

  await updateCycleSettings(deps.db, existing.id, {
    goalCount: goalOpt ?? undefined,
    penaltyPerPost: penaltyOpt ?? undefined,
  });
  const added: string[] = [];
  for (const id of mentions) {
    if (await addParticipant(deps.db, existing.id, id, "manual", nowIso)) added.push(id);
  }
  if (added.length > 0) {
    await deps.api.sendMessage(existing.thread_id, {
      content: `${added.map((id) => `<@${id}>`).join(" ")} ${label}에 합류했어요!`,
    });
  }
  return publicMessage(`${label} 목표를 갱신했어요. (참여자 ${added.length}명 추가)`);
};
```

`src/router.ts` 수정:

```ts
import { handleGoal } from "./interactions/goal";
```

```ts
const commandHandlers: Record<string, Handler> = {
  인증: handleSubmit,
  목표설정: handleGoal,
};
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test` && `npm run typecheck`
Expected: 전체 PASS

- [ ] **Step 5: 커밋**

```bash
git add src/interactions/goal.ts src/router.ts test/goal.test.ts
git commit -m "feat: /목표설정 — 사이클 생성·갱신

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: /현황 — 진행률 조회

**Files:**
- Create: `src/interactions/status.ts`
- Modify: `src/router.ts` (commandHandlers에 `현황` 등록)
- Test: `test/status.test.ts`

**Interfaces:**
- Consumes: Task 8 `resolveCycle`, Task 2 `formatRemaining`/`isPastDeadline`/`weekLabel`, Task 5 `listParticipants`/`countSubmissionsByUser`
- Produces: `handleStatus: Handler` — 조회 전용이라 마감된 주차에서도 동작한다(스펙 §5.2)

- [ ] **Step 1: 실패하는 테스트 작성**

`test/status.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as q from "../src/db/queries";
import { handleStatus } from "../src/interactions/status";
import { CHANNEL_ID, DEFAULT_NOW, makeCommandInteraction, makeDeps, readJson } from "./helpers";

const NOW_ISO = DEFAULT_NOW.toISOString();

describe("/현황", () => {
  it("참여자별 N/M와 달성 체크, 멘션 알림은 끈다", async () => {
    const c = await q.createCycle(env.DB, {
      weekStart: "2026-07-20", goalCount: 2, penaltyPerPost: 10000,
      channelId: CHANNEL_ID, threadId: "thread-A", createdBy: "user:u1", createdAt: NOW_ISO,
    });
    await q.addParticipant(env.DB, c.id, "u1", "manual", NOW_ISO);
    await q.addParticipant(env.DB, c.id, "u2", "manual", NOW_ISO);
    await q.insertSubmission(env.DB, { cycleId: c.id, userId: "u1", url: "https://a.com/1", submittedAt: NOW_ISO });
    await q.insertSubmission(env.DB, { cycleId: c.id, userId: "u1", url: "https://a.com/2", submittedAt: NOW_ISO });

    const body = await readJson(await handleStatus(makeCommandInteraction("현황"), makeDeps()));
    expect(body.data.content).toContain("<@u1>: 2/2개 ✅");
    expect(body.data.content).toContain("<@u2>: 0/2개");
    expect(body.data.content).toContain("마감까지");
    expect(body.data.allowed_mentions).toEqual({ parse: [] });
  });

  it("마감된 주차의 스레드에서도 조회는 된다", async () => {
    await q.createCycle(env.DB, {
      weekStart: "2026-07-13", goalCount: 1, penaltyPerPost: 10000,
      channelId: CHANNEL_ID, threadId: "thread-OLD", createdBy: "user:u1", createdAt: NOW_ISO,
    });
    const i = makeCommandInteraction("현황", [], { channelId: "thread-OLD", parentId: CHANNEL_ID });
    const body = await readJson(await handleStatus(i, makeDeps()));
    expect(body.data.content).toContain("마감됨");
  });

  it("사이클이 없으면 ephemeral", async () => {
    const body = await readJson(await handleStatus(makeCommandInteraction("현황"), makeDeps()));
    expect(body.data.flags).toBe(64);
  });
});
```

- [ ] **Step 2: 실행해 실패 확인**

Run: `npx vitest run test/status.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`src/interactions/status.ts`:

```ts
import { countSubmissionsByUser, listParticipants } from "../db/queries";
import { formatRemaining, isPastDeadline, weekLabel } from "../domain/cycle";
import { ephemeral, publicMessage } from "../discord/replies";
import type { Handler } from "../router";
import { resolveCycle } from "./resolve-cycle";

export const handleStatus: Handler = async (interaction, deps) => {
  const now = deps.now();
  const cycle = await resolveCycle(deps.db, interaction, now);
  if (!cycle) return ephemeral("이번 주 목표가 아직 없어요. `/목표설정`으로 시작해주세요.");

  const label = weekLabel(cycle.week_start);
  const participants = await listParticipants(deps.db, cycle.id);
  if (participants.length === 0) return publicMessage(`**${label} 현황**\n아직 참여자가 없어요.`);

  const counts = await countSubmissionsByUser(deps.db, cycle.id);
  const lines = participants.map((p) => {
    const n = counts.get(p.user_id) ?? 0;
    return `- <@${p.user_id}>: ${n}/${cycle.goal_count}개${n >= cycle.goal_count ? " ✅" : ""}`;
  });
  const timeNote = isPastDeadline(cycle.week_start, now)
    ? "마감됨"
    : `마감까지 ${formatRemaining(cycle.week_start, now)}`;
  return publicMessage(`**${label} 현황** (${timeNote})\n${lines.join("\n")}`, {
    allowed_mentions: { parse: [] },
  });
};
```

`src/router.ts` 수정: `import { handleStatus } from "./interactions/status";` 추가, 레지스트리에 `현황: handleStatus` 추가.

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test`
Expected: 전체 PASS

- [ ] **Step 5: 커밋**

```bash
git add src/interactions/status.ts src/router.ts test/status.test.ts
git commit -m "feat: /현황 — 진행률 조회

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: /참여취소 + [참여하기] 버튼

**Files:**
- Create: `src/interactions/withdraw.ts`, `src/interactions/join-button.ts`
- Modify: `src/router.ts` (commandHandlers에 `참여취소`, componentHandlers에 `join` 등록)
- Test: `test/participants.test.ts`

**Interfaces:**
- Consumes: Task 8 `resolveCycle`, Task 2 `isPastDeadline`/`weekLabel`, Task 5 참여자·제출 쿼리, `getStringOption`(USER 옵션의 value도 유저 id 문자열이므로 그대로 사용)
- Produces:
  - `handleWithdraw: Handler` — `대상` 옵션(기본 본인). 조건: 마감 전 + 그 사이클 제출물 0개
  - `handleJoinButton: Handler` — `custom_id = "join:<week_start>"` 파싱, 마감 전이면 참여 등록

- [ ] **Step 1: 실패하는 테스트 작성**

`test/participants.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as q from "../src/db/queries";
import { handleJoinButton } from "../src/interactions/join-button";
import { handleWithdraw } from "../src/interactions/withdraw";
import {
  CHANNEL_ID, DEFAULT_NOW, makeCommandInteraction, makeComponentInteraction, makeDeps, readJson,
} from "./helpers";

const NOW_ISO = DEFAULT_NOW.toISOString();

async function seedCycle(weekStart = "2026-07-20", threadId = "thread-A") {
  return q.createCycle(env.DB, {
    weekStart, goalCount: 1, penaltyPerPost: 10000,
    channelId: CHANNEL_ID, threadId, createdBy: "user:u1", createdAt: NOW_ISO,
  });
}

describe("/참여취소", () => {
  it("대상 옵션이 없으면 본인을 취소한다", async () => {
    const c = await seedCycle();
    await q.addParticipant(env.DB, c.id, "u1", "manual", NOW_ISO);
    const body = await readJson(await handleWithdraw(makeCommandInteraction("참여취소"), makeDeps()));
    expect(body.data.content).toContain("<@u1>");
    expect(await q.listParticipants(env.DB, c.id)).toEqual([]);
  });
  it("누구나 대상을 지정해 취소할 수 있다", async () => {
    const c = await seedCycle();
    await q.addParticipant(env.DB, c.id, "u2", "manual", NOW_ISO);
    const i = makeCommandInteraction("참여취소", [{ name: "대상", type: 6, value: "u2" }]);
    await handleWithdraw(i, makeDeps());
    expect(await q.listParticipants(env.DB, c.id)).toEqual([]);
  });
  it("이미 인증한 글이 있으면 거부", async () => {
    const c = await seedCycle();
    await q.addParticipant(env.DB, c.id, "u1", "manual", NOW_ISO);
    await q.insertSubmission(env.DB, { cycleId: c.id, userId: "u1", url: "https://a.com/p", submittedAt: NOW_ISO });
    const body = await readJson(await handleWithdraw(makeCommandInteraction("참여취소"), makeDeps()));
    expect(body.data.flags).toBe(64);
    expect((await q.listParticipants(env.DB, c.id)).length).toBe(1);
  });
  it("참여자가 아니면 ephemeral", async () => {
    await seedCycle();
    const body = await readJson(await handleWithdraw(makeCommandInteraction("참여취소"), makeDeps()));
    expect(body.data.flags).toBe(64);
  });
  it("마감 후에는 거부", async () => {
    await seedCycle("2026-07-13", "thread-OLD");
    const i = makeCommandInteraction("참여취소", [], { channelId: "thread-OLD", parentId: CHANNEL_ID });
    const body = await readJson(await handleWithdraw(i, makeDeps()));
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain("마감");
  });
});

describe("[참여하기] 버튼", () => {
  it("클릭하면 참여자로 등록되고 공개 응답", async () => {
    const c = await seedCycle();
    const body = await readJson(
      await handleJoinButton(makeComponentInteraction("join:2026-07-20", { userId: "u5" }), makeDeps())
    );
    expect(body.data.flags).toBeUndefined();
    expect(body.data.content).toContain("<@u5>");
    expect((await q.listParticipants(env.DB, c.id)).map((p) => p.joined_via)).toEqual(["button"]);
  });
  it("중복 클릭은 ephemeral '이미 참여 중'", async () => {
    const c = await seedCycle();
    await q.addParticipant(env.DB, c.id, "u5", "button", NOW_ISO);
    const body = await readJson(
      await handleJoinButton(makeComponentInteraction("join:2026-07-20", { userId: "u5" }), makeDeps())
    );
    expect(body.data.flags).toBe(64);
  });
  it("마감 지난 주차의 버튼은 거부", async () => {
    await seedCycle("2026-07-13", "thread-OLD");
    const body = await readJson(
      await handleJoinButton(makeComponentInteraction("join:2026-07-13"), makeDeps())
    );
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain("마감");
  });
  it("사이클이 없는 week_start면 에러 안내", async () => {
    const body = await readJson(
      await handleJoinButton(makeComponentInteraction("join:2026-07-20"), makeDeps())
    );
    expect(body.data.flags).toBe(64);
  });
});
```

- [ ] **Step 2: 실행해 실패 확인**

Run: `npx vitest run test/participants.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`src/interactions/withdraw.ts`:

```ts
import { countSubmissionsByUser, listParticipants, removeParticipant } from "../db/queries";
import { isPastDeadline, weekLabel } from "../domain/cycle";
import { ephemeral, publicMessage } from "../discord/replies";
import type { Handler } from "../router";
import { getStringOption, interactionUserId } from "../types";
import { resolveCycle } from "./resolve-cycle";

export const handleWithdraw: Handler = async (interaction, deps) => {
  const now = deps.now();
  const cycle = await resolveCycle(deps.db, interaction, now);
  if (!cycle) return ephemeral("이번 주 목표가 아직 없어요.");
  if (isPastDeadline(cycle.week_start, now)) return ephemeral("이미 마감된 주차예요.");

  const target = getStringOption(interaction, "대상") ?? interactionUserId(interaction);
  const participants = await listParticipants(deps.db, cycle.id);
  if (!participants.some((p) => p.user_id === target)) {
    return ephemeral("그분은 이번 주 참여자가 아니에요.");
  }
  const submitted = (await countSubmissionsByUser(deps.db, cycle.id)).get(target) ?? 0;
  if (submitted > 0) return ephemeral("이미 인증한 글이 있어서 참여를 취소할 수 없어요.");

  await removeParticipant(deps.db, cycle.id, target);
  return publicMessage(`<@${target}>님을 ${weekLabel(cycle.week_start)} 참여자에서 뺐어요.`);
};
```

`src/interactions/join-button.ts`:

```ts
import { addParticipant, getCycleByWeekStart, listParticipants } from "../db/queries";
import { isPastDeadline, weekLabel } from "../domain/cycle";
import { ephemeral, publicMessage } from "../discord/replies";
import type { Handler } from "../router";
import { interactionUserId } from "../types";

export const handleJoinButton: Handler = async (interaction, deps) => {
  const weekStart = (interaction.data?.custom_id ?? "").slice("join:".length);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return ephemeral("잘못된 버튼이에요.");

  const now = deps.now();
  if (isPastDeadline(weekStart, now)) return ephemeral("이미 마감된 주차예요.");
  const cycle = await getCycleByWeekStart(deps.db, weekStart);
  if (!cycle) return ephemeral("해당 주차 목표를 찾을 수 없어요.");

  const userId = interactionUserId(interaction);
  const added = await addParticipant(deps.db, cycle.id, userId, "button", now.toISOString());
  if (!added) return ephemeral("이미 참여 중이에요.");

  const count = (await listParticipants(deps.db, cycle.id)).length;
  return publicMessage(`<@${userId}>님이 ${weekLabel(weekStart)}에 참여했어요! (현재 ${count}명)`);
};
```

`src/router.ts` 수정 — import 2줄 추가 후:

```ts
const commandHandlers: Record<string, Handler> = {
  인증: handleSubmit,
  목표설정: handleGoal,
  현황: handleStatus,
  참여취소: handleWithdraw,
};

const componentHandlers: Record<string, Handler> = {
  join: handleJoinButton,
};
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test` && `npm run typecheck`
Expected: 전체 PASS

- [ ] **Step 5: 커밋**

```bash
git add src/interactions/withdraw.ts src/interactions/join-button.ts src/router.ts test/participants.test.ts
git commit -m "feat: /참여취소와 참여하기 버튼

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: /벌금현황 + /벌금조정

**Files:**
- Create: `src/interactions/penalty.ts`
- Modify: `src/router.ts` (commandHandlers에 `벌금현황`, `벌금조정` 등록)
- Test: `test/penalty.test.ts`

**Interfaces:**
- Consumes: Task 5 `getPenaltyBalances`/`getPenaltyBalance`/`insertAdjustment`
- Produces: `handlePenaltyStatus: Handler`, `handlePenaltyAdjust: Handler`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/penalty.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as q from "../src/db/queries";
import { handlePenaltyAdjust, handlePenaltyStatus } from "../src/interactions/penalty";
import { makeCommandInteraction, makeDeps, readJson } from "./helpers";

function adjustInteraction(target: string, amount: number, reason?: string) {
  const options = [
    { name: "대상", type: 6, value: target },
    { name: "금액", type: 4, value: amount },
  ];
  if (reason !== undefined) options.push({ name: "사유", type: 3, value: reason } as never);
  return makeCommandInteraction("벌금조정", options, { userId: "admin" });
}

describe("/벌금현황", () => {
  it("벌금이 없으면 축하 메시지", async () => {
    const body = await readJson(await handlePenaltyStatus(makeCommandInteraction("벌금현황"), makeDeps()));
    expect(body.data.content).toContain("없어요");
  });
  it("멤버별 잔액과 총액을 보여주고 멘션 알림은 끈다", async () => {
    await q.insertAdjustment(env.DB, { userId: "u1", amount: 20000, reason: "이월", createdBy: "user:admin", createdAt: "2026-07-20T00:00:00Z" });
    await q.insertAdjustment(env.DB, { userId: "u2", amount: 10000, reason: null, createdBy: "user:admin", createdAt: "2026-07-20T00:00:00Z" });
    const body = await readJson(await handlePenaltyStatus(makeCommandInteraction("벌금현황"), makeDeps()));
    expect(body.data.content).toContain("<@u1>님: 20,000원");
    expect(body.data.content).toContain("<@u2>님: 10,000원");
    expect(body.data.content).toContain("30,000원");
    expect(body.data.allowed_mentions).toEqual({ parse: [] });
  });
});

describe("/벌금조정", () => {
  it("원장에 조정 행을 남기고 잔액을 알려준다", async () => {
    const body = await readJson(await handlePenaltyAdjust(adjustInteraction("u1", 15000, "기존 봇 이월"), makeDeps()));
    expect(body.data.content).toContain("+15,000원");
    expect(body.data.content).toContain("기존 봇 이월");
    expect(body.data.content).toContain("15,000원");
    const row = await env.DB.prepare("SELECT * FROM penalty_entries WHERE user_id = 'u1'")
      .first<{ kind: string; created_by: string; amount: number }>();
    expect(row).toMatchObject({ kind: "adjustment", created_by: "user:admin", amount: 15000 });
  });
  it("음수 조정(납부·삭감)이 잔액에 반영된다", async () => {
    await handlePenaltyAdjust(adjustInteraction("u1", 20000), makeDeps());
    const body = await readJson(await handlePenaltyAdjust(adjustInteraction("u1", -5000), makeDeps()));
    expect(body.data.content).toContain("-5,000원");
    expect(await q.getPenaltyBalance(env.DB, "u1")).toBe(15000);
  });
  it("0원은 거부", async () => {
    const body = await readJson(await handlePenaltyAdjust(adjustInteraction("u1", 0), makeDeps()));
    expect(body.data.flags).toBe(64);
  });
});
```

- [ ] **Step 2: 실행해 실패 확인**

Run: `npx vitest run test/penalty.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`src/interactions/penalty.ts`:

```ts
import { getPenaltyBalance, getPenaltyBalances, insertAdjustment } from "../db/queries";
import { ephemeral, publicMessage } from "../discord/replies";
import type { Handler } from "../router";
import { getIntegerOption, getStringOption, interactionUserId } from "../types";

const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

export const handlePenaltyStatus: Handler = async (_interaction, deps) => {
  const balances = await getPenaltyBalances(deps.db);
  if (balances.length === 0) return publicMessage("쌓인 벌금이 없어요! 🎉");
  const total = balances.reduce((sum, b) => sum + b.balance, 0);
  const lines = balances.map((b) => `- <@${b.user_id}>님: ${won(b.balance)}`);
  return publicMessage(
    `**벌금 현황**\n${lines.join("\n")}\n지금까지 모인 금액: **${won(total)}**`,
    { allowed_mentions: { parse: [] } }
  );
};

export const handlePenaltyAdjust: Handler = async (interaction, deps) => {
  const target = getStringOption(interaction, "대상");
  const amount = getIntegerOption(interaction, "금액");
  if (!target || amount === null) return ephemeral("대상과 금액을 입력해주세요.");
  if (amount === 0) return ephemeral("0원은 조정할 수 없어요.");

  const reason = getStringOption(interaction, "사유");
  await insertAdjustment(deps.db, {
    userId: target,
    amount,
    reason,
    createdBy: `user:${interactionUserId(interaction)}`,
    createdAt: deps.now().toISOString(),
  });
  const balance = await getPenaltyBalance(deps.db, target);
  const sign = amount > 0 ? "+" : "-";
  const reasonNote = reason ? ` (사유: ${reason})` : "";
  return publicMessage(
    `<@${target}>님 벌금 ${sign}${won(Math.abs(amount))} 조정${reasonNote} → 현재 ${won(balance)}`
  );
};
```

`src/router.ts` 수정: `import { handlePenaltyAdjust, handlePenaltyStatus } from "./interactions/penalty";` 추가, 레지스트리에 `벌금현황: handlePenaltyStatus`, `벌금조정: handlePenaltyAdjust` 추가.

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test`
Expected: 전체 PASS

- [ ] **Step 5: 커밋**

```bash
git add src/interactions/penalty.ts src/router.ts test/penalty.test.ts
git commit -m "feat: /벌금현황·/벌금조정 — 원장 조회와 조정

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: 정산 sweep 잡 + scheduled 핸들러

**Files:**
- Create: `src/jobs/settle.ts`
- Modify: `src/index.ts` (`scheduled` 핸들러 추가)
- Test: `test/settle-job.test.ts`

**Interfaces:**
- Consumes: Task 2 `isPastDeadline`/`weekLabel`, Task 4 `calculateSettlement`, Task 5 사이클·참여자·제출·원장 쿼리, Task 6 `DiscordApi`
- Produces:
  - `interface JobDeps { env: Env; db: D1Database; api: DiscordApi; now: () => Date }` — Task 14의 두 잡도 이 타입을 사용
  - `settleSweep(deps: JobDeps): Promise<void>` — 순서: 원장 기록 → 공지 → `settled_at`. 공지 실패 시 `settled_at`을 찍지 않아 다음 실행이 재시도한다

- [ ] **Step 1: 실패하는 테스트 작성**

`test/settle-job.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as q from "../src/db/queries";
import type { DiscordApi } from "../src/discord/api";
import { settleSweep, type JobDeps } from "../src/jobs/settle";
import { CHANNEL_ID, DEFAULT_NOW, fakeApi, makeEnv, type ApiCall } from "./helpers";

const NOW_ISO = "2026-07-15T03:00:00.000Z"; // 지난주 수요일

function jobDeps(api?: DiscordApi): JobDeps & { calls: ApiCall[] } {
  const fake = fakeApi();
  return {
    env: makeEnv(),
    db: env.DB,
    api: api ?? fake.api,
    now: () => DEFAULT_NOW, // 2026-07-22 수요일 → 2026-07-13 주는 마감 지남
    calls: fake.calls,
  };
}

async function seedLastWeek(goalCount = 1) {
  const c = await q.createCycle(env.DB, {
    weekStart: "2026-07-13", goalCount, penaltyPerPost: 10000,
    channelId: CHANNEL_ID, threadId: "thread-OLD", createdBy: "user:u1", createdAt: NOW_ISO,
  });
  return c;
}

describe("settleSweep", () => {
  it("마감 지난 미정산 사이클: 미달자에게 부과, 공지, settled 처리", async () => {
    const c = await seedLastWeek();
    await q.addParticipant(env.DB, c.id, "u1", "manual", NOW_ISO); // 0개 → 미달
    await q.addParticipant(env.DB, c.id, "u2", "manual", NOW_ISO); // 1개 → 달성
    await q.insertSubmission(env.DB, { cycleId: c.id, userId: "u2", url: "https://a.com/p", submittedAt: NOW_ISO });

    const deps = jobDeps();
    await settleSweep(deps);

    expect(await q.getPenaltyBalance(env.DB, "u1")).toBe(10000);
    expect(await q.getPenaltyBalance(env.DB, "u2")).toBe(0);
    expect((await q.getCycleByWeekStart(env.DB, "2026-07-13"))?.settled_at).not.toBeNull();
    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0].args[0]).toBe("thread-OLD");
    expect(JSON.stringify(deps.calls[0].args[1])).toContain("<@u1>");
  });

  it("두 번 실행해도 벌금·공지가 중복되지 않는다 (멱등)", async () => {
    const c = await seedLastWeek();
    await q.addParticipant(env.DB, c.id, "u1", "manual", NOW_ISO);
    const deps = jobDeps();
    await settleSweep(deps);
    await settleSweep(deps); // settled_at이 찍혀 있어 두 번째는 no-op
    expect(await q.getPenaltyBalance(env.DB, "u1")).toBe(10000);
    expect(deps.calls).toHaveLength(1);
  });

  it("전원 달성이면 축하 공지만", async () => {
    const c = await seedLastWeek();
    await q.addParticipant(env.DB, c.id, "u2", "manual", NOW_ISO);
    await q.insertSubmission(env.DB, { cycleId: c.id, userId: "u2", url: "https://a.com/p", submittedAt: NOW_ISO });
    const deps = jobDeps();
    await settleSweep(deps);
    expect(JSON.stringify(deps.calls[0].args[1])).toContain("전원");
    expect(await q.getPenaltyBalance(env.DB, "u2")).toBe(0);
  });

  it("참여자 0명이면 공지 없이 settled 처리", async () => {
    await seedLastWeek();
    const deps = jobDeps();
    await settleSweep(deps);
    expect(deps.calls).toHaveLength(0);
    expect((await q.getCycleByWeekStart(env.DB, "2026-07-13"))?.settled_at).not.toBeNull();
  });

  it("마감 전 사이클은 건드리지 않는다", async () => {
    const c = await q.createCycle(env.DB, {
      weekStart: "2026-07-20", goalCount: 1, penaltyPerPost: 10000,
      channelId: CHANNEL_ID, threadId: "thread-A", createdBy: "user:u1", createdAt: NOW_ISO,
    });
    await q.addParticipant(env.DB, c.id, "u1", "manual", NOW_ISO);
    const deps = jobDeps();
    await settleSweep(deps);
    expect(await q.getPenaltyBalance(env.DB, "u1")).toBe(0);
    expect((await q.getCycleByWeekStart(env.DB, "2026-07-20"))?.settled_at).toBeNull();
  });

  it("공지 실패 시 settled_at을 찍지 않는다 (다음 실행이 재시도, 원장은 멱등)", async () => {
    const c = await seedLastWeek();
    await q.addParticipant(env.DB, c.id, "u1", "manual", NOW_ISO);
    const throwingApi = {
      sendMessage: async () => { throw new Error("Discord 500"); },
      createThread: async () => { throw new Error("unused"); },
    } as unknown as DiscordApi;
    await expect(settleSweep(jobDeps(throwingApi))).rejects.toThrow("Discord 500");
    expect(await q.getPenaltyBalance(env.DB, "u1")).toBe(10000); // 원장은 이미 기록
    expect((await q.getCycleByWeekStart(env.DB, "2026-07-13"))?.settled_at).toBeNull();

    // 다음 실행(정상 API)이 마무리한다 — 벌금 중복 없이 공지 + settled
    const deps = jobDeps();
    await settleSweep(deps);
    expect(await q.getPenaltyBalance(env.DB, "u1")).toBe(10000);
    expect(deps.calls).toHaveLength(1);
    expect((await q.getCycleByWeekStart(env.DB, "2026-07-13"))?.settled_at).not.toBeNull();
  });
});
```

- [ ] **Step 2: 실행해 실패 확인**

Run: `npx vitest run test/settle-job.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`src/jobs/settle.ts`:

```ts
import {
  countSubmissionsByUser, insertSettlementEntries, listParticipants, listUnsettledCycles, markSettled,
} from "../db/queries";
import type { DiscordApi } from "../discord/api";
import { isPastDeadline, weekLabel } from "../domain/cycle";
import { calculateSettlement } from "../domain/settlement";
import type { Env } from "../types";

export interface JobDeps {
  env: Env;
  db: D1Database;
  api: DiscordApi;
  now: () => Date;
}

const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

export async function settleSweep(deps: JobDeps): Promise<void> {
  const now = deps.now();
  const targets = (await listUnsettledCycles(deps.db)).filter((c) => isPastDeadline(c.week_start, now));

  for (const cycle of targets) {
    const participants = await listParticipants(deps.db, cycle.id);
    const counts = await countSubmissionsByUser(deps.db, cycle.id);
    const charges = calculateSettlement({
      goalCount: cycle.goal_count,
      penaltyPerPost: cycle.penalty_per_post,
      participants: participants.map((p) => ({
        userId: p.user_id,
        submissionCount: counts.get(p.user_id) ?? 0,
      })),
    });
    const label = weekLabel(cycle.week_start);

    // 1) 원장 기록 (INSERT OR IGNORE — 재실행에도 멱등)
    await insertSettlementEntries(
      deps.db,
      cycle.id,
      charges.map((c) => ({
        userId: c.userId,
        amount: c.amount,
        reason: `${label} 정산 (${c.shortfall}개 미달)`,
      })),
      now.toISOString()
    );

    // 2) 공지 (실패하면 throw → settled_at을 찍지 않고 다음 실행이 재시도)
    if (participants.length > 0) {
      const content =
        charges.length === 0
          ? `🎉 **${label} 전원 목표 달성!** 벌금 없이 마감됐어요.`
          : `⚖️ **${label} 정산 결과**\n` +
            charges
              .map((c) => `- <@${c.userId}>님: ${c.shortfall}개 미달 → 벌금 ${won(c.amount)}`)
              .join("\n");
      await deps.api.sendMessage(cycle.thread_id, { content });
    }

    // 3) 정산 완료 표시
    await markSettled(deps.db, cycle.id, now.toISOString());
  }
}
```

`src/index.ts` 수정 — import 추가:

```ts
import { settleSweep, type JobDeps } from "./jobs/settle";
```

default export 객체에 `scheduled` 추가 (`fetch` 아래):

```ts
  async scheduled(event, env, _ctx): Promise<void> {
    const deps: JobDeps = {
      env,
      db: env.DB,
      api: new DiscordApi(env.DISCORD_TOKEN),
      now: () => new Date(),
    };
    try {
      switch (event.cron) {
        case "5 15 * * *": // 매일 00:05 KST — 정산 sweep
          await settleSweep(deps);
          break;
        default:
          console.log(`미연결 cron: ${event.cron}`); // Task 14에서 나머지 두 잡을 연결한다
      }
    } catch (err) {
      console.error("cron 잡 실패:", event.cron, err);
      throw err;
    }
  },
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test` && `npm run typecheck`
Expected: 전체 PASS (settle 6건 포함)

- [ ] **Step 5: 커밋**

```bash
git add src/jobs/settle.ts src/index.ts test/settle-job.test.ts
git commit -m "feat: 정산 sweep 잡 — 멱등 부과·공지·settled 처리

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 14: 안전망 공지 잡 + 리마인더 잡

**Files:**
- Create: `src/jobs/fallback-notice.ts`, `src/jobs/reminder.ts`
- Modify: `src/index.ts` (`scheduled`의 나머지 cron 2개 연결)
- Test: `test/notice-jobs.test.ts`

**Interfaces:**
- Consumes: Task 13 `JobDeps`, Task 2 `weekStartOf`/`weekLabel`, Task 5 사이클·참여자·제출 쿼리, Task 11의 버튼 custom_id 규약 `join:<week_start>`
- Produces: `fallbackNotice(deps: JobDeps): Promise<void>`, `reminder(deps: JobDeps): Promise<void>`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/notice-jobs.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as q from "../src/db/queries";
import { fallbackNotice } from "../src/jobs/fallback-notice";
import { reminder } from "../src/jobs/reminder";
import type { JobDeps } from "../src/jobs/settle";
import { CHANNEL_ID, DEFAULT_NOW, fakeApi, makeEnv, type ApiCall } from "./helpers";

const NOW_ISO = DEFAULT_NOW.toISOString();

function jobDeps(): JobDeps & { calls: ApiCall[] } {
  const fake = fakeApi();
  return { env: makeEnv(), db: env.DB, api: fake.api, now: () => DEFAULT_NOW, calls: fake.calls };
}

describe("fallbackNotice (화요일 안전망)", () => {
  it("이번 주 사이클이 없으면 버튼 공지 → 스레드 → 사이클 생성 → 스레드 안내", async () => {
    const deps = jobDeps();
    await fallbackNotice(deps);

    expect(deps.calls.map((c) => c.method)).toEqual(["sendMessage", "createThread", "sendMessage"]);
    expect(deps.calls[0].args[0]).toBe(CHANNEL_ID);
    expect(JSON.stringify(deps.calls[0].args[1])).toContain('"custom_id":"join:2026-07-20"');

    const cycle = await q.getCycleByWeekStart(env.DB, "2026-07-20");
    expect(cycle).toMatchObject({ goal_count: 1, penalty_per_post: 10000, created_by: "bot:fallback" });
    expect(cycle?.thread_id).toMatch(/^thread-/);
    expect(deps.calls[2].args[0]).toBe(cycle!.thread_id);
  });

  it("이번 주 사이클이 이미 있으면 아무것도 하지 않는다", async () => {
    await q.createCycle(env.DB, {
      weekStart: "2026-07-20", goalCount: 1, penaltyPerPost: 10000,
      channelId: CHANNEL_ID, threadId: "thread-A", createdBy: "user:u1", createdAt: NOW_ISO,
    });
    const deps = jobDeps();
    await fallbackNotice(deps);
    expect(deps.calls).toHaveLength(0);
  });
});

describe("reminder (일요일 마감 리마인더)", () => {
  async function seedWithParticipants() {
    const c = await q.createCycle(env.DB, {
      weekStart: "2026-07-20", goalCount: 1, penaltyPerPost: 10000,
      channelId: CHANNEL_ID, threadId: "thread-A", createdBy: "user:u1", createdAt: NOW_ISO,
    });
    await q.addParticipant(env.DB, c.id, "u1", "manual", NOW_ISO);
    await q.addParticipant(env.DB, c.id, "u2", "manual", NOW_ISO);
    return c;
  }

  it("미달성 참여자만 멘션한다", async () => {
    const c = await seedWithParticipants();
    await q.insertSubmission(env.DB, { cycleId: c.id, userId: "u2", url: "https://a.com/p", submittedAt: NOW_ISO });
    const deps = jobDeps();
    await reminder(deps);
    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0].args[0]).toBe("thread-A");
    const content = JSON.stringify(deps.calls[0].args[1]);
    expect(content).toContain("<@u1>");
    expect(content).not.toContain("<@u2>");
  });

  it("전원 달성이면 침묵", async () => {
    const c = await seedWithParticipants();
    await q.insertSubmission(env.DB, { cycleId: c.id, userId: "u1", url: "https://a.com/1", submittedAt: NOW_ISO });
    await q.insertSubmission(env.DB, { cycleId: c.id, userId: "u2", url: "https://a.com/2", submittedAt: NOW_ISO });
    const deps = jobDeps();
    await reminder(deps);
    expect(deps.calls).toHaveLength(0);
  });

  it("사이클이 없으면 침묵", async () => {
    const deps = jobDeps();
    await reminder(deps);
    expect(deps.calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 실행해 실패 확인**

Run: `npx vitest run test/notice-jobs.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`src/jobs/fallback-notice.ts`:

```ts
import { createCycle, getCycleByWeekStart } from "../db/queries";
import { weekLabel, weekStartOf } from "../domain/cycle";
import type { JobDeps } from "./settle";

// 화 10:00 KST — 이번 주 목표가 없으면 기본값으로 생성하고 참여 버튼 공지 (스펙 §6)
export async function fallbackNotice(deps: JobDeps): Promise<void> {
  const now = deps.now();
  const weekStart = weekStartOf(now);
  if (await getCycleByWeekStart(deps.db, weekStart)) return;

  const label = weekLabel(weekStart);
  const msg = await deps.api.sendMessage(deps.env.CHANNEL_ID, {
    content:
      `📣 아직 **${label} 목표**가 없어요! 아래 버튼으로 참여하거나 \`/목표설정\`으로 직접 설정해주세요.\n` +
      `기본 설정: 주당 1개 · 미달 1개당 10,000원 · 일요일 23:59 마감`,
    components: [
      {
        type: 1,
        components: [{ type: 2, style: 1, label: "참여하기", custom_id: `join:${weekStart}` }],
      },
    ],
  });
  const thread = await deps.api.createThread(deps.env.CHANNEL_ID, msg.id, `${label} 글쓰기`);
  await createCycle(deps.db, {
    weekStart,
    goalCount: 1,
    penaltyPerPost: 10000,
    channelId: deps.env.CHANNEL_ID,
    threadId: thread.id,
    createdBy: "bot:fallback",
    createdAt: now.toISOString(),
  });
  await deps.api.sendMessage(thread.id, {
    content: `${label} 스레드예요. 참여자는 여기서 \`/인증\`으로 글을 인증해주세요.`,
  });
}
```

`src/jobs/reminder.ts`:

```ts
import { countSubmissionsByUser, getCycleByWeekStart, listParticipants } from "../db/queries";
import { weekStartOf } from "../domain/cycle";
import type { JobDeps } from "./settle";

// 일 10:00 KST — 미달성 참여자만 멘션 (스펙 §6). 전원 달성이면 침묵.
export async function reminder(deps: JobDeps): Promise<void> {
  const now = deps.now();
  const cycle = await getCycleByWeekStart(deps.db, weekStartOf(now));
  if (!cycle) return;

  const participants = await listParticipants(deps.db, cycle.id);
  if (participants.length === 0) return;

  const counts = await countSubmissionsByUser(deps.db, cycle.id);
  const behind = participants
    .map((p) => ({ id: p.user_id, n: counts.get(p.user_id) ?? 0 }))
    .filter((p) => p.n < cycle.goal_count);
  if (behind.length === 0) return;

  await deps.api.sendMessage(cycle.thread_id, {
    content:
      `⏰ **오늘 23:59 마감!**\n` +
      behind.map((p) => `- <@${p.id}>님: 현재 ${p.n}/${cycle.goal_count}개`).join("\n"),
  });
}
```

`src/index.ts` 수정 — import 2줄 추가:

```ts
import { fallbackNotice } from "./jobs/fallback-notice";
import { reminder } from "./jobs/reminder";
```

`scheduled`의 switch에서 기존 `default` 케이스를 아래로 교체:

```ts
        case "0 1 * * 2": // 화 10:00 KST — 안전망 공지
          await fallbackNotice(deps);
          break;
        case "0 1 * * 0": // 일 10:00 KST — 마감 리마인더
          await reminder(deps);
          break;
        default:
          console.log(`알 수 없는 cron: ${event.cron}`);
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test` && `npm run typecheck`
Expected: 전체 PASS

- [ ] **Step 5: 커밋**

```bash
git add src/jobs/fallback-notice.ts src/jobs/reminder.ts src/index.ts test/notice-jobs.test.ts
git commit -m "feat: 안전망 공지·마감 리마인더 잡

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 15: 커맨드 등록 스크립트 + README

**Files:**
- Create: `scripts/register.ts`, `README.md`

**Interfaces:**
- Consumes: 스펙 §5.1 명령 정의, Task 11의 옵션 이름들 (`대상`, `금액`, `사유`, `링크`, `참여자`, `개수`, `벌금`, `주차` — 핸들러의 `getStringOption`/`getIntegerOption` 이름과 정확히 일치해야 한다)
- Produces: `npm run register` — 길드 슬래시 커맨드 일괄 등록(PUT, 즉시 반영), 운영 문서

- [ ] **Step 1: 등록 스크립트 작성**

`scripts/register.ts`:

```ts
// 길드 커맨드 등록: DISCORD_TOKEN=... DISCORD_APPLICATION_ID=... DISCORD_GUILD_ID=... npm run register
const required = ["DISCORD_TOKEN", "DISCORD_APPLICATION_ID", "DISCORD_GUILD_ID"] as const;
for (const name of required) {
  if (!process.env[name]) {
    console.error(`환경변수 ${name}가 필요해요. 예: ${required.map((n) => `${n}=...`).join(" ")} npm run register`);
    process.exit(1);
  }
}

const STRING = 3;
const INTEGER = 4;
const USER = 6;

const commands = [
  {
    name: "목표설정",
    description: "이번 주(또는 다음 주) 글쓰기 목표를 설정해요",
    options: [
      { type: STRING, name: "참여자", description: "참여자 멘션 (예: @하영 @민희)", required: true },
      { type: INTEGER, name: "개수", description: "주당 목표 글 개수 (기본 1)", required: false, min_value: 1 },
      { type: INTEGER, name: "벌금", description: "미달 1개당 벌금, 원 (기본 10000)", required: false, min_value: 0 },
      {
        type: STRING, name: "주차", description: "어느 주의 목표인지 (기본: 이번주)", required: false,
        choices: [
          { name: "이번주", value: "이번주" },
          { name: "다음주", value: "다음주" },
        ],
      },
    ],
  },
  {
    name: "인증",
    description: "쓴 글 링크를 인증해요",
    options: [{ type: STRING, name: "링크", description: "https:// 로 시작하는 글 링크", required: true }],
  },
  { name: "현황", description: "이번 주 진행 현황을 봐요", options: [] },
  { name: "벌금현황", description: "누적 벌금 현황을 봐요", options: [] },
  {
    name: "벌금조정",
    description: "벌금을 수동으로 조정해요 (양수=부과, 음수=삭감)",
    options: [
      { type: USER, name: "대상", description: "조정할 멤버", required: true },
      { type: INTEGER, name: "금액", description: "원 단위, 양수=부과·음수=삭감", required: true },
      { type: STRING, name: "사유", description: "선택 사항", required: false },
    ],
  },
  {
    name: "참여취소",
    description: "이번 주 참여를 취소해요 (인증한 글이 없을 때만)",
    options: [{ type: USER, name: "대상", description: "취소할 멤버 (기본: 본인)", required: false }],
  },
];

const url = `https://discord.com/api/v10/applications/${process.env.DISCORD_APPLICATION_ID}/guilds/${process.env.DISCORD_GUILD_ID}/commands`;
const res = await fetch(url, {
  method: "PUT",
  headers: {
    authorization: `Bot ${process.env.DISCORD_TOKEN}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(commands),
});
if (!res.ok) {
  console.error(`등록 실패: ${res.status}`, await res.text());
  process.exit(1);
}
console.log(`길드 커맨드 ${commands.length}개 등록 완료`);
```

- [ ] **Step 2: 스크립트 동작 확인 (환경변수 없이 → 안내 후 종료)**

Run: `npm run register`
Expected: `환경변수 DISCORD_TOKEN가 필요해요...` 출력 후 exit code 1 (실제 등록은 배포 단계에서 수행)

- [ ] **Step 3: README 작성**

`README.md`:

```markdown
# 글개 봇 (geulgae-bot)

글쓰기 스터디 "글개"의 주간 목표·벌금 관리 디스코드 봇.
Cloudflare Workers(HTTP Interactions) + D1 + Cron Triggers로 무료 운영한다.
설계 문서: `docs/specs/2026-07-20-geulgae-bot-design.md`

## 명령

| 명령 | 설명 |
|---|---|
| `/목표설정 참여자 [개수] [벌금] [주차]` | 주간 목표 생성·갱신 (주차: 이번주/다음주) |
| `/인증 링크` | 글 링크 인증. 스레드 안에서 하면 그 주차로 귀속 |
| `/현황` | 참여자별 진행률과 남은 시간 |
| `/벌금현황` | 누적 벌금 잔액과 총액 |
| `/벌금조정 대상 금액 [사유]` | 벌금 수동 조정 (양수=부과, 음수=삭감) |
| `/참여취소 [대상]` | 참여 취소 (마감 전 + 인증한 글이 없을 때만) |

자동화(KST): 매일 00:05 정산 sweep · 화 10:00 목표 없으면 참여 버튼 공지 · 일 10:00 미달성자 리마인더

## 개발

```bash
npm install
npm test            # vitest + 로컬 D1 (마이그레이션 자동 적용)
npm run typecheck
```

## 최초 배포 절차

1. [Discord Developer Portal](https://discord.com/developers/applications)에서 앱 생성
   - **Bot** 탭: 토큰 발급 (`DISCORD_TOKEN`)
   - **General Information**: `PUBLIC KEY`, `APPLICATION ID` 확보
2. 디스코드에서 개발자 모드를 켜고 서버 ID(`DISCORD_GUILD_ID`)와 인증 채널 ID(`CHANNEL_ID`)를 우클릭 복사
3. D1 생성: `npx wrangler d1 create geulgae-bot-db` → 출력된 `database_id`를 `wrangler.toml`에 반영
4. `wrangler.toml`의 `[vars]` 4개(`REPLACE_ME`)를 실제 값으로 교체
5. 스키마 적용: `npm run migrate:remote`
6. 토큰 시크릿 등록: `npx wrangler secret put DISCORD_TOKEN`
7. 배포: `npm run deploy` → `https://geulgae-bot.<계정>.workers.dev` URL 확보
8. 개발자 포털 **General Information → Interactions Endpoint URL**에 위 URL 등록 (저장 시 Discord가 PING 검증)
9. 커맨드 등록: `DISCORD_TOKEN=... DISCORD_APPLICATION_ID=... DISCORD_GUILD_ID=... npm run register`
10. 봇 초대: **OAuth2 → URL Generator**에서 `bot` 스코프 + 권한
    (View Channels, Send Messages, Create Public Threads, Send Messages in Threads) URL로 초대
11. 기존 봇에서 이월할 벌금이 있으면 `/벌금조정`으로 멤버별 입력

## 운영 메모

- 로그: `npx wrangler tail`
- 정산은 매일 00:05 KST에 "마감 지났고 미정산인 사이클 전부"를 처리한다.
  실행이 실패해도 다음 날 자동으로 따라잡고, 중복 실행돼도 벌금이 이중 부과되지 않는다.
- 링크 접속 확인 실패는 인증에 영향을 주지 않는다 (기록만 남김).
```

- [ ] **Step 4: 전체 검증**

Run: `npm test` && `npm run typecheck`
Expected: 전체 PASS — 이 시점에 스펙의 모든 기능이 구현·테스트된 상태

- [ ] **Step 5: 커밋**

```bash
git add scripts/register.ts README.md
git commit -m "feat: 커맨드 등록 스크립트와 운영 README

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 구현 완료 후 (사람이 하는 일)

코드 작업이 아니므로 태스크에 포함하지 않는다: README의 "최초 배포 절차"를 따라 실제 Discord 앱 생성 → D1 생성 → 배포 → 커맨드 등록 → 봇 초대를 진행하고, 테스트 서버에서 `/목표설정 → /인증 → /현황 → 벌금 흐름`을 수동으로 한 바퀴 확인한다.

## 범위 제외 (스펙 §10 재확인)

이스터에그 명령, 관리자 권한 체계, 콘텐츠 품질 검증, 다중 서버 지원, 에러 알림 채널, GitHub Actions CI — 구현하지 않는다.
