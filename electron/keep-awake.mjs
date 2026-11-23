/** Keep this computer awake applies while something can reach it: the phone link is running without an error, or the
 * person's other computers may open it over Tailscale. */
export function reachableForKeepAwake(state, share) {
  return (state?.enabled === true && !state.error) || share?.on === true;
}

/** Electron's powerSaveBlocker type that keeps the system from idle sleep and lets the display turn off. */
export const COMPANION_BLOCKER = "prevent-app-suspension";

/**
 * The Phone link's keep-awake. It holds this computer awake only while it is wanted and the computer is on power, and it
 * writes one log line each time the hold starts or ends. `blocker`: Electron's powerSaveBlocker. `isOnBattery()`:
 * powerMonitor's word; an error reads as on power. `log(line)`.
 */
export function createCompanionAwakeHold({ blocker, isOnBattery, log = () => {} }) {
  let wanted = false;
  let blockerId = null;
  const battery = () => { try { return isOnBattery() === true; } catch { return false; } };

  function look() {
    const onBattery = battery();
    const hold = wanted && !onBattery;
    if (hold && blockerId === null) {
      blockerId = blocker.start(COMPANION_BLOCKER);
      log("phone link: holding this computer awake while it is on power");
    } else if (!hold && blockerId !== null) {
      if (blocker.isStarted(blockerId)) blocker.stop(blockerId);
      blockerId = null;
      log(`phone link: released the awake hold (${wanted ? "on battery" : "off"})`);
    }
  }

  return {
    want(on) { wanted = on === true; look(); },
    look,
    holding: () => blockerId !== null,
    watch(powerMonitor) { for (const event of ["on-ac", "on-battery"]) { try { powerMonitor?.on(event, look); } catch {} } },
  };
}
