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

// VIS-001·PAGE-004: 서재 페이지용 전체 조회
export async function listAllCycles(db: D1Database): Promise<CycleRow[]> {
  const { results } = await db.prepare("SELECT * FROM cycles ORDER BY week_start DESC").all<CycleRow>();
  return results;
}

export interface SubmissionRow {
  id: number;
  cycle_id: number;
  user_id: string;
  url: string;
  fetch_title: string | null;
  submitted_at: string;
}

export async function listAllSubmissions(db: D1Database): Promise<SubmissionRow[]> {
  const { results } = await db
    .prepare("SELECT id, cycle_id, user_id, url, fetch_title, submitted_at FROM submissions ORDER BY submitted_at")
    .all<SubmissionRow>();
  return results;
}

export async function listAllParticipants(db: D1Database): Promise<{ cycle_id: number; user_id: string }[]> {
  const { results } = await db
    .prepare("SELECT cycle_id, user_id FROM participants")
    .all<{ cycle_id: number; user_id: string }>();
  return results;
}

export interface PenaltyEntryRow {
  user_id: string;
  amount: number;
  kind: string;
  cycle_id: number | null;
  created_at: string;
}

export async function listAllPenaltyEntries(db: D1Database): Promise<PenaltyEntryRow[]> {
  const { results } = await db
    .prepare("SELECT user_id, amount, kind, cycle_id, created_at FROM penalty_entries")
    .all<PenaltyEntryRow>();
  return results;
}

export async function countDistinctParticipants(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(DISTINCT user_id) AS n FROM participants")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// PAGE-002: 홈페이지 작성자 표기용 닉네임 (본인 등록, BOT-002)
export async function setNickname(db: D1Database, userId: string, name: string, updatedAt: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO nicknames (user_id, name, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`
    )
    .bind(userId, name, updatedAt)
    .run();
}

export async function getNicknames(db: D1Database): Promise<Map<string, string>> {
  const { results } = await db
    .prepare("SELECT user_id, name FROM nicknames")
    .all<{ user_id: string; name: string }>();
  return new Map(results.map((r) => [r.user_id, r.name]));
}

// PAGE-008·PAGE-012: 결산 키워드. 본문은 저장하지 않고 추출된 키워드만 남긴다.
export async function insertKeywords(
  db: D1Database,
  submissionId: number,
  keywords: string[],
  createdAt: string
): Promise<void> {
  if (keywords.length === 0) return;
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO keywords (submission_id, keyword, created_at) VALUES (?, ?, ?)"
  );
  await db.batch(keywords.map((k) => stmt.bind(submissionId, k, createdAt)));
}

// PAGE-013: 소급 배치용 — 키워드가 없는 제출을 id 커서 순서로 가져온다.
export async function listSubmissionsMissingKeywords(
  db: D1Database,
  afterId: number,
  limit: number
): Promise<{ id: number; url: string; fetch_title: string | null }[]> {
  const { results } = await db
    .prepare(
      `SELECT s.id, s.url, s.fetch_title FROM submissions s
       WHERE s.id > ? AND NOT EXISTS (SELECT 1 FROM keywords k WHERE k.submission_id = s.id)
       ORDER BY s.id LIMIT ?`
    )
    .bind(afterId, limit)
    .all<{ id: number; url: string; fetch_title: string | null }>();
  return results;
}

export async function listAllKeywords(
  db: D1Database
): Promise<{ submission_id: number; keyword: string }[]> {
  const { results } = await db
    .prepare("SELECT submission_id, keyword FROM keywords")
    .all<{ submission_id: number; keyword: string }>();
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
