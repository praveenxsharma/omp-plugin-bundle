# agy-context-unlock

Raise the official Antigravity client's context window from 256K to about 1M (983,040) and lift the 64K (192KB) single user-message cap. Supports macOS (arm64 / x86-64), Linux (x86-64 / arm64), and Windows (x86-64 / arm64). Requires `agy >= 1.5.0`.

This directory is **not** part of the OMP plugin install. Only running these scripts rewrites the official `agy` binary. After `agy` or the Antigravity desktop app upgrades, the binary is official again and you must re-run.

The OMP plugin's `autoPatch` looks for:

- macOS / Linux: `~/.gemini/antigravity/tools/agy-patch.py`
- Windows: `%USERPROFILE%\.gemini\antigravity\tools\agy-patch.py`

Copy `agy-patch.py` there. Next plugin start checks and patches if still locked. If the script is missing, context stays 256K and models still work.

## Unlock terminal `agy`

Confirm `agy --version` is `1.5.x` (`agy update` if older). Quit running `agy` processes, then:

**macOS / Linux:**

```sh
python3 agy-patch.py --binary ~/.local/bin/agy --dry-run
python3 agy-patch.py --binary ~/.local/bin/agy --in-place
```

**Windows (PowerShell):**

```powershell
python agy-patch.py --binary "$env:LOCALAPPDATA\agy\bin\agy.exe" --dry-run
python agy-patch.py --binary "$env:LOCALAPPDATA\agy\bin\agy.exe" --in-place
```

Without `--binary`, macOS / Linux default to `~/.local/bin/agy`, Windows to `%LOCALAPPDATA%\agy\bin\agy.exe`. `--dry-run` reports gate status only. `--in-place` writes a `.bak` backup first (macOS re-signs, Windows strips a stale signature).

## Unlock the desktop app

Quit Antigravity and back up the original file, then:

**macOS:**

```sh
python3 agy-patch.py \
  --binary "/Applications/Antigravity.app/Contents/Resources/bin/language_server" \
  --in-place --no-backup
```

**Windows (PowerShell):**

```powershell
python agy-patch.py `
  --binary "$env:LOCALAPPDATA\Programs\Antigravity\resources\bin\language_server.exe" `
  --in-place
```

## Re-unlock after upgrades (macOS)

On Windows / Linux the OMP plugin's `autoPatch` checks before each `agy acp` start.

On macOS, if you also use the official terminal and desktop clients, `agy-autopatch.py` plus `launchd` re-patches only when the binary is official again and sends `SIGTERM` to `language_server` for a reload.

Default paths:

```text
~/.local/bin/agy
/Applications/Antigravity.app/Contents/Resources/bin/language_server
~/.gemini/antigravity/tools/agy-patch.py
```

```sh
python3 agy-autopatch.py
```
