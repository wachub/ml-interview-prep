# Local Book Editor

This is a local, browser-based editor for the Quarto book. It keeps the existing
`.qmd` files as the source of truth while providing structured controls for:

- browsing chapters, sections, and interview questions;
- dragging chapters, sections, and questions into a new order;
- adding a new interview question to a section;
- adding a new section at the end of a page;
- editing a question, its short answer, and its explanation tabs separately;
- adding, removing, and dragging explanation tabs into a new order;
- editing section introductions without touching the questions below them;
- falling back to raw Quarto Markdown whenever a block has unusual markup;
- running `quarto render` and opening the rendered book.

Select a section and choose **Add question to this section** to draft a new
question. Fill in its title, short answer, and explanation tabs, then choose
**Save changes** to add it to the source file.

Select a page's **Introduction** and choose **Add section to this page** to
draft a new section. Sections are added at the end of that page when saved.

Drag the dotted handle beside an item to reorder it. Tiles slide into their
preview positions while you hover, and the outline numbers follow them. Drop
to save the new order to the source; cancelling the drag restores the original
order. These numbers are a live preview, not a separate draft or staging store.
Regular chapters can be moved within or between
parts; the home page stays first and appendices stay within the appendices.
Sections can be moved within a chapter, and questions within their section.
While dragging a section, its question lists fold out of the way; expanded
sections reopen after the move.
The editor keeps the full source block for
each item intact, including its question content. Choose **Render book** after
a move to refresh the chapter, section, and question numbers in the preview.

**Open preview** shows the most recent rendered output. If the output does not
exist yet, choose **Render book** first. A preview opened during rendering waits
for the new output instead of returning a 404.
Rendered preview files are served without browser caching, so reloading an open
preview tab after rendering shows the newest version.

## Start it

From the project root, run:

```bash
python3 book-editor/server.py
```

The editor opens at <http://127.0.0.1:8765>. To use a different port or avoid
opening a browser automatically:

```bash
python3 book-editor/server.py --port 9000 --no-browser
```

## Safety model

- The server binds only to `127.0.0.1` and accepts only `.qmd` files listed in
  `_quarto.yml`.
- Every save and reorder checks that the file has not changed since it was opened.
- Before replacing a file, the editor writes a timestamped backup under
  `.book-editor/backups/`.
- Files are replaced atomically, so an interrupted write cannot leave a partial
  chapter behind.
- The editor does not commit or push changes. Review the rendered output and use
  Git normally when you are happy with an edit.
