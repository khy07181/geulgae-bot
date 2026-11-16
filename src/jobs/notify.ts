import type { JobDeps } from "./settle";

// 잡 실패가 아무도 모르게 지나가지 않도록 인증 채널에 남기는 베스트에포트 알림.
// 알림 실패가 원래 흐름을 바꾸면 안 되므로 여기서 모든 예외를 삼킨다.
export async function notifyFailure(deps: JobDeps, content: string): Promise<void> {
  try {
    await deps.api.sendMessage(deps.env.CHANNEL_ID, { content, allowed_mentions: { parse: [] } });
  } catch (err) {
    console.error("실패 알림 전송도 실패:", err);
  }
}

// 에러를 디스코드 코드 스팬(`...`) 안에 넣어도 깨지지 않게 다듬는다.
export function errorNote(err: unknown): string {
  return String(err).replace(/`/g, "'").slice(0, 200);
}
