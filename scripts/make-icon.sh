#!/bin/bash
# Generates assets/icon.icns from a 1024x1024 PNG
# Usage: bash scripts/make-icon.sh [source-png]
# If no source PNG is provided, generates a placeholder using sips

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR/.."
ASSETS="$ROOT/assets"
ICONSET="$ASSETS/icon.iconset"
SOURCE="${1:-}"

mkdir -p "$ICONSET"

if [ -z "$SOURCE" ]; then
  # Generate a placeholder 1024x1024 PNG using Python + built-in tools
  python3 - <<'PYEOF'
import struct, zlib, os

def png(w, h, pixels):
    def chunk(name, data):
        c = zlib.crc32(name + data) & 0xffffffff
        return struct.pack('>I', len(data)) + name + data + struct.pack('>I', c)
    raw = b''.join(b'\x00' + bytes(pixels[y*w*4:(y+1)*w*4]) for y in range(h))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + \
           chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')

w = h = 1024
pixels = []
for y in range(h):
    for x in range(w):
        # Draw a rounded-rect background (dark) with a simple fox-orange circle
        cx, cy = w//2, h//2
        r = int(((x-cx)**2 + (y-cy)**2)**0.5)
        # Background: #1a1a1a
        bg = (26, 26, 26)
        # Orange circle: #f6851b
        if r < 380:
            pixels.extend([246, 133, 27])
        else:
            pixels.extend(bg)

with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '../assets/icon-source.png'), 'wb') as f:
    f.write(png(w, h, pixels))
print('Generated placeholder icon-source.png')
PYEOF
  SOURCE="$ASSETS/icon-source.png"
fi

echo "Generating iconset from $SOURCE..."

# Generate all required sizes
sips -z 16 16     "$SOURCE" --out "$ICONSET/icon_16x16.png"       > /dev/null
sips -z 32 32     "$SOURCE" --out "$ICONSET/icon_16x16@2x.png"    > /dev/null
sips -z 32 32     "$SOURCE" --out "$ICONSET/icon_32x32.png"       > /dev/null
sips -z 64 64     "$SOURCE" --out "$ICONSET/icon_32x32@2x.png"    > /dev/null
sips -z 128 128   "$SOURCE" --out "$ICONSET/icon_128x128.png"     > /dev/null
sips -z 256 256   "$SOURCE" --out "$ICONSET/icon_128x128@2x.png"  > /dev/null
sips -z 256 256   "$SOURCE" --out "$ICONSET/icon_256x256.png"     > /dev/null
sips -z 512 512   "$SOURCE" --out "$ICONSET/icon_256x256@2x.png"  > /dev/null
sips -z 512 512   "$SOURCE" --out "$ICONSET/icon_512x512.png"     > /dev/null
cp "$SOURCE"             "$ICONSET/icon_512x512@2x.png"

iconutil -c icns "$ICONSET" -o "$ASSETS/icon.icns"
rm -rf "$ICONSET"

echo "✓ Created assets/icon.icns"
