import { canonicalToolkitSlug, projectAuthConfigs } from "./composio-project.ts";

/** Toolkits the person's own project has an enabled auth config for. A failed read answers none, so cards keep their catalog flag. */
export async function ownAuthToolkits(apiKey: string): Promise<ReadonlySet<string>> {
  try {
    const { choices } = await projectAuthConfigs(apiKey);
    return new Set(Object.keys(choices).map(canonicalToolkitSlug));
  } catch {
    return new Set();
  }
}
