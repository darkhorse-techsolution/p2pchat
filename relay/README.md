# Running a relay

The relay lets two apps talk when neither can reach the other directly (both behind NAT, different
networks). It forwards encrypted frames between random addresses and stores nothing. What it can see:
each app's IP address, and which random addresses talk to which. What it cannot see: names, keys,
contact lists, or any message content - those are end-to-end encrypted, and the link from each app to
the relay is encrypted too, so even the control traffic is opaque on the wire.

Zero dependencies. Needs Node 20+ (or any Electron binary run with `ELECTRON_RUN_AS_NODE=1`).

## Quick start (any Linux VPS)

```sh
git clone <this repo> p2pchat && cd p2pchat
node relay/server.js --port 4433 --public-host relay.example.com
```

It prints the relay address, for example:

```
relay://relay.example.com:4433/kQL-hf5Uu9Yist9y1XrXomK6N3ScLSmoTtf4WJCb1EQ
```

Paste that into **Settings → Relay** in one app. Every invite that app creates from then on carries
it, so contacts pick it up automatically when they add the invite. Open TCP 4433 in the firewall.
Use any port; 443 passes through more corporate networks.

The relay's identity is the key in that address. It is generated on first run into `--data`
(default `./relay-data/relay-key.json`). Keep that file: if it changes, the address changes and every
app has to be told the new one.

## Without sudo: a user service (how it runs on 49.12.170.6)

```sh
mkdir -p ~/.config/systemd/user ~/p2pchat-relay/data
# ~/.config/systemd/user/p2pchat-relay.service: same as below but WorkingDirectory=%h/p2pchat-relay,
# ExecStart=/usr/local/bin/node relay/server.js --port 4433 --host 0.0.0.0 --public-host <ip> --data %h/p2pchat-relay/data,
# and WantedBy=default.target
loginctl enable-linger $USER            # keeps user services running without a login session
systemctl --user daemon-reload && systemctl --user enable --now p2pchat-relay
journalctl --user -u p2pchat-relay -f   # prints the relay address on start
```

## As a system service

```ini
# /etc/systemd/system/p2pchat-relay.service
[Unit]
Description=P2P Chat relay
After=network-online.target

[Service]
User=relay
WorkingDirectory=/opt/p2pchat
ExecStart=/usr/bin/node relay/server.js --port 4433 --public-host relay.example.com --data /var/lib/p2pchat-relay
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/p2pchat-relay

[Install]
WantedBy=multi-user.target
```

```sh
sudo useradd -r -s /usr/sbin/nologin relay
sudo mkdir -p /var/lib/p2pchat-relay && sudo chown relay /var/lib/p2pchat-relay
sudo systemctl enable --now p2pchat-relay
sudo journalctl -u p2pchat-relay -f      # shows the relay address on start
```

## Docker

```sh
docker build -f relay/Dockerfile -t p2pchat-relay .
docker run -d --name relay --restart unless-stopped -p 4433:4433 -v relay-data:/data \
  p2pchat-relay --public-host relay.example.com
docker logs relay | grep relay://
```

## Limits built in

Per connection: 256 addresses, 64 open channels, 300 KB frames, 90 s idle timeout (apps ping every
25 s). Per IP: 32 connections. A client that cannot complete the encrypted link handshake within 8 s
is dropped. There is no persistence, so a relay restart drops live channels; apps reconnect on their
own with backoff and messages queued on the sender's device are delivered when both are back.

## What it does not do

It does not store messages for offline recipients. If the other person's app is not running, your
message waits on your machine and goes out when both apps are connected to the relay. The app is a
background app precisely so that "running" is the normal state.

## Call server (STUN/TURN) for screen sharing

Screen-share media is WebRTC between the two apps. Two home networks usually cannot reach each other
directly, so the app also uses a TURN server; the chat relay above cannot carry media (it is TCP and
only forwards the app's own frames). Any TURN server works; the one the app ships with is coturn in
Docker, run as an ordinary user:

```sh
docker run -d --name p2pturn --restart unless-stopped --network host coturn/coturn:4.6 \
  -n --log-file=stdout --listening-ip=<public ip> --relay-ip=<public ip> --listening-port=3478 \
  --min-port=49160 --max-port=49200 --realm=p2pchat --user=<user>:<password> --lt-cred-mech \
  --fingerprint --no-tls --no-dtls --no-cli --no-multicast-peers --max-bps=6000000 \
  --denied-peer-ip=10.0.0.0-10.255.255.255 --denied-peer-ip=172.16.0.0-172.31.255.255 \
  --denied-peer-ip=192.168.0.0-192.168.255.255 --denied-peer-ip=127.0.0.0-127.255.255.255 \
  --denied-peer-ip=100.64.0.0-100.127.255.255 --denied-peer-ip=169.254.0.0-169.254.255.255
```

Open UDP and TCP 3478 and UDP 49160-49200 to the world. Put the host, user and password into
`main/turn.json` (copy `main/turn.example.json`; the file is not committed) before building, or into Settings → "Screen share and voice" in a
running app. The server only ever sees DTLS-SRTP ciphertext; the long-term credential is inside the
app, so cap the bandwidth (`--max-bps`) and refuse private peer ranges, as above. Pin
`--listening-ip` and `--relay-ip`: left to discovery, coturn on a Docker host binds every bridge and
can hand out an unreachable 172.x relay address.
