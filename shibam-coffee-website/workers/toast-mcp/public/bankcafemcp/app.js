const BASE = "/bankcafemcp";
const state = { data: null, csrf: "" };
const $ = (selector) => document.querySelector(selector);

function notice(message, error = false) {
  const element = $("#notice");
  element.textContent = message;
  element.classList.remove("hidden");
  element.classList.toggle("error", error);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  if (state.csrf) headers.set("X-CSRF-Token", state.csrf);
  const response = await fetch(`${BASE}${path}`, { ...options, headers, credentials: "same-origin" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Request failed (${response.status})`);
  return data;
}

function item(title, detail) {
  const row = document.createElement("div");
  row.className = "item";
  const content = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = String(title ?? "");
  const small = document.createElement("div");
  small.className = "fine";
  small.textContent = String(detail ?? "");
  content.append(strong, small);
  row.append(content);
  return row;
}

function button(label, onClick, className = "secondary") {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  element.addEventListener("click", onClick);
  return element;
}

function renderConnection(connection) {
  const title = connection.institution_name ? `${connection.label} · ${connection.institution_name}` : connection.label;
  const verified = connection.last_verified_at ? `verified ${new Date(connection.last_verified_at).toLocaleString()}` : "not yet verified";
  const row = item(title, `${connection.environment} · ${connection.status} · ${verified}`);
  row.classList.add("connection");

  if (connection.status !== "active") {
    const warning = document.createElement("p");
    warning.className = "warning";
    warning.textContent = connection.last_error_code === "BANK_RELINK_REQUIRED"
      ? "Needs attention: the bank requires you to re-authorize this connection in Plaid, then connect again with the new access token."
      : "Needs attention: Plaid rejected the stored credentials. Rotate the Plaid secret below or reconnect.";
    row.append(warning);
  }

  const accounts = document.createElement("ul");
  accounts.className = "accounts";
  for (const account of connection.accounts ?? []) {
    const entry = document.createElement("li");
    const mask = account.mask ? ` ••••${account.mask}` : "";
    const kind = [account.subtype || account.type, account.currency].filter(Boolean).join(" · ");
    entry.textContent = `${account.name}${mask}${kind ? ` — ${kind}` : ""}`;
    accounts.append(entry);
  }
  if (!accounts.children.length) {
    const empty = document.createElement("li");
    empty.textContent = "No accounts returned by Plaid.";
    accounts.append(empty);
  }
  row.append(accounts);

  const controls = document.createElement("div");
  controls.className = "actions";
  const secret = document.createElement("input");
  secret.type = "password";
  secret.autocomplete = "new-password";
  secret.placeholder = "New Plaid secret";
  secret.setAttribute("aria-label", "New Plaid secret");
  controls.append(
    button("Refresh accounts", () => mutate(`/api/connections/${connection.id}/refresh`, { method: "POST", body: "{}" })),
    secret,
    button("Rotate secret", async () => {
      if (await mutate(`/api/connections/${connection.id}/rotate`, { method: "POST", body: JSON.stringify({ clientSecret: secret.value }) })) secret.value = "";
    }),
    button("Disconnect", () => {
      if (confirm("Disconnect this bank? The Plaid access token is revoked at Plaid and deleted here.")) {
        void mutate(`/api/connections/${connection.id}`, { method: "DELETE" });
      }
    }, "danger"),
  );
  row.append(controls);
  return row;
}

function render(data) {
  state.data = data;
  state.csrf = data.csrfToken;
  $("#signed-out").classList.add("hidden");
  $("#workspace").classList.remove("hidden");
  $("#user-name").textContent = data.user.displayName || data.user.email;
  $("#user-email").textContent = data.user.email;
  $("#organization-name").textContent = data.organization ? data.organization.name : "No organization";
  $("#logout-csrf").value = state.csrf;
  $("#endpoint").textContent = data.mcpEndpoint;

  const owner = data.organization?.role === "owner";
  $("#mode-disabled").classList.toggle("hidden", data.bankMode);
  $("#not-owner").classList.toggle("hidden", owner || !data.organization);
  $("#owner-tools").classList.toggle("hidden", !owner);

  const toggle = $("#enabled-toggle");
  toggle.checked = Boolean(data.bankEnabled);
  toggle.disabled = !owner || !data.bankMode;
  for (const control of $("#connection-form").elements) control.disabled = !data.bankMode;

  $("#connections").replaceChildren(...((data.connections ?? []).length
    ? data.connections.map(renderConnection)
    : [document.createTextNode("No banks connected.")]));

  $("#grants").replaceChildren(...((data.grants ?? []).length ? data.grants.map((grant) => {
    const row = item(grant.clientName, (grant.scope || []).join(", "));
    row.append(button("Revoke", () => {
      if (confirm("Revoke this MCP client's bank access now?")) {
        void mutate(`/api/grants/${encodeURIComponent(grant.id)}/revoke`, { method: "POST", body: "{}" });
      }
    }));
    return row;
  }) : [document.createTextNode("No MCP clients are authorized for bank data.")]));
}

async function load() {
  try {
    render(await api("/api/me"));
  } catch (error) {
    if (!String(error.message).includes("Sign in")) notice(error.message, true);
  }
}

async function mutate(path, options) {
  try {
    await api(path, options);
    notice("Saved.");
    render(await api("/api/me"));
    return true;
  } catch (error) {
    notice(error.message, true);
    if (state.data) render(state.data);
    return false;
  }
}

$("#enabled-toggle").addEventListener("change", (event) => {
  void mutate("/api/settings", { method: "POST", body: JSON.stringify({ enabled: event.target.checked }) });
});

$("#connection-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const submit = formElement.querySelector("button[type=submit]");
  submit.disabled = true;
  submit.textContent = "Verifying with Plaid…";
  const ok = await mutate("/api/connections", {
    method: "POST",
    body: JSON.stringify({
      label: form.get("label"),
      environment: form.get("environment"),
      clientId: form.get("clientId"),
      clientSecret: form.get("clientSecret"),
      accessToken: form.get("accessToken"),
    }),
  });
  formElement.elements.clientSecret.value = "";
  formElement.elements.accessToken.value = "";
  if (ok) formElement.reset();
  submit.disabled = false;
  submit.textContent = "Verify and connect";
});

load();
