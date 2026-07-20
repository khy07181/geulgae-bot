export interface SettlementInput {
  goalCount: number;
  penaltyPerPost: number;
  participants: { userId: string; submissionCount: number }[];
}

export interface PenaltyCharge {
  userId: string;
  shortfall: number;
  amount: number;
}

export function calculateSettlement(input: SettlementInput): PenaltyCharge[] {
  return input.participants
    .map((p) => {
      const shortfall = Math.max(0, input.goalCount - p.submissionCount);
      return { userId: p.userId, shortfall, amount: shortfall * input.penaltyPerPost };
    })
    .filter((c) => c.shortfall > 0);
}
