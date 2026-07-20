import { getPenaltyBalance, getPenaltyBalances, insertAdjustment } from "../db/queries";
import { ephemeral, publicMessage } from "../discord/replies";
import type { Handler } from "../router";
import { getIntegerOption, getStringOption, interactionUserId } from "../types";

const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

export const handlePenaltyStatus: Handler = async (_interaction, deps) => {
  const balances = await getPenaltyBalances(deps.db);
  if (balances.length === 0) return publicMessage("쌓인 벌금이 없어요! 🎉");
  const total = balances.reduce((sum, b) => sum + b.balance, 0);
  const lines = balances.map((b) => `- <@${b.user_id}>님: ${won(b.balance)}`);
  return publicMessage(
    `**벌금 현황**\n${lines.join("\n")}\n지금까지 모인 금액: **${won(total)}**`,
    { allowed_mentions: { parse: [] } }
  );
};

export const handlePenaltyAdjust: Handler = async (interaction, deps) => {
  const target = getStringOption(interaction, "대상");
  const amount = getIntegerOption(interaction, "금액");
  if (!target || amount === null) return ephemeral("대상과 금액을 입력해주세요.");
  if (amount === 0) return ephemeral("0원은 조정할 수 없어요.");

  const reason = getStringOption(interaction, "사유");
  await insertAdjustment(deps.db, {
    userId: target,
    amount,
    reason,
    createdBy: `user:${interactionUserId(interaction)}`,
    createdAt: deps.now().toISOString(),
  });
  const balance = await getPenaltyBalance(deps.db, target);
  const sign = amount > 0 ? "+" : "-";
  const reasonNote = reason ? ` (사유: ${reason})` : "";
  return publicMessage(
    `<@${target}>님 벌금 ${sign}${won(Math.abs(amount))} 조정${reasonNote} → 현재 ${won(balance)}`
  );
};
