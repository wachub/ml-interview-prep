const state = {
  book: null,
  document: null,
  selection: null,
  dirty: false,
  mode: "structured",
  activeTab: 0,
  draftTabs: [],
  rawModified: false,
};

const $ = (selector) => document.querySelector(selector);
const tree = $("#book-tree");
const structuredEditor = $("#structured-editor");
const rawEditor = $("#raw-editor");
const rawContent = $("#raw-content");
const saveButton = $("#save-button");
const saveState = $("#save-state");

function escapeHtml(value = "") {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function visibilityIcon(hidden) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/>${hidden ? '<path d="m4 4 16 16"/>' : ""}</svg>`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: options.body ? { "Content-Type": "application/json" } : {},
    ...options,
  });
  let data;
  try { data = await response.json(); } catch { data = { error: `Request failed (${response.status})` }; }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function toast(message, type = "info") {
  const element = document.createElement("div");
  element.className = `toast ${type}`;
  element.textContent = message;
  $("#toast-region").append(element);
  setTimeout(() => element.remove(), 4600);
}

function setDirty(value = true) {
  state.dirty = value;
  saveButton.disabled = !value;
  saveState.textContent = value ? "Unsaved changes" : "Saved";
  saveState.className = `save-state ${value ? "dirty" : "saved"}`;
}

function canLeave() {
  return !state.dirty || window.confirm("Discard the unsaved changes in this editor?");
}

function appendixLetter(index) {
  let value = index + 1;
  let letters = "";
  while (value > 0) {
    value -= 1;
    letters = String.fromCharCode(65 + value % 26) + letters;
    value = Math.floor(value / 26);
  }
  return letters;
}

function chapterNumber(path) {
  let chapter = 0;
  let appendix = 0;
  for (const item of state.book?.documents || []) {
    const number = item.group === "appendices" ? appendixLetter(appendix++) : String(++chapter);
    if (item.path === path) return number;
  }
  return "";
}

async function loadBook() {
  state.book = await api("/api/book");
  tree.innerHTML = state.book.documents.map((item, index) => {
    const fixed = item.path === "index.qmd";
    const number = chapterNumber(item.path);
    return `
    ${index === 0 || state.book.documents[index - 1].group !== item.group ? `<div class="group-label" data-animation-key="group:${escapeHtml(item.group)}">${escapeHtml(item.groupLabel)}</div>` : ""}
    <div class="document-node ${fixed ? "" : "draggable-node"}" data-move-kind="chapter" data-move-id="${escapeHtml(item.path)}" data-move-path="${escapeHtml(item.path)}" data-path="${escapeHtml(item.path)}" data-animation-key="chapter:${escapeHtml(item.path)}" title="${fixed ? "Book home page stays first" : "Drag to reorder chapters"}">
      <div class="tree-row">
      <button class="document-button" data-action="open-document" data-path="${escapeHtml(item.path)}">
        <span class="chevron">›</span>
        <span class="outline-number chapter-number">${number}</span>
        <span class="document-title">${escapeHtml(item.title)}</span>
        <span class="count">${item.questionCount || item.sectionCount}</span>
      </button>
      </div>
      <div class="document-children"><div class="tree-loading">Loading…</div></div>
    </div>
  `;
  }).join("");
  state.book.documents.forEach((item) => renderDocumentChildren(item));
}

function renderDocumentChildren(documentData, expand = false) {
  const node = tree.querySelector(`.document-node[data-path="${CSS.escape(documentData.path)}"]`);
  if (!node) return;
  const children = node.querySelector(".document-children");
  const chapter = chapterNumber(documentData.path);
  const expandedSections = new Set(Array.from(children.querySelectorAll(".section-node.open"), (item) => item.dataset.sectionId));
  const items = [
    `<button class="tree-item section" data-node-id="intro" data-path="${escapeHtml(documentData.path)}">Introduction</button>`,
  ];
  documentData.sections.forEach((section, sectionIndex) => {
    const hasQuestions = section.questions.length > 0;
    const hiddenQuestionCount = section.questions.filter((question) => question.hidden).length;
    const sectionNumber = `${chapter}.${sectionIndex + 1}`;
    items.push(`<div class="section-node draggable-node ${expandedSections.has(section.id) ? "open" : ""} ${hasQuestions ? "has-questions" : ""}" data-move-kind="section" data-move-id="${section.id}" data-move-path="${escapeHtml(documentData.path)}" data-section-id="${section.id}" data-animation-key="section:${escapeHtml(section.animationKey || section.id)}" title="Drag to reorder within this chapter"><div class="tree-row">
      <button class="tree-item section" data-kind="section" data-node-id="${section.id}" data-path="${escapeHtml(documentData.path)}" ${hasQuestions ? `aria-expanded="${expandedSections.has(section.id)}"` : ""}>
        <span class="section-chevron" aria-hidden="true">${hasQuestions ? "›" : ""}</span><span class="outline-number section-number">${sectionNumber}</span><span class="section-label">${escapeHtml(section.title)}</span>${hiddenQuestionCount ? `<span class="hidden-indicator" role="img" aria-label="${hiddenQuestionCount} hidden question${hiddenQuestionCount === 1 ? "" : "s"}" title="${hiddenQuestionCount} hidden question${hiddenQuestionCount === 1 ? "" : "s"}">${visibilityIcon(true)}</span>` : ""}
      </button></div><div class="section-children">`);
    section.questions.forEach((question, questionIndex) => {
      const label = question.title ? `Q: ${question.title}` : "Question (raw QMD)";
      const action = question.hidden ? "Show question in rendered book" : "Hide question from rendered book";
      items.push(`<div class="question-node draggable-node tree-row ${question.hidden ? "is-hidden-question" : ""}" data-move-kind="question" data-move-id="${question.id}" data-move-path="${escapeHtml(documentData.path)}" data-animation-key="question:${escapeHtml(question.animationKey || question.id)}" title="Drag to reorder within this section"><button class="tree-item question" data-node-id="${question.id}" data-path="${escapeHtml(documentData.path)}"><span class="outline-number question-number">${sectionNumber}.${questionIndex + 1}</span><span class="question-label">${escapeHtml(label)}</span></button><button class="visibility-toggle ${question.hidden ? "is-hidden" : ""}" type="button" data-action="toggle-question-visibility" data-node-id="${question.id}" data-path="${escapeHtml(documentData.path)}" data-hidden="${question.hidden}" aria-label="${action}" title="${action}">${visibilityIcon(question.hidden)}</button></div>`);
    });
    items.push("</div></div>");
  });
  children.innerHTML = items.join("");
  if (expand) node.classList.add("open");
  document.querySelectorAll(".document-button").forEach((button) => button.classList.toggle("active", button.dataset.path === state.document?.path));
  filterTree($("#search-input").value);
}

function setSectionOpen(sectionNode, open) {
  sectionNode.classList.toggle("open", open);
  sectionNode.querySelector(".tree-item.section").setAttribute("aria-expanded", String(open));
}

async function ensureDocument(path) {
  if (state.document?.path === path) return state.document;
  state.document = await api(`/api/document?path=${encodeURIComponent(path)}`);
  renderDocumentChildren(state.document, true);
  return state.document;
}

function findNode(id) {
  if (!state.document) return null;
  if (id === "intro") return state.document.intro;
  for (const section of state.document.sections) {
    if (section.id === id) return section;
    const question = section.questions.find((item) => item.id === id);
    if (question) return question;
  }
  return null;
}

function numberForNode(node) {
  const chapter = chapterNumber(state.document?.path);
  if (node.kind === "intro") return chapter;
  if (node.isNew && node.kind === "section") return `${chapter}.${state.document.sections.length + 1}`;
  if (node.isNew && node.kind === "question") {
    const indices = /^section-(\d+)-question-(\d+)$/.exec(node.id);
    if (indices) return `${chapter}.${Number(indices[1]) + 1}.${Number(indices[2]) + 1}`;
  }
  for (const [sectionIndex, section] of state.document.sections.entries()) {
    const sectionNumber = `${chapter}.${sectionIndex + 1}`;
    if (section.id === node.id) return sectionNumber;
    const questionIndex = section.questions.findIndex((question) => question.id === node.id);
    if (questionIndex !== -1) return `${sectionNumber}.${questionIndex + 1}`;
  }
  return "";
}

async function openDocument(path) {
  const node = tree.querySelector(`.document-node[data-path="${CSS.escape(path)}"]`);
  if (node?.classList.contains("open")) {
    node.querySelectorAll(".section-node.open").forEach((section) => setSectionOpen(section, false));
    node.classList.remove("open");
    return;
  }
  if (state.document?.path === path) {
    node?.classList.add("open");
    return;
  }
  if (!canLeave()) return;
  try {
    const data = await ensureDocument(path);
    renderDocumentChildren(data, true);
    selectNode("intro");
  } catch (error) { toast(error.message, "error"); }
}

async function openNode(path, id) {
  if (!canLeave()) return;
  try {
    await ensureDocument(path);
    renderDocumentChildren(state.document, true);
    selectNode(id);
    if (window.innerWidth <= 900) $("#sidebar").classList.remove("open");
  } catch (error) { toast(error.message, "error"); }
}

function selectNode(id) {
  const node = findNode(id);
  if (!node) return;
  showNode(node);
}

function showNode(node) {
  state.selection = node;
  state.activeTab = 0;
  state.draftTabs = node.tabs ? structuredClone(node.tabs) : [];
  state.mode = node.kind === "question" && !node.structured ? "raw" : "structured";
  state.rawModified = false;
  $("#empty-state").classList.add("hidden");
  $("#editor-view").classList.remove("hidden");
  const kindLabel = node.kind === "intro" ? "CHAPTER INTRO" : node.kind === "question" ? "INTERVIEW QUESTION" : node.kind.toUpperCase();
  $("#editor-kind").textContent = `${kindLabel} · ${numberForNode(node)}`;
  $("#editor-title").textContent = node.title || (node.isNew ? `New ${node.kind}` : state.document.title);
  $("#file-path").textContent = state.document.path;
  $("#line-number").textContent = `line ${node.line || 1}`;
  rawContent.value = node.raw;
  const questionActions = $("#question-actions");
  questionActions.classList.toggle("hidden", node.kind !== "question" || Boolean(node.isNew));
  renderStructuredEditor();
  setMode(state.mode);
  setDirty(false);
  document.querySelectorAll(".tree-item").forEach((item) => item.classList.toggle("active", item.dataset.nodeId === node.id && item.dataset.path === state.document.path));
}

function startNewQuestion() {
  const section = state.selection;
  if (!section || section.kind !== "section" || !canLeave()) return;
  const position = section.questions.length ? section.questions.at(-1).end : section.end;
  showNode({
    id: `${section.id}-question-${section.questions.length}`,
    kind: "question",
    isNew: true,
    structured: true,
    title: "",
    attributes: "{.qa-card}",
    shortAnswer: "",
    beforeShort: "",
    detailsLead: "<details><summary><strong>Expand explanation</strong></summary>\n\n::: {.panel-tabset}\n",
    tabs: [{ title: "Intuition", content: "" }],
    detailsTail: ":::\n</details>\n",
    raw: "",
    start: position,
    end: position,
    line: state.document.content.slice(0, position).split("\n").length,
  });
  setDirty(true);
  $("#question-title").focus();
}

function startNewSection() {
  if (state.selection?.kind !== "intro" || !canLeave()) return;
  const position = state.document.content.length;
  showNode({
    id: `section-${state.document.sections.length}`,
    kind: "section",
    isNew: true,
    title: "",
    attributes: "",
    body: "",
    questions: [],
    raw: "",
    start: position,
    end: position,
    line: state.document.content.slice(0, position).split("\n").length,
  });
  setDirty(true);
  $("#section-title").focus();
}

function renderStructuredEditor() {
  const node = state.selection;
  if (!node) return;
  if (node.kind === "question") {
    renderQuestionEditor(node);
  } else if (node.kind === "section") {
    structuredEditor.innerHTML = `
      <div class="field"><label for="section-title">Section title</label><input id="section-title" class="text-input" value="${escapeHtml(node.title)}" /></div>
      ${node.isNew ? "" : `<div class="section-actions"><button class="button secondary" data-action="add-question">＋ Add question to this section</button><span>Opens a new draft below this section’s existing questions.</span></div>`}
      <div class="field"><div class="field-head"><label for="section-body">Section introduction</label><span>Questions underneath this section are edited separately.</span></div><textarea id="section-body" class="section-body">${escapeHtml(node.body || "")}</textarea></div>
    `;
    bindDirtyInputs(structuredEditor);
  } else {
    structuredEditor.innerHTML = `
      <div class="section-actions"><button class="button secondary" data-action="add-section">＋ Add section to this page</button><span>Opens a new draft at the end of this page.</span></div>
      <div class="field"><div class="field-head"><label for="intro-body">Page introduction</label><span>Includes the chapter heading or the page's YAML title block.</span></div><textarea id="intro-body" class="section-body">${escapeHtml(node.raw)}</textarea></div>
    `;
    bindDirtyInputs(structuredEditor);
  }
}

function renderQuestionEditor(node) {
  if (!node.structured) {
    structuredEditor.innerHTML = `<div class="unsupported-note">This question uses a structure the form cannot safely decompose. Use <strong>Raw QMD</strong>; the editor will preserve it exactly.</div>`;
    return;
  }
  structuredEditor.innerHTML = `
    <div class="form-grid">
      <div class="field"><label for="question-title">Question</label><input id="question-title" class="text-input" value="${escapeHtml(node.title)}" /></div>
      <div class="field"><label for="question-attributes">Quarto attributes</label><input id="question-attributes" class="text-input" value="${escapeHtml(node.attributes)}" /><div class="field-help">IDs and the <code>.qa-card</code> class live here.</div></div>
    </div>
    <div class="field"><div class="field-head"><label for="short-answer">Short interview answer</label><span>Markdown and TeX are supported.</span></div><textarea id="short-answer" class="short-answer">${escapeHtml(node.shortAnswer)}</textarea></div>
    <div class="field"><div class="field-head"><label>Expanded explanation tabs</label><span>Edit one tab at a time; reorder without touching QMD markers.</span></div><div id="tabs-editor" class="tabs-editor"></div></div>
  `;
  bindDirtyInputs(structuredEditor);
  renderTabs();
}

function renderTabs() {
  const container = $("#tabs-editor");
  if (!container) return;
  if (!state.draftTabs.length) state.draftTabs.push({ title: "Deep Dive", content: "" });
  state.activeTab = Math.max(0, Math.min(state.activeTab, state.draftTabs.length - 1));
  const current = state.draftTabs[state.activeTab];
  container.innerHTML = `
    <div class="tabs-bar">
      ${state.draftTabs.map((tab, index) => `<button class="tab-button ${index === state.activeTab ? "active" : ""}" data-tab-index="${index}" draggable="true" title="Drag to reorder tab">${escapeHtml(tab.title || "Untitled")}</button>`).join("")}
      <button class="tab-button add-tab" data-action="add-tab">＋ Add tab</button>
    </div>
    <div class="tab-content">
      <div class="field"><label for="tab-title">Tab name</label><input id="tab-title" class="text-input" value="${escapeHtml(current.title)}" /></div>
      <div class="field"><label for="tab-body">Tab content</label><textarea id="tab-body">${escapeHtml(current.content)}</textarea></div>
      <div class="tab-tools">
        <button class="remove-tab" data-action="remove-tab">Remove tab</button>
      </div>
    </div>
  `;
  $("#tab-title").addEventListener("input", (event) => {
    current.title = event.target.value;
    container.querySelector(`.tab-button[data-tab-index="${state.activeTab}"]`).textContent = event.target.value || "Untitled";
    setDirty();
  });
  $("#tab-body").addEventListener("input", (event) => { current.content = event.target.value; setDirty(); });
}

function bindDirtyInputs(container) {
  container.querySelectorAll("input, textarea").forEach((input) => input.addEventListener("input", () => setDirty()));
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".mode-switch button").forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
  structuredEditor.classList.toggle("hidden", mode !== "structured");
  rawEditor.classList.toggle("hidden", mode !== "raw");
}

function normalizeBlock(value) {
  return value.replace(/^\s+|\s+$/g, "");
}

function buildQuestionRaw() {
  const node = state.selection;
  const title = $("#question-title").value.trim();
  const attributes = $("#question-attributes").value.trim() || "{.qa-card}";
  const answer = normalizeBlock($("#short-answer").value);
  const tabs = state.draftTabs.map((tab) => `#### ${tab.title.trim() || "Untitled"}\n\n${normalizeBlock(tab.content)}`).join("\n\n");
  return `### Q: ${title} ${attributes}\n${node.beforeShort}\n**Short answer:** ${answer}\n\n${node.detailsLead}\n${tabs}\n${node.detailsTail}`.replace(/\n{4,}/g, "\n\n\n").replace(/\s*$/, "\n");
}

function buildStructuredRaw() {
  const node = state.selection;
  if (node.kind === "question") return node.structured ? buildQuestionRaw() : rawContent.value;
  if (node.kind === "section") {
    const title = $("#section-title").value.trim();
    const body = normalizeBlock($("#section-body").value);
    return `## ${title}${node.attributes ? ` ${node.attributes}` : ""}\n\n${body}${body ? "\n\n" : ""}`;
  }
  return $("#intro-body").value;
}

async function saveSelection() {
  if (!state.selection || !state.dirty) return;
  const node = state.selection;
  if (node.isNew && state.mode === "structured") {
    const titleField = node.kind === "section" ? $("#section-title") : $("#question-title");
    if (!titleField.value.trim()) {
      toast(`Enter a ${node.kind} title before saving.`, "error");
      titleField.focus();
      return;
    }
  }
  let replacement = state.mode === "raw" ? rawContent.value : buildStructuredRaw();
  if (node.kind === "question" && node.hidden) {
    replacement = `<!-- book-editor:hidden-question:start -->\n:::: {.content-hidden when-format="html"}\n${replacement.replace(/\s*$/, "")}\n::::\n<!-- book-editor:hidden-question:end -->\n`;
  }
  if (node.isNew) {
    const validHeading = node.kind === "section" ? /^##(?!#)\s+\S/m.test(replacement) : /^### Q:\s*\S/m.test(replacement);
    if (!validHeading) {
      toast(`A new ${node.kind} needs a ${node.kind === "section" ? "##" : "### Q:"} heading.`, "error");
      return;
    }
  }
  if (!replacement.endsWith("\n")) replacement += "\n";
  if (node.isNew) {
    const before = state.document.content.slice(0, node.start);
    const prefix = before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    replacement = prefix + replacement.replace(/\n*$/, "\n\n");
  }
  const content = state.document.content.slice(0, node.start) + replacement + state.document.content.slice(node.end);
  saveButton.disabled = true;
  saveState.textContent = "Saving…";
  try {
    const result = await api("/api/save", {
      method: "POST",
      body: JSON.stringify({ path: state.document.path, content, expectedHash: state.document.hash }),
    });
    const oldId = node.id;
    state.document = result.document;
    renderDocumentChildren(state.document, true);
    selectNode(findNode(oldId) ? oldId : "intro");
    toast(`Saved. Backup: ${result.backup}`);
    await refreshGitStatus();
  } catch (error) {
    saveState.textContent = "Save failed";
    saveState.className = "save-state dirty";
    saveButton.disabled = false;
    toast(error.message, "error");
  }
}

async function renderBook() {
  if (state.dirty) {
    toast("Save or discard your current changes before rendering.", "error");
    return;
  }
  const dialog = $("#render-dialog");
  $("#render-button").disabled = true;
  $("#preview-button").disabled = true;
  $("#dialog-preview").disabled = true;
  $("#render-status").textContent = "Rendering the complete Quarto book…";
  $("#render-status").className = "render-status";
  $("#render-output").textContent = "Running quarto render…";
  dialog.showModal();
  try {
    const result = await api("/api/render", { method: "POST", body: "{}" });
    if (result.migrated?.length) {
      const selectedPath = state.document?.path;
      const selectedId = state.selection?.id;
      await loadBook();
      if (selectedPath && result.migrated.some((item) => item.path === selectedPath)) {
        state.document = await api(`/api/document?path=${encodeURIComponent(selectedPath)}`);
        renderDocumentChildren(state.document, true);
        selectNode(findNode(selectedId) ? selectedId : "intro");
      }
      toast(`Updated ${result.migrated.length} chapter${result.migrated.length === 1 ? "" : "s"} to use Quarto hidden-content blocks.`);
    }
    $("#render-output").textContent = result.output || "Render completed without console output.";
    $("#render-status").textContent = result.ok ? "Render succeeded" : `Render failed (exit ${result.returnCode})`;
    $("#render-status").className = `render-status ${result.ok ? "success" : "error"}`;
    $("#dialog-preview").disabled = !result.ok;
  } catch (error) {
    $("#render-status").textContent = "Render failed";
    $("#render-status").className = "render-status error";
    $("#render-output").textContent = error.message;
  } finally {
    $("#render-button").disabled = false;
    $("#preview-button").disabled = false;
  }
}

async function setQuestionHidden(path, questionId, hidden) {
  if (!canLeave()) return;
  const selectedPath = state.document?.path;
  const selectedId = state.selection?.id;
  try {
    const documentData = selectedPath === path ? state.document : await api(`/api/document?path=${encodeURIComponent(path)}`);
    const result = await api("/api/question-visibility", {
      method: "POST",
      body: JSON.stringify({ path, questionId, hidden, expectedHash: documentData.hash }),
    });
    if (selectedPath === path) state.document = result.document;
    renderDocumentChildren(result.document);
    if (selectedPath === path && selectedId) selectNode(findNode(selectedId) ? selectedId : "intro");
    toast(`Question ${hidden ? "hidden" : "shown"}. Render to update the HTML preview. Backup: ${result.backup}`);
    await refreshGitStatus();
  } catch (error) { toast(error.message, "error"); }
}

async function deleteQuestion() {
  const node = state.selection;
  if (!node || node.kind !== "question" || node.isNew || !canLeave()) return;
  const name = node.title ? `“${node.title}”` : "this question";
  if (!window.confirm(`Delete ${name} and its answer content from the Quarto source? This cannot be undone from the editor. A backup copy will be made first.`)) return;
  try {
    const result = await api("/api/delete-question", {
      method: "POST",
      body: JSON.stringify({ path: state.document.path, questionId: node.id, expectedHash: state.document.hash }),
    });
    state.document = result.document;
    await loadBook();
    renderDocumentChildren(state.document, true);
    selectNode("intro");
    toast(`Question deleted. Backup: ${result.backup}`);
    await refreshGitStatus();
  } catch (error) { toast(error.message, "error"); }
}

async function refreshGitStatus() {
  try {
    const result = await api("/api/git-status");
    $("#git-dot").className = `status-dot ${result.clean ? "clean" : "dirty"}`;
    $("#git-status").textContent = result.clean ? "Working tree clean" : "Local changes present";
  } catch {
    $("#git-status").textContent = "Git status unavailable";
  }
}

function filterTree(query) {
  const needle = query.trim().toLowerCase();
  document.querySelectorAll(".document-node").forEach((documentNode) => {
    const documentMatches = documentNode.querySelector(".document-title").textContent.toLowerCase().includes(needle);
    const intro = documentNode.querySelector('.tree-item[data-node-id="intro"]');
    if (!intro) return;
    const introVisible = !needle || documentMatches || "introduction".includes(needle);
    intro.classList.toggle("filtered-out", !introVisible);
    let visibleChildren = introVisible ? 1 : 0;
    documentNode.querySelectorAll(".section-node").forEach((sectionNode) => {
      const sectionMatches = sectionNode.querySelector(".section-label").textContent.toLowerCase().includes(needle);
      let visibleQuestions = 0;
      sectionNode.querySelectorAll(".tree-item.question").forEach((question) => {
        const visible = !needle || documentMatches || sectionMatches || question.textContent.toLowerCase().includes(needle);
        question.classList.toggle("filtered-out", !visible);
        if (visible) visibleQuestions += 1;
      });
      const visible = !needle || documentMatches || sectionMatches || visibleQuestions > 0;
      sectionNode.classList.toggle("filtered-out", !visible);
      if (visible) visibleChildren += 1;
      if (needle && visibleQuestions > 0 && sectionNode.classList.contains("has-questions")) setSectionOpen(sectionNode, true);
    });
    documentNode.classList.toggle("filtered-out", Boolean(needle) && !documentMatches && visibleChildren === 0);
    if (needle && visibleChildren) documentNode.classList.add("open");
  });
}

let draggedItem = null;
let moving = false;
let autoScrollFrame = 0;
let autoScrollStep = 0;
let activeRowAnimations = [];
let dragCandidate = null;
let dragPointer = null;
let suppressNextTreeClick = false;

function sectionKey(section) {
  return `${section.title}\u0000${section.raw}`;
}

function expandedSectionKeys(path) {
  const documentNode = tree.querySelector(`.document-node[data-path="${CSS.escape(path)}"]`);
  if (!documentNode || state.document?.path !== path) return new Set();
  const byId = new Map(state.document.sections.map((section) => [section.id, section]));
  return new Set(Array.from(documentNode.querySelectorAll(".section-node.open"), (node) => byId.get(node.dataset.sectionId)).filter(Boolean).map(sectionKey));
}

function restoreExpandedSections(path, keys) {
  if (!keys?.size || state.document?.path !== path) return;
  const documentNode = tree.querySelector(`.document-node[data-path="${CSS.escape(path)}"]`);
  for (const section of state.document.sections) {
    if (!keys.has(sectionKey(section))) continue;
    const node = documentNode?.querySelector(`.section-node[data-section-id="${CSS.escape(section.id)}"]`);
    if (node?.classList.contains("has-questions")) setSectionOpen(node, true);
  }
}

function stopAutoScroll() {
  autoScrollStep = 0;
  if (autoScrollFrame) cancelAnimationFrame(autoScrollFrame);
  autoScrollFrame = 0;
}

function updateAutoScroll(pointerY) {
  const bounds = tree.getBoundingClientRect();
  const edge = 48;
  if (pointerY < bounds.top || pointerY > bounds.bottom) { stopAutoScroll(); return; }
  autoScrollStep = pointerY < bounds.top + edge ? -Math.ceil((bounds.top + edge - pointerY) / 4)
    : pointerY > bounds.bottom - edge ? Math.ceil((pointerY - (bounds.bottom - edge)) / 4) : 0;
  if (!autoScrollStep || autoScrollFrame) return;
  const tick = () => {
    if (!draggedItem || !autoScrollStep) { autoScrollFrame = 0; return; }
    tree.scrollTop += autoScrollStep;
    if (dragPointer) previewDragAt(dragPointer.x, dragPointer.y);
    autoScrollFrame = requestAnimationFrame(tick);
  };
  autoScrollFrame = requestAnimationFrame(tick);
}

function reorderRows(kind, path) {
  if (kind === "chapter") return tree.querySelectorAll(":scope > .group-label, :scope > .document-node");
  const documentNode = tree.querySelector(`.document-node[data-path="${CSS.escape(path)}"]`);
  if (!documentNode) return [];
  if (kind === "section") return documentNode.querySelectorAll(":scope > .document-children > .section-node");
  return documentNode.querySelectorAll(".question-node");
}

function rowPositions(kind, path) {
  const positions = new Map();
  const viewport = tree.getBoundingClientRect();
  for (const element of reorderRows(kind, path)) {
    const bounds = element.getBoundingClientRect();
    if (bounds.height && bounds.bottom > viewport.top && bounds.top < viewport.bottom) {
      positions.set(element.dataset.animationKey, { top: bounds.top, left: bounds.left });
    }
  }
  return positions;
}

async function animateReorder(kind, path, before, movedKey, preview = false) {
  activeRowAnimations.forEach((animation) => animation.cancel());
  activeRowAnimations = [];
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const animations = [];
  for (const element of reorderRows(kind, path)) {
    const first = before.get(element.dataset.animationKey);
    if (!first) continue;
    const last = element.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    const moved = element.dataset.animationKey === movedKey;
    animations.push(element.animate([
      { transform: `translate(${dx}px, ${dy}px)${moved ? " scale(.985)" : ""}` },
      { transform: "translate(0, 0) scale(1)" },
    ], {
      duration: preview ? 220 : moved ? 390 : 340,
      easing: "cubic-bezier(.22, 1, .36, 1)",
    }));
  }
  activeRowAnimations = animations;
  await Promise.allSettled(animations.map((animation) => animation.finished));
  if (activeRowAnimations === animations) activeRowAnimations = [];
}

function updateOutlineNumbers() {
  let chapter = 0;
  let appendix = 0;
  const byPath = new Map(state.book.documents.map((item) => [item.path, item]));
  for (const documentNode of tree.querySelectorAll(":scope > .document-node")) {
    const item = byPath.get(documentNode.dataset.path);
    const number = item?.group === "appendices" ? appendixLetter(appendix++) : String(++chapter);
    documentNode.querySelector(":scope > .tree-row .chapter-number").textContent = number;
    for (const [sectionIndex, sectionNode] of Array.from(documentNode.querySelectorAll(":scope > .document-children > .section-node")).entries()) {
      const sectionNumber = `${number}.${sectionIndex + 1}`;
      sectionNode.querySelector(":scope > .tree-row .section-number").textContent = sectionNumber;
      sectionNode.querySelectorAll(":scope > .section-children > .question-node").forEach((questionNode, questionIndex) => {
        questionNode.querySelector(".question-number").textContent = `${sectionNumber}.${questionIndex + 1}`;
      });
    }
  }
  if (state.selection && state.document) {
    const selected = tree.querySelector(`.tree-item.active[data-path="${CSS.escape(state.document.path)}"]`);
    const number = state.selection.kind === "intro" ? tree.querySelector(`.document-node[data-path="${CSS.escape(state.document.path)}"] > .tree-row .chapter-number`)?.textContent
      : selected?.querySelector(".section-number, .question-number")?.textContent;
    if (number) {
      const kindLabel = state.selection.kind === "intro" ? "CHAPTER INTRO" : state.selection.kind === "question" ? "INTERVIEW QUESTION" : "SECTION";
      $("#editor-kind").textContent = `${kindLabel} · ${number}`;
    }
  }
}

function restoreDragPreview(item) {
  if (!item?.sourceNode?.isConnected || !item.originalParent?.isConnected) return;
  const before = rowPositions(item.kind, item.path);
  item.originalParent.insertBefore(item.sourceNode, item.originalNextSibling);
  updateOutlineNumbers();
  animateReorder(item.kind, item.path, before, item.sourceNode.dataset.animationKey, true);
  restoreChapterExpansion(item);
  restoreExpandedSections(item.path, item.expandedKeys);
}

function restoreChapterExpansion(item) {
  if (!item?.openDocumentPaths) return;
  for (const path of item.openDocumentPaths) {
    const documentNode = tree.querySelector(`.document-node[data-path="${CSS.escape(path)}"]`);
    documentNode?.classList.add("open");
    for (const id of item.openSectionIds.get(path) || []) {
      const sectionNode = documentNode?.querySelector(`.section-node[data-section-id="${CSS.escape(id)}"]`);
      if (sectionNode?.classList.contains("has-questions")) setSectionOpen(sectionNode, true);
    }
  }
}

async function reorder(kind, source, target, path, position, expandedKeys = null, dragContext = null) {
  if (moving || source === target) return;
  if (state.dirty) { toast("Save or discard your current edits before moving items.", "error"); return; }
  moving = true;
  const previousScroll = tree.scrollTop;
  const before = rowPositions(kind, path);
  const sourceNode = kind === "chapter" ? tree.querySelector(`.document-node[data-path="${CSS.escape(source)}"]`)
    : tree.querySelector(`.draggable-node[data-move-kind="${kind}"][data-move-id="${CSS.escape(source)}"]`);
  const movedKey = sourceNode?.dataset.animationKey;
  try {
    if (kind !== "chapter" && state.document?.path !== path) await ensureDocument(path);
    const result = await api("/api/reorder", {
      method: "POST",
      body: JSON.stringify({ kind, source, target, path, position,
        expectedHash: kind === "chapter" ? state.book.configHash : state.document.hash }),
    });
    if (result.unchanged) { restoreDragPreview(dragContext); restoreExpandedSections(path, expandedKeys); return; }
    if (kind === "chapter") {
      await loadBook();
      if (state.document) {
        renderDocumentChildren(state.document, true);
        if (state.selection) selectNode(state.selection.id);
      }
    } else {
      state.document = result.document;
      renderDocumentChildren(state.document, true);
      selectNode(result.selectedId);
    }
    tree.scrollTop = previousScroll;
    await animateReorder(kind, path, before, movedKey);
    restoreChapterExpansion(dragContext);
    restoreExpandedSections(path, expandedKeys);
    const movedRow = kind === "chapter" ? tree.querySelector(`.document-node[data-path="${CSS.escape(source)}"] > .tree-row`)
      : kind === "section" ? tree.querySelector(`.section-node[data-section-id="${CSS.escape(result.selectedId)}"] > .tree-row`)
      : tree.querySelector(`.question-node[data-move-id="${CSS.escape(result.selectedId)}"]`);
    movedRow?.scrollIntoView({ block: "nearest" });
    toast(`${kind[0].toUpperCase() + kind.slice(1)} moved and saved. Render to update the HTML preview.`);
    await refreshGitStatus();
  } catch (error) {
    restoreDragPreview(dragContext);
    restoreExpandedSections(path, expandedKeys);
    toast(error.message, "error");
  }
  finally { moving = false; }
}

function beginTreeDrag(node) {
  if (state.dirty) { toast("Save your current edits before dragging items.", "error"); return false; }
  draggedItem = {
    kind: node.dataset.moveKind,
    id: node.dataset.moveId,
    path: node.dataset.movePath,
    sourceNode: node,
    originalParent: node.parentElement,
    originalNextSibling: node.nextSibling,
    originalNextElementSibling: node.nextElementSibling,
    previewChanged: false,
  };
  if (draggedItem.kind === "section") {
    draggedItem.expandedKeys = expandedSectionKeys(draggedItem.path);
    node.closest(".document-node")?.querySelectorAll(".section-node.open").forEach((section) => setSectionOpen(section, false));
  } else if (draggedItem.kind === "chapter") {
    const openDocuments = Array.from(tree.querySelectorAll(".document-node.open"));
    draggedItem.openDocumentPaths = openDocuments.map((documentNode) => documentNode.dataset.path);
    draggedItem.openSectionIds = new Map(openDocuments.map((documentNode) => [documentNode.dataset.path,
      Array.from(documentNode.querySelectorAll(".section-node.open"), (section) => section.dataset.sectionId)]));
    openDocuments.forEach((documentNode) => documentNode.classList.remove("open"));
  }
  node.classList.add("dragging");
  tree.classList.add("drag-active");
  document.body.classList.add("reordering");
  return true;
}

function validDragTarget(node, item) {
  if (!node || node === item.sourceNode || node.dataset.moveKind !== item.kind) return false;
  if (item.kind !== "chapter" && node.dataset.movePath !== item.path) return false;
  if (item.kind === "question" && node.closest(".section-node") !== item.sourceNode.closest(".section-node")) return false;
  if (item.kind === "chapter") {
    const sourceGroup = state.book.documents.find((documentData) => documentData.path === item.id)?.group;
    const targetGroup = state.book.documents.find((documentData) => documentData.path === node.dataset.moveId)?.group;
    if (sourceGroup !== targetGroup && !(sourceGroup?.startsWith("part-") && targetGroup?.startsWith("part-"))) return false;
  }
  return true;
}

function previewDragAt(x, y) {
  const item = draggedItem;
  if (!item) return;
  const bounds = tree.getBoundingClientRect();
  if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return;
  const selector = `.draggable-node[data-move-kind="${item.kind}"]`;
  const hit = document.elementFromPoint(x, y);
  let node = hit?.closest(selector);
  if (node && !validDragTarget(node, item)) return;
  if (!node) {
    const nearby = Array.from(reorderRows(item.kind, item.path)).filter((candidate) => candidate.matches(selector) && validDragTarget(candidate, item));
    let distance = Infinity;
    node = null;
    for (const candidate of nearby) {
      const row = candidate.matches(".tree-row") ? candidate : candidate.querySelector(":scope > .tree-row");
      const rect = row.getBoundingClientRect();
      const gap = y < rect.top ? rect.top - y : Math.max(0, y - rect.bottom);
      if (gap < distance) { distance = gap; node = candidate; }
    }
    if (distance > 28) return;
  }
  const row = node.matches(".tree-row") ? node : node.querySelector(":scope > .tree-row");
  const after = y > row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
  const reference = after ? node.nextSibling : node;
  item.previewTarget = node.dataset.moveId;
  item.previewPosition = after ? "after" : "before";
  if (reference === item.sourceNode || item.sourceNode.nextSibling === reference) return;
  const before = rowPositions(item.kind, item.path);
  node.parentElement.insertBefore(item.sourceNode, reference);
  item.previewChanged = item.sourceNode.parentElement !== item.originalParent
    || item.sourceNode.nextElementSibling !== item.originalNextElementSibling;
  updateOutlineNumbers();
  animateReorder(item.kind, item.path, before, item.sourceNode.dataset.animationKey, true);
}

tree.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || moving || dragCandidate) return;
  if (event.target.closest(".visibility-toggle")) return;
  const row = event.target.closest(".tree-row");
  const node = row?.closest(".draggable-node");
  const ownRow = node?.matches(".question-node") ? node : node?.querySelector(":scope > .tree-row");
  if (!node || row !== ownRow) return;
  dragCandidate = { node, pointerId: event.pointerId, pointerType: event.pointerType, x: event.clientX, y: event.clientY, blocked: false, timer: null };
  if (event.pointerType === "touch") {
    const candidate = dragCandidate;
    candidate.timer = setTimeout(() => {
      if (dragCandidate !== candidate || candidate.blocked) return;
      suppressNextTreeClick = true;
      if (!beginTreeDrag(candidate.node)) { candidate.blocked = true; return; }
      tree.setPointerCapture(candidate.pointerId);
    }, 300);
  }
});

window.addEventListener("pointermove", (event) => {
  if (!dragCandidate || event.pointerId !== dragCandidate.pointerId) return;
  if (!draggedItem) {
    const distance = Math.hypot(event.clientX - dragCandidate.x, event.clientY - dragCandidate.y);
    if (dragCandidate.pointerType === "touch") {
      if (distance >= 6) { clearTimeout(dragCandidate.timer); dragCandidate.blocked = true; }
      return;
    }
    if (dragCandidate.blocked || distance < 6) return;
    suppressNextTreeClick = true;
    if (!beginTreeDrag(dragCandidate.node)) { dragCandidate.blocked = true; return; }
    tree.setPointerCapture(event.pointerId);
  }
  event.preventDefault();
  dragPointer = { x: event.clientX, y: event.clientY };
  updateAutoScroll(event.clientY);
  previewDragAt(event.clientX, event.clientY);
});

tree.addEventListener("touchmove", (event) => {
  if (draggedItem) event.preventDefault();
}, { passive: false });

function finishTreeDrag(event, cancelled = false) {
  if (!dragCandidate || event.pointerId !== dragCandidate.pointerId) return;
  clearTimeout(dragCandidate.timer);
  const item = draggedItem;
  const wasDragging = Boolean(item);
  if (tree.hasPointerCapture(event.pointerId)) tree.releasePointerCapture(event.pointerId);
  dragCandidate = null;
  draggedItem = null;
  dragPointer = null;
  stopAutoScroll();
  tree.classList.remove("drag-active");
  document.body.classList.remove("reordering");
  if (!wasDragging) {
    if (suppressNextTreeClick) setTimeout(() => { suppressNextTreeClick = false; }, 0);
    return;
  }
  event.preventDefault();
  item.sourceNode.classList.remove("dragging");
  const bounds = tree.getBoundingClientRect();
  const inside = event.clientX >= bounds.left && event.clientX <= bounds.right
    && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
  if (cancelled || !inside || !item.previewChanged) restoreDragPreview(item);
  else reorder(item.kind, item.id, item.previewTarget, item.path, item.previewPosition, item.expandedKeys, item);
  setTimeout(() => { suppressNextTreeClick = false; }, 0);
}

window.addEventListener("pointerup", (event) => finishTreeDrag(event));
window.addEventListener("pointercancel", (event) => finishTreeDrag(event, true));
window.addEventListener("blur", () => {
  if (dragCandidate) finishTreeDrag({ pointerId: dragCandidate.pointerId, clientX: -1, clientY: -1, preventDefault() {} }, true);
});
tree.addEventListener("click", (event) => {
  if (!suppressNextTreeClick) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  suppressNextTreeClick = false;
}, true);

tree.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.action === "toggle-question-visibility") {
    await setQuestionHidden(button.dataset.path, button.dataset.nodeId, button.dataset.hidden !== "true");
    return;
  }
  if (button.dataset.action === "open-document") await openDocument(button.dataset.path);
  else if (button.dataset.kind === "section") {
    const sectionNode = button.closest(".section-node");
    if (sectionNode.classList.contains("has-questions")) {
      const open = !sectionNode.classList.contains("open");
      setSectionOpen(sectionNode, open);
      if (!open) return;
    }
    await openNode(button.dataset.path, button.dataset.nodeId);
  }
  else if (button.dataset.nodeId) await openNode(button.dataset.path, button.dataset.nodeId);
});

structuredEditor.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.action === "add-section") { startNewSection(); return; }
  if (button.dataset.action === "add-question") { startNewQuestion(); return; }
  if (button.dataset.tabIndex !== undefined) {
    state.activeTab = Number(button.dataset.tabIndex); renderTabs(); return;
  }
  if (button.dataset.action === "add-tab") {
    state.draftTabs.push({ title: "New Tab", content: "" }); state.activeTab = state.draftTabs.length - 1; setDirty(); renderTabs();
  } else if (button.dataset.action === "remove-tab") {
    if (state.draftTabs.length === 1) { toast("A question needs at least one explanation tab.", "error"); return; }
    state.draftTabs.splice(state.activeTab, 1); state.activeTab = Math.max(0, state.activeTab - 1); setDirty(); renderTabs();
  }
});

let draggedTab = null;
structuredEditor.addEventListener("dragstart", (event) => {
  const tab = event.target.closest(".tab-button[data-tab-index]");
  if (!tab) return;
  draggedTab = Number(tab.dataset.tabIndex);
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", String(draggedTab));
  tab.classList.add("dragging");
});
structuredEditor.addEventListener("dragover", (event) => {
  const tab = event.target.closest(".tab-button[data-tab-index]");
  if (draggedTab === null || !tab || Number(tab.dataset.tabIndex) === draggedTab) return;
  event.preventDefault();
  const after = event.clientX > tab.getBoundingClientRect().left + tab.getBoundingClientRect().width / 2;
  structuredEditor.querySelectorAll(".tab-button.drop-before, .tab-button.drop-after").forEach((item) => item.classList.remove("drop-before", "drop-after"));
  tab.classList.add(after ? "drop-after" : "drop-before");
  event.dataTransfer.dropEffect = "move";
});
structuredEditor.addEventListener("drop", (event) => {
  const tab = event.target.closest(".tab-button[data-tab-index]");
  if (draggedTab === null || !tab || !(tab.classList.contains("drop-before") || tab.classList.contains("drop-after"))) return;
  event.preventDefault();
  const target = Number(tab.dataset.tabIndex);
  let insertAt = target + (tab.classList.contains("drop-after") ? 1 : 0);
  const [moved] = state.draftTabs.splice(draggedTab, 1);
  if (draggedTab < insertAt) insertAt -= 1;
  state.draftTabs.splice(insertAt, 0, moved);
  state.activeTab = insertAt;
  draggedTab = null;
  setDirty();
  renderTabs();
});
structuredEditor.addEventListener("dragend", () => {
  draggedTab = null;
  structuredEditor.querySelectorAll(".tab-button.dragging, .tab-button.drop-before, .tab-button.drop-after").forEach((item) => item.classList.remove("dragging", "drop-before", "drop-after"));
});

rawContent.addEventListener("input", () => { state.rawModified = true; setDirty(); });
document.querySelectorAll(".mode-switch button").forEach((button) => button.addEventListener("click", () => {
  if (button.dataset.mode === "structured" && state.mode === "raw" && state.rawModified) {
    toast("Save the Raw QMD changes before returning to the structured form.", "error");
    return;
  }
  if (button.dataset.mode === "raw" && state.mode === "structured" && state.dirty) {
    rawContent.value = buildStructuredRaw();
  }
  setMode(button.dataset.mode);
}));
saveButton.addEventListener("click", saveSelection);
$("#delete-question-button").addEventListener("click", deleteQuestion);
$("#render-button").addEventListener("click", renderBook);
$("#preview-button").addEventListener("click", () => window.open("/book/", "_blank"));
$("#dialog-preview").addEventListener("click", () => window.open("/book/", "_blank"));
$("#close-dialog").addEventListener("click", () => $("#render-dialog").close());
$("#dialog-done").addEventListener("click", () => $("#render-dialog").close());
$("#menu-button").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
$("#search-input").addEventListener("input", (event) => filterTree(event.target.value));
window.addEventListener("beforeunload", (event) => { if (state.dirty) { event.preventDefault(); event.returnValue = ""; } });
window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); saveSelection(); }
});

Promise.all([loadBook(), refreshGitStatus()]).catch((error) => toast(error.message, "error"));
