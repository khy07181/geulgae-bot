import type { CycleRow, PenaltyEntryRow, SubmissionRow } from "../db/queries";
import { recapYearOf } from "./cycle";

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export interface RecapInput {
  year: number;
  cycles: CycleRow[];
  submissions: SubmissionRow[];
  participants: { cycle_id: number; user_id: string }[];
  penalties: PenaltyEntryRow[];
}

export interface MemberRecap {
  userId: string;
  posts: number;
  achievedWeeks: number;
  joinedWeeks: number;
}

export interface Recap {
  year: number;
  weekCount: number;
  postCount: number;
  allAchievedWeekLabels: string[]; // week_start 오름차순
  members: MemberRecap[]; // 글 수 내림차순
  settlementSum: number; // 그 해 귀속 사이클의 자동 정산 부과 합계
  adjustmentSum: number; // 그 해(KST, created_at 기준) 수동 조정 합계
}

// VIS-001·PAGE-005: 연도별 결산 집계. 연도 귀속은 그 주 일요일의 연도.
export function buildRecap(input: RecapInput): Recap {
  const cycles = input.cycles
    .filter((c) => recapYearOf(c.week_start) === input.year)
    .sort((a, b) => (a.week_start < b.week_start ? -1 : 1));
  const cycleIds = new Set(cycles.map((c) => c.id));
  const goalOf = new Map(cycles.map((c) => [c.id, c.goal_count]));

  const submissions = input.submissions.filter((s) => cycleIds.has(s.cycle_id));
  const participants = input.participants.filter((p) => cycleIds.has(p.cycle_id));

  // (cycle, user)별 제출 수
  const countByCycleUser = new Map<string, number>();
  for (const s of submissions) {
    const key = `${s.cycle_id}:${s.user_id}`;
    countByCycleUser.set(key, (countByCycleUser.get(key) ?? 0) + 1);
  }

  const memberMap = new Map<string, MemberRecap>();
  const member = (userId: string): MemberRecap => {
    let m = memberMap.get(userId);
    if (!m) {
      m = { userId, posts: 0, achievedWeeks: 0, joinedWeeks: 0 };
      memberMap.set(userId, m);
    }
    return m;
  };
  for (const s of submissions) member(s.user_id).posts += 1;
  for (const p of participants) {
    const m = member(p.user_id);
    m.joinedWeeks += 1;
    const n = countByCycleUser.get(`${p.cycle_id}:${p.user_id}`) ?? 0;
    if (n >= (goalOf.get(p.cycle_id) ?? 1)) m.achievedWeeks += 1;
  }

  // 전원 달성 주 (참여자가 있는 주만)
  const participantsByCycle = new Map<number, string[]>();
  for (const p of participants) {
    const list = participantsByCycle.get(p.cycle_id) ?? [];
    list.push(p.user_id);
    participantsByCycle.set(p.cycle_id, list);
  }
  const allAchieved = cycles.filter((c) => {
    const ps = participantsByCycle.get(c.id) ?? [];
    return ps.length > 0 && ps.every((u) => (countByCycleUser.get(`${c.id}:${u}`) ?? 0) >= c.goal_count);
  });

  // 벌금: 정산 부과는 사이클 귀속, 수동 조정은 created_at의 KST 연도 귀속
  let settlementSum = 0;
  let adjustmentSum = 0;
  for (const e of input.penalties) {
    if (e.kind === "settlement") {
      if (e.cycle_id !== null && cycleIds.has(e.cycle_id)) settlementSum += e.amount;
    } else if (new Date(new Date(e.created_at).getTime() + KST_OFFSET_MS).getUTCFullYear() === input.year) {
      adjustmentSum += e.amount;
    }
  }

  return {
    year: input.year,
    weekCount: cycles.length,
    postCount: submissions.length,
    allAchievedWeekLabels: allAchieved.map((c) => c.week_start),
    members: [...memberMap.values()].sort((a, b) => b.posts - a.posts || a.userId.localeCompare(b.userId)),
    settlementSum,
    adjustmentSum,
  };
}
