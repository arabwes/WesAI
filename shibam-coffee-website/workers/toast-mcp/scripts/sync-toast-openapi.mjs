import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogDirectory = resolve(root, "catalog");

const specifications = {
  cashmgmt: "https://doc.toasttab.com/toast-api-specifications/toast-cashmgmt-api.yaml",
  config: "https://doc.toasttab.com/toast-api-specifications/toast-config-api.yaml",
  labor: "https://doc.toasttab.com/toast-api-specifications/toast-labor-api.yaml",
  orders: "https://doc.toasttab.com/toast-api-specifications/toast-orders-api.yaml",
  "device-details": "https://doc.toasttab.com/toast-api-specifications/device-details-api.yaml",
  kitchen: "https://doc.toasttab.com/toast-api-specifications/toast-kitchen-api-docs.yaml",
  menus: "https://doc.toasttab.com/toast-api-specifications/toast-menus-api.yaml",
  "digital-schedule": "https://doc.toasttab.com/toast-api-specifications/toast-ordermgmt-config-api-docs.yaml",
  packaging: "https://doc.toasttab.com/toast-api-specifications/packaging-api.yaml",
  restaurants: "https://doc.toasttab.com/toast-api-specifications/toast-restaurants-api.yaml",
  stock: "https://doc.toasttab.com/toast-api-specifications/toast-stock-api.yaml",
  availability: "https://doc.toasttab.com/toast-api-specifications/toast-restaurant-availability-api-docs.yaml",
};

// Toast documents these POST endpoints as calculations/searches that do not mutate
// restaurant data. No other POST may enter the generated runtime catalog.
const reviewedReadOnlyPosts = new Set([
  "orders:applicableDiscountsPost",
  "orders:pricesPost",
  "stock:postInventorySearch",
]);

function requiredScope(domain, path, operation) {
  if (domain === "labor") {
    return /employee/i.test(`${path} ${operation.operationId ?? ""}`) ? "labor.employees:read" : "labor:read";
  }
  return {
    cashmgmt: "cashmgmt:read",
    config: "config:read",
    orders: "orders:read",
    "device-details": "device-details.info:read",
    kitchen: "kitchen:read",
    menus: "menus:read",
    "digital-schedule": "digital_schedule:read",
    packaging: "packaging:read",
    restaurants: "restaurants:read",
    stock: "stock:read",
    availability: "restaurants:read",
  }[domain];
}

function dereferenceParameter(document, parameter) {
  if (!parameter?.$ref) return parameter;
  const segments = parameter.$ref.replace(/^#\//u, "").split("/");
  return segments.reduce((value, segment) => value?.[segment.replaceAll("~1", "/").replaceAll("~0", "~")], document);
}

function parameterType(parameter) {
  const schema = parameter?.schema ?? {};
  if (schema.type === "array") return "array";
  if (["integer", "number", "boolean"].includes(schema.type)) return schema.type;
  return "string";
}

function bodyMetadata(document, operation) {
  const bodyParameter = operation.parameters?.map((parameter) => dereferenceParameter(document, parameter)).find((parameter) => parameter?.in === "body");
  const requestBody = operation.requestBody;
  const schema = bodyParameter?.schema ?? requestBody?.content?.["application/json"]?.schema;
  const resolveSchema = (input) => input?.$ref ? dereferenceParameter(document, input) : input;
  const resolved = resolveSchema(schema);
  const requiredProperties = new Set(resolved?.required ?? []);
  for (const component of resolved?.allOf ?? []) for (const name of resolveSchema(component)?.required ?? []) requiredProperties.add(name);
  return {
    requestBody: Boolean(bodyParameter || requestBody),
    bodyRequired: bodyParameter?.required === true || requestBody?.required === true,
    bodyRootType: resolved?.type ?? null,
    bodyRequiredProperties: [...requiredProperties].sort(),
  };
}

function sensitivity(domain, path, operation) {
  const haystack = `${domain} ${path} ${operation.operationId ?? ""} ${operation.summary ?? ""}`.toLowerCase();
  const extraScopes = [];
  if (/guest|customer|email|phone|first.?name|last.?name/u.test(haystack)) extraScopes.push("guest.pi:read");
  if (/delivery|address/u.test(haystack)) extraScopes.push("delivery_info.address:read");
  if (domain === "orders" || (domain === "kitchen" && /fulfillment/u.test(haystack))) {
    return { classification: extraScopes.length ? "pii" : "orders", persistable: false, extraScopes };
  }
  if (domain === "labor") return { classification: "labor", persistable: false, extraScopes };
  if (domain === "cashmgmt") return { classification: "cash", persistable: false, extraScopes };
  if (extraScopes.length) return { classification: "pii", persistable: false, extraScopes };
  return { classification: "operational", persistable: true, extraScopes };
}

function isMenusV2(path) {
  return !/\/menus\/v3(?:\/|$)/u.test(path);
}

function runtimePathFor(document, path) {
  if (typeof document.basePath === "string") return `${document.basePath.replace(/\/$/u, "")}${path}`;
  const serverUrl = document.servers?.[0]?.url;
  if (typeof serverUrl !== "string" || serverUrl.includes("{")) return path;
  try {
    const base = new URL(serverUrl).pathname.replace(/\/$/u, "");
    return `${base}${path}`;
  } catch {
    return path;
  }
}

const locks = {};
const candidates = [];
await mkdir(catalogDirectory, { recursive: true });

for (const [domain, source] of Object.entries(specifications)) {
  const response = await fetch(source, { redirect: "error" });
  if (!response.ok) throw new Error(`Unable to fetch ${source}: HTTP ${response.status}`);
  const text = await response.text();
  const checksum = createHash("sha256").update(text).digest("hex");
  const document = YAML.parse(text);
  locks[domain] = { source, sha256: checksum, title: document.info?.title ?? domain, version: String(document.info?.version ?? "unknown") };

  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const operation = pathItem?.[method];
      if (!operation) continue;
      const sourceOperationId = operation.operationId || `${method}_${path.replace(/[^a-z0-9]+/giu, "_")}`;
      const id = `${domain}_${sourceOperationId}`;
      const runtimePath = runtimePathFor(document, path);
      const scope = requiredScope(domain, runtimePath, operation);
      const reviewedReadOnlyPost = method === "post" && reviewedReadOnlyPosts.has(`${domain}:${sourceOperationId}`);
      const paymentApi = domain === "orders" && /\/payments(?:\/|$)/iu.test(runtimePath);
      const safeGet = method === "get" && !paymentApi && (domain !== "menus" || isMenusV2(runtimePath));
      const safety = sensitivity(domain, runtimePath, operation);
      const body = bodyMetadata(document, operation);
      const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]
        .map((parameter) => dereferenceParameter(document, parameter))
        .filter((parameter) => parameter && ["path", "query"].includes(parameter.in))
        .map((parameter) => ({
          name: parameter.name,
          in: parameter.in,
          required: parameter.in === "path" || parameter.required === true,
          type: parameterType(parameter),
          description: parameter.description ?? "",
        }));
      candidates.push({
        id,
        sourceOperationId,
        domain,
        method: method.toUpperCase(),
        path: runtimePath,
        specificationPath: path,
        description: operation.summary ?? operation.description?.split("\n")[0] ?? id,
        requiredScope: scope,
        additionalScopes: safety.extraScopes,
        sensitivity: safety.classification,
        persistable: safety.persistable,
        parameters,
        ...body,
        pagination: parameters.some((parameter) => /page|limit|offset|cursor/i.test(parameter.name)) ? "parameterized" : "none",
        classification: safeGet || reviewedReadOnlyPost ? "exposed" : "excluded",
        reviewedReadOnlyPost,
        exclusionReason: safeGet || reviewedReadOnlyPost
          ? null
          : paymentApi
            ? "Payment and card APIs are excluded regardless of HTTP method"
            : method !== "get"
              ? "HTTP method is not independently reviewed as non-mutating"
              : "Menus V3 is reserved for ordering integrations",
        source: domain,
      });
    }
  }
}

candidates.sort((left, right) => left.id.localeCompare(right.id) || left.path.localeCompare(right.path));
await writeFile(resolve(catalogDirectory, "spec-lock.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), specifications: locks }, null, 2)}\n`);
await writeFile(resolve(catalogDirectory, "operation-review.json"), `${JSON.stringify(candidates, null, 2)}\n`);
console.log(`Pinned ${Object.keys(locks).length} Toast specifications and reviewed ${candidates.length} operations.`);
