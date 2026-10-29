#!/usr/bin/env bash
# Copyright (c) 2026 Stubaggs
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Party Mode setup: installs, checks, updates and removes Party Mode on Linux,
# with Docker or with the Roon Extension Manager. It keeps nothing of its
# own: each run reads what's installed from Docker.
#
#   bash party-mode-setup.sh                 menus
#   bash party-mode-setup.sh --status        what's installed

set -Eeuo pipefail
# Anything unexpected stops the program; say where, rather than quietly.
trap 'printf "\nThe setup program stopped unexpectedly (line %s).\n" "$LINENO" >&2' ERR

# This program's own version, separate from Party Mode's: raise it with every
# change, so a copy kept on a computer can tell a newer one is out.
SETUP_VERSION=1.4
IMAGE=stubaggs/roon-extension-party-mode
SOURCE=https://github.com/stubaggs/roon-extension-party-mode
DESCRIPTION="Roon Extension for parties: guests request music from their phone, no app needed"
BASE="roon-extension-party-mode"
MANAGER="roon-extension-manager"
REM=/home/node/.rem
ENTRY_FILE="roon-extension-party-mode.json"
REPOSITORY_URL=${PARTY_MODE_SETUP_REPOSITORY_URL:-https://raw.githubusercontent.com/TheAppgineer/roon-extension-repository/v1.x/repository.json}
TAGS_URL="https://hub.docker.com/v2/repositories/$IMAGE/tags?page_size=100"
SETUP_URL=https://raw.githubusercontent.com/stubaggs/roon-extension-party-mode/main/party-mode-setup.sh
TITLE="Party Mode setup $SETUP_VERSION"
# The Manager can't finish installing or updating its copy while other
# containers' names contain its container's name (it looks its copy up by part
# of the name), so a computer runs Party Mode one way.
MANAGE="The Extension Manager updates Party Mode each night. Manage it in Roon:
Settings > Extensions, then the Extension Manager's Settings."
ONE_WAY="On one computer, run Party Mode with Docker or with the Extension
Manager, not both."

WHIPTAIL=0

have() { command -v "$1" >/dev/null 2>&1; }

fetch() {
  if have curl; then curl -fsSL --connect-timeout 5 --max-time 10 "$1"
  elif have wget; then wget -qO- -T 10 "$1"
  else return 1
  fi
}

# The Manager's own list, read once a run (it's needed in several places, and
# offline each read would wait). Kept in a file: callers run in $(…).
LIST_FILE=''
official_list() {
  if [[ ! -s $LIST_FILE ]]; then
    fetch "$REPOSITORY_URL" > "$LIST_FILE" 2>/dev/null || true
    if [[ ! -s $LIST_FILE ]]; then echo unreadable > "$LIST_FILE"; fi
  fi
  cat "$LIST_FILE"
}

# --- Screens: whiptail when there's a terminal for it, plain text otherwise ---
# Both write to the terminal or stderr, never stdout, which carries a menu's
# choice when it's called in $(…). Boxes fit an 80 × 24 terminal.

box_size() {
  SCREEN_H=$(tput lines 2>/dev/null || echo 24)
  local cols
  cols=$(tput cols 2>/dev/null || echo 80)
  BOX_H=$(( SCREEN_H - 2 < 22 ? SCREEN_H - 2 : 22 ))
  BOX_W=$(( cols - 4 < 76 ? cols - 4 : 76 ))
}

# Joins a message's lines into paragraphs, for whiptail or fold to wrap. Blank
# lines, and lines that start with a space or a digit (commands, lists, logs),
# stay as they are.
paragraphs() {
  awk 'BEGIN { RS = ""; ORS = "\n\n" }
    { n = split($0, l, "\n"); out = l[1]
      for (i = 2; i <= n; i++) {
        if (l[i] ~ /^[ 0-9]/ || l[i - 1] ~ /^[ 0-9]/) out = out "\n" l[i]; else out = out " " l[i]
      }
      print out }' <<<"$1"
}

msg() {
  local text n
  text=$(paragraphs "$1")
  if (( WHIPTAIL )); then
    # A box that fits closes with Enter; one that scrolls takes Enter to scroll.
    box_size
    n=$(fold -s -w $(( BOX_W - 4 )) <<<"$text" | wc -l)
    if (( n + 7 <= SCREEN_H )); then
      whiptail --title "$TITLE" --msgbox "$text" $(( n + 7 )) "$BOX_W" >/dev/tty || true
    else
      whiptail --title "$TITLE" --scrolltext --msgbox "$text

(Tab, then Enter, to close.)" "$SCREEN_H" "$BOX_W" >/dev/tty || true
    fi
    between
  else
    printf '%s\n\n' "$text" | fold -s -w 78 >&2
  fi
}

die() {
  msg "$1"
  exit 1
}

# ask "question" [yes label] [no label]
ask() {
  local text n rc=0
  text=$(paragraphs "$1")
  if (( WHIPTAIL )); then
    box_size
    n=$(fold -s -w $(( BOX_W - 4 )) <<<"$text" | wc -l)
    whiptail --title "$TITLE" --yes-button "${2:-Yes}" --no-button "${3:-No}" \
      --yesno "$text" $(( n + 7 < SCREEN_H ? n + 7 : SCREEN_H )) "$BOX_W" >/dev/tty || rc=$?
    between
    return "$rc"
  elif [[ -t 0 ]]; then
    local answer
    printf '%s\n' "$text" | fold -s -w 78 >&2
    read -r -p "[y/N] " answer
    [[ $answer == [yY]* ]]
  else
    return 1
  fi
}

# answer "question" [default]: prints what was typed; fails on Cancel.
answer() {
  if (( WHIPTAIL )); then
    local reply rc=0
    box_size
    reply=$(whiptail --title "$TITLE" --inputbox "$(paragraphs "$1")" 12 "$BOX_W" "${2:-}" 3>&1 1>&2 2>&3) || rc=$?
    between
    printf '%s\n' "$reply"
    return "$rc"
  else
    local reply
    printf '%s\n' "$(paragraphs "$1")" | fold -s -w 78 >&2
    read -r -p "> " reply
    [[ -n $reply ]] || return 1
    printf '%s\n' "$reply"
  fi
}

# menu "text" key label [key label …]: prints the chosen key; fails on Back (or
# BACK, its label).
menu() {
  local text=$1; shift
  if (( WHIPTAIL )); then
    local lines n choice rc=0
    box_size
    lines=$(printf '%s\n' "$text" | wc -l)
    n=$(( $# / 2 ))
    choice=$(whiptail --title "$TITLE" --notags --cancel-button "${BACK:-Back}" \
      --menu "$text" $(( lines + n + 8 < BOX_H ? lines + n + 8 : BOX_H )) "$BOX_W" \
      $(( n < BOX_H - lines - 8 ? n : BOX_H - lines - 8 )) "$@" 3>&1 1>&2 2>&3) || rc=$?
    between
    printf '%s\n' "$choice"
    return "$rc"
  else
    local keys=() n=0 choice
    printf '\n%s\n\n' "$text" >&2
    while (( $# )); do
      keys+=("$1"); n=$(( n + 1 ))
      printf '  %2d) %s\n' "$n" "$2" >&2
      shift 2
    done
    printf '   0) %s\n' "${BACK:-Back}" >&2
    read -r -p "Choose: " choice
    [[ $choice =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= n )) || return 1
    printf '%s\n' "${keys[choice - 1]}"
  fi
}

# Between screens, the terminal shows only what's happening now: never what
# an earlier step printed.
between() {
  clear >/dev/tty
  printf '%s\n\nOne moment...\n' "$TITLE" >/dev/tty
}

# Long-running Docker output goes to the terminal, between screens.
progress() {
  if (( WHIPTAIL )); then
    clear >/dev/tty
    printf '%s\n\n' "$TITLE" >/dev/tty
  fi
  printf '%s\n' "$1" >&2
}

# --- Docker ---

check_docker() {
  if ! have docker; then
    die "Docker isn't installed.

On DietPi, install it with dietpi-software (Docker). On other Linux, see
https://docs.docker.com/engine/install/ and run this again."
  fi
  local err
  if ! err=$(docker version --format '{{.Server.Version}}' 2>&1 >/dev/null); then
    if [[ $err == *"permission denied"* ]]; then
      die "You don't have permission to use Docker. Run this again with sudo:

  sudo bash $0

To use Docker without sudo, add yourself to the docker group
(sudo usermod -aG docker $USER), then log out and back in."
    fi
    die "Docker isn't running. Start it (sudo systemctl start docker) and run this
again.

$err"
  fi
}

# Every Party Mode container, by its image or by the label the image carries.
copies() {
  local name image source
  docker ps -a --format '{{.Names}}|{{.Image}}|{{.Label "org.opencontainers.image.source"}}' |
    while IFS='|' read -r name image source; do
      case $image in
        "$IMAGE" | "$IMAGE":* | */"$IMAGE" | */"$IMAGE":*) printf '%s\n' "$name" ;;
        *) if [[ $source == "$SOURCE" ]]; then printf '%s\n' "$name"; fi ;;
      esac
    done
}

# How Party Mode names itself to Roon (lib/roon-service.js): a version with a
# suffix is a separate extension named after the suffix's word ("beta"), and
# so is a copy with a name ("Garden"). Two copies with the same of both clash.
channel_of() {
  local suffix
  if [[ $1 != *-* ]]; then return 0; fi
  suffix=${1#*-}
  if [[ $suffix =~ ^([A-Za-z]+) ]]; then
    printf '%s\n' "${BASH_REMATCH[1],,}"
  else
    printf 'beta\n'
  fi
}

slug() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]\{1,\}/-/g; s/^-*//; s/-*$//'
}

roon_name() {
  local label=${1:-}
  if [[ -n ${2:-} ]]; then label=${label:+$label, }$2; fi
  printf 'Party Mode%s\n' "${label:+ ($label)}"
}

# Reads one copy into C_* variables.
read_copy() {
  C_NAME=$1
  local line type name src dest image_env
  IFS='|' read -r C_STATE C_IMAGE C_VERSION C_PROJECT C_DIR C_FILES C_IMAGE_ID < <(
    docker inspect -f '{{.State.Status}}|{{.Config.Image}}|{{index .Config.Labels "org.opencontainers.image.version"}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.project.working_dir"}}|{{index .Config.Labels "com.docker.compose.project.config_files"}}|{{.Image}}' "$1")
  # Images before 1.4.0 label their version with the tag ("latest").
  if [[ ! $C_VERSION =~ ^[0-9] ]]; then C_VERSION=''; fi
  C_METHOD=docker C_DATA_TYPE='' C_DATA='' C_DATA_DEST=''
  while IFS='|' read -r type name src dest; do
    case $dest in
      "$REM") C_METHOD=manager ;;
      /data | /usr/src/app/config.json)
        C_DATA_TYPE=$type C_DATA_DEST=$dest
        if [[ $type == volume ]]; then C_DATA=$name; else C_DATA=$src; fi ;;
    esac
  done < <(docker inspect -f '{{range .Mounts}}{{.Type}}|{{.Name}}|{{.Source}}|{{.Destination}}{{println}}{{end}}' "$1")
  if [[ $C_METHOD != manager && -n $C_PROJECT ]]; then C_METHOD=compose; fi
  # The settings given to the container, not those its image sets (its build).
  C_ENV=()
  image_env=$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$C_IMAGE_ID" 2>/dev/null) || true
  while IFS= read -r line; do
    case $line in
      ROON_EXTENSION_PARTY_MODE_* | ROON-EXTENSION-PARTY-MODE_*)
        if ! grep -qxF -- "$line" <<<"$image_env"; then C_ENV+=("$line"); fi ;;
    esac
  done < <(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1")
  C_INSTANCE=''
  for line in "${C_ENV[@]+"${C_ENV[@]}"}"; do
    case $line in *_INSTANCE=*) C_INSTANCE=${line#*=} ;; esac
  done
  C_CHANNEL=$(channel_of "$C_VERSION")
  C_KEY="$C_CHANNEL/$(slug "$C_INSTANCE")"
}

# The version a running copy reports, for images that don't label it.
copy_version() {
  if [[ -n $C_VERSION ]]; then printf '%s\n' "$C_VERSION"
  elif [[ $C_STATE == running ]]; then
    docker exec "$C_NAME" node -p "require('./package.json').version" 2>/dev/null || true
  fi
}

# Whether the copy's web server has started (its log says so).
listening() {
  docker logs --tail 3000 "$1" 2>&1 | grep -q 'listening on port'
}

method_name() {
  case $1 in
    manager) echo "the Extension Manager" ;;
    compose) echo "Docker Compose" ;;
    *) echo "Docker" ;;
  esac
}

# running, or stopped: the details are in Roon.
state_words() {
  if [[ $C_STATE == running ]]; then echo running; else echo stopped; fi
}

# Copies installed one way: manager, or docker (Compose included).
copies_by() {
  local name
  for name in $(copies); do
    read_copy "$name"
    if [[ $1 == manager && $C_METHOD == manager ]] || [[ $1 == docker && $C_METHOD != manager ]]; then
      printf '%s\n' "$name"
    fi
  done
}

# Party Mode's volumes that no container uses.
unused_volumes() {
  docker volume ls -q --filter dangling=true | grep -E "^$BASE.*-data\$" || true
}

# Copies that are the same extension to Roon clash, even on different computers.
duplicates() {
  local name seen=() k
  for name in $(copies); do
    read_copy "$name"
    for k in "${seen[@]+"${seen[@]}"}"; do
      if [[ ${k%%=*} == "$C_KEY" ]]; then
        printf '\nWarning: %s and %s are the same extension\n' "${k#*=}" "$name"
        printf 'to Roon, so they clash. Uninstall one, or give it a name.\n'
      fi
    done
    seen+=("$C_KEY=$name")
  done
}

# A kept volume's copy, from its name: roon-extension-party-mode[-word][-name]-data.
# Prints the container name, then the name in Roon (the name's capitals are a guess).
kept_copy() {
  local rest=${1%-data} channel='' words
  rest=${rest#"$BASE"}; rest=${rest#-}
  if [[ $rest =~ ^(alpha|beta|rc)(-|$) ]]; then
    channel=${BASH_REMATCH[1]}; rest=${rest#"$channel"}; rest=${rest#-}
  fi
  words=$(sed 's/-/ /g; s/\b\(.\)/\u\1/g' <<<"$rest")
  printf '%s\n%s\n' "${1%-data}" "$(roon_name "$channel" "$words")"
}

image_has_data() {
  docker run --rm --network none --entrypoint sh "$1" -c 'test -d /data' 2>/dev/null
}

image_version() {
  local v
  v=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$1")
  if [[ ! $v =~ ^[0-9] ]]; then
    v=$(docker run --rm --network none --entrypoint node "$1" -p "require('./package.json').version" 2>/dev/null) || v=''
  fi
  printf '%s\n' "$v"
}

# --- Extension Manager ---

manager_state() {
  local state
  state=$(docker inspect -f '{{.State.Status}}' "$MANAGER" 2>/dev/null) || state=''
  printf '%s\n' "${state:-none}"
}

manager_words() {
  case $(manager_state) in
    none) echo "not installed" ;;
    running) echo "running" ;;
    *) echo "installed, not running" ;;
  esac
}

# The Manager's data: a volume (rem_data with its installer) or a folder.
manager_data() {
  docker inspect -f '{{range .Mounts}}{{if eq .Destination "'"$REM"'"}}{{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}' "$MANAGER"
}

# Runs a shell command in the Manager's data folder: in the Manager if it's
# running, else in a short-lived container from its image. With -i first, it
# reads stdin; without, it leaves stdin to the person answering.
in_manager_data() {
  local input=()
  if [[ $1 == -i ]]; then input=(-i); shift; fi
  if [[ $(manager_state) == running ]]; then
    docker exec "${input[@]+"${input[@]}"}" "$MANAGER" sh -c "cd $REM && $1"
  else
    # Without the warning Docker gives when the image's platform is recorded oddly.
    docker run --rm "${input[@]+"${input[@]}"}" --network none -v "$(manager_data):$REM" \
      --entrypoint sh "$(docker inspect -f '{{.Config.Image}}' "$MANAGER")" -c "cd $REM && $1" \
      2> >(grep -v "^WARNING: The requested image's platform" >&2)
  fi
}

# Files in the Manager's repos/ that name Party Mode's image.
local_entries() {
  in_manager_data "for f in repos/*; do if [ -f \"\$f\" ] && grep -q '\"$IMAGE\"' \"\$f\"; then echo \"\${f#repos/}\"; fi; done"
}

# Where Party Mode is in the Manager's settings: the category of the Manager's
# own list (read now, as the Manager does), or Local, for a local entry.
manager_category() {
  local list category
  list=$(official_list)
  category=$(awk -v repo="\"$IMAGE\"" '/"display_name"/ { name = $0 } /"extensions"/ { c = name }
    index($0, repo) { print c; exit }' <<<"$list" | sed 's/.*"display_name": *"\([^"]*\)".*/\1/')
  printf '%s\n' "${category:-Local}"
}

listed() {
  [[ $(manager_category) != Local ]]
}

# restart_manager "why": the Manager reads its entries only when it starts.
restart_manager() {
  if [[ $(manager_state) == running ]]; then
    progress "Restarting the Extension Manager, $1..."
    docker restart "$MANAGER" >/dev/null
  fi
}

entry_json() {
  cat <<EOF
[
    {
        "display_name": "Local",
        "extensions": [
            {
                "author": "Stubaggs",
                "display_name": "Party Mode",
                "description": "$DESCRIPTION",
                "image": {
                    "repo": "$IMAGE",
                    "tags": {
                        "amd64": "$1",
                        "arm": "$1",
                        "arm64": "$1"
                    },
                    "binds": [
                        "/usr/src/app/config.json"
                    ]
                }
            }
        ]
    }
]
EOF
}

# The Extension Manager and its copy, under a heading.
# Its own state goes on the heading, so the lines under it are Party Mode's.
manager_text() {
  local name where
  printf 'Extension Manager (%s)\n' "$(manager_words)"
  if [[ $(manager_state) == none ]]; then return 0; fi
  for name in $(copies_by manager); do copy_lines "$name"; done
  if [[ -n $(copies_by manager) ]]; then return 0; fi
  printf '  Party Mode isn'"'"'t installed with the Extension Manager.\n'
  # Where the Manager offers it: its own list, a local entry, or both.
  where=()
  if listed; then where+=("under $(manager_category)"); fi
  if [[ -n $(local_entries || true) ]]; then where+=("under Local"); fi
  case ${#where[@]} in
    1) printf '  The Extension Manager offers it to install, %s.\n' "${where[0]}" ;;
    2) printf '  The Extension Manager offers it to install, %s and %s.\n' "${where[@]}" ;;
  esac
}

# --- Versions ---

# Newest first, in semantic-version order: a release above its betas, and in a
# beta's suffix a number below a word (beta.rc1 after beta.12).
versions() {
  fetch "$TAGS_URL" 2>/dev/null | grep -o '"name": *"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/' |
    grep -E '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' | version_order | head -n 25 || true
}

version_order() {
  awk '{
    base = $0; pre = ""
    if (index($0, "-")) { base = substr($0, 1, index($0, "-") - 1); pre = substr($0, index($0, "-") + 1) }
    split(base, b, ".")
    key = sprintf("%05d.%05d.%05d", b[1], b[2], b[3])
    if (pre == "") key = key " z"
    else {
      key = key " a"
      n = split(pre, p, ".")
      for (i = 1; i <= n; i++) key = key (p[i] ~ /^[0-9]+$/ ? sprintf(".0%010d", p[i]) : ".1" p[i])
    }
    print key "\t" $0
  }' | LC_ALL=C sort -r | cut -f2
}

# Prints the chosen tag.
choose_tag() {
  local choice list=() v
  choice=$(menu "Which version of Party Mode?" \
    latest "Latest release (recommended)" \
    beta "Beta: the next version, for testing" \
    version "A particular version") || return 1
  if [[ $choice != version ]]; then printf '%s\n' "$choice"; return; fi
  while IFS= read -r v; do list+=("$v" "$v"); done < <(versions)
  if (( ${#list[@]} == 0 )); then
    msg "Couldn't read the list of versions from Docker Hub."
    return 1
  fi
  choice=$(menu "Which version? It stays on it: it isn't updated." "${list[@]}") || return 1
  printf '%s\n' "$choice"
}

# --- Status ---

# A copy in two lines, under a heading.
copy_lines() {
  local version
  read_copy "$1"
  version=$(copy_version)
  printf '  %s%s%s\n' "$(roon_name "$C_CHANNEL" "$C_INSTANCE")" "${version:+ $version}" \
    "$([[ $C_METHOD == compose ]] && echo ', Docker Compose')"
  printf '    %s: %s\n' "$1" "$(state_words)"
}

# Docker's copies and settings kept from an uninstall, then the Extension
# Manager's: two lines each, so a few fit one screen.
docker_text() {
  local name vol kept any=0
  printf 'Docker\n'
  for vol in $(unused_volumes); do
    any=1
    mapfile -t kept < <(kept_copy "$vol")
    printf '  %s\n    %s: settings only\n' "${kept[1]}" "${kept[0]}"
  done
  for name in $(copies_by docker); do any=1; copy_lines "$name"; done
  if (( ! any )); then printf '  Party Mode isn'"'"'t installed with Docker.\n'; fi
}

status_text() {
  docker_text
  printf '\n'
  manager_text
  if mixed; then
    printf '\n%s Choose Fix in the menu.\n' "$ONE_WAY"
  fi
  duplicates
}

# --- Choosing a copy ---

# pick_copy "question" manager|docker: prints a container's name; fails on Back
# (or if none).
pick_copy() {
  local text=$1 name items=()
  for name in $(copies_by "$2"); do
    read_copy "$name"
    items+=("$name" "$(roon_name "$C_CHANNEL" "$C_INSTANCE")")
  done
  if (( ${#items[@]} == 0 )); then return 1; fi
  if (( ${#items[@]} == 2 )); then printf '%s\n' "${items[0]}"; return; fi
  menu "$text" "${items[@]}"
}

restart() {
  local name
  if [[ -z $(copies_by "$1") ]]; then msg "Party Mode isn't installed this way."; return 0; fi
  name=$(pick_copy "Restart which copy?" "$1") || return 0
  progress "Restarting $name..."
  docker restart "$name" >/dev/null
  wait_ready "$name"
}

# wait_ready name [new [more]]: waits up to 90 s for the web server to start,
# or the container to stop. A new copy also gets the step in Roon, then more.
wait_ready() {
  local name=$1 i roon=''
  progress "Waiting for $name to start..."
  for (( i = 0; i < 45; i++ )); do
    if [[ $(docker inspect -f '{{.State.Status}}' "$name") != running ]]; then break; fi
    if listening "$name"; then break; fi
    sleep 2
  done
  read_copy "$name"
  if [[ $C_STATE != running ]]; then
    msg "Party Mode stopped. The end of its log:

$(docker logs --tail 12 "$name" 2>&1 | sed 's/^/ /')"
    return 0
  fi
  if [[ ${2:-} == new ]]; then
    roon="

In Roon, open Settings > Extensions to enable and configure it.${3:+

$3}"
  fi
  msg "$(roon_name "$C_CHANNEL" "$C_INSTANCE") $(copy_version) has started.$roon"
}

# --- With Docker ---

# Asks for a copy's name until it's one no copy of this version uses.
ask_instance() {
  local channel=$1 name key other c
  while true; do
    name=$(answer "A name for this copy, such as Garden: letters, digits and spaces.
Roon shows it as $(roon_name "$channel" Garden), a separate extension
with its own settings and zone.") || return 1
    name=$(printf '%s' "$name" | sed 's/^ *//; s/ *$//')
    if [[ ! $name =~ ^[A-Za-z0-9][A-Za-z0-9\ -]{0,29}$ ]]; then
      msg "Use letters, digits, spaces and hyphens only, up to 30."
      continue
    fi
    key="$channel/$(slug "$name")"
    other=''
    for c in $(copies); do
      read_copy "$c"
      if [[ $C_KEY == "$key" ]]; then other=$c; fi
    done
    if [[ -n $other ]]; then
      msg "$(roon_name "$channel" "$name") is already installed ($other).
Choose another name."
      continue
    fi
    printf '%s\n' "$name"
    return 0
  done
}

# install_docker [named]: with "named", asks for a name first.
install_docker() {
  local tag ref version channel instance='' other name vol c env=()
  if [[ -n $(copies_by manager) ]]; then
    msg "$ONE_WAY Party Mode is installed with the Extension Manager here:
uninstall it there first, or keep using the Extension Manager."
    return 0
  fi
  tag=$(choose_tag) || return 0
  ref=$IMAGE:$tag
  progress "Downloading $ref..."
  if ! docker pull "$ref"; then
    msg "Couldn't download $ref."
    return 0
  fi
  version=$(image_version "$ref")
  channel=$(channel_of "$version")
  if [[ ${1:-} == named ]]; then
    instance=$(ask_instance "$channel") || return 0
  else
    other=''
    for c in $(copies); do
      read_copy "$c"
      if [[ $C_KEY == "$channel/" ]]; then other=$c; fi
    done
    if [[ -n $other ]]; then
      read_copy "$other"
      ask "$(roon_name "$channel") is already installed ($other, with
$(method_name "$C_METHOD")). Another copy of it would clash in Roon.

To hold another party at the same time, in another zone, install another
copy with a name of its own. Do that?" "Name it" "Cancel" || return 0
      instance=$(ask_instance "$channel") || return 0
    fi
  fi
  if ! image_has_data "$ref"; then
    ask "Party Mode $version keeps its settings inside its container, so they
don't carry over to the next version: after updating, you choose them again
in Roon. From 1.4.0 they're kept." "Install" "Cancel" || return 0
  fi
  name=$BASE${channel:+-$channel}
  if [[ -n $instance ]]; then name+="-$(slug "$instance")"; fi
  vol=$name-data
  if docker inspect "$name" >/dev/null 2>&1; then
    msg "There's already a container called $name. Remove it first."
    return 0
  fi
  progress "Starting $(roon_name "$channel" "$instance")..."
  if [[ -n $instance ]]; then env=(-e "ROON_EXTENSION_PARTY_MODE_INSTANCE=$instance"); fi
  if ! run_container "$name" "$ref" -v "$vol:/data" "${env[@]+"${env[@]}"}"; then
    docker rm -f "$name" >/dev/null 2>&1 || true
    msg "Docker couldn't start Party Mode (see above)."
    return 0
  fi
  # So the Manager doesn't offer Party Mode to install beside it.
  if [[ $(manager_state) == running ]] && ! listed && [[ -n $(local_entries || true) ]]; then
    for c in $(local_entries || true); do remove_entry_file "$c" || true; done
    restart_manager "so it no longer offers Party Mode"
  fi
  wait_ready "$name" new
}

# run_container name image [docker run options…]: the README's options;
# read-only where the image keeps its settings in /data. The log driver is
# named: DietPi's Docker defaults to journald, which refuses the size options.
# The memory limit only where Docker can apply it: Raspberry Pi kernels start
# without it, and Docker would warn that it's discarded.
run_container() {
  local name=$1 ref=$2 ro=() mem=(); shift 2
  if image_has_data "$ref"; then ro=(--read-only); fi
  if [[ $(docker info --format '{{.MemoryLimit}}' 2>/dev/null) == true ]]; then mem=(--memory 512m); fi
  docker run -d --name "$name" --network host --restart unless-stopped \
    --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
    "${ro[@]+"${ro[@]}"}" "${mem[@]+"${mem[@]}"}" --cap-drop ALL --security-opt no-new-privileges \
    "$@" "$ref" >/dev/null
}

compose() {
  local files=() f args=(-p "$C_PROJECT")
  IFS=',' read -r -a files <<<"$C_FILES"
  for f in "${files[@]}"; do args+=(-f "$f"); done
  if docker compose version >/dev/null 2>&1; then
    (cd "$C_DIR" && docker compose "${args[@]}" "$@")
  elif have docker-compose; then
    (cd "$C_DIR" && docker-compose "${args[@]}" "$@")
  else
    msg "Docker Compose isn't installed, so this copy can't be changed from here."
    return 1
  fi
}

update_docker() {
  local name tag ref new old_id mount=() env=() e
  if [[ -z $(copies_by docker) ]]; then msg "Party Mode isn't installed with Docker."; return 0; fi
  name=$(pick_copy "Update which copy?" docker) || return 0
  read_copy "$name"
  if [[ $C_METHOD == compose ]]; then
    progress "Updating $name with Docker Compose..."
    if compose pull && compose up -d; then wait_ready "$name"; else msg "Docker Compose couldn't update it (see above)."; fi
    return 0
  fi
  tag=${C_IMAGE##*:}
  if [[ $C_IMAGE != *:* ]]; then tag=latest; fi
  if [[ $tag != latest && $tag != beta ]]; then
    ask "$name stays on version $tag. Choose another version?" || return 0
    tag=$(choose_tag) || return 0
  fi
  if [[ -n $C_DATA ]]; then
    mount=(-v "$C_DATA:$C_DATA_DEST")
  else
    ask "$name keeps its settings inside its container, so they don't carry
over: after updating, you choose them again in Roon." "Update" "Cancel" || return 0
    mount=(-v "$name-data:/data")
  fi
  ref=$IMAGE:$tag
  progress "Downloading $ref..."
  if ! docker pull "$ref"; then
    msg "Couldn't download $ref."
    return 0
  fi
  new=$(docker image inspect -f '{{.Id}}' "$ref")
  if [[ $new == "$C_IMAGE_ID" ]]; then
    msg "$name is up to date ($(copy_version))."
    return 0
  fi
  old_id=$C_IMAGE_ID
  for e in "${C_ENV[@]+"${C_ENV[@]}"}"; do env+=(-e "$e"); done
  progress "Replacing $name..."
  docker stop "$name" >/dev/null
  docker rename "$name" "$name-old"
  if ! run_container "$name" "$ref" "${mount[@]}" "${env[@]+"${env[@]}"}"; then
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker rename "$name-old" "$name"
    docker start "$name" >/dev/null
    msg "Couldn't start the new version, so the old one is running again."
    return 0
  fi
  docker rm "$name-old" >/dev/null
  docker image rm "$old_id" >/dev/null 2>&1 || true
  wait_ready "$name"
}

# Whether to keep a copy's settings: prints "keep" or "all"; fails on Back.
how_much() {
  menu "Uninstall $1:" \
    keep "Party Mode only: keep its settings for a reinstall" \
    all "Everything: its settings and Roon's pairing too"
}

uninstall_docker() {
  local name items=() vol choice how image data type kept
  for name in $(copies_by docker); do
    read_copy "$name"
    items+=("copy:$name" "$(roon_name "$C_CHANNEL" "$C_INSTANCE")")
  done
  for vol in $(unused_volumes); do
    mapfile -t kept < <(kept_copy "$vol")
    items+=("volume:$vol" "${kept[1]}: settings only")
  done
  if (( ${#items[@]} == 0 )); then
    msg "Party Mode isn't installed with Docker, and nothing of it is left."
    return 0
  fi
  choice=$(menu "Uninstall which copy?" "${items[@]}") || return 0
  case $choice in
    volume:*)
      ask "Remove the volume ${choice#volume:}, with the settings and Roon's
pairing in it?" || return 0
      docker volume rm "${choice#volume:}" >/dev/null
      msg "Removed."
      return 0 ;;
  esac
  read_copy "${choice#copy:}"
  how=$(how_much "$C_NAME") || return 0
  msg "$(remove_docker_copy "${choice#copy:}" "$how")"
}

# remove_docker_copy name keep|all: removes a copy run with Docker; prints
# what's left to do, if anything.
remove_docker_copy() {
  local name image data type
  read_copy "$1"
  if [[ $C_METHOD == compose ]]; then
    progress "Removing $C_PROJECT..."
    if [[ $2 == all ]]; then compose down -v --rmi all >&2; else compose down --rmi all >&2; fi ||
      { echo "Docker Compose couldn't remove $1 (see above)."; return 0; }
    echo "Removed. Delete the folder $C_DIR yourself."
    return 0
  fi
  # By its tag: an image ID with more than one tag can't be removed.
  name=$C_NAME image=$C_IMAGE data=$C_DATA type=$C_DATA_TYPE
  docker rm -f "$name" >/dev/null
  docker image rm "$image" >/dev/null 2>&1 || true
  if [[ $2 == keep ]]; then
    echo "Removed. Its settings are kept${data:+ ($data)}: installing it again
with the same name picks them up."
  elif [[ $type == volume ]]; then
    docker volume rm "$data" >/dev/null
    echo "Removed."
  elif [[ -n $data ]]; then
    echo "Removed. Its settings are in $data: delete it yourself."
  else
    echo "Removed."
  fi
}

# --- Both ways on one computer ---

# The Manager's copy beside copies run with Docker: the Manager can't finish
# installing or updating its copy (see ONE_WAY).
mixed() {
  [[ -n $(copies_by manager) && -n $(copies_by docker) ]]
}

fix_mixed() {
  local keep how name mcopy entries notes=''
  keep=$(menu "Party Mode is installed with Docker and with the Extension Manager
here. $ONE_WAY Which to keep?" \
    docker "Docker: remove the Extension Manager's copy" \
    manager "The Extension Manager: remove the copies run with Docker") || return 0
  mcopy=$(copies_by manager)
  if [[ $keep == docker ]]; then
    # The Manager's copy is the Manager's to remove.
    while [[ -n $(copies_by manager) ]]; do
      ask "Uninstall Party Mode with the Extension Manager, so it runs only with
Docker.

$(in_roon Uninstall)" "Done: check" "Cancel" || return 0
    done
    # Without its entry, Party Mode isn't offered in the Manager to install again.
    entries=$(local_entries || true)
    for name in $entries; do remove_entry_file "$name" || true; done
    if [[ -n $entries ]]; then restart_manager "so it no longer offers Party Mode"; fi
    msg "Party Mode runs with Docker here."
    return 0
  fi
  how=$(how_much "the copies run with Docker") || return 0
  for name in $(copies_by docker); do
    notes+="$(remove_docker_copy "$name" "$how")"$'\n'
  done
  read_copy "$mcopy"
  if [[ $C_STATE == created ]]; then
    msg "Removed the copies run with Docker. The Extension Manager's install had
stalled: uninstall Party Mode with it, then install it again.

$(in_roon Uninstall)

Then set Action to Install, and Save again."
  else
    msg "Removed the copies run with Docker. Party Mode runs with the Extension
Manager here."
  fi
  if [[ $notes == *yourself* ]]; then msg "$(grep yourself <<<"$notes")"; fi
}


docker_menu() {
  local choice items text n
  while true; do
    items=(install "Install Party Mode"
      named "Install another copy, with its own name (such as Garden)")
    n=$(copies_by docker | wc -l)
    if (( n > 3 )); then
      text="Docker"$'\n'"  $n copies are installed (see Status)."
    else
      text=$(docker_text)
    fi
    if (( n > 0 )); then items+=(update "Update" restart "Restart"); fi
    if (( n > 0 )) || [[ -n $(unused_volumes) ]]; then items+=(uninstall "Uninstall"); fi
    choice=$(menu "$text" "${items[@]}") || return 0
    case $choice in
      install) install_docker ;;
      named) install_docker named ;;
      update) update_docker ;;
      restart) restart docker ;;
      uninstall) uninstall_docker ;;
    esac
  done
}

# --- With the Extension Manager ---
# The Manager installs only the latest release: all it can offer once Party
# Mode is in its own list. Until then, a local entry in its data names it.

# Once Party Mode is in the Manager's own list, a local entry would list it
# twice, so it goes. Only a beta the Manager installed from an older entry (the
# README's steps) needs anything done, in Roon.
tidy_entries() {
  local entries name c beta=0
  if ! listed; then return 0; fi
  entries=$(local_entries || true)
  if [[ -z $entries ]]; then return 0; fi
  msg "The Extension Manager now offers Party Mode under $(manager_category), from
its own list, so it no longer needs to offer it under Local."
  for name in $entries; do remove_entry_file "$name" || true; done
  restart_manager "so it no longer offers Party Mode under Local"
  for c in $(copies_by manager); do
    read_copy "$c"
    if [[ -n $C_CHANNEL ]]; then beta=1; fi
  done
  if (( beta )); then
    msg "The Extension Manager now lists Party Mode itself, under the
$(manager_category) category, for the latest release. To move to it, uninstall
Party Mode (beta) in Roon, then install Party Mode there again."
  fi
}

# in_roon Install|Uninstall: where to do it. The Manager installs,
# updates and uninstalls its copy itself; the program only points there.
in_roon() {
  printf '%s\n' "In Roon, open Settings > Extensions, then the Extension Manager's
Settings. Under the $(manager_category) category, choose Party Mode. Below
its description, set Action to $1, then Save."
}

# Each action fails only on Cancel, so the menu shows again; once it's done,
# the main menu does.
install_manager() {
  local name
  if [[ -n $(copies_by manager) ]]; then
    msg "The Extension Manager has already installed Party Mode. It runs one
copy: for more, install them with Docker."
    return 0
  fi
  if [[ -n $(copies_by docker) ]]; then
    msg "$ONE_WAY Party Mode is installed with Docker here: uninstall it
there first, or keep using Docker."
    return 0
  fi
  # The Manager reads its entries only when it starts: restart it only when
  # the entry changes.
  if ! listed && ! has_entry; then
    for name in $(local_entries || true); do remove_entry_file "$name" || return 0; done
    entry_json latest | in_manager_data -i "mkdir -p repos && cat > 'repos/$ENTRY_FILE'"
    restart_manager "so it offers Party Mode"
  fi
  while [[ -z $(copies_by manager) ]]; do
    ask "Party Mode is ready to install with the Extension Manager.

$(in_roon Install)

Downloading it can take a few minutes, with no change in Roon's status
until it's done. Choose Done: check once Roon shows Party Mode installed." \
      "Done: check" "Cancel" || return 1
  done
  wait_ready "$(copies_by manager)" new "$MANAGE"
}

# Whether this program's entry, as it would write it now, is the only one.
has_entry() {
  [[ $(local_entries || true) == "$ENTRY_FILE" ]] &&
    [[ $(in_manager_data "cat 'repos/$ENTRY_FILE'") == "$(entry_json latest)" ]]
}

remove_entry_file() {
  if [[ $(in_manager_data "grep -o '\"repo\"' 'repos/$1' | wc -l") -gt 1 ]]; then
    msg "$1 in the Extension Manager's repos folder lists other extensions
too, so it's left as it is. Remove Party Mode from it yourself."
    return 1
  fi
  in_manager_data "rm -f 'repos/$1'"
}

uninstall_manager() {
  local entries name offered=''
  while [[ -n $(copies_by manager) ]]; do
    ask "Uninstall Party Mode with the Extension Manager.

$(in_roon Uninstall)" "Done: check" "Cancel" || return 1
  done
  # Without its entry, the Manager no longer lists Party Mode in Roon.
  entries=$(local_entries || true)
  for name in $entries; do remove_entry_file "$name" || true; done
  if [[ -n $entries ]]; then
    restart_manager "so it no longer offers Party Mode"
    if ! listed; then offered=", and it's no longer offered there"; fi
  fi
  msg "Party Mode has been uninstalled from the Extension Manager$offered."
}

# Removes the local entry while Party Mode isn't installed (after an uninstall
# in Roon, or an install not finished).
unoffer_manager() {
  local name
  for name in $(local_entries || true); do remove_entry_file "$name" || return 0; done
  restart_manager "so it no longer offers Party Mode under Local"
  msg "The Extension Manager no longer offers Party Mode under Local."
}

manager_menu() {
  local choice items text
  if [[ $(manager_state) == none ]]; then
    msg "The Extension Manager isn't installed. On DietPi, install it with
dietpi-software (Roon Extension Manager). On other Linux, see
https://github.com/TheAppgineer/roon-extension-manager/wiki

Or install Party Mode with Docker."
    return 0
  fi
  if [[ $(manager_state) != running ]]; then
    msg "The Extension Manager isn't running. Start it, then choose this again."
    return 0
  fi
  tidy_entries
  while true; do
    text=$(manager_text)
    items=()
    if [[ -z $(copies_by manager) ]]; then
      items+=(install "Install Party Mode")
      if ! listed && [[ -n $(local_entries || true) ]]; then
        items+=(unoffer "Stop offering Party Mode under Local in the Extension Manager")
      fi
    else
      text+=$'\n\n'"$MANAGE"
      items+=(uninstall "Uninstall")
    fi
    choice=$(menu "$text" "${items[@]}") || return 0
    case $choice in
      install) install_manager || continue ;;
      unoffer) unoffer_manager ;;
      uninstall) uninstall_manager || continue ;;
    esac
    return 0
  done
}

# --- Main ---

# The version of the setup program online, if it's later than this one: an
# older copy kept on the computer may not know what the current one does. Quiet
# if it can't tell.
newer_setup() {
  local online
  online=$(fetch "$SETUP_URL" 2>/dev/null | sed -n 's/^SETUP_VERSION=\([0-9][0-9.]*\)$/\1/p' | head -n 1) || return 1
  [[ -n $online && $online != "$SETUP_VERSION" ]] || return 1
  [[ $(printf '%s\n%s\n' "$SETUP_VERSION" "$online" | sort -V | tail -n 1) == "$online" ]] || return 1
  printf '%s\n' "$online"
}

main_menu() {
  local choice manager fix online title="Party Mode: a Roon extension for parties."
  if online=$(newer_setup); then
    title+=$'\n\n'"Setup program $online is available (this is $SETUP_VERSION): download it"$'\n'"again (see the README)."
  fi
  if (( ! WHIPTAIL )); then printf '%s\n' "$TITLE" >&2; fi
  while true; do
    manager="With the Extension Manager"
    if [[ $(manager_state) == none ]]; then manager+=" (not installed)"; fi
    fix=()
    if mixed; then fix=(fix "Fix: Party Mode is installed both ways here"); fi
    choice=$(BACK=Finish menu "$title" \
      "${fix[@]+"${fix[@]}"}" \
      status "Status: what's installed" \
      docker "With Docker: install, update, uninstall" \
      manager "$manager") || break
    case $choice in
      fix) fix_mixed ;;
      status) msg "$(status_text)" ;;
      docker) docker_menu ;;
      manager) manager_menu ;;
    esac
  done
  if (( WHIPTAIL )); then clear; fi
}

usage() {
  printf 'Party Mode setup %s\n\n' "$SETUP_VERSION"
  sed -n '/^#   bash/s/^#   //p' "$0"
}

main() {
  local action=''
  while (( $# )); do
    case $1 in
      --status) action=status ;;
      --help | -h) usage; return 0 ;;
      *) printf 'Unknown option: %s\n\n' "$1" >&2; usage >&2; return 2 ;;
    esac
    shift
  done
  # whiptail needs to know the terminal; without that, plain prompts.
  if [[ -z $action && -t 0 && -t 1 && -n ${TERM:-} && $TERM != dumb ]] && have whiptail; then
    WHIPTAIL=1
  fi
  LIST_FILE=$(mktemp)
  trap 'rm -f "$LIST_FILE"' EXIT
  check_docker
  case $action in
    status) status_text ;;
    *)
      if [[ ! -t 0 ]]; then die "Run this in a terminal, or with --status."; fi
      main_menu ;;
  esac
}

main "$@"
