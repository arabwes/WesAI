const state = { data: null, csrf: "" };
const $ = (selector) => document.querySelector(selector);
const escapeText = (value) => String(value ?? "");
const toastScopes = ["cashmgmt:read","config:read","delivery_info.address:read","device-details.info:read","digital_schedule:read","guest.pi:read","kitchen:read","labor.employees:read","labor:read","menus:read","orders:read","packaging:read","restaurants:read","stock:read"];

function notice(message, error = false) {
  const element = $("#notice");
  element.textContent = message;
  element.classList.remove("hidden");
  element.style.borderColor = error ? "var(--danger)" : "var(--coffee)";
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  if (state.csrf) headers.set("X-CSRF-Token", state.csrf);
  const response = await fetch(`/toast-mcp${path}`, { ...options, headers, credentials: "same-origin" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Request failed (${response.status})`);
  return data;
}

function render(data) {
  state.data = data; state.csrf = data.csrfToken;
  $("#signed-out").classList.add("hidden"); $("#workspace").classList.remove("hidden");
  $("#user-name").textContent = data.user.displayName || data.user.email;
  $("#user-email").textContent = data.user.email; $("#logout-csrf").value = state.csrf;
  const organizationSelect = $("#organization-select"); organizationSelect.replaceChildren();
  for (const organization of data.organizations) {
    const option = document.createElement("option"); option.value = organization.id; option.textContent = organization.name; option.selected = organization.id === data.activeOrganizationId; organizationSelect.append(option);
  }
  const active = data.organizations.find((organization) => organization.id === data.activeOrganizationId);
  const owner = active?.role === "owner";
  $("#claim-code").textContent = active?.externalGroupRef || "—";
  $("#locations").replaceChildren(...(data.locations.length ? data.locations.map((location) => {
    const row = item(`${location.location_name || location.restaurant_name}`, `${location.id} · ${location.status}${location.migration_pending ? " · partner switch needs owner confirmation" : ""}`);
    if (owner && location.migration_pending) { const confirm = document.createElement("button"); confirm.className = "secondary"; confirm.textContent = "Confirm partner switch"; confirm.addEventListener("click", () => mutate(`/api/locations/${location.id}/confirm-partner`, { method:"POST", body:"{}" })); row.append(confirm); }
    return row;
  }) : [document.createTextNode("No connected locations.")]));
  $("#grants").replaceChildren(...(data.grants.length ? data.grants.map((grant) => {
    const row = item(grant.metadata?.clientName || grant.clientId, (grant.scope || []).join(", "));
    const button = document.createElement("button"); button.className = "secondary"; button.textContent = "Revoke";
    button.addEventListener("click", () => { if (confirm("Revoke this MCP client grant now?")) void mutate(`/api/grants/${encodeURIComponent(grant.id)}/revoke`, { method: "POST", body: "{}" }); });
    row.append(button); return row;
  }) : [document.createTextNode("No active MCP client grants.")]));
  $("#owner-tools").classList.toggle("hidden", !owner);
  if (!owner) return;
  for (const control of $("#connection-form").elements) control.disabled = !data.byoMode;
  if (!data.byoMode) $("#connection-form").title = "Disabled until Toast credential-use terms are confirmed";
  $("#sensitive-toggle").checked = Boolean(active.sensitivePiiEnabled);
  const scopeSelect = $("#scope-select"); scopeSelect.replaceChildren(...toastScopes.map((scope) => { const option = document.createElement("option"); option.value = scope; option.textContent = scope; option.selected = data.enabledToastScopes.includes(scope); return option; }));
  $("#connections").replaceChildren(...data.connections.map((connection) => {
    const row = item(connection.label, `${connection.kind} · ${connection.environment} · ${connection.status} · ${connection.location_count} locations`);
    const controls = document.createElement("div"); controls.className = "actions";
    if (connection.kind === "byo") {
      const secret = document.createElement("input"); secret.type = "password"; secret.autocomplete = "new-password"; secret.placeholder = "New secret"; secret.setAttribute("aria-label", "New client secret");
      const rotate = document.createElement("button"); rotate.className = "secondary"; rotate.textContent = connection.status === "active" ? "Rotate" : "Reconnect"; rotate.addEventListener("click", () => mutate(`/api/connections/${connection.id}/rotate`, { method:"POST", body:JSON.stringify({ clientSecret:secret.value }) })); controls.append(secret, rotate);
    }
    const disconnect = document.createElement("button"); disconnect.className = "secondary"; disconnect.textContent = connection.kind === "partner" ? "Disconnect partner access" : "Disconnect"; disconnect.addEventListener("click", () => { if (confirm("Disconnect this Toast connection?")) void mutate(`/api/connections/${connection.id}`, { method: "DELETE" }); });
    controls.append(disconnect);
    if (connection.kind === "byo") { const remove = document.createElement("button"); remove.className = "secondary"; remove.textContent = "Delete credential"; remove.addEventListener("click", () => { if (confirm("Permanently delete this stored Toast credential?")) void mutate(`/api/connections/${connection.id}?permanent=true`, { method: "DELETE" }); }); controls.append(remove); }
    row.append(controls); return row;
  }));
  $("#members").replaceChildren(...data.members.map((member) => {
    const row = item(member.email, `${member.role} · ${member.status}`);
    if (member.role !== "member" || member.status !== "active") return row;
    const editor = document.createElement("div"); editor.className = "member-editor";
    const locationLabel = document.createElement("label"); locationLabel.textContent = "Location IDs";
    const locationInput = document.createElement("input"); locationInput.value = (member.locationIds || []).join(","); locationLabel.append(locationInput);
    const scopeLabel = document.createElement("label"); scopeLabel.textContent = "OAuth scopes";
    const scopeInput = document.createElement("input"); scopeInput.value = (member.scopes || []).join(","); scopeLabel.append(scopeInput);
    const actions = document.createElement("div"); actions.className = "actions";
    const save = document.createElement("button"); save.className = "secondary"; save.textContent = "Save access";
    save.addEventListener("click", () => void mutate(`/api/members/${member.id}/permissions`, { method: "PUT", body: JSON.stringify({ locationIds: csv(locationInput.value), scopes: csv(scopeInput.value) }) }));
    const revoke = document.createElement("button"); revoke.className = "secondary"; revoke.textContent = "Revoke member";
    revoke.addEventListener("click", () => { if (confirm(`Revoke ${member.email} and all of their organization-bound MCP grants?`)) void mutate(`/api/members/${member.id}/revoke`, { method: "POST", body: "{}" }); });
    const transfer = document.createElement("button"); transfer.className = "secondary"; transfer.textContent = "Make owner";
    transfer.addEventListener("click", () => { if (confirm(`Transfer ownership to ${member.email}? You will become a member.`)) void mutate("/api/organization/transfer-ownership", { method: "POST", body: JSON.stringify({ membershipId: member.id }) }); });
    actions.append(save, revoke, transfer); editor.append(locationLabel, scopeLabel, actions); row.append(editor); return row;
  }));
}

function item(title, detail) { const row = document.createElement("div"); row.className = "item"; const content = document.createElement("div"); const strong = document.createElement("strong"); strong.textContent = escapeText(title); const small = document.createElement("div"); small.className = "fine"; small.textContent = escapeText(detail); content.append(strong, small); row.append(content); return row; }
function csv(value) { return String(value).split(",").map((item) => item.trim()).filter(Boolean); }
async function load() { try { render(await api("/api/me")); const invite = new URLSearchParams(location.search).get("invite"); if (invite && await mutate("/api/invitations/accept", { method:"POST", body:JSON.stringify({ token:invite }) })) history.replaceState({}, "", "/toast-mcp/"); } catch (error) { if (!String(error.message).includes("Sign in")) notice(error.message, true); } }
async function mutate(path, options) { try { await api(path, options); notice("Saved."); render(await api("/api/me")); return true; } catch (error) { notice(error.message, true); return false; } }

$("#organization-select").addEventListener("change", (event) => mutate("/api/organizations/active", { method:"POST", body:JSON.stringify({ organizationId:event.target.value }) }));
$("#sensitive-toggle").addEventListener("change", (event) => mutate("/api/scopes/sensitive", { method:"POST", body:JSON.stringify({ enabled:event.target.checked }) }));
$("#save-scopes").addEventListener("click", () => mutate("/api/scopes", { method:"PUT", body:JSON.stringify({ scopes:[...$("#scope-select").selectedOptions].map((option) => option.value) }) }));
$("#connection-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); if (await mutate("/api/connections", { method:"POST", body:JSON.stringify({ label:form.get("label"), environment:form.get("environment"), clientId:form.get("clientId"), clientSecret:form.get("clientSecret"), restaurantGuids:String(form.get("restaurantGuids")).split(/\s+/).filter(Boolean) }) })) event.currentTarget.reset(); });
$("#invite-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); if (await mutate("/api/invitations", { method:"POST", body:JSON.stringify({ email:form.get("email"), locationIds:csv(form.get("locationIds")), scopes:csv(form.get("scopes")) }) })) event.currentTarget.reset(); });
$("#delete-organization").addEventListener("click", async () => { const active = state.data?.organizations.find((organization) => organization.id === state.data.activeOrganizationId); if (!active) return; const confirmation = prompt(`Type the organization ID ${active.id} to permanently delete ${active.name}.`); if (confirmation !== active.id) { notice("Organization deletion was cancelled.", true); return; } if (await mutate("/api/organization", { method:"DELETE", body:JSON.stringify({ confirmation }) })) location.assign("/toast-mcp/"); });
const invitation = new URLSearchParams(location.search).get("invite");
if (invitation) $("#signed-out a").href = `/toast-mcp/auth/login?returnTo=${encodeURIComponent(`/toast-mcp/?invite=${invitation}`)}`;
load();
