import type { Deps } from "../router";
import type { Interaction } from "../types";

// "조용한 처리" 패턴: deferredEphemeral()로 응답해둔 인터랙션을 마무리한다.
// work가 성공하면 원본("생각 중...")을 삭제해 실행자에게 아무 흔적도 남기지 않고,
// 실패하면 원본을 failureNote로 편집해 피드백을 남긴다.
export async function settleDeferred(
  deps: Deps,
  interaction: Interaction,
  work: () => Promise<void>,
  failureNote: string
): Promise<void> {
  try {
    await work();
    await deps.api.deleteOriginalResponse(deps.env.DISCORD_APPLICATION_ID, interaction.token);
  } catch (err) {
    console.error("백그라운드 처리 실패:", err);
    try {
      await deps.api.editOriginalResponse(deps.env.DISCORD_APPLICATION_ID, interaction.token, failureNote);
    } catch (editErr) {
      console.error("원본 응답 편집 실패:", editErr);
    }
  }
}
