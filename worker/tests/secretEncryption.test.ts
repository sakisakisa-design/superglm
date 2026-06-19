import { describe, expect, it } from "vitest";
import { ConfigStore, SecretDecryptError } from "../src/storage/configStore";
import { MockD1 } from "./helpers/mockD1";

function dbWithProviders(rows: Array<Record<string, unknown>>): D1Database {
  return new MockD1({ providers: rows as never[] }) as unknown as D1Database;
}

describe("ConfigStore secret encryption", () => {
  it("refuses to store a plaintext api_key when requireEncryption is true and ENCRYPTION_KEY is missing", async () => {
    const store = new ConfigStore(dbWithProviders([]), undefined, true);
    await expect(
      store.upsertProviderProfile({
        id: "p", name: "P", protocol: "openai", base_url: "https://x/v1", api_key: "super-secret-12345678",
      }),
    ).rejects.toBeInstanceOf(SecretDecryptError);
  });

  it("stores api_key encrypted when ENCRYPTION_KEY is set", async () => {
    const mock = new MockD1();
    const db = mock as unknown as D1Database;
    const store = new ConfigStore(db, "a".repeat(32));
    await store.upsertProviderProfile({
      id: "p", name: "P", protocol: "openai", base_url: "https://x/v1", api_key: "super-secret-12345678",
    });
    const stored = mock.providers.get("p") as { api_key: string } | undefined;
    expect(stored?.api_key).toMatch(/^enc:/);
    // The plaintext key must not appear in the stored blob.
    expect(stored?.api_key).not.toContain("super-secret-12345678");
  });

  it("throws SecretDecryptError when ENCRYPTION_KEY is missing but stored value is encrypted", async () => {
    // Seed a row that already has an encrypted-looking value.
    const db = dbWithProviders([
      { id: "p", name: "P", protocol: "openai", base_url: "https://x/v1", api_key: "enc:iv.ciphertext" },
    ]);
    const store = new ConfigStore(db); // no key
    await expect(store.getProviderProfile("p")).rejects.toBeInstanceOf(SecretDecryptError);
  });

  it("throws SecretDecryptError (not the ciphertext) when ENCRYPTION_KEY is wrong", async () => {
    const db = dbWithProviders([
      { id: "p", name: "P", protocol: "openai", base_url: "https://x/v1", api_key: "enc:iv.ciphertext" },
    ]);
    const store = new ConfigStore(db, "z".repeat(32));
    await expect(store.getProviderProfile("p")).rejects.toBeInstanceOf(SecretDecryptError);
  });

  it("round-trips a key with the correct ENCRYPTION_KEY", async () => {
    const db = dbWithProviders([]);
    const key = "k".repeat(32);
    const writer = new ConfigStore(db, key);
    await writer.upsertProviderProfile({
      id: "p", name: "P", protocol: "openai", base_url: "https://x/v1", api_key: "plaintext-key-abcdef",
    });
    const reader = new ConfigStore(db, key);
    const got = await reader.getProviderProfile("p");
    expect(got?.api_key).toBe("plaintext-key-abcdef");
  });
});
