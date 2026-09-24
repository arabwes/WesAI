export function clientMetadataIsSafe(metadata: Record<string, unknown>): boolean {
  if (metadata.software_statement !== undefined) return false;
  if (typeof metadata.client_name === "string" && metadata.client_name.length > 100) return false;
  if (Array.isArray(metadata.redirect_uris) && metadata.redirect_uris.length > 10) return false;
  if (Array.isArray(metadata.contacts) && metadata.contacts.length > 5) return false;
  for (const field of ["client_uri", "logo_uri", "tos_uri", "policy_uri"]) {
    const value = metadata[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > 500) return false;
    try {
      if (new URL(value).protocol !== "https:") return false;
    } catch {
      return false;
    }
  }
  return true;
}
