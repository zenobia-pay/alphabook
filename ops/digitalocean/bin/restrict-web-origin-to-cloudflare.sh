#!/usr/bin/env bash
set -euo pipefail

CF_IPV4_URL="https://www.cloudflare.com/ips-v4"
CF_IPV6_URL="https://www.cloudflare.com/ips-v6"
CFSET_V4="alphabook_cloudflare_v4"
CFSET_V6="alphabook_cloudflare_v6"
CHAIN_V4="ALPHABOOK_CF_EDGE"
CHAIN_V6="ALPHABOOK_CF_EDGE_V6"

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "Run as root." >&2
    exit 1
  fi
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || missing+=("$1")
}

install_deps() {
  local missing=()
  need_cmd curl
  need_cmd ipset
  need_cmd iptables
  need_cmd ip6tables
  need_cmd netfilter-persistent
  if (( ${#missing[@]} == 0 )); then
    return
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y curl ipset iptables-persistent netfilter-persistent
}

ensure_ipset() {
  local name="$1"
  local family="$2"
  ipset create "$name" hash:net family "$family" -exist
  ipset flush "$name"
}

populate_ipset() {
  local name="$1"
  local url="$2"
  curl -fsSL "$url" | while IFS= read -r cidr; do
    [[ -n "$cidr" ]] || continue
    ipset add "$name" "$cidr" -exist
  done
}

ensure_chain() {
  local chain="$1"
  local ipt="$2"
  "$ipt" -N "$chain" 2>/dev/null || true
  "$ipt" -F "$chain"
}

ensure_jump() {
  local ipt="$1"
  local chain="$2"
  "$ipt" -C INPUT -p tcp -m multiport --dports 80,443 -j "$chain" 2>/dev/null \
    || "$ipt" -I INPUT 1 -p tcp -m multiport --dports 80,443 -j "$chain"
}

build_rules() {
  iptables -A "$CHAIN_V4" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  iptables -A "$CHAIN_V4" -m set --match-set "$CFSET_V4" src -j ACCEPT
  iptables -A "$CHAIN_V4" -j DROP

  ip6tables -A "$CHAIN_V6" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  ip6tables -A "$CHAIN_V6" -m set --match-set "$CFSET_V6" src -j ACCEPT
  ip6tables -A "$CHAIN_V6" -j DROP
}

persist_rules() {
  mkdir -p /etc/iptables
  ipset save > /etc/ipset.conf
  iptables-save > /etc/iptables/rules.v4
  ip6tables-save > /etc/iptables/rules.v6
  systemctl enable netfilter-persistent >/dev/null 2>&1 || true
}

main() {
  require_root
  install_deps

  ensure_ipset "$CFSET_V4" inet
  ensure_ipset "$CFSET_V6" inet6
  populate_ipset "$CFSET_V4" "$CF_IPV4_URL"
  populate_ipset "$CFSET_V6" "$CF_IPV6_URL"

  ensure_chain "$CHAIN_V4" iptables
  ensure_chain "$CHAIN_V6" ip6tables
  build_rules
  ensure_jump iptables "$CHAIN_V4"
  ensure_jump ip6tables "$CHAIN_V6"
  persist_rules

  echo "Locked 80/443 to Cloudflare IP ranges."
}

main "$@"
