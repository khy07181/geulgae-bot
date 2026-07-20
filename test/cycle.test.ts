import { describe, expect, it } from "vitest";
import {
  deadlineOf,
  formatRemaining,
  isPastDeadline,
  nextWeekStartOf,
  weekLabel,
  weekStartOf,
} from "../src/domain/cycle";

// 기준: 2026-07-20은 월요일(KST). KST = UTC+9이므로
// KST 2026-07-20 00:00:00 == UTC 2026-07-19T15:00:00Z

describe("weekStartOf", () => {
  it("KST 월요일 0시 정각은 그 날이 주 시작", () => {
    expect(weekStartOf(new Date("2026-07-19T15:00:00Z"))).toBe("2026-07-20");
  });
  it("직전 1초는 이전 주(일요일 23:59:59 KST)", () => {
    expect(weekStartOf(new Date("2026-07-19T14:59:59Z"))).toBe("2026-07-13");
  });
  it("주 중간(수요일 낮)도 같은 월요일", () => {
    expect(weekStartOf(new Date("2026-07-22T03:00:00Z"))).toBe("2026-07-20");
  });
  it("월말·월초 경계를 넘는 주도 정확하다", () => {
    // 2026-08-01(토) KST 낮 → 그 주 월요일은 2026-07-27
    expect(weekStartOf(new Date("2026-08-01T03:00:00Z"))).toBe("2026-07-27");
  });
});

describe("nextWeekStartOf", () => {
  it("다음 주 월요일을 돌려준다", () => {
    expect(nextWeekStartOf(new Date("2026-07-22T03:00:00Z"))).toBe("2026-07-27");
  });
});

describe("마감 판정", () => {
  it("deadlineOf는 KST 다음 주 월요일 0시의 UTC 순간", () => {
    expect(deadlineOf("2026-07-13").toISOString()).toBe("2026-07-19T15:00:00.000Z");
  });
  it("일요일 23:59:59 KST는 마감 전", () => {
    expect(isPastDeadline("2026-07-13", new Date("2026-07-19T14:59:59Z"))).toBe(false);
  });
  it("월요일 00:00:00 KST부터 마감", () => {
    expect(isPastDeadline("2026-07-13", new Date("2026-07-19T15:00:00Z"))).toBe(true);
  });
});

describe("weekLabel", () => {
  it("월요일 날짜 기준 n주차", () => {
    expect(weekLabel("2026-07-20")).toBe("7월 3주차"); // ceil(20/7) = 3
    expect(weekLabel("2026-07-06")).toBe("7월 1주차"); // ceil(6/7) = 1
  });
});

describe("formatRemaining", () => {
  it("일 단위가 남으면 '일 시간'", () => {
    // 마감(2026-07-19T15:00Z)까지 2일 5시간 전
    expect(formatRemaining("2026-07-13", new Date("2026-07-17T10:00:00Z"))).toBe("2일 5시간");
  });
  it("한 시간 미만이면 '분'", () => {
    expect(formatRemaining("2026-07-13", new Date("2026-07-19T14:15:00Z"))).toBe("45분");
  });
  it("마감 후에는 '마감됨'", () => {
    expect(formatRemaining("2026-07-13", new Date("2026-07-19T15:00:00Z"))).toBe("마감됨");
  });
});
