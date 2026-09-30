#!/usr/bin/env python3
"""Decode a pi session export's embedded payload.

The export HTML embeds session data as one base64 blob rendered client-side, so
grep and browser find cannot see rule text in a fresh file. This prints what is
actually in the payload.

Usage:
  export_payload.py <export.html>                 # system prompt facts + entry summary
  export_payload.py <export.html> --entries       # every text-bearing entry, loud and quiet
  export_payload.py <export.html> --prompt        # the full system prompt
  export_payload.py <export.html> --grep PATTERN  # matches in the prompt and entries

Exit 0 when the payload decodes, 1 when it does not.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import re
import sys

BLOB = re.compile(r"[A-Za-z0-9+/]{40,}={0,2}")
# The export embeds the payload in this tag; the blob scan is the fallback for
# layouts that stop using it. A short session's payload is well under 800 chars,
# so a length threshold alone silently misses it.
SESSION_DATA = re.compile(
    r'<script id="session-data" type="application/json">([A-Za-z0-9+/=]+)</script>'
)

# Entry types whose text this script can read. `message` is included on purpose:
# injected content can land as a plain message (a steer or follow-up), and a
# custom-only filter would report that as "nothing was injected".
TEXT_ENTRY_TYPES = {"message", "custom", "custom_message"}


def decode_payload(html: str) -> dict:
    """Return the session payload embedded in the export."""
    tagged = SESSION_DATA.search(html)
    candidates = [tagged.group(1)] if tagged else sorted(set(BLOB.findall(html)), key=len, reverse=True)
    skipped: list[str] = []
    for blob in candidates:
        try:
            data = json.loads(base64.b64decode(blob).decode())
        except (ValueError, binascii.Error, UnicodeDecodeError) as error:
            skipped.append(f"{len(blob)}-char blob: {error}")
            continue
        if isinstance(data, dict) and ("entries" in data or "systemPrompt" in data):
            return data
    if skipped:
        print(f"skipped {len(skipped)} undecodable blob(s); first: {skipped[0]}", file=sys.stderr)
    raise SystemExit("no session payload found — is this a pi export HTML?")


def entry_text(entry: dict) -> str:
    message = entry.get("message")
    if isinstance(message, dict):
        content = message.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return "\n".join(
                part.get("text", "") for part in content if isinstance(part, dict)
            )
    content = entry.get("content")
    return content if isinstance(content, str) else ""


def entry_label(entry: dict) -> str:
    """Human label for an entry: its role, or its customType."""
    message = entry.get("message")
    if isinstance(message, dict) and message.get("role"):
        return str(message["role"])
    return str(entry.get("customType") or entry.get("type"))


def text_entries(payload: dict) -> list[dict]:
    return [
        entry
        for entry in payload.get("entries", [])
        if entry.get("type") in TEXT_ENTRY_TYPES
    ]


def show_summary(payload: dict, html: str) -> None:
    prompt = payload.get("systemPrompt")
    entries = payload.get("entries", [])
    print(f"systemPrompt: {'absent (CLI export path)' if prompt is None else f'{len(prompt)} chars'}")
    if isinstance(prompt, str):
        for tag in ("<rules>", "</rules>", "<user-rules>", "</user-rules>"):
            print(f"  {tag:<12} {prompt.count(tag)}")
    print(f"entries: {len(entries)}")
    counts: dict[str, int] = {}
    for entry in entries:
        counts[entry.get("type", "?")] = counts.get(entry.get("type", "?"), 0) + 1
    for kind, count in sorted(counts.items()):
        print(f"  {kind:<16} {count}")
    print(f"hidden-message class referenced in template: {'hook-message-hidden' in html}")
    text_bearing = text_entries(payload)
    if text_bearing:
        print("text-bearing entries:")
        for entry in text_bearing:
            print(
                f"  {entry.get('type'):<16} {entry_label(entry):<24} "
                f"display={entry.get('display')!r:<6} {len(entry_text(entry))} chars"
            )


def show_entries(payload: dict) -> None:
    for index, entry in enumerate(text_entries(payload)):
        print(
            f"--- [{index}] {entry.get('type')} {entry_label(entry)} "
            f"display={entry.get('display')!r} ---"
        )
        text = entry_text(entry)
        print(text if text else "(empty)")
        print()


def grep(payload: dict, pattern: str) -> int:
    regex = re.compile(pattern)
    hits = 0
    prompt = payload.get("systemPrompt")
    if isinstance(prompt, str):
        for match in regex.finditer(prompt):
            hits += 1
            start = max(0, match.start() - 200)
            print(f"--- systemPrompt @ {match.start()} ---")
            print(prompt[start : match.end() + 200])
            print()
    for index, entry in enumerate(text_entries(payload)):
        text = entry_text(entry)
        if regex.search(text):
            hits += 1
            print(
                f"--- entry[{index}] {entry.get('type')} {entry_label(entry)} "
                f"display={entry.get('display')!r} ---"
            )
            print(text)
            print()
    print(f"{hits} match(es) for {pattern!r}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("html", help="path to a pi session export .html")
    parser.add_argument("--entries", action="store_true", help="print every text-bearing entry body")
    parser.add_argument("--prompt", action="store_true", help="print the full system prompt")
    parser.add_argument("--grep", metavar="PATTERN", help="print matches with context")
    args = parser.parse_args()

    try:
        with open(args.html, encoding="utf-8", errors="replace") as handle:
            html = handle.read()
    except OSError as error:
        print(f"cannot read {args.html}: {error}", file=sys.stderr)
        return 1

    payload = decode_payload(html)

    if args.grep:
        return grep(payload, args.grep)
    if args.prompt:
        print(payload.get("systemPrompt") or "(absent)")
        return 0
    if args.entries:
        show_entries(payload)
        return 0
    show_summary(payload, html)
    return 0


if __name__ == "__main__":
    sys.exit(main())
