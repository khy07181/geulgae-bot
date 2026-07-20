import { describe, expect, it } from "vitest";
import { calculateSettlement } from "../src/domain/settlement";

describe("calculateSettlement", () => {
  it("미달 개수 × 단가를 부과하고, 달성자는 결과에서 제외한다", () => {
    const charges = calculateSettlement({
      goalCount: 2,
      penaltyPerPost: 10000,
      participants: [
        { userId: "u1", submissionCount: 0 }, // 2개 미달
        { userId: "u2", submissionCount: 1 }, // 1개 미달
        { userId: "u3", submissionCount: 2 }, // 달성
        { userId: "u4", submissionCount: 5 }, // 초과 달성
      ],
    });
    expect(charges).toEqual([
      { userId: "u1", shortfall: 2, amount: 20000 },
      { userId: "u2", shortfall: 1, amount: 10000 },
    ]);
  });
  it("전원 달성이면 빈 배열", () => {
    expect(
      calculateSettlement({
        goalCount: 1,
        penaltyPerPost: 10000,
        participants: [{ userId: "u1", submissionCount: 1 }],
      })
    ).toEqual([]);
  });
  it("참여자가 없으면 빈 배열", () => {
    expect(
      calculateSettlement({ goalCount: 1, penaltyPerPost: 10000, participants: [] })
    ).toEqual([]);
  });
});
