#!/bin/bash
# Generates the test videos the harness pages in test/fixtures/ play (kept out of git).
set -euo pipefail
cd "$(dirname "$0")/../test/fixtures"
command -v ffmpeg >/dev/null || { echo "Needs ffmpeg (brew install ffmpeg)."; exit 1; }

# 120 s, no audio track.
ffmpeg -v error -y -f lavfi -i testsrc2=size=640x360:rate=30:duration=120 -c:v libx264 -pix_fmt yuv420p test.mp4
# 120 s with a tone (an audio track is required for Firefox's own auto-PiP).
ffmpeg -v error -y -f lavfi -i testsrc2=size=640x360:rate=30:duration=120 -f lavfi -i sine=frequency=440:duration=120 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest test-audio.mp4
# 10 s, silent: a reel-style clip.
ffmpeg -v error -y -i test.mp4 -t 10 -c copy test-short.mp4
echo "Fixtures written to $(pwd)"
