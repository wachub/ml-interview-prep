# ML Interview Prep

A Quarto Book for the machine-learning portion of ML Engineer, Research Engineer, and applied AI interviews. It is a reasoning-first, deliberately non-encyclopedic curriculum intended to grow over one to two years.

## Build locally

Install [Quarto](https://quarto.org/docs/get-started/) and run:

```bash
quarto render
```

The rendered HTML book is written to `_book/`. Preview it interactively with `quarto preview`.

## Edit with the local GUI

If you prefer not to edit Quarto Markdown directly, start the local book editor:

```bash
python3 book-editor/server.py
```

It provides structured chapter, section, question, short-answer, and explanation-tab
editing while keeping the existing `.qmd` files as the source of truth. Every save
creates a local backup, and the GUI can render and open the finished book. See
[`book-editor/README.md`](book-editor/README.md) for details.

## Structure

- **Core ML Foundations** — probability and objectives, generalization and regularization, optimization, and core models.
- **Deep Learning and Modern ML** — representations, Transformers, LLMs, and retrieval/RAG.
- **Interview Reasoning** — evaluation, debugging, experimental design, and ML-system trade-offs.

The first two chapters contain the initial teaching material. The remaining chapters establish a stable curriculum without pretending the first version is complete.
