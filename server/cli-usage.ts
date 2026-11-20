import { resolveServerControlPlaneURL } from "../electron/companion-account-service.mjs";

export { HEADLESS_VERBS as HEADLESS_VERB_NAMES } from "./headless/args.ts";

export const HEADLESS_USAGE = `Drive a running workspace (scripts, CI, other agents):
  seira doctor                          check the server answers and an engine is ready
  seira doctor --host                   check this Linux machine can run a server (exit 7 if not)
  seira doctor --data [--fix]           check (and safely repair) this computer's data folder (exit 8 if a problem is left)
  seira bots | channels | models        your bots, your rooms, the engines and their models
  seira run BOT "do this"               give a bot one job and wait until it and every teammate it asked are done
  seira send BOT "text"                 send one message and return at once
  seira wait BOT                        wait on work already running
  seira messages BOT                    the latest messages of a conversation
  seira interrupt BOT [--tree]          press Stop (--tree: and every teammate on its job)
  seira export BOT --out DIR            write a job's transcripts, files and screens to DIR
  seira events [--job THREAD]           the server's live events as JSON lines
  seira team apply FILE                 make the workspace match a team file (team export writes one)
  seira engine set claude --key-env ANTHROPIC_API_KEY         give it an engine without a screen
  seira connect URL --code CODE --out FILE                    get a token for a workspace elsewhere
  seira token create NAME --out FILE [--expires 90d]          a token for CI that ends on its date (token list, token revoke ID)
  seira new-bot | new-channel | set-model | edit | mcp

  Server: --url URL (or SEIRA_URL), --port N (or SEIRA_PORT), else this computer's.
  Token: SEIRA_TOKEN or --token-file FILE. --json prints one JSON document;
  progress goes to stderr (--quiet drops it). seira help VERB for the details.`;

const LOGIN_OWN = `login   signs this machine in to the account service at
        SEIRA_CONTROL_PLANE_URL (an emailed code) and reserves its public
        address for --tunnel; with --relay it reserves none, for serve
        --relay. Fails when no account service is set.`;
const LOGIN_SEIRA = `login   signs this machine in to your Seira account (an emailed code)
        and reserves its public https://c-….seira.run address for --tunnel;
        with --relay it reserves none, for serve --relay, which needs
        SEIRA_CONTROL_PLANE_URL (an account service you run).`;
const TUNNEL_OWN = `--tunnel     serve at the public address that an account service gives,
             through a Cloudflare tunnel. Needs SEIRA_CONTROL_PLANE_URL (an
             account service you run) and \`seira login\` once on this
             machine first. Without one, use the ways above. With
             --tailscale too, phones also get the tailnet address.`;
const TUNNEL_SEIRA = `--tunnel     serve at the https://c-….seira.run address of your Seira
             account, through a Cloudflare tunnel. Run \`seira login\` once
             on this machine first. SEIRA_CONTROL_PLANE_URL points login
             and --tunnel at an account service you run instead. With
             --tailscale too, phones also get the tailnet address.`;

/** The usage text, its commands written the way this CLI was started (`npx @seira-bot/seira …`). `live` is for tests. */
export function usage(prefix = "seira", env: NodeJS.ProcessEnv = process.env, live?: readonly string[]): string {
  const seiraTunnel = !Object.hasOwn(env, "SEIRA_CONTROL_PLANE_URL") && resolveServerControlPlaneURL({ environment: env, ...(live ? { live } : {}) }) !== "";
  const text = seiraTunnel ? USAGE.replace(LOGIN_OWN, LOGIN_SEIRA).replace(TUNNEL_OWN, TUNNEL_SEIRA) : USAGE;
  return text.split("\n").map((line) => line.replace(/^(\s+)seira(?= )/, `$1${prefix}`)).join("\n");
}

export const USAGE = `seira — your team of AI bots, ready in a few steps

  seira                               set up once, then open your workspace
  seira setup [--data-dir DIR]
  seira start [the same options as serve]
  seira serve [--port 8799] [--data-dir DIR] [--label NAME]
                    [--public-url https://host | --domain HOST | --tailscale] [--tunnel] [--lan] [--relay]
  seira pair  [--label NAME] [--phone [ios|android]] [--ttl 24h] [--public-url https://host]
  seira devices [revoke ID]
  seira status
  seira --version
  seira login [--email you@example.com] [--relay]
  seira logout
  seira access list | add EMAIL [--chat-only] | remove EMAIL
  seira service install [the same way-in options as serve] [--port N] [--data-dir DIR] | uninstall
                    [--sentinel]   (the health scan below, every two minutes, instead of the server)
  seira sentinel [--data-dir DIR] [--out DIR] [--once] [--json]         (read-only health scan; see --help)
  seira config backups | restore NAME          (dated copies of the settings file; see --help)
  seira browser install [--with-deps] | status
  seira fleet init --domain HOST [--operator USER] | create NAME --admin EMAIL [--member EMAIL] [--brand FILE]
                    [--anthropic-key-file FILE] [--cap USD] [--license-key KEY] [--memory 1G]
                  | list | users NAME add|remove EMAIL [--chat-only] | suspend NAME | resume NAME
                  | delete NAME --yes [--keep-data] | upgrade   (all take --dry-run)
                  | agent [--socket PATH] [--group USER]   (root; installed by init --operator)

setup   choose AI access and optional phone access; keep existing bots and chats
start   same as seira: use your saved settings and open the workspace
serve   starts the server without prompts; in a terminal it prints a pairing
        code, the link to paste into the desktop app (＋ → Connect to a
        server) and a QR for a phone
pair    a new pairing code for the running server, with its link and QR
        (--phone: chat and approvals only; --ttl keeps it open up to 24h,
        still single use)
devices lists paired devices; "devices revoke ID" signs one out
status  the running server, the address others reach it at, and whether
        that address answers as this server
${LOGIN_OWN}
logout  releases that address and signs out
access  who may sign in with an emailed code at /pair: an address or
        @domain; --chat-only gives chat and approvals without settings.
        Takes effect at once, no restart.
service keep the server running across reboots: writes a systemd unit
        (Linux) or a launchd agent (macOS) for the same serve options and
        prints the commands that install it. Run from npx, it first
        installs a copy of this version next to your data for the service.
browser install: the bots' browser engine (agent-browser, pinned) into the
        data dir, and Chrome for Testing into the user's browser cache.
        --with-deps also installs
        the Linux libraries Chrome needs (run as root once). Then run
        browser install as the user running serve, from that user's home.
        status: what the current user and data directory have.
fleet   many client workspaces on one Linux server, each its own account,
        service, data folder, brand, sign-in list and keys at NAME.HOST
        behind the system Caddy. Plans are printed unless run as root;
        --dry-run always prints. Install the package permanently first.
        init --operator USER also installs the fleet agent, a root service
        on a Unix socket only USER may open, so the workspace running as
        USER manages the others from Settings → Installations.

Ways in (pick one; --lan can join any):
--public-url you already have HTTPS in front (cloudflared, Caddy, nginx):
             the link uses that address, after checking it reaches this
             server. http:// is accepted only for a private network address.
--lan        this network only, plain http: listens on this machine's
             private addresses and answers nobody on the open internet
--tailscale  serve over your tailnet: Tailscale terminates HTTPS and the
             link uses this machine's MagicDNS name (needs Tailscale signed in
             and HTTPS certificates enabled for the tailnet); the share ends
             when serve stops
--domain     serve at https://HOST on your own domain: a pinned Caddy is
             downloaded once and run alongside the server, and gets the
             certificate itself. Point the domain's DNS at this machine and
             open ports 80 and 443.
${TUNNEL_OWN}

--relay      phones only, and it can join any of the ways in above except
             --tunnel: the Seira phone app pairs by QR through Seira Relay,
             end-to-end encrypted, with no address, open port or VPN. Needs
             SEIRA_CONTROL_PLANE_URL and \`seira login --relay\` once on this
             machine first. Not on a machine with a tunnel address: the
             relay stays off there.

--no-open   do not open a browser window
--no-pair   do not print a pairing code
--local     start locally this time, ignoring saved remote-access settings

${HEADLESS_USAGE}

Install once with \`npm install -g @seira-bot/seira\`, then type \`seira\`.
Or run without a global install: \`npx @seira-bot/seira\`. Node 24+ is required.
`;
