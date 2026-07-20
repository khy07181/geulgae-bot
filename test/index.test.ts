import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { makeEnv } from "./helpers";

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function makeKeys() {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { pair, publicKeyHex: toHex(raw) };
}

async function signedRequest(pair: CryptoKeyPair, body: string, tamper = false) {
  const timestamp = "1721000000";
  const data = new TextEncoder().encode(timestamp + body);
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, data));
  if (tamper) sig[0] ^= 0xff;
  return new Request("https://bot.test/", {
    method: "POST",
    headers: { "x-signature-ed25519": toHex(sig), "x-signature-timestamp": timestamp },
    body,
  });
}

describe("index.fetch", () => {
  it("올바른 서명의 PING에 200 {type:1}", async () => {
    const { pair, publicKeyHex } = await makeKeys();
    const env = makeEnv({ DISCORD_PUBLIC_KEY: publicKeyHex });
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      await signedRequest(pair, JSON.stringify({ id: "1", type: 1, token: "t" })),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toEqual({ type: 1 });
  });
  it("잘못된 서명은 401", async () => {
    const { pair, publicKeyHex } = await makeKeys();
    const env = makeEnv({ DISCORD_PUBLIC_KEY: publicKeyHex });
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      await signedRequest(pair, JSON.stringify({ id: "1", type: 1, token: "t" }), true),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });
});
