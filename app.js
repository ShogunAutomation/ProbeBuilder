/* app.js — Renishaw Probe Routine Builder (fresh refactor)
   - Arbitrary-depth tree (folders & container ops)
   - Inline, expandable cards (no modal required)
   - Single-axis P9811 via radio; P9812 Web/Pocket auto/explicit
   - Context-based G-code emitter (labels, indent, loops)
   - LocalStorage persistence
*/

// =================== Small DOM helpers ===================
const qs  = (s, root = document) => root.querySelector(s);
const qsa = (s, root = document) => Array.from(root.querySelectorAll(s));
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(n.style, v);
    else if (k === "dataset") Object.assign(n.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}

// =================== Persistence ===================
const STORAGE_KEY = "renishaw_probe_builder_v2";

function save() {
  // serialize Sets
  const toSave = {
    tree: state.tree,
    collapsed: Array.from(state.collapsed),
    expanded: Array.from(state.expanded),
    targetParentId: state.targetParentId,
    showGCode: state.showGCode
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
}

function load() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    const s = JSON.parse(raw);
    if (Array.isArray(s.tree)) state.tree = s.tree;
    if (Array.isArray(s.collapsed)) state.collapsed = new Set(s.collapsed);
    if (Array.isArray(s.expanded)) state.expanded = new Set(s.expanded);
    if (typeof s.targetParentId === "string") state.targetParentId = s.targetParentId;
    if (typeof s.showGCode === "boolean") state.showGCode = s.showGCode;
  } catch {}
}

// =================== State & IDs ===================
const state = {
  tree: [],                 // array<Node> at root
  collapsed: new Set(),     // ids of collapsed containers
  expanded: new Set(),      // ids of cards expanded for inline editing
  targetParentId: "root",   // toolbox “Add to” destination
  showGCode: false,
};

const uid = () =>
  "op_" + (crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)));

// =================== Tools Registry ===================
// A tool is a node template with optional "container: true" and a gcode emitter.
// Inline edit UI is driven by UI_SCHEMAS below.

const TOOLS = [
  // --------- Organization / Containers ----------
  {
    id: "folder",
    name: "Folder",
    icon: "📁",
    desc: "Organize operations",
    category: "org",
    container: true,
    defaultParams: { name: "New Section", note: "" },
    gcode(op, ctx) {
      const nm = (op.params.name || "SECTION").toUpperCase();
      const lines = [
        `;===== ${nm} =====`,
        ...(emitChildren(op, ctx, 0)),
        `;===== END ${nm} =====`,
        ``,
      ];
      return lines;
    },
  },
  {
    id: "if-block",
    name: "IF Block",
    icon: "🧩",
    desc: "Conditional block",
    category: "org",
    container: true,
    defaultParams: { left: "#100", op: "GT", right: "#101" }, // example: #100 GT #101
    parameterOptions: { op: ["EQ", "NE", "GT", "GE", "LT", "LE"] },
    gcode(op, ctx) {
      const { left, op: cmp, right } = op.params;
      const lid = ctx.nextLabel();
      const lines = [
        `IF [${left} ${cmp} ${right}] GOTO ${lid}`,
        `; (IF false → skip children)`,
        `GOTO ${lid}_END`,
        `N${lid}`,
        ...emitChildren(op, ctx, 1),
        `N${lid}_END`,
        ``,
      ];
      return lines;
    },
  },
  {
    id: "while-block",
    name: "WHILE Loop",
    icon: "🔁",
    desc: "Loop while condition is true",
    category: "org",
    container: true,
    defaultParams: { left: "#100", op: "LT", right: "10" }, // e.g., while #100 LT 10
    parameterOptions: { op: ["EQ", "NE", "GT", "GE", "LT", "LE"] },
    gcode(op, ctx) {
      const { left, op: cmp, right } = op.params;
      const i = ctx.loopIndex();
      const lines = [
        `WHILE [${left} ${cmp} ${right}] DO${i}`,
        ...emitChildren(op, ctx, 1),
        `END${i}`,
        ``,
      ];
      return lines;
    },
  },

  // --------- Setup ----------
  {
    id: "set-work-offset",
    name: "Work Offset",
    icon: "🎯",
    desc: "Set active work offset",
    category: "setup",
    defaultParams: { offset: "G54", P: "1" },
    parameterOptions: { offset: ["G54", "G55", "G56", "G57", "G154"], P: ["1", "2", "3", "4", "5"] },
    gcode(op) {
      let s = `${op.params.offset}`;
      if (op.params.offset === "G154") s += ` P${op.params.P}`;
      return [s, ""];
    },
  },
  {
    id: "tool-change",
    name: "Tool Change",
    icon: "🔧",
    desc: "Change to specified tool",
    category: "setup",
    defaultParams: { toolNumber: 1, spindleSpeed: 1000, coolant: "M8" },
    parameterOptions: { coolant: ["M8", "M7", "M9"] },
    gcode(op) {
      const { toolNumber, spindleSpeed, coolant } = op.params;
      return [`T${toolNumber} M6`, `S${spindleSpeed} M3`, `${coolant}`, ``];
    },
  },
  {
    id: "rapid-move",
    name: "Rapid Move",
    icon: "⚡",
    desc: "G0 rapid positioning",
    category: "setup",
    defaultParams: { X: 0, Y: 0, Z: 25 },
    gcode(op) {
      const { X, Y, Z } = op.params;
      return [`G0 X${X} Y${Y} Z${Z}`, ``];
    },
  },

  // --------- Probe Ops ----------
  // P9811 single-axis (X or Y or Z) — radio control
  {
    id: "single-touch-axis",
    name: "Single Touch (P9811)",
    icon: "📍",
    desc: "Single-axis touch — choose X or Y or Z",
    category: "probe",
    defaultParams: { axis: "X", distance: -10, feed: 10 },
    gcode(op) {
      const { axis = "X", distance = -10, feed = 10 } = op.params;
      const ax = String(axis).toUpperCase();
      return [`G65 P9811 ${ax}${distance} F${feed}`, ``];
    },
  },

  // P9812 Web/Pocket — Auto by Z or explicit mode
  {
    id: "web-pocket",
    name: "Web / Pocket (P9812)",
    icon: "🧱",
    desc: "Rectangular web or pocket probing",
    category: "probe",
    defaultParams: { mode: "auto", X: 0, Y: 0, Z: "", W: 20, L: 15, feed: 10 },
    parameterOptions: { mode: ["auto", "web", "pocket"] },
    gcode(op) {
      const p = op.params;
      const isPocket = p.mode === "pocket" || (p.mode === "auto" && p.Z !== "" && p.Z !== null && p.Z !== undefined);
      const parts = [`G65 P9812`, `X${p.X}`, `Y${p.Y}`, isPocket ? `Z${p.Z}` : null, `W${p.W}`, `L${p.L}`, `F${p.feed}`]
        .filter(Boolean);
      return [parts.join(" "), ``];
    },
  },

  // Simple P9810 safe position / single point for completeness
  {
    id: "safe-approach",
    name: "Safe Approach (P9810)",
    icon: "🛡️",
    desc: "G65 P9810 safe positioning",
    category: "probe",
    defaultParams: { X: 0, Y: 0, Z: 25, feed: 1000 },
    gcode(op) {
      const { X, Y, Z, feed } = op.params;
      return [`G65 P9810 X${X} Y${Y} Z${Z} F${feed}`, ``];
    },
  },
];

const TOOL_BY_ID = Object.fromEntries(TOOLS.map(t => [t.id, t]));

// =================== UI Schemas (inline editors) ===================
// Each function returns an array of field descriptors:
// { key, type: 'number'|'text'|'radio'|'select', label?, step?, options?, help? }
const UI_SCHEMAS = {
  folder: (op) => [
    { key: "name", type: "text", label: "Name" },
    { key: "note", type: "text", label: "Note" },
  ],

  "if-block": (op) => [
    { key: "left", type: "text", label: "Left" },
    { key: "op", type: "select", label: "Operator", options: TOOL_BY_ID["if-block"].parameterOptions.op },
    { key: "right", type: "text", label: "Right" },
  ],

  "while-block": (op) => [
    { key: "left", type: "text", label: "Left" },
    { key: "op", type: "select", label: "Operator", options: TOOL_BY_ID["while-block"].parameterOptions.op },
    { key: "right", type: "text", label: "Right" },
  ],

  "set-work-offset": (op) => [
    { key: "offset", type: "select", label: "Offset", options: TOOL_BY_ID["set-work-offset"].parameterOptions.offset },
    { key: "P", type: "select", label: "P (for G154)", options: TOOL_BY_ID["set-work-offset"].parameterOptions.P, help: "Only used when offset is G154." },
  ],

  "tool-change": (op) => [
    { key: "toolNumber", type: "number", label: "Tool Number", step: 1 },
    { key: "spindleSpeed", type: "number", label: "Spindle Speed", step: 1 },
    { key: "coolant", type: "select", label: "Coolant", options: TOOL_BY_ID["tool-change"].parameterOptions.coolant },
  ],

  "rapid-move": (op) => [
    { key: "X", type: "number", step: 0.001 },
    { key: "Y", type: "number", step: 0.001 },
    { key: "Z", type: "number", step: 0.001 },
  ],

  "single-touch-axis": (op) => [
    { key: "axis", type: "radio", label: "Axis", options: ["X", "Y", "Z"], help: "P9811 takes exactly one axis." },
    { key: "distance", type: "number", label: "Touch Distance", step: 0.001 },
    { key: "feed", type: "number", label: "Feed (F)", step: 1 },
  ],

  "web-pocket": (op) => [
    { key: "mode", type: "radio", label: "Mode", options: [
      { value: "auto",   label: "Auto (Z→Pocket)" },
      { value: "web",    label: "Web" },
      { value: "pocket", label: "Pocket" },
    ], help: "Auto: blank Z=Web, set Z=Pocket." },
    { key: "X", type: "number", step: 0.001 },
    { key: "Y", type: "number", step: 0.001 },
    { key: "Z", type: "number", step: 0.001, label: "Z (Pocket only)" },
    { key: "W", type: "number", step: 0.001, label: "Width (W)" },
    { key: "L", type: "number", step: 0.001, label: "Length (L)" },
    { key: "feed", type: "number", step: 1, label: "Feed (F)" },
  ],

  "safe-approach": (op) => [
    { key: "X", type: "number", step: 0.001 },
    { key: "Y", type: "number", step: 0.001 },
    { key: "Z", type: "number", step: 0.001 },
    { key: "feed", type: "number", step: 1, label: "Feed (F)" },
  ],
};

// =================== Tree Utilities ===================
function walk(list = state.tree, fn, parent = null) {
  for (const node of list) {
    if (fn(node, parent) === true) return true;
    if (Array.isArray(node.children) && walk(node.children, fn, node)) return true;
  }
  return false;
}

function getNode(id) {
  let out = null;
  walk(state.tree, (n) => (n.id === id ? (out = n, true) : false));
  return out;
}

function getParent(id) {
  let p = null;
  walk(state.tree, (n, parent) => (n.id === id ? (p = parent, true) : false));
  return p;
}

function removeNode(id, list = state.tree) {
  const i = list.findIndex(n => n.id === id);
  if (i >= 0) return list.splice(i, 1)[0];
  for (const n of list) {
    if (n.children) {
      const r = removeNode(id, n.children);
      if (r) return r;
    }
  }
  return null;
}

function insertNode(node, parentId = "root", index = Infinity) {
  if (parentId === "root" || !parentId) {
    if (index > state.tree.length) index = state.tree.length;
    state.tree.splice(index, 0, node);
    return;
  }
  const parent = getNode(parentId);
  if (!parent) return;
  if (!parent.children) parent.children = [];
  if (index > parent.children.length) index = parent.children.length;
  parent.children.splice(index, 0, node);
}

function isDescendant(maybeAncestorId, id) {
  const anc = getNode(maybeAncestorId);
  let found = false;
  walk(anc?.children || [], (n) => (n.id === id ? (found = true, true) : false));
  return found;
}

function eachContainer(fn, list = state.tree) {
  for (const n of list) {
    const def = TOOL_BY_ID[n.toolId];
    if (def?.container) fn(n);
    if (n.children) eachContainer(fn, n.children);
  }
}

// =================== Mutations ===================
function addNode(toolId, parentId = state.targetParentId) {
  const t = TOOL_BY_ID[toolId];
  if (!t) return;
  const node = {
    id: uid(),
    toolId: t.id,
    name: t.name,
    icon: t.icon,
    category: t.category,
    description: t.desc,
    params: { ...t.defaultParams },
    ...(t.container ? { children: [] } : {}),
  };
  insertNode(node, parentId, Infinity);
  save(); renderAll();
}

function updateParams(id, patch) {
  const n = getNode(id); if (!n) return;
  n.params = { ...n.params, ...patch };
  save(); renderAll();
}

function moveNode(id, targetParentId = "root", index = Infinity) {
  if (id === targetParentId) return;
  if (targetParentId !== "root" && isDescendant(id, targetParentId)) return; // no cycles
  const node = removeNode(id); if (!node) return;
  insertNode(node, targetParentId, index);
  save(); renderAll();
}

async function deleteNode(id) {
  const n = getNode(id);
  if (!n) return;
  const isContainer = !!TOOL_BY_ID[n.toolId]?.container;
  const extra = isContainer && n.children?.length ? ` It contains ${n.children.length} item(s).` : "";
  const ok = window.confirm(`Delete "${isContainer ? (n.params?.name || n.name) : n.name}"?${extra}`);
  if (!ok) return;
  removeNode(id);
  state.expanded.delete(id);
  state.collapsed.delete(id);
  save(); renderAll();
}

function reorderSibling(id, dir = -1) {
  const parent = getParent(id);
  const list = parent ? parent.children : state.tree;
  const i = list.findIndex(n => n.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  const [m] = list.splice(i, 1);
  list.splice(j, 0, m);
  save(); renderAll();
}

function setTargetParent(id) {
  state.targetParentId = id || "root";
  save(); refreshTargetParentDropdown();
}

function toggleCollapsed(id) {
  state.collapsed.has(id) ? state.collapsed.delete(id) : state.collapsed.add(id);
  save(); renderAll();
}

function toggleExpanded(id) {
  state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
  save(); renderAll();
}

// =================== G-code Emitter ===================
function createEmitContext(indent = 0, labelSeed = 1000, loopDepth = 0) {
  return {
    indent,
    labelSeed,
    loopDepth,
    line(s) { return "  ".repeat(this.indent) + s; },
    nextLabel() { return (this.labelSeed++).toString(); },
    loopIndex() { return Math.min(this.loopDepth + 1, 9); },
    indented(delta = 1) {
      return createEmitContext(this.indent + delta, this.labelSeed, this.loopDepth + (delta > 0 ? 1 : 0));
    },
  };
}

function emitNode(node, ctx) {
  const def = TOOL_BY_ID[node.toolId];
  if (!def) return [ctx.line(`; Unknown node ${node.toolId}`)];
  const raw = def.gcode ? def.gcode(node, {
    ...ctx,
    nextLabel: () => ctx.nextLabel(),
    loopIndex: () => ctx.loopIndex(),
  }) : [];
  const arr = Array.isArray(raw) ? raw : [raw];
  // indent all lines (except empty)
  return arr.map(l => (l ? ctx.line(l) : ctx.line("")));
}

function emitChildren(node, ctx, indentDelta = 1) {
  const out = [];
  for (const child of (node.children || [])) {
    out.push(...emitNode(child, ctx.indented(indentDelta)));
  }
  return out;
}

function generateGCode() {
  const ctx = createEmitContext(0, 1000, 0);
  const header = [
    `;Renishaw Probe Routine - Generated by Probe Builder`,
    `;Program: PROBE_ROUTINE.NC`,
    `;Date: ${new Date().toLocaleDateString()}`,
    ``,
    `;Initialize program`,
    `G0 G17 G40 G49 G80 G90`,
    ``,
  ];
  const body = [];
  for (const n of state.tree) body.push(...emitNode(n, ctx));
  const footer = [
    `;End of probe routine`,
    `G0 G53 Z0.`,
    `M30`,
    ``,
  ];
  return header.concat(body, footer).join("\n");
}

// =================== Rendering ===================
const listEl        = qs("#list");
const emptyEl       = qs("#empty");
const opCountEl     = qs("#opCount");
const itemCountEl   = qs("#itemCount");
const gcodePanel    = qs("#gcode");
const gcodePre      = qs("#gcodePre");
const toolboxOrgs   = { org: qs("#tools-organization"), setup: qs("#tools-setup"), probe: qs("#tools-probe") };
const targetSelect  = qs("#target-parent-select");

function renderAll() {
  // workspace list
  if (!state.tree.length) {
    emptyEl?.setAttribute("style", "display:block;");
    listEl?.setAttribute("style", "display:none;");
    listEl?.replaceChildren();
  } else {
    emptyEl?.setAttribute("style", "display:none;");
    listEl?.setAttribute("style", "display:flex; flex-direction:column; gap:.6rem;");
    listEl?.replaceChildren(...state.tree.map((n, i) => renderCard(n, [i + 1], null)));
  }

  // counts
  const counts = countTree(state.tree);
  if (opCountEl) opCountEl.textContent = String(counts.ops);
  if (itemCountEl) itemCountEl.textContent = String(counts.total);

  // gcode
  if (state.showGCode && gcodePre) gcodePre.textContent = generateGCode();

  // destination menus
  refreshTargetParentDropdown();
}

function countTree(list) {
  let ops = 0, total = 0;
  walk(list, (n) => { total++; if (!TOOL_BY_ID[n.toolId]?.container) ops++; });
  return { ops, total };
}

function renderCard(node, pathNums, parentId) {
  const def = TOOL_BY_ID[node.toolId];
  const isContainer = !!def?.container;
  const collapsed = state.collapsed.has(node.id);
  const expanded  = state.expanded.has(node.id);
  const numberTag = "#" + pathNums.join(".");

  const left = el("div", { class: "info" },
    isContainer ? el("button", { class: "cbtn", title: collapsed ? "Expand" : "Collapse", onClick: () => toggleCollapsed(node.id) }, collapsed ? "▶" : "▼") : null,
    el("span", { class: "icon" }, isContainer ? (collapsed ? "📁" : "📂") : (node.icon || "•")),
    el("div", { class: "meta" },
      el("h3", {}, isContainer ? (node.params?.name || node.name) : node.name),
      el("p", {}, isContainer ? `${node.children?.length || 0} items` : node.description)
    )
  );

  // move up/down within siblings
  const upBtn   = el("button", { class: "cbtn", title: "Move up",   onClick: () => reorderSibling(node.id, -1) }, "▲");
  const downBtn = el("button", { class: "cbtn", title: "Move down", onClick: () => reorderSibling(node.id, +1) }, "▼");

  // parent “Add to” menu (show only for non-root destination switcher in toolbox)
  const expandBtn = el("button", { class: "cbtn", title: expanded ? "Collapse details" : "Expand details", onClick: () => toggleExpanded(node.id) }, expanded ? "▾" : "▸");
  const deleteBtn = el("button", { class: "cbtn red", title: "Delete", onClick: () => deleteNode(node.id) }, "🗑");

  // Move into another container menu
  const moveMenuBtn = el("div", { class: "folder-selector" },
    el("button", { class: "fd-btn", onClick: (e) => toggleMoveMenu(e, node.id) }, "📂 Move"),
    el("div", { class: "fd-menu", id: `fd-${node.id}` })
  );

  const controls = el("div", { class: "controls" },
    el("span", { class: `pill ${isContainer ? "folder" : node.category}` }, numberTag),
    expandBtn,
    moveMenuBtn,
    upBtn,
    downBtn,
    deleteBtn
  );

  const top = el("div", { class: "row" }, left, controls);
  const card = el("div", { class: `card ${isContainer ? "folder" : ""}`, dataset: { id: node.id } }, top);

  if (expanded) {
    card.classList.add("expanded");
    card.append(renderInlineEditor(node));
  }

  if (isContainer && !collapsed && node.children?.length) {
    const kids = el("div", { class: "children" },
      node.children.map((ch, i) => renderCard(ch, pathNums.concat(i + 1), node.id))
    );
    card.append(kids);
  }

  return card;
}

// -------- Inline Editor --------
function renderInlineEditor(node) {
  const schema = UI_SCHEMAS[node.toolId];
  const fields = schema ? schema(node) : Object.keys(node.params || {}).map(k => ({ key: k, type: "number" }));
  const wrap = el("div", { class: "details" },
    el("div", { class: "help", style: { marginBottom: ".4rem" } }, "Edit parameters inline"),
    el("div", { class: "form-grid" },
      ...fields.map(f => renderField(node, f))
    )
  );
  return wrap;
}

function renderField(node, f) {
  const labelText = f.label || toLabel(f.key);
  const group = el("div", { class: "field" },
    el("label", {}, labelText)
  );

  if (f.type === "radio") {
    const rg = el("div", { class: "radio-group" });
    for (const opt of f.options) {
      const val  = typeof opt === "object" ? opt.value : opt;
      const text = typeof opt === "object" ? opt.label : opt;
      const id   = `${node.id}_${f.key}_${val}`;
      rg.append(
        el("label", { class: "radio", for: id },
          el("input", {
            type: "radio",
            name: `${node.id}:${f.key}`,
            id,
            value: String(val),
            ...(String(node.params[f.key]) === String(val) ? { checked: true } : {}),
            onChange: () => updateParams(node.id, { [f.key]: val }),
          }),
          text
        )
      );
    }
    group.append(rg);
    if (f.help) group.append(el("div", { class: "help" }, f.help));
    return group;
  }

  if (f.type === "select") {
    const sel = el("select", {
      class: "sel",
      onChange: (e) => updateParams(node.id, { [f.key]: e.target.value }),
    },
      ...(f.options || []).map(opt => {
        const v = typeof opt === "object" ? opt.value : opt;
        const t = typeof opt === "object" ? opt.label : opt;
        return el("option", { value: v, ...(String(node.params[f.key]) === String(v) ? { selected: true } : {}) }, t);
      })
    );
    group.append(sel);
    if (f.help) group.append(el("div", { class: "help" }, f.help));
    return group;
  }

  // number / text
  const type = f.type === "text" ? "text" : "number";
  const input = el("input", {
    class: "inp",
    type,
    ...(f.step ? { step: String(f.step) } : {}),
    value: node.params[f.key] ?? "",
    onInput: (e) => {
      const raw = e.target.value;
      const val = type === "number" ? (raw === "" ? "" : (parseFloat(raw) || 0)) : raw;
      updateParams(node.id, { [f.key]: val });
    },
  });
  group.append(input);
  if (f.help) group.append(el("div", { class: "help" }, f.help));
  return group;
}

function toLabel(key) {
  return String(key).replace(/([A-Z])/g, " $1").replace(/^./, s => s.toUpperCase());
}

// -------- Move menus --------
function toggleMoveMenu(e, nodeId) {
  e.stopPropagation();
  // close others
  qsa(".fd-menu").forEach(m => m.classList.remove("show"));
  const menu = qs(`#fd-${CSS.escape(nodeId)}`);
  if (!menu) return;
  const open = menu.classList.contains("show");
  if (open) { menu.classList.remove("show"); return; }
  menu.classList.add("show");
  menu.replaceChildren(...buildMoveOptions(nodeId));
  document.addEventListener("click", closeMenusOnce, { once: true });
}
function closeMenusOnce() { qsa(".fd-menu").forEach(m => m.classList.remove("show")); }

function buildMoveOptions(nodeId) {
  const items = [];
  items.push(el("button", { class: "fd-item", onClick: () => moveNode(nodeId, "root") }, "📂 Root"));
  eachContainer((c) => {
    if (c.id === nodeId) return;
    if (isDescendant(nodeId, c.id)) return; // prevent cycles
    const nm = c.params?.name || c.name || "Container";
    items.push(el("button", { class: "fd-item", onClick: () => moveNode(nodeId, c.id) }, `📁 ${nm}`));
  });
  return items;
}

// -------- Destination dropdown (Toolbox “Add to”) --------
function refreshTargetParentDropdown() {
  const sel = targetSelect;
  if (!sel) return;
  const current = state.targetParentId;
  sel.replaceChildren(el("option", { value: "root", ...(current === "root" ? { selected: true } : {}) }, "📂 Root"));
  eachContainer((c) => {
    const nm = c.params?.name || c.name || "Container";
    sel.append(el("option", { value: c.id, ...(current === c.id ? { selected: true } : {}) }, `📁 ${nm}`));
  });
}

// =================== Toolbox ===================
function renderToolbox() {
  // Group by category
  const byCat = { org: [], setup: [], probe: [] };
  for (const t of TOOLS) byCat[t.category]?.push(t);

  if (toolboxOrgs.org) {
    toolboxOrgs.org.replaceChildren(...byCat.org.map(makeToolCard));
  }
  if (toolboxOrgs.setup) {
    toolboxOrgs.setup.replaceChildren(...byCat.setup.map(makeToolCard));
  }
  if (toolboxOrgs.probe) {
    toolboxOrgs.probe.replaceChildren(...byCat.probe.map(makeToolCard));
  }
}

function makeToolCard(t) {
  return el("div", { class: "tool", role: "button", tabIndex: 0, onClick: () => addNode(t.id) },
    el("div", {}, el("div", { class: "icon", style: "margin-bottom:.5rem;" }, t.icon)),
    el("div", {}, el("h4", {}, t.name), el("p", {}, t.desc)),
    el("button", { class: "add", onClick: (e) => { e.stopPropagation(); addNode(t.id); } }, "+", " Add")
  );
}

// =================== Header buttons / Wiring ===================
function wireHeader() {
  const toggleBtn = qs("#btn-toggle-gcode");
  const label     = qs("#gc-label");
  const download  = qs("#btn-download");

  toggleBtn?.addEventListener("click", () => {
    state.showGCode = !state.showGCode;
    gcodePanel?.classList.toggle("show", state.showGCode);
    if (label) label.textContent = state.showGCode ? "Hide G‑Code" : "Show G‑Code";
    save();
    if (state.showGCode && gcodePre) gcodePre.textContent = generateGCode();
  });

  download?.addEventListener("click", () => {
    const g = generateGCode();
    const blob = new Blob([g], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: "probe_routine.nc" });
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  });

  targetSelect?.addEventListener("change", (e) => setTargetParent(e.target.value));
}

// =================== Demo seed (optional) ===================
function maybeSeed() {
  if (state.tree.length) return;
  const f1 = { id: uid(), toolId: "folder", name: "Folder", icon: "📁", category: "org", description: "Organize operations", params: { name: "Setup A", note: "" }, children: [] };
  const n1 = { id: uid(), toolId: "set-work-offset", name: "Work Offset", icon: "🎯", category: "setup", description: "Set active work offset", params: { offset: "G54", P: "1" } };
  const n2 = { id: uid(), toolId: "single-touch-axis", name: "Single Touch (P9811)", icon: "📍", category: "probe", description: "Single-axis touch", params: { axis: "X", distance: -10, feed: 10 } };
  f1.children.push(n1, n2);

  const loop = { id: uid(), toolId: "while-block", name: "WHILE Loop", icon: "🔁", category: "org", description: "Loop", params: { left: "#100", op: "LT", right: "3" }, children: [] };
  loop.children.push({ id: uid(), toolId: "web-pocket", name: "Web / Pocket (P9812)", icon: "🧱", category: "probe", description: "Web/Pocket", params: { mode: "auto", X: 0, Y: 0, Z: "", W: 20, L: 15, feed: 10 } });

  state.tree.push(f1, loop, { id: uid(), toolId: "safe-approach", name: "Safe Approach (P9810)", icon: "🛡️", category: "probe", description: "Safe approach", params: { X: 0, Y: 0, Z: 25, feed: 1000 } });
}

// =================== Init ===================
load();
maybeSeed();
renderToolbox();
wireHeader();
renderAll();

// Close open move menus on global click (safety)
document.addEventListener("click", (e) => {
  if (!e.target.closest(".folder-selector")) qsa(".fd-menu").forEach(m => m.classList.remove("show"));
});
