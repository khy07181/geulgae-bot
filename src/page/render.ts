import type { CycleRow, SubmissionRow } from "../db/queries";
import { weekLabel } from "../domain/cycle";
import type { Recap } from "../domain/recap";

export interface LibraryData {
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
// 라벨 형식("익명 A", 첫 등장 순서)은 구현 임시값 — 보고 후 확정.
export function displayNames(userIdsInOrder: string[], nicknames: Map<string, string>): Map<string, string> {
  const names = new Map<string, string>();
  let anon = 0;
  for (const id of userIdsInOrder) {
    if (names.has(id)) continue;
    names.set(id, nicknames.get(id) ?? `익명 ${String.fromCharCode(65 + (anon++ % 26))}`);
  }
  return names;
}

const STYLE = `
  body { font-family: system-ui, sans-serif; max-width: 42rem; margin: 0 auto; padding: 2rem 1rem 4rem; color: #1a1a1a; }
  h1 { margin-bottom: 0.25rem; }
  .stats { color: #666; margin-bottom: 2rem; }
  h2 { border-bottom: 2px solid #1a1a1a; padding-bottom: 0.25rem; margin-top: 2.5rem; }
  h3 { color: #444; margin-top: 1.5rem; }
  .week { margin: 0.75rem 0 1rem; }
  .week-label { font-weight: 600; }
  .week-meta { color: #888; font-size: 0.85rem; margin-left: 0.4rem; }
  ul { margin: 0.4rem 0 0; padding-left: 1.2rem; }
  li { margin: 0.25rem 0; }
  a { color: #0b57d0; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .author { color: #666; font-size: 0.9rem; }
  .empty { color: #aaa; font-size: 0.9rem; }
  table { border-collapse: collapse; margin: 1rem 0; }
  th, td { border: 1px solid #ddd; padding: 0.4rem 0.8rem; text-align: center; }
  th:first-child, td:first-child { text-align: left; }
`;

// PAGE-001: 비밀 경로 페이지 — 검색엔진 수집 금지, Discord 숫자 ID는 절대 출력하지 않는다.
export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

// VIS-001·PAGE-004·PAGE-005: 연도별 결산 뷰. 연중에 열면 진행 현황판으로 동작한다.
export function renderRecap(recap: Recap, names: Map<string, string>): string {
  const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
  let out = `<h1>🏁 ${recap.year} 글개 결산</h1>\n`;
  if (recap.weekCount === 0) {
    out += `<p class="empty">이 해의 기록이 없어요.</p>\n<p><a href="./">← 서재로</a></p>\n`;
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
  out += `<p><a href="./">← 서재로</a></p>\n`;
  return layout(`${recap.year} 글개 결산`, out);
}

// VIS-001·PAGE-004: 서재 — 전체 통계 + 연·월로 묶은 주차별 인증 글 목록
export function renderLibrary(d: LibraryData): string {
  const names = displayNames(d.submissions.map((s) => s.user_id), d.nicknames);
  const byCycle = new Map<number, SubmissionRow[]>();
  for (const s of d.submissions) {
    const list = byCycle.get(s.cycle_id) ?? [];
    list.push(s);
    byCycle.set(s.cycle_id, list);
  }

  let out = `<h1>📚 글개 서재</h1>\n<p class="stats">글 ${d.submissions.length}편 · ${d.cycles.length}주차 · 참여 ${d.writerCount}명</p>\n`;
  let curYear = "";
  let curMonth = "";
  for (const cycle of d.cycles) {
    const [y, m] = cycle.week_start.split("-");
    if (y !== curYear) {
      curYear = y;
      curMonth = "";
      // 연도 결산으로 가는 상대 링크 — 서재는 항상 /s/<토큰>/ (트레일링 슬래시)에서 서빙된다 (PAGE-004)
      out += `<h2><a href="${y}">${y}년</a> <span class="week-meta">결산 보기 →</span></h2>\n`;
    }
    if (m !== curMonth) {
      curMonth = m;
      out += `<h3>${Number(m)}월</h3>\n`;
    }
    const subs = byCycle.get(cycle.id) ?? [];
    const items =
      subs.length === 0
        ? `<p class="empty">인증 글 없음</p>`
        : `<ul>\n${subs
            .map((s) => {
              const title = s.fetch_title?.trim() || s.url;
              return `<li><a href="${escapeHtml(s.url)}">${escapeHtml(title)}</a> <span class="author">— ${escapeHtml(names.get(s.user_id) ?? "익명")}</span></li>`;
            })
            .join("\n")}\n</ul>`;
    out += `<div class="week"><span class="week-label">${escapeHtml(weekLabel(cycle.week_start))}</span><span class="week-meta">${cycle.week_start} 시작 · 목표 주 ${cycle.goal_count}개</span>\n${items}\n</div>\n`;
  }
  return layout("글개 서재", out);
}
