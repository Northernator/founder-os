import { describe, expect, it, vi } from "vitest";

import {
  FrappeAuthError,
  FrappeHttpError,
  FrappeNonLocalHostError,
  createFrappeClient,
  redactAuthHeader,
} from "../src/frappe-client.js";

describe("createFrappeClient host guard", () => {
  it("accepts localhost", () => {
    const client = createFrappeClient({
      siteUrl: "http://localhost:8000",
      apiKey: "k",
      apiSecret: "s",
      fetchImpl: vi.fn() as never,
    });
    expect(client.siteUrl).toBe("http://localhost:8000/");
  });

  it("accepts 127.0.0.1", () => {
    const client = createFrappeClient({
      siteUrl: "http://127.0.0.1:8000",
      apiKey: "k",
      apiSecret: "s",
      fetchImpl: vi.fn() as never,
    });
    expect(client.siteUrl).toBe("http://127.0.0.1:8000/");
  });

  it("accepts host.docker.internal", () => {
    const client = createFrappeClient({
      siteUrl: "http://host.docker.internal:8000",
      apiKey: "k",
      apiSecret: "s",
      fetchImpl: vi.fn() as never,
    });
    expect(client.siteUrl).toBe("http://host.docker.internal:8000/");
  });

  it("rejects an attacker-controlled host BEFORE any socket opens", () => {
    const fetchImpl = vi.fn();
    expect(() =>
      createFrappeClient({
        siteUrl: "http://attacker.example.com/api/method/ping",
        apiKey: "k",
        apiSecret: "s",
        fetchImpl: fetchImpl as never,
      })
    ).toThrow(FrappeNonLocalHostError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an IPv4 that is not 127.0.0.1", () => {
    expect(() =>
      createFrappeClient({
        siteUrl: "http://10.0.0.5:8000",
        apiKey: "k",
        apiSecret: "s",
        fetchImpl: vi.fn() as never,
      })
    ).toThrow(FrappeNonLocalHostError);
  });
});

describe("createFrappeClient auth requirements", () => {
  it("requires apiKey + apiSecret", () => {
    expect(() =>
      createFrappeClient({
        siteUrl: "http://localhost:8000",
        apiKey: "",
        apiSecret: "s",
        fetchImpl: vi.fn() as never,
      })
    ).toThrow(FrappeAuthError);
  });
});

describe("FrappeClient.request", () => {
  it("attaches Authorization + User-Agent + site-name headers", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const client = createFrappeClient({
      siteUrl: "http://localhost:8000",
      apiKey: "abc",
      apiSecret: "xyz",
      clientVersion: "test/0.0.0",
      fetchImpl: fetchImpl as never,
    });
    await client.request({ method: "GET", path: "/api/method/ping" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const callArgs = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const init = callArgs[1];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("token abc:xyz");
    expect(headers["User-Agent"]).toBe("test/0.0.0");
    expect(headers["X-Frappe-Site-Name"]).toBe("localhost");
  });

  it("throws FrappeHttpError on non-2xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const client = createFrappeClient({
      siteUrl: "http://localhost:8000",
      apiKey: "k",
      apiSecret: "s",
      fetchImpl: fetchImpl as never,
    });
    await expect(
      client.request({ method: "GET", path: "/api/method/ping" })
    ).rejects.toBeInstanceOf(FrappeHttpError);
  });

  it("rejects paths that do not start with /api/", async () => {
    const client = createFrappeClient({
      siteUrl: "http://localhost:8000",
      apiKey: "k",
      apiSecret: "s",
      fetchImpl: vi.fn() as never,
    });
    await expect(
      client.request({ method: "GET", path: "/method/ping" })
    ).rejects.toThrow(/must start with "\/api\/"/);
  });
});

describe("redactAuthHeader", () => {
  it("redacts the token value", () => {
    expect(redactAuthHeader("Authorization: token abc:xyz")).toBe(
      "Authorization: token <redacted>"
    );
  });

  it("leaves non-matching strings alone", () => {
    expect(redactAuthHeader("Content-Type: application/json")).toBe(
      "Content-Type: application/json"
    );
  });
});
