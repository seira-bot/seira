import { z } from "zod";
import { canonicalToolkitSlug, projectAuthConfigs } from "./composio-project.ts";

const brokerListSchema = z.object({ toolkits: z.array(z.string()) });

export type OwnAuthSource =
  | { apiKey: string }
  | { readBroker: () => Promise<Response> }
  | null;

/** Toolkits the project has its own enabled auth config for. A failed read answers none, so cards keep their catalog flag. */
export async function ownAuthToolkits(source: OwnAuthSource): Promise<ReadonlySet<string>> {
  if (!source) return new Set();
  try {
    if ("apiKey" in source) {
      const { choices } = await projectAuthConfigs(source.apiKey);
      return new Set(Object.keys(choices).map(canonicalToolkitSlug));
    }
    const res = await source.readBroker();
    if (!res.ok) return new Set();
    const { toolkits } = brokerListSchema.parse(await res.json());
    return new Set(toolkits.map(canonicalToolkitSlug));
  } catch {
    return new Set();
  }
}
