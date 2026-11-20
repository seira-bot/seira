import { workspacePreparationDockerfile } from "./container-workspace.ts";

export const CUA_DRIVER_VERSION = "0.37.0";
export const BASE_IMAGE_REPOSITORY = "docker.io/trycua/xfce-cua";
// Official multi-architecture Cua XFCE 0.1.0 manifest (amd64 + arm64).
export const BASE_IMAGE_DIGEST = "sha256:274eb636f5cf3fc58f705916ee72b7a701270b3877369d08533a385c5325be9b";
export const BASE_IMAGE = `${BASE_IMAGE_REPOSITORY}@${BASE_IMAGE_DIGEST}`;
// localhost/ is explicit: Podman prepends it to unqualified build tags and may then resolve the name on Docker Hub.
// Image and container labels, not this mutable tag, decide compatibility.
export const IMAGE_REPOSITORY = "localhost/seira/cua-local-vm";
export const IMAGE_LAYER_VERSION = "9";
export const IMAGE_LAYER_LABEL = "com.seira.image-layer";
export const IMAGE = `${IMAGE_REPOSITORY}:driver-${CUA_DRIVER_VERSION}-v${IMAGE_LAYER_VERSION}`;
export const SEIRA_IMAGE = `localhost/seira/cua-local-vm:driver-${CUA_DRIVER_VERSION}-v${IMAGE_LAYER_VERSION}`;
export const MANAGED_LABEL = "com.seira.local-vm";
export const DRIVER_LABEL = "com.seira.cua-driver";
export const BASE_IMAGE_LABEL = "com.seira.cua-base";
const GUEST_HOME = "/home/cua";
export const VM_WORKSPACE_GUEST = `${GUEST_HOME}/workspace`;
export const CUA_SOCKET = "/run/user/1000/seira-cua.sock";
export const CUA_EXECUTABLE = "/usr/local/libexec/seira/cua-driver";

const LINUX_WHEELS = {
  x86_64: {
    url: "https://files.pythonhosted.org/packages/3b/b0/97f6d8828b8a6ca3649ad7150ddbc23addde56f014c9bd407876484ecb8d/cua_driver-0.37.0-py3-none-manylinux_2_31_x86_64.whl",
    sha256: "e530ee36226d99516ef7ec696ba31d516e487ae5e5effdd5e2610c56af3eee19",
  },
  aarch64: {
    url: "https://files.pythonhosted.org/packages/dc/33/81e2531353837f80358fbf56629a74f50d7f097af4b5f67626b0afce2d61/cua_driver-0.37.0-py3-none-manylinux_2_31_aarch64.whl",
    sha256: "1a0103fd7fa5e9d51ee3ce26d502eb4187702282b3f4bcf1e9c09c6ce9f9d558",
  },
} as const;

/** Both Linux wheels are exact-version and SHA-256 verified. The first RUN rejects a defective base: some published ARM64
 * upstream layers shipped zero-byte OpenSSL libraries ("curl: error while loading shared libraries … file too short"). */
export function managedImageDockerfile(): string {
  return `FROM ${BASE_IMAGE}
USER root
RUN set -eux; \\
    arch="$(uname -m)"; \\
    case "$arch" in \\
      x86_64) wheel_url='${LINUX_WHEELS.x86_64.url}'; wheel_sha='${LINUX_WHEELS.x86_64.sha256}'; wheel_path='/tmp/cua_driver-${CUA_DRIVER_VERSION}-py3-none-manylinux_2_31_x86_64.whl'; lib_triplet='x86_64-linux-gnu' ;; \\
      aarch64|arm64) wheel_url='${LINUX_WHEELS.aarch64.url}'; wheel_sha='${LINUX_WHEELS.aarch64.sha256}'; wheel_path='/tmp/cua_driver-${CUA_DRIVER_VERSION}-py3-none-manylinux_2_31_aarch64.whl'; lib_triplet='aarch64-linux-gnu' ;; \\
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \\
    esac; \\
    for ssl_lib in "/lib/$lib_triplet/libssl.so.3" "/lib/$lib_triplet/libcrypto.so.3"; do \\
      if [ -e "$ssl_lib" ] && [ ! -s "$ssl_lib" ]; then \\
        echo "pinned base image is defective on $arch: $ssl_lib is zero bytes, so curl cannot start — re-pull or replace the base image instead of debugging the wheel download" >&2; \\
        exit 1; \\
      fi; \\
    done; \\
    curl -fsSL "$wheel_url" -o "$wheel_path"; \\
    echo "$wheel_sha  $wheel_path" | sha256sum -c -; \\
    /opt/venv/bin/python -m pip install --no-cache-dir --force-reinstall --no-deps "$wheel_path"; \\
    rm -f "$wheel_path"; \\
    driver_bin="$(find /opt/venv/lib -path '*/cua_driver/bin/cua-driver' -type f -print -quit)"; \\
    test -n "$driver_bin"; \\
    install -D -m 0755 "$driver_bin" ${CUA_EXECUTABLE}; \\
    install -d -o cua -g cua -m 0700 ${VM_WORKSPACE_GUEST}; \\
    test "$(${CUA_EXECUTABLE} --version)" = "cua-driver ${CUA_DRIVER_VERSION}"
# Install before XFCE starts so the panel and window manager see the font too.
# Noto Sans CJK JP is distributed under the SIL Open Font License 1.1.
RUN set -eux; \\
    install -d -m 0755 /usr/local/share/fonts; \\
    curl -fsSL 'https://raw.githubusercontent.com/notofonts/noto-cjk/165c01b46ea533872e002e0785ff17e44f6d97d8/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf' -o /usr/local/share/fonts/NotoSansCJKjp-Regular.otf; \\
    echo '68a3fc98800b2a27b371f2fb79991daf3633bd89309d4ffaa6946fd587f375b5  /usr/local/share/fonts/NotoSansCJKjp-Regular.otf' | sha256sum -c -; \\
    chmod 0644 /usr/local/share/fonts/NotoSansCJKjp-Regular.otf; \\
    install -d -m 0755 /usr/local/share/licenses/noto-cjk; \\
    curl -fsSL 'https://raw.githubusercontent.com/notofonts/noto-cjk/165c01b46ea533872e002e0785ff17e44f6d97d8/LICENSE' -o /usr/local/share/licenses/noto-cjk/OFL.txt; \\
    echo '6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2  /usr/local/share/licenses/noto-cjk/OFL.txt' | sha256sum -c -; \\
    fc-cache -f
${workspacePreparationDockerfile(VM_WORKSPACE_GUEST)}
# A bot's own desktop: a 200 ms (not 800) watch for windows an action opens still sees Firefox popups; no cursor glide; plain logs; Chrome's own sandbox off, since it needs namespaces this hardened container (capabilities dropped, runtime seccomp) refuses and Chrome exits with code 21; the container is the isolation boundary here. --grant existing-profile lets the bot attach the browser tools to Chromium it opened on this desktop; without it every attach is refused with browser_consent_required.
RUN printf '%s\\n' \\
      '#!/bin/sh' \\
      '/usr/local/bin/prepare-seira-workspace.sh' \\
      'attempt=0' \\
      'until DISPLAY=:1 xset q >/dev/null 2>&1; do' \\
      '  attempt=$((attempt + 1))' \\
      '  if [ "$attempt" -ge 45 ]; then echo "X display :1 did not become ready within 45 seconds" >&2; exit 1; fi' \\
      '  sleep 1' \\
      'done' \\
      'exec env CUA_DRIVER_BROWSER_NO_SANDBOX=1 CUA_DRIVER_INSTALL_CHANNEL=python_package CUA_DRIVER_RS_TELEMETRY_ENABLED=0 CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS=200 NO_COLOR=1 ${CUA_EXECUTABLE} serve --socket ${CUA_SOCKET} --permission-mode standard --grant existing-profile --cursor-reduced-motion on' \\
      > /usr/local/bin/start-seira-cua-driver.sh \\
    && chmod 0755 /usr/local/bin/start-seira-cua-driver.sh
RUN printf '%s\\n' \\
      '' \\
      '[program:seira-cua-driver]' \\
      'command=/usr/local/bin/start-seira-cua-driver.sh' \\
      'user=cua' \\
      'environment=HOME="/home/cua",USER="cua",DISPLAY=":1"' \\
      'autorestart=true' \\
      'startsecs=2' \\
      'stdout_logfile=/var/log/supervisor/cua-driver.log' \\
      'stderr_logfile=/var/log/supervisor/cua-driver.error.log' \\
      'priority=30' \\
      >> /etc/supervisor/supervisord.conf
LABEL ${MANAGED_LABEL}="1" \\
      ${DRIVER_LABEL}="${CUA_DRIVER_VERSION}" \\
      ${BASE_IMAGE_LABEL}="${BASE_IMAGE_DIGEST}" \\
      ${IMAGE_LAYER_LABEL}="${IMAGE_LAYER_VERSION}"
`;
}
