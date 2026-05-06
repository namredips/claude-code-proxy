#!/usr/bin/env bash

set -euo pipefail

readonly DEFAULT_BINARY="/Users/jefcox/bin/claude-code-proxy-codex-usage"
readonly BINARY="${CCP_LAUNCHD_BINARY:-$DEFAULT_BINARY}"
readonly DOMAIN="gui/$(id -u)"
readonly AGENTS_DIR="${CCP_LAUNCHD_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
readonly STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/claude-code-proxy"
readonly PATH_VALUE="${CCP_LAUNCHD_PATH:-/Users/jefcox/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"

usage() {
    cat >&2 <<'EOF'
Usage: scripts/launchd.sh ACTION [codex|gemini|all]

Actions:
  write      Write plist files to ~/Library/LaunchAgents without loading them
  install    Write plist files and start services when their ports are free
  start      Start loaded services, or install/start them when ports are free
  restart    Restart loaded services; install/start them when ports are free
  stop       Stop and unload services
  status     Show launchd and port status

Environment:
  CCP_LAUNCHD_BINARY      Proxy binary path (default: /Users/jefcox/bin/claude-code-proxy-codex-usage)
  CCP_LAUNCHD_AGENTS_DIR  LaunchAgents directory (default: ~/Library/LaunchAgents)
  CCP_LAUNCHD_PATH        PATH exported to launchd services
EOF
}

xml_escape() {
    sed \
        -e 's/&/\&amp;/g' \
        -e 's/</\&lt;/g' \
        -e 's/>/\&gt;/g' \
        -e 's/"/\&quot;/g' \
        -e "s/'/\&apos;/g" <<<"$1"
}

label_for() {
    case "$1" in
        codex) printf '%s\n' "com.namredips.claude-code-proxy.codex" ;;
        gemini) printf '%s\n' "com.namredips.claude-code-proxy.gemini" ;;
        *) return 1 ;;
    esac
}

port_for() {
    case "$1" in
        codex) printf '%s\n' "18765" ;;
        gemini) printf '%s\n' "18766" ;;
        *) return 1 ;;
    esac
}

plist_for() {
    printf '%s/%s.plist\n' "$AGENTS_DIR" "$(label_for "$1")"
}

env_xml_for() {
    local service="$1"
    case "$service" in
        codex)
            cat <<EOF
        <key>CCP_CLAUDE_ALIAS_PROVIDER</key>
        <string>codex</string>
        <key>CCP_CODEX_DEFAULT_EFFORT</key>
        <string>high</string>
EOF
            ;;
        gemini)
            cat <<EOF
        <key>CCP_CLAUDE_ALIAS_PROVIDER</key>
        <string>gemini</string>
        <key>CCP_GEMINI_DEFAULT_EFFORT</key>
        <string>high</string>
        <key>CCP_GEMINI_ENABLE_FALLBACK</key>
        <string>1</string>
        <key>CCP_GEMINI_ENABLE_GOOGLE_ONE_CREDITS</key>
        <string>0</string>
        <key>CCP_GEMINI_SMALL_FAST_MODEL</key>
        <string>gemini-3-flash-preview</string>
EOF
            ;;
        *)
            return 1
            ;;
    esac
}

render_plist() {
    local service="$1"
    local label port binary home path state_dir
    label=$(label_for "$service")
    port=$(port_for "$service")
    binary=$(xml_escape "$BINARY")
    home=$(xml_escape "$HOME")
    path=$(xml_escape "$PATH_VALUE")
    state_dir=$(xml_escape "$STATE_DIR")

    cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$label</string>
    <key>ProgramArguments</key>
    <array>
        <string>$binary</string>
        <string>serve</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$home</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PORT</key>
        <string>$port</string>
        <key>PATH</key>
        <string>$path</string>
$(env_xml_for "$service")
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>$state_dir/launchd-$service.out.log</string>
    <key>StandardErrorPath</key>
    <string>$state_dir/launchd-$service.err.log</string>
</dict>
</plist>
EOF
}

write_plist() {
    local service="$1"
    mkdir -p "$AGENTS_DIR" "$STATE_DIR"
    render_plist "$service" >"$(plist_for "$service")"
    chmod 644 "$(plist_for "$service")"
    printf 'wrote %s\n' "$(plist_for "$service")"
}

is_loaded() {
    launchctl print "$DOMAIN/$(label_for "$1")" >/dev/null 2>&1
}

port_is_open() {
    nc -z localhost "$(port_for "$1")" >/dev/null 2>&1
}

wait_for_port() {
    local service="$1"
    local port
    port=$(port_for "$service")
    for _ in {1..50}; do
        if nc -z localhost "$port" >/dev/null 2>&1; then
            return 0
        fi
        sleep 0.1
    done
    return 1
}

bootstrap_service() {
    local service="$1"
    local label plist
    label=$(label_for "$service")
    plist=$(plist_for "$service")

    write_plist "$service"

    if is_loaded "$service"; then
        launchctl enable "$DOMAIN/$label" >/dev/null 2>&1 || true
        launchctl kickstart -k "$DOMAIN/$label"
    else
        if port_is_open "$service"; then
            printf 'port %s is already in use; wrote plist but skipped starting %s\n' "$(port_for "$service")" "$label" >&2
            return 2
        fi
        launchctl bootstrap "$DOMAIN" "$plist"
        launchctl enable "$DOMAIN/$label" >/dev/null 2>&1 || true
    fi

    if wait_for_port "$service"; then
        printf 'started %s on port %s\n' "$label" "$(port_for "$service")"
    else
        printf 'started %s but port %s did not open; check %s/launchd-%s.err.log\n' "$label" "$(port_for "$service")" "$STATE_DIR" "$service" >&2
        return 1
    fi
}

stop_service() {
    local service="$1"
    local label
    label=$(label_for "$service")
    if is_loaded "$service"; then
        launchctl bootout "$DOMAIN/$label"
        printf 'stopped %s\n' "$label"
    else
        printf '%s is not loaded\n' "$label"
    fi
}

status_service() {
    local service="$1"
    local label port
    label=$(label_for "$service")
    port=$(port_for "$service")

    printf '\n%s\n' "$label"
    printf 'plist: %s\n' "$(plist_for "$service")"
    if is_loaded "$service"; then
        launchctl print "$DOMAIN/$label" | sed -n '1,28p'
    else
        printf 'launchd: not loaded\n'
    fi
    if command -v lsof >/dev/null 2>&1; then
        lsof -nP -iTCP:"$port" -sTCP:LISTEN || true
    fi
}

for_each_service() {
    local action="$1"
    local target="$2"
    local services=()
    local failed=0

    case "$target" in
        codex|gemini) services=("$target") ;;
        all) services=(codex gemini) ;;
        *)
            usage
            exit 2
            ;;
    esac

    for service in "${services[@]}"; do
        "$action" "$service" || failed=1
    done

    return "$failed"
}

main() {
    if (($# < 1 || $# > 2)); then
        usage
        exit 2
    fi

    local action="$1"
    local target="${2:-all}"

    case "$action" in
        write) for_each_service write_plist "$target" ;;
        install|start|restart) for_each_service bootstrap_service "$target" ;;
        stop|uninstall) for_each_service stop_service "$target" ;;
        status) for_each_service status_service "$target" ;;
        *)
            usage
            exit 2
            ;;
    esac
}

main "$@"
