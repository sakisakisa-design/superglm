// Dashboard auth helper + 401-handling regression tests.
// These exercise the web client (web/src/auth.ts, web/src/api.ts) in a Node env by
// stubbing a minimal window/sessionStorage/localStorage and fetch.

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

interface WindowStub {
  sessionStorage: MemoryStorage;
  localStorage: MemoryStorage;
}

let win: WindowStub;
let fetchMock: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

beforeEach(() => {
  win = { sessionStorage: new MemoryStorage(), localStorage: new MemoryStorage() };
  // The web modules reference `window` at call time, so expose it on globalThis.
  (globalThis as unknown as { window: WindowStub }).window = win;
  fetchMock = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  (globalThis as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

afterEach(() => {
  delete (globalThis as unknown as { window?: WindowStub }).window;
  delete (globalThis as unknown as { fetch?: typeof fetchMock }).fetch;
});

describe("web auth header helper", () => {
  it("authHeaders is empty when no key is stored", async () => {
    const { authHeaders } = await import("../web/src/auth");
    expect(authHeaders()).toEqual({});
  });

  it("setKey stores in sessionStorage by default and authHeaders sends Bearer", async () => {
    const { setKey, authHeaders, getKey, hasKey } = await import("../web/src/auth");
    setKey("my-secret", false);
    expect(win.sessionStorage.getItem("superds_admin_key")).toBe("my-secret");
    expect(win.localStorage.getItem("superds_admin_key_remember")).toBeNull();
    expect(hasKey()).toBe(true);
    expect(getKey()).toBe("my-secret");
    expect(authHeaders()).toEqual({ authorization: "Bearer my-secret" });
  });

  it("remember=true persists to localStorage", async () => {
    const { setKey } = await import("../web/src/auth");
    setKey("remembered", true);
    expect(win.localStorage.getItem("superds_admin_key")).toBe("remembered");
    expect(win.localStorage.getItem("superds_admin_key_remember")).toBe("1");
  });

  it("forgetKey clears both stores", async () => {
    const { setKey, forgetKey, hasKey } = await import("../web/src/auth");
    setKey("x", false);
    setKey("y", true);
    forgetKey();
    expect(hasKey()).toBe(false);
    expect(win.sessionStorage.getItem("superds_admin_key")).toBeNull();
    expect(win.localStorage.getItem("superds_admin_key")).toBeNull();
    expect(win.localStorage.getItem("superds_admin_key_remember")).toBeNull();
  });

  it("setKey trims whitespace", async () => {
    const { setKey, getKey } = await import("../web/src/auth");
    setKey("  spaced  ", false);
    expect(getKey()).toBe("spaced");
  });
});

describe("web api 401 handling", () => {
  it("getJson throws AuthError and forgets the key on 401", async () => {
    const { setKey } = await import("../web/src/auth");
    setKey("will-be-rejected", false);
    (globalThis as unknown as { fetch: typeof fetchMock }).fetch = async () =>
      new Response("nope", { status: 401 });

    // api.ts is a module that captures authHeaders/forgetKey/AuthError at import time.
    // Re-import it fresh so it picks up the stubbed window.
    vi.resetModules();
    const { api, AuthError } = await import("../web/src/api");
    const { hasKey } = await import("../web/src/auth");

    await expect(api.overview()).rejects.toBeInstanceOf(AuthError);
    expect(hasKey()).toBe(false);
  });

  it("health stays unauthenticated (no auth header required)", async () => {
    let capturedHeaders: Record<string, string> = {};
    (globalThis as unknown as { fetch: typeof fetchMock }).fetch = async (_input, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ ok: true, service: "s", time: "t" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    vi.resetModules();
    const { api } = await import("../web/src/api");
    const res = await api.health();
    expect(res.ok).toBe(true);
    expect(capturedHeaders.authorization).toBeUndefined();
  });

  it("protected calls send the Bearer header", async () => {
    const { setKey } = await import("../web/src/auth");
    setKey("abc", false);
    let capturedHeaders: Record<string, string> = {};
    (globalThis as unknown as { fetch: typeof fetchMock }).fetch = async (_input, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ providers: [] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    vi.resetModules();
    const { api } = await import("../web/src/api");
    await api.listProviders();
    expect(capturedHeaders.authorization).toBe("Bearer abc");
  });
});
