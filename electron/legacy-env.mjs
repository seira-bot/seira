import { LEGACY_ENV_PREFIX, ENV_PREFIX } from "./legacy-names.mjs";

export const LEGACY_ENV_REMOVAL = "two minor releases after v0.1.182";

/** Security: a filter that refuses `SEIRA_` names must refuse the old `OMB_` ones too, which may still sit in an operator's
 * environment. Names compare in capitals because Windows environments do. */
export function isHarnessEnvName(name) {
  const upper = name.toUpperCase();
  return upper.startsWith(ENV_PREFIX) || upper.startsWith(LEGACY_ENV_PREFIX);
}

const warned = new Set();

/** Moves every `OMB_<name>` onto `SEIRA_<name>` and removes it, so no child inherits the old name. When both are set
 * and differ, `SEIRA_` wins. A warning names the variable once per process and never prints its value. */
export function adoptLegacyEnv(env = process.env, warn) {
  const report = { adopted: [], conflicts: [] };
  const announce = (key, line) => {
    if (warn && !warned.has(key)) { warned.add(key); warn(line); }
  };
  for (const legacy of Object.keys(env)) {
    if (!legacy.toUpperCase().startsWith(LEGACY_ENV_PREFIX)) continue;
    const value = env[legacy];
    delete env[legacy];
    if (value === undefined) continue;
    const current = ENV_PREFIX + legacy.slice(LEGACY_ENV_PREFIX.length).toUpperCase();
    if (env[current] === undefined || (env[current] === "" && value !== "")) {
      env[current] = value;
      report.adopted.push(legacy);
      announce(`adopted:${legacy}`, `${legacy} is deprecated and stops working ${LEGACY_ENV_REMOVAL}; rename it to ${current}.`);
    } else if (env[current] !== value) {
      report.conflicts.push(legacy);
      announce(`conflict:${legacy}`, `Both ${current} and ${legacy} are set to different values; using ${current}. Remove ${legacy}.`);
    } else {
      announce(`duplicate:${legacy}`, `${legacy} is deprecated and stops working ${LEGACY_ENV_REMOVAL}; remove it, ${current} is already set.`);
    }
  }
  return report;
}
