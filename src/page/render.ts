import type { CycleRow, SubmissionRow } from "../db/queries";
import { weekLabel } from "../domain/cycle";
import type { Recap } from "../domain/recap";

export interface ArchiveData {
  cycles: CycleRow[]; // week_start 내림차순
  submissions: SubmissionRow[]; // submitted_at 오름차순
  nicknames: Map<string, string>;
  writerCount: number;
}

export function escapeHtml(s: string): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return s.replace(/[&<>"']/g, (c) => map[c]);
}

// PAGE-002·BOT-003: 닉네임 미등록자는 익명 라벨로 표시한다.
// 라벨은 제출 시간순 첫 등장 순서로 배정해 아카이브·결산에서 같은 사람이 같은 라벨을 받는다.
export function displayNames(userIdsInOrder: string[], nicknames: Map<string, string>): Map<string, string> {
  const names = new Map<string, string>();
  let anon = 0;
  for (const id of userIdsInOrder) {
    if (names.has(id)) continue;
    names.set(id, nicknames.get(id) ?? `익명 ${String.fromCharCode(65 + (anon++ % 26))}`);
  }
  return names;
}

// PAGE-010: 모던 미니멀 — 밝은 배경, 흰 카드, Pretendard, 인디고 포인트 (docs/mockups 미니멀 테마 기준)
const STYLE = `
  :root {
    --bg:#fafafa; --ink:#111113; --ink2:#55555e; --ink3:#9d9da8;
    --accent:#4f46e5; --rule:#e8e8ec; --card:#ffffff; --card-bd:#e8e8ec;
    --track:#eeeef2; --radius:14px;
    --shadow:0 1px 2px rgba(0,0,0,.04), 0 4px 16px rgba(0,0,0,.05);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font-family: "Pretendard Variable", Pretendard, system-ui, sans-serif;
    line-height: 1.65; -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 46rem; margin: 0 auto; padding: 3.5rem 1.25rem 6rem; }
  a { color: inherit; text-decoration: none; }
  .kicker {
    font-size: .7rem; font-weight: 700; letter-spacing: .34em;
    text-transform: uppercase; color: var(--accent); margin: 0 0 1rem;
  }
  h1 {
    font-weight: 800; font-size: clamp(2.2rem, 7vw, 3rem);
    line-height: 1.15; letter-spacing: -.02em; margin: 0 0 .6rem;
  }
  h1 .en { color: var(--accent); }
  .stats { font-size: .9rem; color: var(--ink2); margin: 0 0 1rem; }
  .stats b { color: var(--ink); font-weight: 700; }
  .lede { font-size: .95rem; color: var(--ink2); margin: .6rem 0 1.6rem; max-width: 36rem; }

  .year-head { display: flex; align-items: baseline; justify-content: space-between; margin: 2.8rem 0 .4rem; }
  .year-head h2 { font-size: 1.9rem; font-weight: 800; letter-spacing: -.01em; margin: 0; }
  .recap-link { font-size: .85rem; font-weight: 600; color: var(--accent); }
  .recap-link:hover { text-decoration: underline; }
  h3.month { font-size: .75rem; font-weight: 700; letter-spacing: .2em; color: var(--ink3); margin: 1.9rem 0 .7rem; }

  .week {
    display: grid; grid-template-columns: 8.5rem 1fr; gap: 1rem;
    background: var(--card); border: 1px solid var(--card-bd); border-radius: var(--radius);
    box-shadow: var(--shadow); padding: 1.1rem 1.3rem; margin-bottom: .8rem;
  }
  .week .wk { font-weight: 700; font-size: .95rem; display: block; }
  .week .meta { font-size: .74rem; color: var(--ink3); display: block; margin-top: .3rem; line-height: 1.5; }
  ul.entries { list-style: none; margin: 0; padding: 0; }
  ul.entries li { display: flex; align-items: baseline; justify-content: space-between; gap: .8em; margin: .4rem 0; }
  .entry-t { font-weight: 500; font-size: .95rem; min-width: 0; overflow-wrap: anywhere; }
  a.entry-t:hover { color: var(--accent); }
  .by { font-size: .78rem; color: var(--ink2); white-space: nowrap; }
  .empty { color: var(--ink3); font-size: .85rem; }

  section { margin-top: 3rem; }
  .sec-head { display: flex; align-items: baseline; gap: .8rem; margin-bottom: 1.1rem; }
  .sec-no { font-weight: 700; color: var(--accent); font-size: .85rem; }
  .sec-head h2 { font-size: 1.3rem; font-weight: 800; letter-spacing: -.01em; margin: 0; }
  .sec-rule { flex: 1; border-bottom: 1px solid var(--rule); transform: translateY(-5px); }

  .stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: .7rem; margin-top: 1.6rem; }
  .stat {
    background: var(--card); border: 1px solid var(--card-bd); border-radius: var(--radius);
    box-shadow: var(--shadow); padding: 1.05rem 1.15rem;
  }
  .s-v { font-weight: 800; font-size: 1.9rem; line-height: 1; margin: 0; letter-spacing: -.01em; }
  .s-v small { font-size: .95rem; font-weight: 600; margin-left: .06em; }
  .s-k { font-size: .74rem; color: var(--ink3); margin: .45rem 0 0; }

  .member-row {
    display: grid; grid-template-columns: 4rem 1fr 2.4rem auto;
    gap: .9rem; align-items: center; margin: .8rem 0;
  }
  .m-name { font-weight: 600; font-size: .92rem; }
  .m-track { background: var(--track); height: 12px; border-radius: 0 6px 6px 0; }
  .m-bar { height: 100%; width: var(--v); background: var(--accent); border-radius: 0 6px 6px 0; min-width: 6px; }
  .m-val { font-weight: 700; font-size: .9rem; text-align: right; font-variant-numeric: tabular-nums; }
  .m-streak { font-size: .74rem; color: var(--ink3); white-space: nowrap; }
  .m-streak b { color: var(--accent); font-weight: 700; }

  .months {
    display: grid; grid-template-columns: repeat(12, 1fr); gap: 6px;
    align-items: end; height: 150px; padding-top: 1.3rem;
  }
  .mo { display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; gap: 5px; }
  .mo i { display: block; width: 100%; max-width: 26px; height: calc(var(--h) * 1%); background: var(--accent); border-radius: 4px 4px 0 0; }
  .mo:hover i { opacity: .75; }
  .mo.zero i { height: 2px; background: var(--rule); border-radius: 0; }
  .mo-v { font-size: .72rem; font-weight: 700; color: var(--ink2); opacity: 0; font-variant-numeric: tabular-nums; }
  .mo:hover .mo-v, .mo.max .mo-v { opacity: 1; }
  .mo-l { font-size: .64rem; color: var(--ink3); }
  .months-base { border-top: 1px solid var(--rule); margin-top: 6px; }

  .keywords { display: flex; flex-wrap: wrap; gap: .55rem .65rem; align-items: baseline; }
  .kw {
    background: var(--card); border: 1px solid var(--card-bd); border-radius: 99px;
    padding: .32em .9em; line-height: 1.3; box-shadow: var(--shadow);
  }
  .kw sup { font-size: .62em; color: var(--ink3); margin-left: .4em; font-weight: 700; }
  .kw.s3 { font-size: 1.15rem; font-weight: 700; }
  .kw.s2 { font-size: .98rem; font-weight: 600; }
  .kw.s1 { font-size: .85rem; color: var(--ink2); }

  .records { display: grid; grid-template-columns: 1fr 1fr; gap: .8rem; }
  .rec {
    background: var(--card); border: 1px solid var(--card-bd); border-radius: var(--radius);
    box-shadow: var(--shadow); padding: 1.1rem 1.2rem 1rem;
  }
  .rec-k { font-size: .68rem; font-weight: 700; letter-spacing: .16em; color: var(--accent); margin: 0 0 .5rem; text-transform: uppercase; }
  .rec-v { font-weight: 700; font-size: 1.02rem; margin: 0; line-height: 1.45; overflow-wrap: anywhere; }
  .rec-m { font-size: .76rem; color: var(--ink3); margin: .4rem 0 0; }

  table { border-collapse: collapse; margin: 1rem 0; }
  th, td { border: 1px solid var(--rule); padding: .45rem .9rem; text-align: center; background: var(--card); }
  th:first-child, td:first-child { text-align: left; }

  .closing { margin-top: 3rem; border-top: 1px solid var(--rule); padding-top: 1.4rem; }
  .cl-row { display: grid; grid-template-columns: 6.5rem 1fr; gap: 1rem; margin: .6rem 0; font-size: .92rem; }
  .cl-k { font-size: .7rem; font-weight: 700; letter-spacing: .14em; color: var(--ink3); text-transform: uppercase; padding-top: .3rem; }
  .cl-v b { font-weight: 700; }

  .foot {
    margin-top: 3.5rem; padding-top: 1.1rem; border-top: 1px solid var(--rule);
    font-size: .75rem; color: var(--ink3);
    display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap;
  }
  .back { font-size: .85rem; font-weight: 600; color: var(--ink2); }
  .back:hover { color: var(--accent); }

  @media (max-width: 580px) {
    .wrap { padding-top: 2.5rem; }
    .week { grid-template-columns: 1fr; gap: .4rem; }
    .stats-row { grid-template-columns: 1fr 1fr; }
    .records { grid-template-columns: 1fr; }
    .member-row { grid-template-columns: 3.4rem 1fr 2.2rem; }
    .m-streak { grid-column: 2 / -1; margin-top: -4px; }
    .mo-l { visibility: hidden; }
    .mo:nth-child(odd) .mo-l { visibility: visible; }
  }
`;

// PAGE-001: 비밀 경로 페이지 — 검색엔진 수집 금지, Discord 숫자 ID는 절대 출력하지 않는다.
// PAGE-007: 웹폰트는 CDN 로드. no-referrer로 비밀 경로가 Referer로 새지 않게 한다.
export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
${body}
</div>
</body>
</html>
`;
}

function weekRange(weekStart: string): string {
  const [y, m, d] = weekStart.split("-").map(Number);
  const end = new Date(Date.UTC(y, m - 1, d + 6));
  const mm = (n: number) => String(n).padStart(2, "0");
  return `${mm(m)}.${mm(d)} – ${mm(end.getUTCMonth() + 1)}.${mm(end.getUTCDate())}`;
}

// VIS-001·PAGE-004·PAGE-006: 아카이브 — 전체 통계 + 연·월로 묶은 주차별 인증 글 목록
export function renderArchive(d: ArchiveData): string {
  const names = displayNames(d.submissions.map((s) => s.user_id), d.nicknames);
  const byCycle = new Map<number, SubmissionRow[]>();
  for (const s of d.submissions) {
    const list = byCycle.get(s.cycle_id) ?? [];
    list.push(s);
    byCycle.set(s.cycle_id, list);
  }

  let out = `<header>
<p class="kicker">Geulgae · Weekly Writing Club</p>
<h1>글개 <span class="en">Archive</span></h1>
<p class="stats"><b>글 ${d.submissions.length}편</b> · ${d.cycles.length}주차 · 참여 ${d.writerCount}명</p>
</header>\n`;
  let curYear = "";
  let curMonth = "";
  for (const cycle of d.cycles) {
    const [y, m] = cycle.week_start.split("-");
    if (y !== curYear) {
      curYear = y;
      curMonth = "";
      // 연도 결산으로 가는 상대 링크 — 아카이브는 항상 /s/<토큰>/ (트레일링 슬래시)에서 서빙된다 (PAGE-004)
      out += `<div class="year-head"><h2>${y}</h2><a class="recap-link" href="${y}">${y} 결산 보기 →</a></div>\n`;
    }
    if (m !== curMonth) {
      curMonth = m;
      out += `<h3 class="month">${Number(m)}월</h3>\n`;
    }
    const subs = byCycle.get(cycle.id) ?? [];
    const items =
      subs.length === 0
        ? `<p class="empty">인증 글 없음</p>`
        : `<ul class="entries">\n${subs
            .map((s) => {
              const title = s.fetch_title?.trim() || s.url;
              return `<li><a class="entry-t" href="${escapeHtml(s.url)}">${escapeHtml(title)}</a><span class="by">${escapeHtml(names.get(s.user_id) ?? "익명")}</span></li>`;
            })
            .join("\n")}\n</ul>`;
    out += `<div class="week"><div class="week-side"><span class="wk">${escapeHtml(weekLabel(cycle.week_start))}</span><span class="meta">${weekRange(cycle.week_start)}<br>목표 주 ${cycle.goal_count}편</span></div>
${items}
</div>\n`;
  }
  out += `<footer class="foot"><span>글개 Archive — 멤버 전용 비공개 페이지</span><span>검색 노출 안 함</span></footer>`;
  return layout("글개 Archive", out);
}

// VIS-001·PAGE-004·PAGE-005: 연도별 결산 뷰. 연중에 열면 진행 현황판으로 동작한다.
// (T-006에서 PAGE-009 구성으로 확장 예정)
export function renderRecap(recap: Recap, names: Map<string, string>): string {
  const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
  let out = `<header>
<p class="kicker">Geulgae · Year in Review</p>
<h1>${recap.year} 글개 결산</h1>
</header>\n`;
  if (recap.weekCount === 0) {
    out += `<p class="empty" style="margin-top:1.5rem">이 해의 기록이 없어요.</p>\n<footer class="foot"><a class="back" href="./">← 글개 Archive</a></footer>\n`;
    return layout(`${recap.year} 글개 결산`, out);
  }
  out += `<p class="stats">글 ${recap.postCount}편 · ${recap.weekCount}주차 · 전원 달성 ${recap.allAchievedWeekLabels.length}주</p>\n`;
  out += `<table><thead><tr><th>이름</th><th>글</th><th>달성 주</th><th>참여 주</th></tr></thead><tbody>\n`;
  for (const m of recap.members) {
    out += `<tr><td>${escapeHtml(names.get(m.userId) ?? "익명")}</td><td>${m.posts}</td><td>${m.achievedWeeks}</td><td>${m.joinedWeeks}</td></tr>\n`;
  }
  out += `</tbody></table>\n`;
  if (recap.allAchievedWeekLabels.length > 0) {
    out += `<p>🎉 전원 달성: ${recap.allAchievedWeekLabels.map((w) => escapeHtml(weekLabel(w))).join(", ")}</p>\n`;
  }
  out += `<p>⚖️ 벌금 — 정산 부과 ${won(recap.settlementSum)} · 수동 조정 ${won(recap.adjustmentSum)}</p>\n`;
  out += `<footer class="foot"><a class="back" href="./">← 글개 Archive</a><span>멤버 전용 비공개 페이지</span></footer>\n`;
  return layout(`${recap.year} 글개 결산`, out);
}
