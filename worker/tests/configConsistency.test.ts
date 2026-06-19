import { loadConfig, saveConfig } from "../src/api/dashboard";
import { ConfigStore } from "../src/storage/configStore";
import { MockD1 } from "./helpers/mockD1";
import type { SuperDeepSeekConfig } from "../src/types/config";

const BASE: SuperDeepSeekConfig = {
  server: { public_base_url: "https://gw.test" },
  security: { local_api_key: "k" },
  runtime: { mode: "observe" },
  providers: [],
  profiles: [],
  models: [],
  model_aliases: [],
};

function env(): { DB: D1Database } {
  return { DB: new MockD1() as unknown as D1Database };
}

describe("config <-> normalized table consistency", () => {
  it("saveConfig writes providers into provider_profiles", async () => {
    const e = env();
    const cfg: SuperDeepSeekConfig = {
      ...BASE,
      providers: [
        { id: "deepseek", name: "DeepSeek", protocol: "openai", base_url: "https://api.deepseek.com/v1", api_key: "test-provider-aaa11112222" },
      ],
    };
    await saveConfig(e, cfg);

    const store = new ConfigStore(e.DB);
    const providers = await store.listProviderProfiles();
    expect(providers).toHaveLength(1);
    expect(providers[0]?.id).toBe("deepseek");
    expect(providers[0]?.api_key).toBe("test-provider-aaa11112222");
  });

  it("saveConfig deletes normalized providers no longer in the config", async () => {
    const e = env();
    const store = new ConfigStore(e.DB);
    await store.upsertProviderProfile({ id: "old", name: "Old", protocol: "openai", base_url: "https://x/v1" });
    await saveConfig(e, { ...BASE, providers: [] });
    expect(await store.listProviderProfiles()).toHaveLength(0);
  });

  it("loadConfig hydrates providers from provider_profiles (CRUD -> config)", async () => {
    const e = env();
    const store = new ConfigStore(e.DB);
    await store.upsertProviderProfile({ id: "qwen", name: "Qwen", protocol: "openai", base_url: "https://dashscope/v1", api_key: "test-provider-qwen12345678" });
    const cfg = await loadConfig(e);
    expect(cfg.providers).toHaveLength(1);
    expect(cfg.providers[0]?.id).toBe("qwen");
  });

  it("loadConfig hydrates model_aliases from the aliases table", async () => {
    const e = env();
    const store = new ConfigStore(e.DB);
    await store.upsertAlias({
      id: "a1", alias: "claude-3-5-haiku-latest", target_model: "deepseek-chat",
      profile_id: "default", role: "fast_tool", strategy: "round_robin",
    });
    const cfg = await loadConfig(e);
    expect(cfg.model_aliases).toHaveLength(1);
    expect(cfg.model_aliases[0]?.alias).toBe("claude-3-5-haiku-latest");
  });

  it("saveConfig syncs Worker-shape model_aliases (with target_model) into aliases", async () => {
    const e = env();
    await saveConfig(e, {
      ...BASE,
      model_aliases: [
        { alias: "claude-x", profile_id: "default", role: "main", target_model: "deepseek-chat" } as unknown as SuperDeepSeekConfig["model_aliases"][number],
      ],
    });
    const store = new ConfigStore(e.DB);
    const aliases = await store.listAliases();
    expect(aliases.some((a) => a.alias === "claude-x" && a.target_model === "deepseek-chat")).toBe(true);
  });

  it("loadConfig hydrates local_api_key from the SUPERDS_LOCAL_API_KEY secret", async () => {
    const e: { DB: D1Database; SUPERDS_LOCAL_API_KEY?: string } = { DB: new MockD1({ configValue: JSON.stringify(BASE) }) as unknown as D1Database };
    e.SUPERDS_LOCAL_API_KEY = "from-secret";
    const cfg = await loadConfig(e);
    expect(cfg.security?.local_api_key).toBe("from-secret");
  });

  it("CRUD round-trip: upsert provider -> loadConfig reflects it -> overview matches", async () => {
    const e = env();
    const store = new ConfigStore(e.DB);
    await store.upsertProviderProfile({ id: "sf", name: "SiliconFlow", protocol: "openai", base_url: "https://api.siliconflow.cn/v1", api_key: "test-provider-sf99887766" });
    const cfg = await loadConfig(e);
    // The config view and the store agree.
    expect(cfg.providers.map((p) => p.id)).toEqual((await store.listProviderProfiles()).map((p) => p.id));
  });
});
