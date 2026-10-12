#!/bin/sh
# Dienstrooster's updater: the one container that may tell Docker what to
# run, so the web app never has to. It
#
# - looks up which version the tag this installation follows (stable, or
#   ROOSTER_VERSION from .env) points at in the registry, every
#   CHECK_EVERY seconds and whenever the app asks (a file `controleren`);
# - writes what it knows to /data/update/status.json for the app to show;
# - updates when a beheerder pressed "Bijwerken" (a file `bijwerken.json`
#   with the version they saw): pull, restart web/solver/caddy, wait until
#   they are healthy, and put the previous images back if they are not.
#
# It takes no other orders. The app (running as `node`) can only drop
# those two files, and their content is never more than a version number
# that must match what the registry says right now - so whoever gets hold
# of the web container can at most trigger the update a beheerder could.
# The app makes the database backup itself before it asks (lib/appUpdate.ts).
#
# docker compose runs here with the installation folder mounted at
# /rooster and the host's own paths passed as --project-directory, so every
# relative path in docker-compose.yml (./data, ...) still means the host
# folder it means when IT runs compose by hand. The project name, folder
# and compose files come from this container's own compose labels.

set -u

DIR=/data/update
STATUS="$DIR/status.json"
REQUEST="$DIR/bijwerken.json"
# The images from before the pull while an update runs, so a restart of
# this container halfway can still put them back. In this container's own
# filesystem (kept across a restart of the container), not in $DIR, which
# the app can write: these get tagged and started.
PREVIOUS=/var/lib/rooster-updater/vorige-images
CHECK_REQUEST="$DIR/controleren"
MOUNT=/rooster
CHECK_EVERY=${CHECK_EVERY:-21600}
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-300}
SERVICES="web solver caddy"
VERSION_LABEL=org.opencontainers.image.version
ACCEPT='application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json'

log() { echo "[updater] $*"; }
# Waits that a stop signal can cut short (a plain foreground sleep holds
# the trap until it ends, and Docker kills the container after 10 seconds).
pause() { sleep "$1" & wait $!; }
trap 'log gestopt; exit 0' TERM INT
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
is_version() { printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; }

# ---- state, written to status.json -------------------------------------

BESCHIKBAAR=""
GECONTROLEERD_OP=""
CONTROLE_FOUT=""
BEZIG=null
LAATSTE=null
UPDATER_VERSIE=""
VOLGT=""

write_status() {
  tmp=$(mktemp "$DIR/.status.XXXXXX") || return
  jq -n \
    --arg levend "$(now_iso)" \
    --arg updater "$UPDATER_VERSIE" \
    --arg volgt "$VOLGT" \
    --arg beschikbaar "$BESCHIKBAAR" \
    --arg gecontroleerd "$GECONTROLEERD_OP" \
    --arg fout "$CONTROLE_FOUT" \
    --argjson bezig "$BEZIG" \
    --argjson laatste "$LAATSTE" \
    'def leeg: if . == "" then null else . end;
     {levend_op: $levend, updater: ($updater|leeg), volgt: ($volgt|leeg),
      beschikbaar: ($beschikbaar|leeg), gecontroleerd_op: ($gecontroleerd|leeg),
      controle_fout: ($fout|leeg), bezig: $bezig, laatste: $laatste}' > "$tmp" \
    && chmod 644 "$tmp" && mv -f "$tmp" "$STATUS" || rm -f "$tmp"
}

set_bezig() { # naar stap
  BEZIG=$(jq -nc --arg naar "$1" --arg stap "$2" --arg sinds "$BEZIG_SINDS" '{naar: $naar, stap: $stap, sinds: $sinds}')
  write_status
}

finish() { # uitkomst reden van naar
  LAATSTE=$(jq -nc --arg u "$1" --arg r "$2" --arg van "$3" --arg naar "$4" --arg op "$(now_iso)" \
    'def leeg: if . == "" then null else . end;
     {uitkomst: $u, reden: ($r|leeg), van: ($van|leeg), naar: ($naar|leeg), op: $op}')
  BEZIG=null
  rm -f "$PREVIOUS"
  write_status
  log "bijwerken naar $4: $1 ${2:+($2)}"
}

# ---- the compose project this container belongs to ---------------------

label() { # container label
  docker inspect -f "{{index .Config.Labels \"$2\"}}" "$1" 2>/dev/null
}

# This container's id: from the files Docker mounts into every container
# (/etc/hostname and friends live under .../containers/<id>/), which also
# holds when the hostname is not the id (network_mode: host, hostname:).
own_id() {
  id=$(grep -o '/containers/[0-9a-f]\{64\}/' /proc/self/mountinfo 2>/dev/null | head -n 1 | cut -d/ -f3)
  [ -n "$id" ] && echo "$id" || hostname
}

discover() {
  SELF=$(own_id)
  PROJECT=$(label "$SELF" com.docker.compose.project)
  WORKDIR=$(label "$SELF" com.docker.compose.project.working_dir)
  CONFIG_FILES=$(label "$SELF" com.docker.compose.project.config_files)
  SELF_IMAGE=$(docker inspect -f '{{.Image}}' "$SELF" 2>/dev/null)
  UPDATER_REF=$(docker inspect -f '{{.Config.Image}}' "$SELF" 2>/dev/null)
  UPDATER_VERSIE=$(docker image inspect -f "{{index .Config.Labels \"$VERSION_LABEL\"}}" "$SELF_IMAGE" 2>/dev/null)
  [ -n "$PROJECT" ] && [ -n "$WORKDIR" ] && [ -n "$CONFIG_FILES" ] && [ -f "$MOUNT/$(basename "$(echo "$CONFIG_FILES" | cut -d, -f1)")" ]
}

# docker compose as IT would run it in the installation folder: the host's
# paths for everything relative, the files read through the mount. A clean
# environment, so nothing of this container's own leaks into interpolation.
compose() {
  set -- --project-directory "$WORKDIR" -p "$PROJECT" "$@"
  old_ifs=$IFS; IFS=,
  files=""
  for f in $CONFIG_FILES; do
    case "$f" in
      "$WORKDIR"/*) files="$files -f $MOUNT/${f#"$WORKDIR"/}" ;;
      "$MOUNT"/*) files="$files -f $f" ;;
      *) IFS=$old_ifs; log "composebestand buiten de installatiemap: $f"; return 1 ;;
    esac
  done
  IFS=$old_ifs
  envfile=""
  [ -f "$MOUNT/.env" ] && envfile="--env-file $MOUNT/.env"
  # shellcheck disable=SC2086 # paths in the installation folder hold no spaces
  env -i PATH="$PATH" HOME=/root docker compose $files $envfile "$@"
}

container_of() { # service
  docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$1" | head -n 1
}

# ---- what the registry says --------------------------------------------

# ghcr.io/alitemu/rooster-web:stable -> host, repository, tag
split_ref() {
  REF_HOST=${1%%/*}
  rest=${1#*/}
  case "$rest" in
    *:*) REF_REPO=${rest%:*}; REF_TAG=${rest##*:} ;;
    *) REF_REPO=$rest; REF_TAG=latest ;;
  esac
  case "$REF_HOST" in
    localhost:*|127.0.0.1:*) REF_SCHEME=http ;;
    *) REF_SCHEME=https ;;
  esac
}

registry_token() {
  auth=$(curl -sS -m 20 -o /dev/null -D - "$REF_SCHEME://$REF_HOST/v2/" | tr -d '\r' | grep -i '^www-authenticate: *bearer' | head -n 1)
  [ -z "$auth" ] && return 0
  realm=$(printf '%s' "$auth" | sed -n 's/.*realm="\([^"]*\)".*/\1/p')
  service=$(printf '%s' "$auth" | sed -n 's/.*service="\([^"]*\)".*/\1/p')
  curl -fsS -m 20 -G "$realm" --data-urlencode "service=$service" --data-urlencode "scope=repository:$REF_REPO:pull" \
    | jq -r '.token // .access_token // empty'
}

registry_get() { # path
  if [ -n "$TOKEN" ]; then
    curl -fsSL -m 60 -H "Accept: $ACCEPT" -H "Authorization: Bearer $TOKEN" "$REF_SCHEME://$REF_HOST/v2/$REF_REPO/$1"
  else
    curl -fsSL -m 60 -H "Accept: $ACCEPT" "$REF_SCHEME://$REF_HOST/v2/$REF_REPO/$1"
  fi
}

# The version label of the image a reference points at, amd64/arm64 alike.
registry_version() { # ref
  split_ref "$1"
  TOKEN=$(registry_token) || return 1
  manifest=$(registry_get "manifests/$REF_TAG") || return 1
  if printf '%s' "$manifest" | jq -e '.manifests' > /dev/null 2>&1; then
    case "$(uname -m)" in aarch64) arch=arm64 ;; *) arch=amd64 ;; esac
    digest=$(printf '%s' "$manifest" | jq -r --arg a "$arch" \
      '[.manifests[] | select(.platform.os == "linux" and .platform.architecture == $a)][0].digest // empty')
    [ -n "$digest" ] || return 1
    manifest=$(registry_get "manifests/$digest") || return 1
  fi
  config=$(printf '%s' "$manifest" | jq -r '.config.digest // empty')
  [ -n "$config" ] || return 1
  registry_get "blobs/$config" | jq -r --arg l "$VERSION_LABEL" '.config.Labels[$l] // empty'
}

check() {
  web=$(container_of web)
  if [ -z "$web" ]; then
    CONTROLE_FOUT=GEEN_WEB
  else
    WEB_REF=$(docker inspect -f '{{.Config.Image}}' "$web")
    split_ref "$WEB_REF"
    VOLGT=$REF_TAG
    found=$(registry_version "$WEB_REF" 2>/dev/null)
    if is_version "$found"; then
      BESCHIKBAAR=$found
      CONTROLE_FOUT=""
    else
      CONTROLE_FOUT=REGISTER_ONBEREIKBAAR
      log "kon de versie van $WEB_REF niet opvragen"
    fi
  fi
  GECONTROLEERD_OP=$(now_iso)
  write_status
}

# ---- updating ----------------------------------------------------------

running_version() { # service
  c=$(container_of "$1")
  [ -n "$c" ] && docker image inspect -f "{{index .Config.Labels \"$VERSION_LABEL\"}}" "$(docker inspect -f '{{.Image}}' "$c")" 2>/dev/null
}

wait_healthy() { # service
  end=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while [ "$(date +%s)" -lt "$end" ]; do
    c=$(container_of "$1")
    state=$( [ -n "$c" ] && docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null)
    case "$state" in
      healthy|running) return 0 ;;
      unhealthy|exited|dead) return 1 ;;
    esac
    pause 3
  done
  return 1
}

all_healthy() {
  for s in $SERVICES; do wait_healthy "$s" || { log "$s is niet gezond"; return 1; }; done
}

# Each service's image id and the reference it runs under, from before the
# pull, so they can be put back under that same name.
remember_images() {
  OLD=""
  for s in $SERVICES updater; do
    c=$(container_of "$s")
    [ -n "$c" ] || continue
    OLD="$OLD $s=$(docker inspect -f '{{.Image}}' "$c")@$(docker inspect -f '{{.Config.Image}}' "$c")"
  done
}

restore_tags() {
  for entry in $OLD; do
    image=${entry#*=}
    docker tag "${image%%@*}" "${image#*@}" || return 1
  done
}

update() {
  if [ ! -f "$REQUEST" ] || [ -L "$REQUEST" ]; then rm -f "$REQUEST"; return; fi
  naar=$(jq -r '.versie // empty' "$REQUEST" 2>/dev/null)
  rm -f "$REQUEST"
  BEZIG_SINDS=$(now_iso)
  van=$(running_version web)
  if ! is_version "$naar"; then finish AFGEBROKEN ONGELDIG "$van" ""; return; fi

  set_bezig "$naar" CONTROLEREN
  check
  if [ "$BESCHIKBAAR" != "$naar" ] || [ -n "$CONTROLE_FOUT" ]; then
    finish AFGEBROKEN ANDERE_VERSIE "$van" "$naar"
    return
  fi

  remember_images
  printf '%s\n' $OLD > "$PREVIOUS"
  set_bezig "$naar" OPHALEN
  if ! compose pull --quiet $SERVICES updater; then
    restore_tags
    finish AFGEBROKEN OPHALEN "$van" "$naar"
    return
  fi

  set_bezig "$naar" HERSTARTEN
  if compose up -d $SERVICES && all_healthy && [ "$(running_version web)" = "$naar" ]; then
    finish GELUKT "" "$van" "$naar"
    # Old images are untagged now; without this the disk fills up release by release.
    source_label=$(label "$(container_of web)" org.opencontainers.image.source)
    [ -n "$source_label" ] && docker image prune -f --filter "label=org.opencontainers.image.source=$source_label" > /dev/null
    replace_self
    return
  fi

  log "de nieuwe versie start niet goed; terug naar de vorige"
  set_bezig "$naar" TERUGZETTEN
  if restore_tags && compose up -d $SERVICES && all_healthy; then
    finish TERUGGEZET GEEN_START "$van" "$naar"
  else
    finish MISLUKT GEEN_START "$van" "$naar"
  fi
}

# A container can't recreate itself (compose would stop it halfway), so a
# short-lived one does it from the new image, with the installation folder
# at its own host path. Meanwhile this one takes no more requests: one
# picked up now would be cut off halfway when it is stopped. A request
# that comes in meanwhile is for the new updater (see the start below).
# Should the swap not happen within a minute, this one carries on.
replace_self() {
  new=$(docker image inspect -f '{{.Id}}' "$UPDATER_REF" 2>/dev/null)
  [ -n "$new" ] && [ "$new" != "$SELF_IMAGE" ] || return 0
  files=""
  old_ifs=$IFS; IFS=,
  for f in $CONFIG_FILES; do files="$files -f $f"; done
  IFS=$old_ifs
  log "de updater zelf gaat over op de nieuwe versie"
  # shellcheck disable=SC2086
  docker run -d --rm --name "$PROJECT-updater-wissel" \
    -v /var/run/docker.sock:/var/run/docker.sock -v "$WORKDIR:$WORKDIR:ro" -w "$WORKDIR" \
    --entrypoint /bin/sh "$new" -c 'sleep 3; exec env -i PATH="$PATH" HOME=/root docker compose "$@" up -d --no-deps updater' \
    wissel -p "$PROJECT" $files > /dev/null || return 0
  pause 60
  log "de nieuwe updater is niet gestart; deze gaat door"
}

# ---- main loop ---------------------------------------------------------

mkdir -p "$DIR" "$(dirname "$PREVIOUS")"
# The app writes its requests here as `node` (uid 1000). chmod first: once
# the folder is node's, root without CAP_FOWNER may no longer change it.
chmod 755 "$DIR" 2>/dev/null
chown 1000:1000 "$DIR" 2>/dev/null

was=null
if [ -f "$STATUS" ]; then
  LAATSTE=$(jq -c '.laatste // null' "$STATUS" 2>/dev/null || echo null)
  was=$(jq -c '.bezig // null' "$STATUS" 2>/dev/null || echo null)
fi
[ -z "$LAATSTE" ] && LAATSTE=null
[ -z "$was" ] && was=null

if ! discover; then
  CONTROLE_FOUT=NIET_VIA_COMPOSE
  log "niet gestart met docker compose, of de installatiemap is niet op $MOUNT gekoppeld"
  while true; do write_status; pause 60; done
fi
log "project $PROJECT in $WORKDIR"

# Stopped in the middle of an update (the server restarted): back to the
# images from before it, so what runs and what `docker compose up -d`
# would start agree again, and say so rather than leave the app showing
# an update that is never going to finish.
if [ "$was" != null ]; then
  log "het vorige bijwerken is onderbroken; terug naar de versie van daarvoor"
  if [ -f "$PREVIOUS" ]; then
    OLD=$(cat "$PREVIOUS")
    restore_tags && compose up -d $SERVICES && all_healthy || log "terugzetten na onderbreking mislukt"
  fi
  LAATSTE=$(printf '%s' "$was" | jq -c --arg op "$(now_iso)" \
    '{uitkomst: "AFGEBROKEN", reden: "ONDERBROKEN", van: null, naar: .naar, op: $op}')
  BEZIG=null
fi
rm -f "$PREVIOUS"

# A request from before a restart is only acted on while it is fresh: the
# beheerder who asked is still watching (it came in while the previous
# updater handed over to this one). An old one nobody is waiting for goes.
find "$DIR" -maxdepth 1 -name "$(basename "$REQUEST")" -mmin +2 -exec rm -f {} \;
check
last_check=$(date +%s)
last_beat=$last_check
while true; do
  if [ -e "$REQUEST" ]; then
    update
    last_check=$(date +%s)
  fi
  now=$(date +%s)
  if [ -e "$CHECK_REQUEST" ] || [ $((now - last_check)) -ge "$CHECK_EVERY" ]; then
    rm -f "$CHECK_REQUEST"
    check
    last_check=$now
    last_beat=$now
  elif [ $((now - last_beat)) -ge 30 ]; then
    write_status
    last_beat=$now
  fi
  pause 3
done
