import { describe, expect, it } from "vitest";
import { normalizeUrl } from "../src/domain/url";

describe("normalizeUrl", () => {
  it("URL이 아니면 거부", () => {
    const r = normalizeUrl("그냥 텍스트");
    expect(r.ok).toBe(false);
  });
  it("http는 거부", () => {
    const r = normalizeUrl("http://example.com/post");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("https");
  });
  it("호스트 소문자화 + 경로 끝 슬래시 제거", () => {
    const r = normalizeUrl("https://Medium.com/@user/my-post/");
    expect(r).toEqual({ ok: true, url: "https://medium.com/@user/my-post" });
  });
  it("트래킹 파라미터와 fragment 제거, 나머지 쿼리는 유지", () => {
    const r = normalizeUrl("https://blog.com/p?utm_source=x&utm_medium=y&id=3&fbclid=abc#section");
    expect(r).toEqual({ ok: true, url: "https://blog.com/p?id=3" });
  });
  it("루트 경로는 슬래시 없이 정규화", () => {
    const r = normalizeUrl("https://example.com/");
    expect(r).toEqual({ ok: true, url: "https://example.com" });
  });
  it("같은 글의 변형 표기는 같은 URL로 수렴 (중복 판정의 근거)", () => {
    const a = normalizeUrl("https://Blog.com/post/?utm_source=discord");
    const b = normalizeUrl("https://blog.com/post");
    expect(a).toEqual(b);
  });
  it("앞뒤 공백은 무시", () => {
    const r = normalizeUrl("  https://blog.com/p  ");
    expect(r).toEqual({ ok: true, url: "https://blog.com/p" });
  });
});
