import { fallbackNotice } from "./fallback-notice";
import { errorNote, notifyFailure } from "./notify";
import { reminder } from "./reminder";
import { settleSweep, type JobDeps } from "./settle";

// 키는 wrangler.toml [triggers].crons와 1:1로 일치해야 한다.
const JOBS: Record<string, { label: string; run: (deps: JobDeps) => Promise<void> }> = {
  "1 15 * * *": { label: "정산 sweep", run: settleSweep }, // 매일 00:01 KST
  "0 1 * * TUE": { label: "안전망 공지", run: fallbackNotice }, // 화 10:00 KST
  "0 1 * * SUN": { label: "마감 리마인더", run: reminder }, // 일 10:00 KST
};

export async function runScheduledJob(cron: string, deps: JobDeps): Promise<void> {
  const job = JOBS[cron];
  if (!job) {
    console.log(`알 수 없는 cron: ${cron}`);
    return;
  }
  try {
    await job.run(deps);
  } catch (err) {
    console.error(`cron 잡 실패 (${job.label}):`, err);
    await notifyFailure(deps, `⚠️ 자동 작업 **${job.label}** 실행이 실패했어요.\n\`${errorNote(err)}\``);
    throw err; // Cloudflare 쪽에도 실패로 기록되게 한다
  }
}
