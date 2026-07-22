#!/usr/bin/env python3
"""Point the Homebrew cask at a freshly released version.

Called by the release workflow with (version, arm64 sha, x86_64 sha).
The first sha256 in the file belongs to the arm build, the second to
intel — the same order they appear in the cask.
"""
import re
import sys

version, arm, amd = sys.argv[1], sys.argv[2], sys.argv[3]
path = "Casks/peye.rb"
src = open(path).read()

src, n = re.subn(r'version "[^"]*"', f'version "{version}"', src, count=1)
if n != 1:
    sys.exit("cask: version line not found")

shas = iter([arm, amd])
src, n = re.subn(r'sha256 "[^"]*"', lambda _: f'sha256 "{next(shas)}"', src, count=2)
if n != 2:
    sys.exit("cask: expected two sha256 lines")

open(path, "w").write(src)
print(f"cask updated to {version}")
