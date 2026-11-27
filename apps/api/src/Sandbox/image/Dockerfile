# The machine a session's commands run in. The workspace reads, writes and saves its files with
# GNU coreutils, findutils and tar, which the base image has, and zstd; the rest is what an agent
# reaches for.
FROM node:24-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl git jq python3 ripgrep unzip zstd \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /
