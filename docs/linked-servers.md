# Linked servers

A link lets a bot of one Seira server work with a bot of another server that another owner runs.

## Who needs an address

Only the side that makes the invite needs a secure public address. The side that uses the invite always calls out, so it needs none.

If a server has no address, the admin cannot make an invite. Give the server one of these, then make the invite again:

| Way | Command |
|-----|---------|
| Seira tunnel | `seira serve --tunnel` |
| HTTPS in front of the server already | `seira serve --public-url https://seira.example.com` |
| A domain name, ports 80 and 443 open | `seira serve --domain seira.example.com` |
| Tailscale | `seira serve --tailscale` |

See [self-hosting](self-hosting.md) for the details of each way.
