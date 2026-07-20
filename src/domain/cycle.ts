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
