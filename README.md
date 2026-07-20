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
