# The machine a session's commands run in. The workspace reads, writes and saves its files with
# GNU coreutils, findutils and tar, which the base image has, and zstd; the rest is what an agent
# reaches for.
FROM node:24-slim
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl git jq python3 ripgrep unzip zstd \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
