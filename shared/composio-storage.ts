// The hosts Composio hands out file upload links on: its own storage (storage.composio.dev in its API reference) and the
// AWS S3 storage behind it (its upload answer names `storage_backend: "s3"`). A file's bytes are put only to one of
// these, over HTTPS, so a link pointing anywhere else (this computer, a private address, another site) is never used.
const S3_SERVICE_LABEL = /^s3(?:-[a-z0-9-]+)?$/;
const S3_PREFIX = /^[a-z0-9][a-z0-9.-]*$/;
const S3_REGION_LABEL = /^[a-z0-9-]+$/;
const MAX_HOST_LENGTH = 253;

function s3Host(host: string): boolean {
  const suffix = ".amazonaws.com";
  if (!host.endsWith(suffix)) return false;
  const labels = host.slice(0, -suffix.length).split(".");
  for (let service = 0; service < labels.length; service += 1) {
    if (!S3_SERVICE_LABEL.test(labels[service]!)) continue;
    if (service > 0 && !S3_PREFIX.test(labels.slice(0, service).join("."))) continue;
    if (labels.slice(service + 1).every((label) => S3_REGION_LABEL.test(label))) return true;
  }
  return false;
}

export function composioStorageHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host.length > MAX_HOST_LENGTH) return false;
  return host === "composio.dev" || host.endsWith(".composio.dev") || s3Host(host);
}

/** The link as a URL when it is HTTPS on Composio's storage, else null. */
export function composioUploadLink(link: string | undefined): URL | null {
  if (!link) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  return composioStorageHost(url.hostname) ? url : null;
}
