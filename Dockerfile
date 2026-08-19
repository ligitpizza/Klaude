FROM node:26-slim

# ffmpeg: apt's build fixes the SIGSEGV we hit with prebuilt static ffmpeg
# binaries (ffmpeg-static / @ffmpeg-installer) when demuxing SoundCloud's
# HLS streams on Render's native runtime.
# python3/make/g++: fallback toolchain for any native npm module (opus,
# sodium-native, sqlite3) that doesn't have a prebuilt binary for this image.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ENV FFMPEG_PATH=/usr/bin/ffmpeg

EXPOSE 3001

CMD ["node", "launch.js"]
