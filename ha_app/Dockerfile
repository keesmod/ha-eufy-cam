FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

# Recordings with AAC-ELD audio (#264) need Fraunhofer FDK AAC from Debian
# non-free, because Debian's FFmpeg cannot decode 16 kHz AAC-ELD.
FROM node:24-bookworm-slim AS native
RUN printf 'Types: deb\nURIs: http://deb.debian.org/debian\nSuites: bookworm bookworm-updates\nComponents: non-free\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n' > /etc/apt/sources.list.d/non-free.sources \
  && apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev libfdk-aac-dev && rm -rf /var/lib/apt/lists/*
COPY native/eld-decode.c /tmp/eld-decode.c
RUN gcc -std=c11 -O2 -Wall -o /usr/local/bin/eufy-eld-decode /tmp/eld-decode.c -lfdk-aac

FROM node:24-bookworm-slim
RUN printf 'Types: deb\nURIs: http://deb.debian.org/debian\nSuites: bookworm bookworm-updates\nComponents: non-free\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n' > /etc/apt/sources.list.d/non-free.sources \
  && apt-get update && apt-get install -y --no-install-recommends ffmpeg libfdk-aac2 tini && rm -rf /var/lib/apt/lists/*
COPY --from=native /usr/local/bin/eufy-eld-decode /usr/local/bin/eufy-eld-decode
WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY bootstrap.mjs ./
EXPOSE 8063
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "bootstrap.mjs"]
