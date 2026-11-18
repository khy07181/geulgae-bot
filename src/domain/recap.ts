import type { CycleRow, PenaltyEntryRow, SubmissionRow } from "../db/queries";
import { recapYearOf, weekLabel } from "./cycle";

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function kst(iso: string): Date {
  return new Date(new Date(iso).getTime() + KST_OFFSET_MS);
}

function kstDateLabel(iso: string): string {
  const d = kst(iso);
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일`;
}

function weekAfter(weekStart: string): string {
  const [y, m, d] = weekStart.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 7)).toISOString().slice(0, 10);
}

export interface RecapInput {
  year: number;
  cycles: CycleRow[];
  submissions: SubmissionRow[];
  participants: { cycle_id: number; user_id: string }[];
  penalties: PenaltyEntryRow[];
  keywords?: { submission_id: number; keyword: string }[];
}

export interface MemberRecap {
  userId: string;
  posts: number;
  achievedWeeks: number;
  joinedWeeks: number;
  longestStreak: number; // 최장 연속 달성 주 (PAGE-009)
}

export interface PostRef {
  title: string; // fetch_title 또는 URL
  userId: string;
  dateLabel: string; // KST "1월 5일"
}

// PAGE-009: 올해의 기록 카드 재료
export interface RecapRecords {
  firstPost: PostRef;
  lastPost: PostRef | null; // 글이 1편이면 null (첫 글과 같음)
  busiestMonth: { month: number; count: number } | null;
  longestAllAchievedRun: { length: number; startLabel: string; endLabel: string } | null;
}

export interface Recap {
  year: number;
  weekCount: number;
  postCount: number;
  allAchievedWeekLabels: string[]; // week_start 오름차순
  members: MemberRecap[]; // 글 수 내림차순
  monthlyPosts: number[]; // 1~12월 발행 수 (제출 시각의 KST 월 기준, PAGE-009)
  keywords: { keyword: string; count: number }[]; // 빈도 내림차순 (PAGE-008)
  records: RecapRecords | null; // 글이 없으면 null
  settlementSum: number; // 그 해 귀속 사이클의 자동 정산 부과 합계
  adjustmentSum: number; // 그 해(KST, created_at 기준) 수동 조정 합계
}

// VIS-001·PAGE-005·PAGE-009: 연도별 결산 집계. 연도 귀속은 그 주 일요일의 연도.
export function buildRecap(input: RecapInput): Recap {
  const cycles = input.cycles
    .filter((c) => recapYearOf(c.week_start) === input.year)
    .sort((a, b) => (a.week_start < b.week_start ? -1 : 1));
  const cycleIds = new Set(cycles.map((c) => c.id));
  const goalOf = new Map(cycles.map((c) => [c.id, c.goal_count]));

  const submissions = input.submissions
    .filter((s) => cycleIds.has(s.cycle_id))
    .sort((a, b) => (a.submitted_at < b.submitted_at ? -1 : 1));
  const participants = input.participants.filter((p) => cycleIds.has(p.cycle_id));

  // (cycle, user)별 제출 수
  const countByCycleUser = new Map<string, number>();
  for (const s of submissions) {
    const key = `${s.cycle_id}:${s.user_id}`;
    countByCycleUser.set(key, (countByCycleUser.get(key) ?? 0) + 1);
  }
  const achieved = (cycleId: number, userId: string): boolean =>
    (countByCycleUser.get(`${cycleId}:${userId}`) ?? 0) >= (goalOf.get(cycleId) ?? 1);

  const memberMap = new Map<string, MemberRecap>();
  const member = (userId: string): MemberRecap => {
    let m = memberMap.get(userId);
    if (!m) {
      m = { userId, posts: 0, achievedWeeks: 0, joinedWeeks: 0, longestStreak: 0 };
      memberMap.set(userId, m);
    }
    return m;
  };
  for (const s of submissions) member(s.user_id).posts += 1;
  const joined = new Set(participants.map((p) => `${p.cycle_id}:${p.user_id}`));
  for (const p of participants) {
    const m = member(p.user_id);
    m.joinedWeeks += 1;
    if (achieved(p.cycle_id, p.user_id)) m.achievedWeeks += 1;
  }

  // 멤버별 최장 연속 달성 주 (PAGE-009): 달력상 연속(정확히 7일 간격)인 주만 잇는다.
  // 미참여·미달성은 물론, 사이클이 생성되지 않은 주(갭)도 연속을 끊는다.
  for (const m of memberMap.values()) {
    let run = 0;
    for (let i = 0; i < cycles.length; i++) {
      const c = cycles[i];
      if (!(joined.has(`${c.id}:${m.userId}`) && achieved(c.id, m.userId))) {
        run = 0;
        continue;
      }
      const contiguous = run > 0 && weekAfter(cycles[i - 1].week_start) === c.week_start;
      run = contiguous ? run + 1 : 1;
      if (run > m.longestStreak) m.longestStreak = run;
    }
  }

  // 전원 달성 주 (참여자가 있는 주만)
  const participantsByCycle = new Map<number, string[]>();
  for (const p of participants) {
    const list = participantsByCycle.get(p.cycle_id) ?? [];
    list.push(p.user_id);
    participantsByCycle.set(p.cycle_id, list);
  }
  const isAllAchieved = (c: CycleRow): boolean => {
    const ps = participantsByCycle.get(c.id) ?? [];
    return ps.length > 0 && ps.every((u) => achieved(c.id, u));
  };
  const allAchieved = cycles.filter(isAllAchieved);

  // 월별 발행 추이: 제출 시각의 KST 월 기준 (PAGE-009)
  const monthlyPosts = Array.from({ length: 12 }, () => 0);
  for (const s of submissions) monthlyPosts[kst(s.submitted_at).getUTCMonth()] += 1;

  // 키워드 빈도 (PAGE-008)
  const submissionIds = new Set(submissions.map((s) => s.id));
  const kwCount = new Map<string, number>();
  for (const k of input.keywords ?? []) {
    if (!submissionIds.has(k.submission_id)) continue;
    kwCount.set(k.keyword, (kwCount.get(k.keyword) ?? 0) + 1);
  }
  const keywords = [...kwCount.entries()]
    .map(([keyword, count]) => ({ keyword, count }))
    .sort((a, b) => b.count - a.count || a.keyword.localeCompare(b.keyword, "ko"));

  // 올해의 기록 (PAGE-009)
  let records: RecapRecords | null = null;
  if (submissions.length > 0) {
    const ref = (s: SubmissionRow): PostRef => ({
      title: s.fetch_title?.trim() || s.url,
      userId: s.user_id,
      dateLabel: kstDateLabel(s.submitted_at),
    });
    const first = submissions[0];
    const last = submissions[submissions.length - 1];

    let busiestMonth: { month: number; count: number } | null = null;
    for (let i = 0; i < 12; i++) {
      if (monthlyPosts[i] > (busiestMonth?.count ?? 0)) busiestMonth = { month: i + 1, count: monthlyPosts[i] };
    }

    // 가장 긴 전원 달성 연속: 멤버 스트릭과 같은 기준(달력상 7일 간격)으로 잇는다.
    let longestAllAchievedRun: RecapRecords["longestAllAchievedRun"] = null;
    let runStart = -1;
    for (let i = 0; i < cycles.length; i++) {
      const c = cycles[i];
      if (!isAllAchieved(c)) {
        runStart = -1;
        continue;
      }
      const contiguous = runStart >= 0 && weekAfter(cycles[i - 1].week_start) === c.week_start;
      if (!contiguous) runStart = i;
      const len = i - runStart + 1;
      if (len > (longestAllAchievedRun?.length ?? 0)) {
        longestAllAchievedRun = {
          length: len,
          startLabel: weekLabel(cycles[runStart].week_start),
          endLabel: weekLabel(c.week_start),
        };
      }
    }

    records = {
      firstPost: ref(first),
      lastPost: last.id !== first.id ? ref(last) : null,
      busiestMonth,
      longestAllAchievedRun,
    };
  }

  // 벌금: 정산 부과는 사이클 귀속, 수동 조정은 created_at의 KST 연도 귀속
  let settlementSum = 0;
  let adjustmentSum = 0;
  for (const e of input.penalties) {
    if (e.kind === "settlement") {
      if (e.cycle_id !== null && cycleIds.has(e.cycle_id)) settlementSum += e.amount;
    } else if (kst(e.created_at).getUTCFullYear() === input.year) {
      adjustmentSum += e.amount;
    }
  }

  return {
    year: input.year,
    weekCount: cycles.length,
    postCount: submissions.length,
    allAchievedWeekLabels: allAchieved.map((c) => c.week_start),
    members: [...memberMap.values()].sort((a, b) => b.posts - a.posts || a.userId.localeCompare(b.userId)),
    monthlyPosts,
    keywords,
    records,
    settlementSum,
    adjustmentSum,
  };
}
