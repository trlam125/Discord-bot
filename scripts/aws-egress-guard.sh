#!/usr/bin/env bash
# Apply Linux egress restrictions ONLY to a dedicated unprivileged voice user.
# SSH, AWS agents, and unrelated services remain unaffected.
set -euo pipefail
if [[ "${EUID}" -ne 0 ]]; then echo 'Run with sudo.' >&2; exit 1; fi
voice_user="${1:-discordvoice}"
voice_uid="$(id -u "$voice_user")" || { echo 'Voice user not found.' >&2; exit 1; }
if [[ "$voice_uid" == 0 ]]; then echo 'Never run voice service as root.' >&2; exit 1; fi
command -v iptables >/dev/null
command -v ip6tables >/dev/null

chain=DISCORD_VOICE_EGRESS
iptables -w -N "$chain" 2>/dev/null || true
iptables -w -F "$chain"

# Permit DNS queries to the system resolver (even if it is in a private VPC),
# but not arbitrary HTTPS traffic to that resolver or the metadata endpoint.
resolvers="127.0.0.53 127.0.0.1 169.254.169.253"
while read -r ip; do
  [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || continue
  [[ "$ip" == "169.254.169.254" ]] && continue
  resolvers="$resolvers $ip"
done < <(awk '$1 == "nameserver" { print $2 }' /etc/resolv.conf)
for address in $(printf '%s\n' $resolvers | sort -u); do
  for proto in udp tcp; do
    iptables -w -A "$chain" -d "$address" -p "$proto" --dport 53 -j RETURN
  done
done

for cidr in \
  0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 \
  169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 \
  192.0.2.0/24 192.88.99.0/24 192.168.0.0/16 \
  198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 \
  224.0.0.0/4 240.0.0.0/4; do
  iptables -w -A "$chain" -d "$cidr" -j REJECT
done
iptables -w -C OUTPUT -m owner --uid-owner "$voice_uid" -j "$chain" 2>/dev/null || \
  iptables -w -I OUTPUT -m owner --uid-owner "$voice_uid" -j "$chain"
# Disable IPv6 outbound for this service to avoid IPv6 private-address bypass.
ip6tables -w -C OUTPUT -m owner --uid-owner "$voice_uid" -j REJECT 2>/dev/null || \
  ip6tables -w -I OUTPUT -m owner --uid-owner "$voice_uid" -j REJECT

echo "Applied egress guard for user $voice_user (UID $voice_uid)."
echo 'Public IPv4 is allowed; IPv4 special/private ranges and all IPv6 are blocked.'
echo 'Save firewall rules using netfilter-persistent if you want them to survive reboot.'
