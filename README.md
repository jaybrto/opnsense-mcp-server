# OPNsense MCP Server

A Model Context Protocol (MCP) server that provides **88 module-based tools** for OPNsense firewall management, exposing 2000+ API methods through a type-safe interface.

## Features

- **Modular Architecture** - 88 logical tools (one per module) instead of 2000+ individual tools
- **Complete API Coverage** - Access to 752 core methods and 1271 plugin methods
- **Tool Filtering** - Reduce context window usage by loading only the tools you need
- **SSE Transport** - Remote access via Server-Sent Events for Docker deployment
- **Plugin Support** - Optional support for 64 plugin modules

## Quick Start

### 1. Build the Docker Image

```bash
git clone https://github.com/jaybrto/opnsense-mcp-server.git
cd opnsense-mcp-server
docker build -t opnsense-mcp-server .
```

### 2. Run the Container

```bash
docker run -d \
  -p 3000:3000 \
  -e OPNSENSE_URL=https://192.168.1.1 \
  -e OPNSENSE_API_KEY=your-api-key \
  -e OPNSENSE_API_SECRET=your-api-secret \
  -e OPNSENSE_VERIFY_SSL=false \
  -e TOOLS_INCLUDE="firewall_*,unbound_*" \
  --name opnsense-mcp \
  opnsense-mcp-server
```

### 3. Configure Claude Code

Add to your Claude Code MCP configuration (`~/.claude.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "opnsense": {
      "url": "http://localhost:3000/sse"
    }
  }
}
```

That's it! Claude Code will now have access to your OPNsense firewall tools.

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPNSENSE_URL` | Yes | OPNsense API URL (e.g., `https://192.168.1.1`) |
| `OPNSENSE_API_KEY` | Yes | API key from OPNsense |
| `OPNSENSE_API_SECRET` | Yes | API secret from OPNsense |
| `OPNSENSE_VERIFY_SSL` | No | Set to `false` for self-signed certs (default: `true`) |
| `INCLUDE_PLUGINS` | No | Set to `true` to enable 64 plugin modules (default: `false`) |
| `TOOLS_INCLUDE` | No | Comma-separated glob patterns to include tools |
| `TOOLS_EXCLUDE` | No | Comma-separated glob patterns to exclude tools |

### Tool Filtering

Reduce context window usage by loading only the tools you need:

```bash
# Only firewall and DNS tools
-e TOOLS_INCLUDE='firewall_*,unbound_*'

# All core tools except diagnostics
-e TOOLS_INCLUDE='!diagnostics_*'

# All core tools + only Caddy plugin (requires INCLUDE_PLUGINS=true)
-e INCLUDE_PLUGINS=true \
-e TOOLS_INCLUDE='*,!plugin_*,plugin_caddy*'

# All core except diagnostics + Caddy plugin
-e INCLUDE_PLUGINS=true \
-e TOOLS_INCLUDE='*,!plugin_*,plugin_caddy*,!diagnostics_*'
```

**Pattern Syntax:**
- `*` matches any characters
- `?` matches single character
- `!` negates a pattern (exclude matching tools)
- Patterns are case-insensitive
- Multiple patterns separated by commas
- Patterns processed left-to-right (later patterns override earlier)

**Test your filters** without deploying (use single quotes to avoid shell issues with `!`):

```bash
node index.js --list-tools --tools-include 'firewall_*,unbound_*'
node index.js --list-tools --plugins --tools-include '*,!plugin_*,plugin_caddy*'
```

### Changing the Port

If port 3000 is already in use, change the host port mapping:

```bash
docker run -d -p 8080:3000 ... opnsense-mcp-server
```

Then update Claude Code config:
```json
{
  "mcpServers": {
    "opnsense": {
      "url": "http://localhost:8080/sse"
    }
  }
}
```

## Docker Compose

Copy the sample environment file and configure:

```bash
cp .env.example .env
# Edit .env with your OPNsense credentials
```

Run:

```bash
docker-compose up -d
```

See `.env.example` for all available configuration options.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/sse` | GET | SSE connection for MCP clients |
| `/message?sessionId=<id>` | POST | Client-to-server messages |
| `/health` | GET | Health check (returns tool count) |

## Available Tools

### Core Modules (24 tools)

| Tool Name | Methods | Description |
|-----------|---------|-------------|
| `core_manage` | 46 | Core system functions, backups, snapshots |
| `firewall_manage` | 67 | Firewall rules, aliases, NAT, categories |
| `interfaces_manage` | 63 | Network interfaces, VLANs, VIPs |
| `diagnostics_manage` | 90 | System diagnostics, ARP, routes, logs |
| `auth_manage` | 19 | Users, groups, authentication |
| `firmware_manage` | 26 | Firmware updates, packages, changelog |
| `ipsec_manage` | 80 | IPsec VPN tunnels, connections |
| `unbound_manage` | 42 | DNS resolver, host overrides |
| `openvpn_manage` | 28 | OpenVPN instances, clients |
| `wireguard_manage` | 28 | WireGuard VPN servers, peers |
| `ids_manage` | 40 | Intrusion detection (Suricata) |
| `dnsmasq_manage` | 35 | Lightweight DNS/DHCP |
| `captiveportal_manage` | 27 | Captive portal, vouchers |
| `monit_manage` | 25 | Service monitoring |
| `trust_manage` | 25 | Certificates, CAs |
| `kea_manage` | 24 | Kea DHCP server |
| `trafficshaper_manage` | 20 | Traffic shaping, QoS |
| `syslog_manage` | 14 | System logging |
| `dhcrelay_manage` | 12 | DHCP relay |
| `routing_manage` | 9 | Routing protocols |
| `routes_manage` | 9 | Static routes |
| `cron_manage` | 8 | Scheduled tasks |
| `dhcpv6_manage` | 8 | DHCPv6 server |
| `dhcpv4_manage` | 7 | DHCPv4 server |

### Plugin Modules (64 tools when `INCLUDE_PLUGINS=true`)

| Tool Name | Methods | Description |
|-----------|---------|-------------|
| `plugin_quagga_manage` | 133 | Routing protocols (BGP, OSPF) |
| `plugin_nginx_manage` | 99 | Nginx web server |
| `plugin_haproxy_manage` | 96 | HAProxy load balancer |
| `plugin_freeradius_manage` | 68 | RADIUS authentication |
| `plugin_postfix_manage` | 66 | Mail server |
| `plugin_caddy_manage` | 52 | Caddy web server |
| `plugin_acmeclient_manage` | 48 | Let's Encrypt certificates |
| `plugin_proxy_manage` | 48 | Web proxy (Squid) |
| `plugin_tor_manage` | 45 | Tor anonymity network |
| `plugin_radsecproxy_manage` | 42 | RadSec proxy |
| `plugin_dnscryptproxy_manage` | 38 | DNSCrypt proxy |
| `plugin_bind_manage` | 36 | BIND DNS server |
| `plugin_siproxd_manage` | 24 | SIP proxy |
| `plugin_tailscale_manage` | 19 | Tailscale VPN |
| `plugin_telegraf_manage` | 18 | Metrics collection |
| `plugin_zabbixagent_manage` | 17 | Zabbix monitoring |
| `plugin_clamav_manage` | 16 | Antivirus |
| `plugin_maltrail_manage` | 16 | Malicious traffic detection |
| `plugin_tinc_manage` | 16 | Tinc VPN |
| `plugin_udpbroadcastrelay_manage` | 16 | UDP broadcast relay |
| `plugin_dyndns_manage` | 14 | Dynamic DNS |
| `plugin_netsnmp_manage` | 14 | SNMP |
| `plugin_nrpe_manage` | 14 | Nagios NRPE |
| `plugin_relayd_manage` | 14 | Load balancer |
| `plugin_shadowsocks_manage` | 14 | Shadowsocks proxy |
| `plugin_crowdsec_manage` | 12 | CrowdSec security |
| `plugin_ftpproxy_manage` | 12 | FTP proxy |
| `plugin_stunnel_manage` | 12 | SSL tunneling |
| `plugin_vnstat_manage` | 12 | Network statistics |
| `plugin_chrony_manage` | 11 | NTP server |
| `plugin_cicap_manage` | 10 | c-icap server |
| `plugin_zerotier_manage` | 10 | ZeroTier VPN |
| `plugin_apcupsd_manage` | 8 | APC UPS daemon |
| `plugin_hwprobe_manage` | 8 | Hardware probe |
| `plugin_lldpd_manage` | 8 | LLDP daemon |
| `plugin_ntopng_manage` | 8 | Network traffic analysis |
| `plugin_nut_manage` | 8 | Network UPS tools |
| `plugin_redis_manage` | 8 | Redis server |
| `plugin_sslh_manage` | 8 | SSL/SSH multiplexer |
| `plugin_wol_manage` | 8 | Wake-on-LAN |
| `plugin_collectd_manage` | 7 | Statistics collection |
| `plugin_gridexample_manage` | 7 | Grid example |
| `plugin_iperf_manage` | 7 | Network performance |
| `plugin_mdnsrepeater_manage` | 7 | mDNS repeater |
| `plugin_muninnode_manage` | 7 | Munin node |
| `plugin_ndproxy_manage` | 7 | NDP proxy |
| `plugin_netdata_manage` | 7 | Netdata monitoring |
| `plugin_nodeexporter_manage` | 7 | Prometheus exporter |
| `plugin_openconnect_manage` | 7 | OpenConnect VPN |
| `plugin_proxysso_manage` | 7 | Proxy SSO |
| `plugin_puppetagent_manage` | 7 | Puppet agent |
| `plugin_qemuguestagent_manage` | 7 | QEMU guest agent |
| `plugin_rspamd_manage` | 7 | Spam filtering |
| `plugin_softether_manage` | 7 | SoftEther VPN |
| `plugin_tayga_manage` | 7 | NAT64 |
| `plugin_tftp_manage` | 7 | TFTP server |
| `plugin_turnserver_manage` | 7 | TURN server |
| `plugin_wazuhagent_manage` | 7 | Wazuh security |
| `plugin_zabbixproxy_manage` | 7 | Zabbix proxy |
| `plugin_smart_manage` | 5 | S.M.A.R.T. monitoring |
| `plugin_helloworld_manage` | 4 | Hello world example |
| `plugin_dechw_manage` | 1 | Deciso hardware |
| `plugin_diagnostics_manage` | 1 | Plugin diagnostics |
| `plugin_dmidecode_manage` | 1 | DMI decode |

## Tool Usage

Each tool accepts a `method` parameter to specify the operation:

```json
{
  "tool": "firewall_manage",
  "arguments": {
    "method": "aliasSearchItem",
    "params": {
      "searchPhrase": "web"
    }
  }
}
```

**Example prompts for Claude:**
- "Use firewall_manage to list all firewall aliases"
- "Use unbound_manage to search for DNS host overrides"
- "Use core_manage to check system status"
- "Use interfaces_manage to get network interface information"

## OPNsense API Setup

1. Log into OPNsense web interface
2. Go to **System → Access → Users**
3. Create or edit a user
4. Generate an API key (creates key + secret pair)
5. Assign appropriate permissions to the user

## Development

```bash
# Install dependencies
yarn install

# Generate tool definitions from OPNsense client
yarn generate-tools

# Build the server
yarn build

# Run locally (stdio mode)
yarn start

# Run in SSE mode
node index.js --sse --port 3000 \
  --url https://192.168.1.1 \
  --api-key YOUR-KEY \
  --api-secret YOUR-SECRET
```

## License

MIT License - see LICENSE file for details.

## Acknowledgments

- Built on the [Model Context Protocol](https://modelcontextprotocol.io/) by Anthropic
