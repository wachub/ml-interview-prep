#!/usr/bin/env python3
"""Local, dependency-free editor for the Quarto ML interview-prep book."""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.parse
import uuid
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


EDITOR_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = EDITOR_DIR.parent.resolve()
STATIC_DIR = EDITOR_DIR / "static"
BACKUP_DIR = PROJECT_ROOT / ".book-editor" / "backups"
SAVE_LOCK = threading.Lock()
RENDER_LOCK = threading.Lock()
QMD_ENTRY_RE = re.compile(r"^\s*-\s+([^#]+?\.qmd)\s*$")
PART_RE = re.compile(r'^\s*-\s+part:\s*["\']?(.+?)["\']?\s*$')
HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
QUESTION_RE = re.compile(r"^###\s+Q:\s*(.*?)\s*(\{[^}]*\})?\s*$")
TAB_RE = re.compile(r"^####\s+(.+?)\s*$")
HIDDEN_START = "<!-- book-editor:hidden-question:start -->"
HIDDEN_END = "<!-- book-editor:hidden-question:end -->"
HIDDEN_BLOCK_RE = re.compile(
    re.escape(HIDDEN_START)
    + r'\s*\n(?:(?P<conditional>:::: \{\.content-hidden when-format="html"\})\s*\n)?'
    + r'(?P<body>.*?)(?:\n::::\s*)?\n'
    + re.escape(HIDDEN_END)
    + r"(?:\r?\n)?",
    re.DOTALL,
)


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def clean_heading(text: str) -> str:
    return re.sub(r"\s*\{[^}]*\}\s*$", "", text).strip()


def book_paths() -> list[str]:
    config = (PROJECT_ROOT / "_quarto.yml").read_text(encoding="utf-8")
    paths: list[str] = []
    for line in config.splitlines():
        match = QMD_ENTRY_RE.match(line)
        if match:
            candidate = match.group(1).strip().strip('"\'')
            if (PROJECT_ROOT / candidate).is_file() and candidate not in paths:
                paths.append(candidate)
    return paths


def chapter_entries(config: str) -> list[dict]:
    """Locate chapter list entries and their Quarto part/appendix boundary."""
    entries = []
    group = "front"
    label = "Opening pages"
    in_appendices = False
    for index, line in enumerate(config.splitlines(keepends=True)):
        if line.startswith("  appendices:"):
            in_appendices = True
            group, label = "appendices", "Appendices"
        if not in_appendices:
            part = PART_RE.match(line)
            if part:
                label = part.group(1).strip().strip('"\'')
                group = f"part-{index}"
        match = QMD_ENTRY_RE.match(line)
        if match:
            path = match.group(1).strip().strip('"\'')
            if (PROJECT_ROOT / path).is_file():
                entries.append({"path": path, "line": index, "group": group, "groupLabel": label})
    return entries


def allowed_path(value: str) -> Path:
    if value not in book_paths():
        raise ValueError("That file is not part of the current Quarto book.")
    resolved = (PROJECT_ROOT / value).resolve()
    if PROJECT_ROOT not in resolved.parents:
        raise ValueError("Invalid project path.")
    return resolved


def line_records(text: str) -> list[dict]:
    records: list[dict] = []
    offset = 0
    for number, line in enumerate(text.splitlines(keepends=True), start=1):
        value = line.rstrip("\r\n")
        records.append(
            {
                "number": number,
                "text": value,
                "start": offset,
                "end": offset + len(line),
            }
        )
        offset += len(line)
    return records


def parse_question(raw: str) -> dict:
    lines = raw.splitlines(keepends=True)
    heading = lines[0].rstrip("\r\n") if lines else ""
    match = QUESTION_RE.match(heading)
    if not match:
        return {"structured": False, "raw": raw}

    title = match.group(1).strip()
    attributes = (match.group(2) or "{.qa-card}").strip()
    body = "".join(lines[1:])
    short_marker = "**Short answer:**"
    marker_at = body.find(short_marker)
    details_at = body.find("<details", marker_at + len(short_marker))
    if marker_at < 0 or details_at < 0:
        return {
            "structured": False,
            "raw": raw,
            "title": title,
            "attributes": attributes,
        }

    before_short = body[:marker_at]
    short_answer = body[marker_at + len(short_marker) : details_at].strip()
    details = body[details_at:]
    panel_marker = "::: {.panel-tabset}"
    panel_at = details.find(panel_marker)
    if panel_at < 0:
        return {
            "structured": False,
            "raw": raw,
            "title": title,
            "attributes": attributes,
        }

    panel_body_at = panel_at + len(panel_marker)
    close_match = re.search(r"(?m)^:::\s*$", details[panel_body_at:])
    if not close_match:
        return {
            "structured": False,
            "raw": raw,
            "title": title,
            "attributes": attributes,
        }

    panel_close = panel_body_at + close_match.start()
    panel_body = details[panel_body_at:panel_close]
    tab_matches = list(re.finditer(r"(?m)^####\s+(.+?)\s*$", panel_body))
    if not tab_matches:
        return {
            "structured": False,
            "raw": raw,
            "title": title,
            "attributes": attributes,
        }

    tabs = []
    for index, tab_match in enumerate(tab_matches):
        content_start = tab_match.end()
        content_end = tab_matches[index + 1].start() if index + 1 < len(tab_matches) else len(panel_body)
        tabs.append(
            {
                "title": tab_match.group(1).strip(),
                "content": panel_body[content_start:content_end].strip(),
            }
        )

    return {
        "structured": True,
        "raw": raw,
        "title": title,
        "attributes": attributes,
        "beforeShort": before_short,
        "shortAnswer": short_answer,
        "detailsLead": details[:panel_body_at],
        "tabs": tabs,
        "detailsTail": details[panel_close:],
    }


def parse_document(path: str, text: str) -> dict:
    records = line_records(text)
    headings: list[dict] = []
    for record in records:
        match = HEADING_RE.match(record["text"])
        if not match:
            continue
        level = len(match.group(1))
        headings.append(
            {
                **record,
                "level": level,
                "heading": match.group(2),
                "label": clean_heading(match.group(2)),
            }
        )

    title_heading = next((item for item in headings if item["level"] == 1), None)
    frontmatter = re.match(r"\A---\s*\n(.*?)\n---(?:\s*\n|$)", text, re.DOTALL)
    yaml_title = re.search(r"(?m)^title:\s*(.+?)\s*$", frontmatter.group(1)) if frontmatter else None
    if title_heading:
        title = title_heading["label"]
    elif yaml_title:
        title = yaml_title.group(1).strip().strip('"\'')
    else:
        title = Path(path).stem.replace("-", " ").title()
    sections: list[dict] = []
    h2s = [item for item in headings if item["level"] == 2]
    hidden_ranges = []
    for match in HIDDEN_BLOCK_RE.finditer(text):
        inner_start = match.start("body")
        inner_end = match.end("body")
        hidden_heading = next(
            (item for item in headings if item["level"] == 3 and inner_start <= item["start"] < inner_end and QUESTION_RE.match(item["text"])),
            None,
        )
        if hidden_heading:
            hidden_ranges.append({
                "start": match.start(),
                "end": match.end(),
                "heading": hidden_heading,
                "raw_end": match.end("body"),
                "conditional": match.group("conditional") is not None,
            })

    for section_index, section in enumerate(h2s):
        section_end = h2s[section_index + 1]["start"] if section_index + 1 < len(h2s) else len(text)
        questions = [
            item
            for item in headings
            if item["level"] == 3
            and item["start"] > section["start"]
            and item["start"] < section_end
            and QUESTION_RE.match(item["text"])
        ]
        def source_start(item: dict) -> int:
            hidden = next((block for block in hidden_ranges if block["heading"] is item), None)
            return hidden["start"] if hidden else item["start"]

        first_question = source_start(questions[0]) if questions else section_end
        section_raw = text[section["start"]:first_question]
        section_attributes = re.search(r"(\{[^}]*\})\s*$", section["heading"])
        section_node = {
            "id": f"section-{section_index}",
            "animationKey": digest(text[section["start"]:section_end].rstrip()),
            "kind": "section",
            "title": section["label"],
            "attributes": section_attributes.group(1) if section_attributes else "",
            "start": section["start"],
            "end": first_question,
            "line": section["number"],
            "raw": section_raw,
            "body": text[section["end"]:first_question].strip(),
            "questions": [],
        }
        for question_index, question in enumerate(questions):
            hidden = next((block for block in hidden_ranges if block["heading"] is question), None)
            question_start = source_start(question)
            question_end = hidden["end"] if hidden else (source_start(questions[question_index + 1]) if question_index + 1 < len(questions) else section_end)
            raw_end = hidden["raw_end"] if hidden else question_end
            raw = text[question["start"]:raw_end].rstrip() + "\n"
            parsed = parse_question(raw)
            section_node["questions"].append(
                {
                    "id": f"section-{section_index}-question-{question_index}",
                    "animationKey": digest(raw),
                    "kind": "question",
                    "start": question_start,
                    "end": question_end,
                    "line": question["number"],
                    "hidden": hidden is not None,
                    "conditionalHidden": hidden["conditional"] if hidden else False,
                    **parsed,
                }
            )
        sections.append(section_node)

    first_h2 = h2s[0]["start"] if h2s else len(text)
    intro_raw = text[:first_h2]
    return {
        "path": path,
        "title": title,
        "hash": digest(text),
        "content": text,
        "intro": {
            "id": "intro",
            "kind": "intro",
            "title": f"{title} — introduction",
            "start": 0,
            "end": first_h2,
            "line": 1,
            "raw": intro_raw,
        },
        "sections": sections,
    }


def book_summary() -> dict:
    config = (PROJECT_ROOT / "_quarto.yml").read_text(encoding="utf-8")
    documents = []
    for entry in chapter_entries(config):
        path = entry["path"]
        text = allowed_path(path).read_text(encoding="utf-8")
        parsed = parse_document(path, text)
        documents.append(
            {
                "path": path,
                "group": entry["group"],
                "groupLabel": entry["groupLabel"],
                "title": parsed["title"],
                "questionCount": sum(len(section["questions"]) for section in parsed["sections"]),
                "sectionCount": len(parsed["sections"]),
                "sections": [
                    {
                        "id": section["id"],
                        "animationKey": section["animationKey"],
                        "title": section["title"],
                        "questions": [
                            {"id": question["id"], "animationKey": question["animationKey"], "title": question.get("title", ""), "hidden": question["hidden"]}
                            for question in section["questions"]
                        ],
                    }
                    for section in parsed["sections"]
                ],
            }
        )
    return {"title": "ML Interview Prep", "configHash": digest(config), "documents": documents}


def move_block(text: str, blocks: list[dict], source_id: str, target_id: str, position: str) -> tuple[str, int]:
    ids = [block["id"] for block in blocks]
    if source_id not in ids or target_id not in ids or source_id == target_id:
        raise ValueError("Choose two different items at the same level.")
    start, end = blocks[0]["start"], blocks[-1]["end"]
    pieces = [text[block["start"]:block["end"]] for block in blocks]
    source_index, target_index = ids.index(source_id), ids.index(target_id)
    moved = pieces.pop(source_index)
    insert_at = target_index + (position == "after")
    if source_index < insert_at:
        insert_at -= 1
    pieces.insert(insert_at, moved)
    # A block that used to end the file may have only one trailing newline.
    # Keep a blank line before the next heading when it moves into the middle.
    for index in range(len(pieces) - 1):
        if not pieces[index].endswith("\n\n"):
            pieces[index] += "\n" if pieces[index].endswith("\n") else "\n\n"
    return text[:start] + "".join(pieces) + text[end:], insert_at


def write_with_backup(file_path: Path, content: str) -> str:
    relative = file_path.relative_to(PROJECT_ROOT)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup_path = BACKUP_DIR / f"{relative}.{stamp}-{uuid.uuid4().hex[:8]}.bak"
    backup_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(file_path, backup_path)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{file_path.name}.", dir=file_path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(content)
        os.chmod(temporary_name, file_path.stat().st_mode)
        os.replace(temporary_name, file_path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)
    return str(backup_path.relative_to(PROJECT_ROOT))


class EditorHandler(BaseHTTPRequestHandler):
    server_version = "QuartoBookEditor/1.0"

    def log_message(self, fmt: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def send_json(self, payload: object, status: int = HTTPStatus.OK) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def send_error_json(self, message: str, status: int = HTTPStatus.BAD_REQUEST) -> None:
        self.send_json({"error": message}, status)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 15_000_000:
            raise ValueError("Request is too large.")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def serve_file(self, file_path: Path) -> None:
        if not file_path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        content = file_path.read_bytes()
        mime, _ = mimetypes.guess_type(str(file_path))
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", (mime or "application/octet-stream") + ("; charset=utf-8" if (mime or "").startswith("text/") else ""))
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)

    def serve_preview_notice(self, rendering: bool) -> None:
        if rendering:
            title = "The book is rendering"
            message = "Quarto is rebuilding the book. This page will refresh automatically when it is ready."
            refresh = '<meta http-equiv="refresh" content="2">'
        else:
            title = "No rendered book yet"
            message = "Return to the editor and choose Render book, then open the preview."
            refresh = ""
        content = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>{refresh}
<style>body{{font:16px/1.6 system-ui,sans-serif;max-width:42rem;margin:12vh auto;padding:0 1.5rem;color:#eef4f1;background:#0d1110}}
a{{color:#96ebc8}}h1{{line-height:1.2}}</style></head>
<body><h1>{title}</h1><p>{message}</p><p><a href="/">Return to Book Editor</a></p></body></html>""".encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        try:
            if route == "/api/health":
                self.send_json({"ok": True})
            elif route == "/api/book":
                self.send_json(book_summary())
            elif route == "/api/document":
                path = query.get("path", [""])[0]
                file_path = allowed_path(path)
                text = file_path.read_text(encoding="utf-8")
                self.send_json(parse_document(path, text))
            elif route == "/api/git-status":
                result = subprocess.run(
                    ["git", "status", "--short"],
                    cwd=PROJECT_ROOT,
                    capture_output=True,
                    text=True,
                    timeout=10,
                    check=False,
                )
                self.send_json({"clean": not result.stdout.strip(), "status": result.stdout})
            elif route == "/book" or route == "/book/":
                preview = PROJECT_ROOT / "_book" / "index.html"
                if RENDER_LOCK.locked() or not preview.is_file():
                    self.serve_preview_notice(RENDER_LOCK.locked())
                else:
                    self.serve_file(preview)
            elif route.startswith("/book/"):
                relative = route.removeprefix("/book/")
                target = (PROJECT_ROOT / "_book" / relative).resolve()
                if (PROJECT_ROOT / "_book").resolve() not in target.parents:
                    raise ValueError("Invalid preview path.")
                # Rendered paths are reused after every build; the browser must
                # fetch their latest bytes when a preview tab is reloaded.
                self.serve_file(target)
            else:
                relative = "index.html" if route == "/" else route.lstrip("/")
                target = (STATIC_DIR / relative).resolve()
                if target != STATIC_DIR and STATIC_DIR not in target.parents:
                    raise ValueError("Invalid static path.")
                self.serve_file(target)
        except ValueError as exc:
            self.send_error_json(str(exc))
        except Exception as exc:  # Keep the local GUI useful without exposing tracebacks.
            self.send_error_json(f"Unexpected server error: {exc}", HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        try:
            payload = self.read_json()
            if parsed.path == "/api/save":
                self.handle_save(payload)
            elif parsed.path == "/api/reorder":
                self.handle_reorder(payload)
            elif parsed.path == "/api/question-visibility":
                self.handle_question_visibility(payload)
            elif parsed.path == "/api/delete-question":
                self.handle_delete_question(payload)
            elif parsed.path == "/api/render":
                self.handle_render()
            else:
                self.send_error_json("Unknown API endpoint.", HTTPStatus.NOT_FOUND)
        except json.JSONDecodeError:
            self.send_error_json("Invalid JSON request.")
        except ValueError as exc:
            self.send_error_json(str(exc))
        except Exception as exc:
            self.send_error_json(f"Unexpected server error: {exc}", HTTPStatus.INTERNAL_SERVER_ERROR)

    def handle_save(self, payload: dict) -> None:
        path = str(payload.get("path", ""))
        content = payload.get("content")
        expected_hash = str(payload.get("expectedHash", ""))
        if not isinstance(content, str):
            raise ValueError("Missing document content.")
        file_path = allowed_path(path)
        with SAVE_LOCK:
            current = file_path.read_text(encoding="utf-8")
            if expected_hash != digest(current):
                self.send_error_json(
                    "The file changed on disk after it was opened. Reload it before saving so no work is overwritten.",
                    HTTPStatus.CONFLICT,
                )
                return
            if not content.strip():
                raise ValueError("Refusing to save an empty document.")

            backup = write_with_backup(file_path, content)

        self.send_json(
            {
                "ok": True,
                "hash": digest(content),
                "backup": backup,
                "document": parse_document(path, content),
            }
        )

    def handle_question_visibility(self, payload: dict) -> None:
        hidden = payload.get("hidden")
        if not isinstance(hidden, bool):
            raise ValueError("Choose whether the question should be hidden.")
        path = str(payload.get("path", ""))
        file_path = allowed_path(path)
        with SAVE_LOCK:
            content = file_path.read_text(encoding="utf-8")
            if payload.get("expectedHash") != digest(content):
                self.send_error_json("This chapter changed on disk. Reload it before changing a question.", HTTPStatus.CONFLICT)
                return
            parsed = parse_document(path, content)
            question_id = str(payload.get("questionId", ""))
            question = next((q for section in parsed["sections"] for q in section["questions"] if q["id"] == question_id), None)
            if question is None:
                raise ValueError("Choose a question in this chapter.")
            if question["hidden"] == hidden and (not hidden or question["conditionalHidden"]):
                self.send_json({"ok": True, "unchanged": True, "document": parsed})
                return
            raw = question["raw"].rstrip("\r\n")
            replacement = (
                f'{HIDDEN_START}\n:::: {{.content-hidden when-format="html"}}\n{raw}\n::::\n{HIDDEN_END}\n'
                if hidden
                else question["raw"]
            )
            updated = content[:question["start"]] + replacement + content[question["end"]:]
            backup = write_with_backup(file_path, updated)
        self.send_json({"ok": True, "backup": backup, "document": parse_document(path, updated)})

    def handle_delete_question(self, payload: dict) -> None:
        path = str(payload.get("path", ""))
        file_path = allowed_path(path)
        with SAVE_LOCK:
            content = file_path.read_text(encoding="utf-8")
            if payload.get("expectedHash") != digest(content):
                self.send_error_json("This chapter changed on disk. Reload it before deleting a question.", HTTPStatus.CONFLICT)
                return
            parsed = parse_document(path, content)
            question_id = str(payload.get("questionId", ""))
            question = next((q for section in parsed["sections"] for q in section["questions"] if q["id"] == question_id), None)
            if question is None:
                raise ValueError("Choose a question in this chapter.")
            updated = content[:question["start"]] + content[question["end"]:]
            if not updated.strip():
                raise ValueError("Refusing to delete the entire document.")
            backup = write_with_backup(file_path, updated)
        self.send_json({"ok": True, "backup": backup, "document": parse_document(path, updated)})

    def handle_reorder(self, payload: dict) -> None:
        kind = payload.get("kind")
        source = str(payload.get("source", ""))
        target = str(payload.get("target", ""))
        position = payload.get("position")
        if position not in ("before", "after"):
            raise ValueError("Invalid move position.")
        if kind == "chapter":
            config_path = PROJECT_ROOT / "_quarto.yml"
            with SAVE_LOCK:
                config = config_path.read_text(encoding="utf-8")
                if payload.get("expectedHash") != digest(config):
                    self.send_error_json("The book configuration changed. Reload the editor before moving chapters.", HTTPStatus.CONFLICT)
                    return
                entries = chapter_entries(config)
                by_path = {item["path"]: item for item in entries}
                if source not in by_path or target not in by_path:
                    raise ValueError("Choose chapters in this book.")
                source_group, target_group = by_path[source]["group"], by_path[target]["group"]
                if source == "index.qmd" or target == "index.qmd" or source_group == "front" or target_group == "front":
                    raise ValueError("The book home page must stay first.")
                if source_group != target_group and not (source_group.startswith("part-") and target_group.startswith("part-")):
                    raise ValueError("Regular chapters can move between parts; appendices stay within the appendices.")
                lines = config.splitlines(keepends=True)
                old_index, target_index = by_path[source]["line"], by_path[target]["line"]
                if old_index == target_index:
                    raise ValueError("Choose a different chapter.")
                indent = re.match(r"^\s*", lines[target_index]).group(0)
                moved = indent + lines[old_index].lstrip()
                lines.pop(old_index)
                insert_at = target_index + (position == "after")
                if old_index < insert_at:
                    insert_at -= 1
                lines.insert(insert_at, moved)
                updated = "".join(lines)
                if updated == config:
                    self.send_json({"ok": True, "unchanged": True, "book": book_summary()})
                    return
                backup = write_with_backup(config_path, updated)
            self.send_json({"ok": True, "backup": backup, "book": book_summary()})
            return

        if kind not in ("section", "question"):
            raise ValueError("Invalid item type.")
        path = str(payload.get("path", ""))
        file_path = allowed_path(path)
        with SAVE_LOCK:
            content = file_path.read_text(encoding="utf-8")
            if payload.get("expectedHash") != digest(content):
                self.send_error_json("This chapter changed on disk. Reload it before moving items.", HTTPStatus.CONFLICT)
                return
            parsed = parse_document(path, content)
            if kind == "section":
                blocks = [dict(section, end=parsed["sections"][i + 1]["start"] if i + 1 < len(parsed["sections"]) else len(content)) for i, section in enumerate(parsed["sections"])]
            else:
                source_parent = next((section for section in parsed["sections"] if any(question["id"] == source for question in section["questions"])), None)
                target_parent = next((section for section in parsed["sections"] if any(question["id"] == target for question in section["questions"])), None)
                if not source_parent or source_parent is not target_parent:
                    raise ValueError("Questions can be moved within the same section.")
                section_index = parsed["sections"].index(source_parent)
                section_end = parsed["sections"][section_index + 1]["start"] if section_index + 1 < len(parsed["sections"]) else len(content)
                blocks = [dict(question, end=source_parent["questions"][i + 1]["start"] if i + 1 < len(source_parent["questions"]) else section_end) for i, question in enumerate(source_parent["questions"])]
            updated, new_index = move_block(content, blocks, source, target, position)
            if updated == content:
                self.send_json({"ok": True, "unchanged": True, "document": parsed})
                return
            backup = write_with_backup(file_path, updated)
            selected_id = f"section-{new_index}" if kind == "section" else f"{source_parent['id']}-question-{new_index}"
        self.send_json({"ok": True, "backup": backup, "document": parse_document(path, updated), "selectedId": selected_id})

    def handle_render(self) -> None:
        if not RENDER_LOCK.acquire(blocking=False):
            self.send_error_json("The book is already rendering.", HTTPStatus.CONFLICT)
            return
        try:
            migrated = self.upgrade_legacy_hidden_questions()
            try:
                result = subprocess.run(
                    ["quarto", "render"],
                    cwd=PROJECT_ROOT,
                    capture_output=True,
                    text=True,
                    timeout=240,
                    check=False,
                )
            except subprocess.TimeoutExpired as exc:
                self.send_json(
                    {"ok": False, "output": (exc.stdout or "") + "\nRender timed out after four minutes."},
                    HTTPStatus.REQUEST_TIMEOUT,
                )
                return
            output = (result.stdout or "") + (result.stderr or "")
            self.send_json({"ok": result.returncode == 0, "output": output, "returnCode": result.returncode, "migrated": migrated})
        finally:
            RENDER_LOCK.release()

    def upgrade_legacy_hidden_questions(self) -> list[dict]:
        """Wrap previously hidden HTML-comment blocks in Quarto conditional divs."""
        migrated = []
        with SAVE_LOCK:
            config = (PROJECT_ROOT / "_quarto.yml").read_text(encoding="utf-8")
            for entry in chapter_entries(config):
                path = entry["path"]
                file_path = allowed_path(path)
                content = file_path.read_text(encoding="utf-8")
                parsed = parse_document(path, content)
                legacy = [
                    question
                    for section in parsed["sections"]
                    for question in section["questions"]
                    if question["hidden"] and not question["conditionalHidden"]
                ]
                if not legacy:
                    continue
                updated = content
                for question in sorted(legacy, key=lambda item: item["start"], reverse=True):
                    raw = question["raw"].rstrip("\r\n")
                    replacement = f'{HIDDEN_START}\n:::: {{.content-hidden when-format="html"}}\n{raw}\n::::\n{HIDDEN_END}\n'
                    updated = updated[:question["start"]] + replacement + updated[question["end"]:]
                backup = write_with_backup(file_path, updated)
                migrated.append({"path": path, "backup": backup})
        return migrated


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the local Quarto Book Editor.")
    parser.add_argument("--port", type=int, default=8765, help="Local port (default: 8765)")
    parser.add_argument("--no-browser", action="store_true", help="Do not open the editor in a browser")
    args = parser.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), EditorHandler)
    url = f"http://127.0.0.1:{args.port}"
    print(f"Quarto Book Editor running at {url}")
    print("Press Ctrl+C to stop.")
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping editor.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
