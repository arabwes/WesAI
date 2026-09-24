import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("isolated Cloudflare deployment contract", () => {
  it("routes only the Toast and BankCafeMCP path families and keeps launch gates closed", async () => {
    const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8")) as {
      routes: Array<{ pattern: string }>;
      vars: Record<string, string>;
      d1_databases: Array<{ binding: string; database_name: string }>;
      kv_namespaces: Array<{ binding: string }>;
      queues: { producers: Array<{ queue: string }> };
    };
    expect(config.routes.map((route) => route.pattern)).toEqual([
      "shibamatlanta.com/toast-mcp*",
      "shibamatlanta.com/.well-known/oauth-protected-resource/toast-mcp*",
      "shibamatlanta.com/.well-known/oauth-authorization-server/toast-mcp*",
      "shibamatlanta.com/bankcafemcp*",
      "shibamatlanta.com/.well-known/oauth-protected-resource/bankcafemcp*",
      "shibamatlanta.com/.well-known/oauth-authorization-server/bankcafemcp*",
    ]);
    expect(config.d1_databases).toContainEqual(expect.objectContaining({ binding: "TOAST_MCP_DB", database_name: "cafe-mcp-db" }));
    expect(config.d1_databases.some((database) => database.binding === "TEAM_DB")).toBe(false);
    expect(config.queues.producers[0]?.queue).toBe("cafe-mcp-jobs");
    expect(config.vars.TOAST_BYO_MODE).toBe("enabled");
    expect(config.vars.TOAST_PARTNER_MODE).toBe("disabled");
    expect(config.vars.BANK_MODE).toBe("disabled");
    expect(config.vars.BANK_BASE_PATH).toBe("/bankcafemcp");
    expect(config.kv_namespaces.map((namespace) => namespace.binding)).toEqual(["OAUTH_KV", "BANK_OAUTH_KV"]);
  });

  it("ships no-index pages and self-service revocation/deletion controls", async () => {
    const [html, script] = await Promise.all([
      readFile(new URL("../public/toast-mcp/index.html", import.meta.url), "utf8"),
      readFile(new URL("../public/toast-mcp/app.js", import.meta.url), "utf8"),
    ]);
    expect(html).toContain('name="robots" content="noindex,nofollow,noarchive"');
    expect(html).toContain('id="delete-organization"');
    expect(html).toContain('id="grants"');
    expect(script).toContain("/permissions");
    expect(script).toContain("/revoke");
    const bankHtml = await readFile(new URL("../public/bankcafemcp/index.html", import.meta.url), "utf8");
    expect(bankHtml).toContain('name="robots" content="noindex,nofollow,noarchive"');
    expect(bankHtml).not.toMatch(/<script(?![^>]*\ssrc=)/u);
  });

  it("uses only redirect modes supported by the Workers runtime", async () => {
    const sourceFiles = [
      "../src/auth0.ts",
      "../src/index.ts",
      "../src/partner.ts",
      "../src/toast/client.ts",
      "../src/toast/credential-broker.ts",
      "../src/bank/plaid.ts",
    ];
    const sources = await Promise.all(
      sourceFiles.map((file) => readFile(new URL(file, import.meta.url), "utf8")),
    );
    expect(sources.join("\n")).not.toContain('redirect: "error"');
  });
});
