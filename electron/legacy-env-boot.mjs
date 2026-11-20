import { adoptLegacyEnv } from "./legacy-env.mjs";

adoptLegacyEnv(process.env, (line) => console.warn(line));
