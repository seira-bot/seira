"use strict";

/** The stable command of a snap: its mount path changes with every revision, `/snap/bin/<name>` does not. */
function snapCommand({ env = process.env } = {}) {
  const name = env.SNAP_INSTANCE_NAME || env.SNAP_NAME;
  return env.SNAP && name && /^[a-z0-9][a-z0-9_-]*$/.test(name) ? `/snap/bin/${name}` : null;
}

module.exports = { snapCommand };
