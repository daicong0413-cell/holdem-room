"""Create a shareable deployment ZIP from clean, committed source + dist/web.

Run npm run build:web first, commit the changes, then:
    python scripts/package-release.py
Python is only needed by the person making the ZIP, not by the server.
"""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def main():
    if git("status", "--porcelain", "--untracked-files=normal").strip():
        raise SystemExit("Commit source changes before packaging; release must match one Git revision.")
    commit = git("rev-parse", "HEAD").decode().strip()
    tracked = [p.decode("utf-8") for p in git("ls-files", "-z").split(b"\0") if p]
    forbidden = {".git", ".agents", ".codex", "node_modules", "releases", ".app-profile", ".workbuddy", "miniprogram"}
    paths = []
    for name in tracked:
        path = Path(name)
        if any(part in forbidden or part.startswith(".chrome-") for part in path.parts):
            raise SystemExit(f"Private or generated directory unexpectedly tracked: {name}")
        if path.name.startswith(".env") and path.name != ".env.example":
            raise SystemExit(f"Environment credentials unexpectedly tracked: {name}")
        if (ROOT / path).is_symlink():
            raise SystemExit(f"Symlinks are not supported in this release: {name}")
        paths.append(path)

    web = ROOT / "dist" / "web"
    if not (web / "index.html").is_file():
        raise SystemExit("Missing built frontend. Run npm run build:web first.")
    paths += [p.relative_to(ROOT) for p in web.rglob("*") if p.is_file()]
    paths = sorted(set(paths), key=lambda p: p.as_posix())

    # Check actual local secrets in memory; never print their values.
    secrets = []
    local_env = ROOT / ".env"
    if local_env.is_file():
        for line in local_env.read_text(encoding="utf-8").splitlines():
            key, sep, value = line.partition("=")
            if sep and any(word in key.upper() for word in ("KEY", "TOKEN", "SECRET", "PASSWORD")):
                value = value.strip().strip("\"'")
                if len(value) >= 12:
                    secrets.append(value.encode())

    files = {}
    for path in paths:
        body = (ROOT / path).read_bytes()
        if any(secret in body for secret in secrets) or re.search(rb"\bsk-[A-Za-z0-9_-]{20,}", body):
            raise SystemExit(f"Possible API credential in release file: {path.as_posix()}")
        files[path.as_posix()] = {"bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()}

    now = datetime.now(timezone.utc)
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    manifest = {
        "project": package["name"],
        "version": package["version"],
        "gitCommit": commit,
        "builtAtUtc": now.isoformat(),
        "node": package["engines"]["node"],
        "entrypoint": "DEPLOY.md",
        "frontendPrebuilt": True,
        "secretsIncluded": False,
        "files": files,
    }
    release_dir = ROOT / "releases"
    release_dir.mkdir(exist_ok=True)
    archive = release_dir / f"holdem-room-{now:%Y%m%d}-{commit[:7]}.zip"
    with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:
        for path in paths:
            output.write(ROOT / path, "holdem-room/" + path.as_posix())
        output.writestr("holdem-room/RELEASE.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix(".zip.sha256").write_text(f"{digest}  {archive.name}\n", encoding="ascii")
    print(f"Archive: {archive}")
    print(f"Source: {commit}; files: {len(files) + 1}; size: {archive.stat().st_size:,} bytes")
    print(f"SHA256: {digest}")


if __name__ == "__main__":
    main()
