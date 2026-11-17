import { setNickname } from "../db/queries";
import { ephemeral, publicMessage } from "../discord/replies";
import type { Handler } from "../router";
import { getStringOption, interactionUserId } from "../types";

export const NICKNAME_MAX_LENGTH = 20;

// PAGE-002·BOT-002: 서재(홈페이지)에 표시할 이름은 본인만 등록·변경한다.
// 주차와 무관한 전체 설정이므로 벌금 명령과 같은 정책으로 실행한 자리에 공개 응답한다.
export const handleNickname: Handler = async (interaction, deps) => {
  const name = (getStringOption(interaction, "이름") ?? "").trim();
  if (!name) return ephemeral("이름을 입력해주세요.");
  if (name.length > NICKNAME_MAX_LENGTH) {
    return ephemeral(`이름은 ${NICKNAME_MAX_LENGTH}자 이하로 해주세요.`);
  }

  const userId = interactionUserId(interaction);
  await setNickname(deps.db, userId, name, deps.now().toISOString());
  return publicMessage(`📛 <@${userId}>님의 서재 표시 이름을 **${name}**(으)로 등록했어요.`, {
    allowed_mentions: { parse: [] },
  });
};
