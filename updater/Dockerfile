# The updater (updater.sh): Docker's own command-line image, which has
# docker compose in it, plus curl and jq to ask the registry which version
# is released. Runs as root: it talks to the Docker socket, which is the
# whole point of it - and the reason it is a container of its own, so the
# web app never gets that socket.
FROM docker:29-cli

RUN apk add --no-cache curl jq

COPY updater.sh /usr/local/bin/updater.sh
RUN chmod 755 /usr/local/bin/updater.sh

ENTRYPOINT ["/usr/local/bin/updater.sh"]
