# Deploying the ChatKJB companion

## Linux (systemd user unit)

```bash
cd companion
go build -o ~/.local/bin/herdr-mobiled ./cmd/herdr-mobiled

# Find your tailnet IP:
TS_IP=$(tailscale ip -4)

# Install the user service, templated with your tailnet IP:
mkdir -p ~/.config/systemd/user
sed "s/%i/$TS_IP/" deploy/herdr-mobiled.service > ~/.config/systemd/user/herdr-mobiled.service
systemctl --user daemon-reload
systemctl --user enable --now herdr-mobiled
systemctl --user status herdr-mobiled
```

## macOS (launchd user agent)

The agent binds to localhost and Tailscale Serve exposes it to the tailnet,
so the port is never published on a local network interface.

```bash
cd companion
go build -o ~/.local/bin/herdr-mobiled ./cmd/herdr-mobiled

# Install the agent, templated with your home directory:
mkdir -p ~/Library/LaunchAgents
sed "s|__HOME__|$HOME|g" deploy/net.neam.herdr-mobiled.plist \
  > ~/Library/LaunchAgents/net.neam.herdr-mobiled.plist
plutil -lint ~/Library/LaunchAgents/net.neam.herdr-mobiled.plist

launchctl bootout "gui/$(id -u)/net.neam.herdr-mobiled" 2>/dev/null
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/net.neam.herdr-mobiled.plist
launchctl print "gui/$(id -u)/net.neam.herdr-mobiled" | grep -E 'state|pid'

# Publish it on the tailnet only:
tailscale serve --bg --tcp 8787 tcp://127.0.0.1:8788
tailscale serve status
```

### Locating the herdr binary

Service managers start the companion with a minimal PATH that does not include
`~/.local/bin`, which used to break `herdr terminal attach` with
`exec: "herdr": executable file not found in $PATH`. The daemon now resolves an
absolute path itself, checking `$HERDR_BIN`, then `PATH`, then the usual
install directories. Set `HERDR_BIN` if herdr lives somewhere unusual.

Verify from a laptop on the tailnet:

```bash
# expects welcome + panes frames
websocat ws://$TS_IP:8787/
```
