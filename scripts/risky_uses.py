#!/usr/bin/env python3
"""List the lines a pull request adds that need a second look, as a summary and never as a failure.

    git diff <base> HEAD | python3 scripts/risky_uses.py --profile addon

The desktop app holds the player's token and installs updates, so a change that runs programs, runs text as code,
loosens a window's security, opens links or permissions, touches tokens or updates, makes network requests, or edits
a workflow or release script is read with more care before it is merged or run. This only points at the lines; a
person decides. The addon repository keeps the same script with its own profile.
"""

from __future__ import annotations

import argparse
import re
import sys

PROFILES = {
    "addon": {
        "patterns": [
            (r"\b(loadstring|setfenv|RunScript)\b|\bload\s*\(", "runs text as code"),
            (r"\b(SendMail|TakeInboxMoney|TakeInboxItem|DeleteInboxItem|AutoLootMailItem)\b", "mail"),
            (r"\b(AcceptTrade|SetTradeMoney|AddTradeMoney|InitiateTrade)\b", "trade"),
            (r"\b(RepairAllItems|PickupMerchantItem|BuyMerchantItem|UseContainerItem|DeleteCursorItem|PickupContainerItem|SellCursorItem)\b", "repair, selling, buying or deleting items"),
            (r"\b(AcceptQuest|CompleteQuest|GetQuestReward|AcknowledgeAutoAcceptQuest|ConfirmBindOnUse)\b", "accepts or turns in on the player's behalf"),
            (r"\b(hooksecurefunc|securecall\w*|SecureActionButton\w*|SecureHandler\w*|RegisterStateDriver|SetAttribute)\b", "secure code and hooks"),
            (r"\b(SendChatMessage|SendAddonMessage|JoinChannelByName|InviteUnit)\b", "sends messages or invites"),
        ],
        "files": [r"^\.github/", r"^scripts/.*\.(sh|py)$"],
    },
    "app": {
        "patterns": [
            (r"\bchild_process\b|\b(exec|execFile|spawn)(Sync)?\s*\(", "runs programs"),
            (r"\b(eval|new Function)\s*\(|dangerouslySetInnerHTML", "runs text as code"),
            (r"\b(nodeIntegration|contextIsolation|webSecurity|sandbox|allowRunningInsecureContent)\b", "window security settings"),
            (r"\bshell\.openExternal\b|\bsetPermissionRequestHandler\b|\bprotocol\.(handle|register\w*)\b", "opens links, permissions, protocols"),
            (r"\b(safeStorage|keytar|autoUpdater|electron-updater)\b", "tokens and updates"),
            (r"\bfetch\s*\(|\bnet\.request\b|\bhttps?\.request\b", "network requests"),
        ],
        "files": [r"^\.github/", r"^scripts/.*\.(sh|py|mjs|js)$", r"^package\.json$"],
    },
}


def scan(diff: str, profile: str) -> dict[str, list[tuple[str, str]]]:
    """File -> list of (reason, added line) for every added line or touched file that needs a look."""
    rules = PROFILES[profile]
    patterns = [(re.compile(pattern), reason) for pattern, reason in rules["patterns"]]
    files = [re.compile(pattern) for pattern in rules["files"]]
    found: dict[str, list[tuple[str, str]]] = {}
    current = None
    for line in diff.splitlines():
        if line.startswith("+++ "):
            path = line[4:].strip()
            current = path[2:] if path.startswith("b/") else (None if path == "/dev/null" else path)
            if current and any(pattern.search(current) for pattern in files):
                found.setdefault(current, []).append(("a workflow or release script changed", current))
            continue
        if line.startswith("+") and not line.startswith("+++") and current:
            text = line[1:]
            if text.lstrip().startswith(("--", "//", "#")):
                continue
            for pattern, reason in patterns:
                if pattern.search(text):
                    found.setdefault(current, []).append((reason, text.strip()))
    return found


def render(found: dict[str, list[tuple[str, str]]]) -> str:
    if not found:
        return "No added line runs programs, runs text as code, changes window security, touches tokens or updates, makes a network request or edits a workflow.\n"
    lines = ["## Lines that need a second look", "", "Added by this pull request. A person reads them; this list fails nothing.", ""]
    for path in sorted(found):
        lines.append(f"### `{path}`")
        seen = set()
        for reason, text in found[path]:
            if (reason, text) in seen:
                continue
            seen.add((reason, text))
            lines.append(f"- {reason}: `{text[:160]}`")
        lines.append("")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", choices=sorted(PROFILES), default="app")
    arguments = parser.parse_args()
    sys.stdout.write(render(scan(sys.stdin.read(), arguments.profile)))


if __name__ == "__main__":
    main()
