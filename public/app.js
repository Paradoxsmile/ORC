const STATES = ["inbox", "specced", "working", "review", "fixing", "verify", "done", "blocked"];

const STATE_LABEL = {
  inbox: "Inbox",
  specced: "Ready",
  working: "Working",
  review: "Review",
  fixing: "Fixing",
  verify: "Verify",
  done: "Done",
  blocked: "Blocked",
};

const LANES = [
  { id: "inbox", label: "Inbox", states: ["inbox"] },
  { id: "specced", label: "Ready", states: ["specced"] },
  { id: "working", label: "Working", states: ["working", "fixing"] },
  { id: "review", label: "Review", states: ["review", "verify"] },
  { id: "blocked", label: "Blocked", states: ["blocked"] },
  { id: "done", label: "Done", states: ["done"] },
];

const COMMANDS = {
  claude: "Claude",
  agy: "Antigravity",
};

const ui = {
  data: null,
  projectId: null,
  query: "",
  selectedTaskId: null,
  detail: null,
  tab: "spec",
  specDraft: null,
  specDirty: false,
  specPreview: false,
  reviewRaw: false,
  diffRaw: false,
};

const MODEL_SUGGESTIONS = [
  "gemini-pro-orchestrator-argon",
  "gemini-4-argon-high",
  "gemini-4-hydrogen-xhigh",
  "claude-sonnet-5-5",
  "claude-opus-5-5",
];

let stateTimer = null;
let detailTimer = null;

const $ = (selector) => document.querySelector(selector);

function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

function projectHash(value) {
  let hash = 0;
  for (const char of String(value)) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % 6;
}

function timeAgo(iso) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const ms = Math.max(0, Date.now() - then);
  if (ms < 45_000) return "now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}

function clockTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function truncate(value, max = 80) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function currentProject() {
  return ui.data?.projects?.find((project) => project.id === ui.projectId) ?? null;
}

function projectName(id) {
  return ui.data?.projects?.find((project) => project.id === id)?.name ?? id;
}

function filteredTasks() {
  if (!ui.data) return [];
  let tasks = ui.data.tasks;
  if (ui.projectId) tasks = tasks.filter((task) => task.project_id === ui.projectId);
  const query = ui.query.trim().toLowerCase();
  if (query) {
    tasks = tasks.filter((task) =>
      [task.id, task.title, task.branch, task.state, task.projectName, task.agent]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }
  return tasks;
}

async function api(path, options = {}) {
  const init = { ...options };
  if (typeof init.body === "string") {
    init.headers = { "Content-Type": "application/json", ...(init.headers ?? {}) };
  }
  const response = await fetch(path, init);
  const text = await response.text();
  let data = null;
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!response.ok) {
    throw new Error(data?.error || `${response.status} ${response.statusText}`);
  }
  return data;
}

function toast(message, kind = "") {
  const root = $("#toastRoot");
  if (!root) return;
  const node = document.createElement("div");
  node.className = `toast ${kind}`.trim();
  node.textContent = message;
  root.appendChild(node);
  setTimeout(() => {
    node.classList.add("leaving");
    setTimeout(() => node.remove(), 220);
  }, kind === "error" ? 6500 : 3500);
}

async function refreshState() {
  try {
    const data = await api("/api/state");
    ui.data = data;
    if (ui.projectId && !data.projects.some((project) => project.id === ui.projectId)) {
      ui.projectId = null;
    }
    render();
  } catch (error) {
    toast(`Cannot load state: ${error.message}`, "error");
  }
}

function scheduleStateRefresh(delay = 300) {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(refreshState, delay);
}

function scheduleDetailRefresh(delay = 500) {
  if (!ui.selectedTaskId) return;
  clearTimeout(detailTimer);
  detailTimer = setTimeout(() => refreshDetail(false), delay);
}

async function refreshDetail(force = false) {
  const id = ui.selectedTaskId;
  if (!id) return;
  if (!force && ui.specDirty) return;
  try {
    const detail = await api(`/api/tasks/${encodeURIComponent(id)}`);
    if (ui.selectedTaskId !== id) return;
    ui.detail = detail;
    ui.specDraft = null;
    ui.specDirty = false;
    renderDrawer();
  } catch (error) {
    toast(error.message, "error");
  }
}

function render() {
  if (!ui.data) return;
  renderHealth();
  renderProjects();
  renderHero();
  renderBoard();
  renderSideFoot();
}

function renderHealth() {
  const health = ui.data?.health ?? {};
  const items = [
    ["claude", "Claude"],
    ["agy", "Antigravity"],
    ["git", "Git"],
  ];
  const pills = items
    .map(([key, label]) => {
      const entry = health[key];
      const ok = Boolean(entry?.available);
      const title = entry?.path || "Not found on PATH";
      return `<span class="${ok ? "ok" : "off"}" title="${esc(title)}"><i></i>${label}</span>`;
    })
    .join("");
  $("#health").innerHTML = `<button type="button" class="health-btn" data-action="open-doctor" title="Click for CLI setup & doctor info">${pills}</button>`;
}

function renderProjects() {
  const projects = ui.data?.projects ?? [];
  const totalActive = projects.reduce((sum, project) => sum + project.active, 0);
  const totalBlocked = projects.reduce((sum, project) => sum + project.blocked, 0);
  const totalDone = projects.reduce((sum, project) => sum + project.done, 0);
  const total = projects.reduce((sum, project) => sum + project.total, 0);

  const allBadge =
    totalBlocked > 0
      ? `<span class="project-badge bad">${totalBlocked}</span>`
      : `<span class="project-badge ${totalActive ? "hot" : ""}">${totalActive}</span>`;

  const html = [
    `<button class="project-item ${ui.projectId ? "" : "active"}" data-project="" title="${esc(
      `${total} tasks · ${totalDone} done · ${totalBlocked} blocked`,
    )}">
      <span class="project-dot proj-5"></span>
      <span class="project-name">All projects</span>
      ${allBadge}
    </button>`,
  ];

  for (const project of projects) {
    const badge =
      project.blocked > 0
        ? `<span class="project-badge bad" title="${project.blocked} blocked">${project.blocked}</span>`
        : `<span class="project-badge ${project.active ? "hot" : ""}" title="${project.active} active">${project.active}</span>`;
    html.push(
      `<button class="project-item ${ui.projectId === project.id ? "active" : ""}" data-project="${esc(
        project.id,
      )}" title="${esc(`${project.path}\nbase ${project.baseBranch} · ${project.total} tasks`)}">
        <span class="project-dot proj-${projectHash(project.id)}"></span>
        <span class="project-name">${esc(project.name)}</span>
        ${badge}
      </button>`,
    );
  }

  if (!projects.length) {
    html.push('<div class="skeleton">No projects yet.</div>');
  }

  $("#projectList").innerHTML = html.join("");
  $("#projectCount").textContent = String(projects.length);
}

function renderHero() {
  const project = currentProject();
  const tasks = filteredTasks();
  const running = new Set(ui.data?.running ?? []);
  const runningCount = tasks.filter((task) => running.has(task.id)).length;

  const counts = Object.fromEntries(STATES.map((state) => [state, 0]));
  if (project) {
    for (const [state, value] of Object.entries(project.counts ?? {})) counts[state] = Number(value);
  } else {
    for (const item of ui.data?.projects ?? []) {
      for (const [state, value] of Object.entries(item.counts ?? {})) counts[state] += Number(value);
    }
  }
  const active = counts.working + counts.review + counts.fixing + counts.verify;
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);

  $("#viewTitle").textContent = project ? project.name : "All projects";
  if (project) {
    const bits = [
      project.path,
      `base ${project.baseBranch}`,
      project.testCommand ? `test "${project.testCommand}"` : "no test command",
    ];
    if (project.setupCommand) bits.push(`setup "${project.setupCommand}"`);
    if (project.reviewer) bits.push(`reviewer ${project.reviewer}`);
    if (project.implModel) bits.push(`impl ${project.implModel}`);
    if (project.reviewModel) bits.push(`review ${project.reviewModel}`);
    $("#viewSub").innerHTML = `${esc(bits.join(" · "))} <button class="btn small ghost inline-btn" data-action="edit-project">⚙ Settings</button>`;
  } else {
    $("#viewSub").textContent = `${(ui.data?.projects ?? []).length} project(s) · ${total} task(s) · one local board`;
  }

  $("#stats").innerHTML = [
    ["Active", active, "blue"],
    ["Blocked", counts.blocked, "red"],
    ["Done", counts.done, "green"],
    ["Total", total, ""],
  ]
    .map(
      ([label, value, tone]) =>
        `<div class="stat ${tone}"><b>${value}</b><span>${label}</span></div>`,
    )
    .join("");

  const notes = [`${tasks.length} shown`];
  if (runningCount) notes.push(`${runningCount} running`);
  if (ui.query.trim()) notes.push(`filter: "${truncate(ui.query, 30)}"`);
  $("#toolbarNote").textContent = notes.join(" · ");
}

function renderBoard() {
  const projects = ui.data?.projects ?? [];
  const board = $("#board");

  if (!projects.length) {
    board.innerHTML = `
      <div class="empty-hero">
        <h2>No projects yet</h2>
        <p>Register a git repository once. ORC will scaffold its docs, keep a task board, and create a worktree per task. Claude and Antigravity keep their own logins and quotas.</p>
        <button class="btn primary" data-action="new-project">Add your first project</button>
      </div>`;
    return;
  }

  const tasks = filteredTasks();
  if (!tasks.length && ui.data.tasks.length) {
    board.innerHTML = `
      <div class="empty-hero">
        <h2>Nothing matches</h2>
        <p>No tasks match this search in ${ui.projectId ? esc(projectName(ui.projectId)) : "any project"}.</p>
        <button class="btn" data-action="clear-search">Clear search</button>
      </div>`;
    return;
  }

  const running = new Set(ui.data.running ?? []);
  board.innerHTML = LANES.map((lane) => {
    const laneTasks = tasks.filter((task) => lane.states.includes(task.state));
    const cards = laneTasks
      .map((task) => renderCard(task, running.has(task.id)))
      .join("");
    return `
      <section class="lane lane-${lane.id}">
        <header class="lane-head">
          <span class="lane-dot"></span>
          <span class="lane-title">${lane.label}</span>
          <span class="lane-count">${laneTasks.length}</span>
        </header>
        <div class="lane-body">
          ${cards || '<div class="lane-empty">empty</div>'}
        </div>
      </section>`;
  }).join("");
}

function renderCard(task, isRunning) {
  const loop = Number(task.review_loops ?? 0);
  const loopLabel = loop ? ` · loop ${loop}/2` : "";
  const lastEvent = task.last_event ? ` · ${task.last_event}` : "";
  return `
    <article class="card state-${esc(task.state)}" role="button" tabindex="0"
      data-task-id="${esc(task.id)}"
      aria-label="${esc(`${task.id} ${task.title}`)}"
      title="${esc(truncate(`${task.title}${lastEvent}`, 220))}">
      <div class="card-top">
        <span class="task-id">${esc(task.id)}</span>
        <span class="state-pill ${esc(task.state)}">${esc(STATE_LABEL[task.state] ?? task.state)}</span>
      </div>
      <h3>${esc(task.title)}</h3>
      <div class="card-meta">
        <span class="project-dot proj-${projectHash(task.project_id)}"></span>
        <span class="project-name">${esc(task.projectName)}</span>
        <span>·</span>
        <span>${esc(COMMANDS[task.agent] ?? task.agent)}</span>
      </div>
      <div class="card-foot">
        <span>${timeAgo(task.updated_at)}</span>
        <span>${esc(loopLabel)}</span>
        <span class="spacer"></span>
        ${isRunning ? '<span class="live">running</span>' : ""}
      </div>
    </article>`;
}

function renderSideFoot() {
  const projects = ui.data?.projects ?? [];
  const tasks = ui.data?.tasks ?? [];
  const running = ui.data?.running ?? [];
  const root = $("#sideFoot");
  if (!root) return;
  root.innerHTML = `
    <strong>${running.length}</strong> agent run(s) · <strong>${tasks.length}</strong> task(s)<br />
    <strong>${projects.length}</strong> project(s) · local only on 127.0.0.1`;
}

/* Drawer ------------------------------------------------------------------ */

function renderDrawer() {
  const root = $("#drawerRoot");
  if (!root) return;

  if (!ui.selectedTaskId) {
    root.innerHTML = "";
    return;
  }

  const task = ui.detail?.task ?? ui.data?.tasks?.find((item) => item.id === ui.selectedTaskId);
  if (!task) {
    root.innerHTML = "";
    return;
  }

  const project = ui.detail?.project ?? ui.data?.projects?.find((item) => item.id === task.project_id);
  const running = ui.detail ? Boolean(ui.detail.running) : Boolean((ui.data?.running ?? []).includes(task.id));
  const canRun = ["specced", "working", "fixing", "review", "verify"].includes(task.state);
  const loops = Number(task.review_loops ?? 0);
  const runtime = ui.detail?.runtime;
  const runtimeLabel = runtime
    ? `${COMMANDS[runtime.implementer] ?? runtime.implementer} → ${COMMANDS[runtime.reviewer] ?? runtime.reviewer}`
    : COMMANDS[task.agent] ?? task.agent;
  const modelNote =
    runtime && (runtime.implModel !== "default" || runtime.reviewModel !== "default")
      ? ` (${runtime.implModel} / ${runtime.reviewModel})`
      : "";
  const rateLimitEvent = [...(ui.detail?.events ?? [])]
    .reverse()
    .find((event) => event.type === "agent.rate_limit");

  const actions = running
    ? '<button class="btn danger" data-action="stop">■ Stop</button>'
    : `<button class="btn primary" data-action="run" ${canRun ? "" : "disabled"}>▶ Run</button>`;

  root.innerHTML = `
    <div class="scrim" data-close-drawer></div>
    <aside class="drawer" role="dialog" aria-modal="true" aria-label="${esc(task.title)}">
      <header class="drawer-head">
        <div>
          <span class="task-id">${esc(task.id)}</span>
          <h2>${esc(task.title)}</h2>
          <div class="drawer-sub">
            <span class="state-pill ${esc(task.state)}">${esc(STATE_LABEL[task.state] ?? task.state)}</span>
            <span>${esc(project?.name ?? projectName(task.project_id))}</span>
            <span>·</span>
            <span>${esc(runtimeLabel)}${esc(modelNote)}</span>
            ${runtime?.agyYolo && runtime.implementer === "agy" ? '<span class="state-pill warn-pill">YOLO</span>' : ""}
            ${loops ? `<span>· loop ${loops}/2</span>` : ""}
            ${task.branch ? `<span>· <span class="mono">${esc(task.branch)}</span></span>` : ""}
          </div>
        </div>
        <button class="drawer-close" data-close-drawer aria-label="Close">×</button>
      </header>

      <div class="drawer-bar">
        ${actions}
        ${task.worktree ? `<button class="btn small" data-action="merge" ${running ? "disabled" : ""}>Merge</button>` : ""}
        <button class="btn small" data-action="open-worktree">Open folder</button>
        <button class="btn small" data-action="open-spec">Spec file</button>
        <button class="btn small" data-action="mark-done" ${running ? "disabled" : ""}>Mark done</button>
        <button class="btn small" data-action="mark-blocked" ${running ? "disabled" : ""}>Block</button>
        <button class="btn small danger" data-action="delete-task" ${running ? "disabled" : ""}>Delete</button>
        <span class="spacer"></span>
        <select id="stateSelect" aria-label="Move task to state" ${running ? "disabled" : ""}>
          ${STATES.map(
            (state) =>
              `<option value="${state}" ${task.state === state ? "selected" : ""}>Move to: ${
                STATE_LABEL[state] ?? state
              }</option>`,
          ).join("")}
        </select>
      </div>

      ${task.last_error ? `<div class="banner">${esc(task.last_error)}</div>` : ""}
      ${rateLimitEvent ? `<div class="banner warn">Rate limit notice: ${esc(rateLimitEvent.text)}</div>` : ""}

      <nav class="tabs" aria-label="Task views">
        ${["spec", "review", "diff", "tests", "events"]
          .map(
            (tab) =>
              `<button class="tab ${ui.tab === tab ? "active" : ""}" data-tab="${tab}">${
                tab === "tests" ? "Tests" : tab[0].toUpperCase() + tab.slice(1)
              }${tab === "events" && ui.detail ? ` (${ui.detail.events.length})` : ""}</button>`,
          )
          .join("")}
      </nav>

      <div class="drawer-body"></div>
    </aside>`;

  renderDrawerBody();
}

function formatInlineMd(escaped) {
  let out = escaped;
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
  return out;
}

function renderMarkdown(source) {
  const lines = String(source ?? "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let inCode = false;
  let codeLines = [];
  let inList = false;

  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };

  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      closeList();
      if (!inCode) {
        inCode = true;
        codeLines = [];
      } else {
        out.push(`<pre class="code md-code">${esc(codeLines.join("\n"))}</pre>`);
        inCode = false;
      }
      continue;
    }

    if (inCode) {
      codeLines.push(raw);
      continue;
    }

    const trimmed = raw.trim();
    if (!trimmed) {
      closeList();
      continue;
    }

    if (/^[*`\s]*VERDICT:\s*(APPROVE|REQUEST\s+CHANGES)\b[*`\s.]*$/i.test(trimmed)) {
      closeList();
      const approve = /APPROVE/i.test(trimmed);
      out.push(
        `<div class="verdict-pill ${approve ? "approve" : "changes"}">${esc(
          approve ? "VERDICT: APPROVE" : "VERDICT: REQUEST CHANGES",
        )}</div>`,
      );
      continue;
    }

    if (/^---+$/.test(trimmed)) {
      closeList();
      out.push("<hr />");
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${formatInlineMd(esc(heading[2]))}</h${level}>`);
      continue;
    }

    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      closeList();
      out.push(`<blockquote>${formatInlineMd(esc(quote[1]))}</blockquote>`);
      continue;
    }

    const checkItem = trimmed.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (checkItem) {
      if (!inList) {
        out.push('<ul class="md-list">');
        inList = true;
      }
      const checked = checkItem[1].toLowerCase() === "x";
      out.push(
        `<li class="md-check ${checked ? "done" : ""}"><span>${checked ? "☑" : "☐"}</span> ${formatInlineMd(
          esc(checkItem[2]),
        )}</li>`,
      );
      continue;
    }

    const listItem = trimmed.match(/^[-*]\s+(.*)$/);
    if (listItem) {
      if (!inList) {
        out.push('<ul class="md-list">');
        inList = true;
      }
      out.push(`<li>${formatInlineMd(esc(listItem[1]))}</li>`);
      continue;
    }

    closeList();
    out.push(`<p>${formatInlineMd(esc(trimmed))}</p>`);
  }

  if (inCode) {
    out.push(`<pre class="code md-code">${esc(codeLines.join("\n"))}</pre>`);
  }
  closeList();
  return `<div class="md-view">${out.join("\n")}</div>`;
}

function renderDiff(patch) {
  const lines = String(patch ?? "").replace(/\r\n/g, "\n").split("\n");
  let files = 0;
  let added = 0;
  let removed = 0;

  const rows = lines.map((line) => {
    if (line.startsWith("diff --git ")) {
      files += 1;
      return `<div class="diff-line diff-file">${esc(line)}</div>`;
    }
    if (line.startsWith("@@ ")) {
      return `<div class="diff-line diff-hunk">${esc(line)}</div>`;
    }
    if (
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file ") ||
      line.startsWith("deleted file ")
    ) {
      return `<div class="diff-line diff-meta">${esc(line)}</div>`;
    }
    if (line.startsWith("+")) {
      added += 1;
      return `<div class="diff-line diff-add">${esc(line)}</div>`;
    }
    if (line.startsWith("-")) {
      removed += 1;
      return `<div class="diff-line diff-del">${esc(line)}</div>`;
    }
    return `<div class="diff-line diff-ctx">${esc(line || " ")}</div>`;
  });

  return {
    summary: `${files} file(s) · +${added} -${removed}`,
    html: `<div class="diff-view">${rows.join("")}</div>`,
  };
}

function renderDrawerBody() {
  const body = document.querySelector(".drawer-body");
  if (!body) return;

  if (!ui.detail) {
    body.innerHTML = '<div class="skeleton">Loading task…</div>';
    return;
  }

  const detail = ui.detail;
  const task = detail.task;

  if (ui.tab === "spec") {
    const value = ui.specDraft ?? detail.spec ?? "";
    body.innerHTML = `
      <div class="code-head">
        <span class="mono">${esc(task.spec_path ?? "")}</span>
        <span class="spacer"></span>
        <button class="btn small ghost" data-action="toggle-spec-preview">${
          ui.specPreview ? "Edit" : "Preview"
        }</button>
        <button class="btn small" data-action="save-spec" ${ui.specDirty ? "" : "disabled"}>Save spec</button>
      </div>
      ${
        ui.specPreview
          ? renderMarkdown(value)
          : `<textarea id="specEditor" class="spec-editor" spellcheck="false"
              aria-label="Task spec markdown">${esc(value)}</textarea>`
      }
      <p class="hint">The spec is the handoff. Saving a spec on an Inbox task moves it to Ready. Keep it short, concrete, and current.</p>`;
    return;
  }

  if (ui.tab === "review") {
    if (!detail.review) {
      body.innerHTML =
        '<div class="empty-panel">No review yet. Run the task and the reviewer will write a verdict here.</div>';
      return;
    }
    body.innerHTML = `
      <div class="code-head">
        <span class="mono">review.md</span>
        <span class="spacer"></span>
        <button class="btn small ghost" data-action="toggle-review-raw">${
          ui.reviewRaw ? "Rendered" : "Raw"
        }</button>
      </div>
      ${ui.reviewRaw ? `<pre class="code">${esc(detail.review)}</pre>` : renderMarkdown(detail.review)}`;
    return;
  }

  if (ui.tab === "diff") {
    if (!detail.diff) {
      body.innerHTML =
        '<div class="empty-panel">No diff captured yet. It appears after the implementation step.</div>';
      return;
    }
    const rendered = renderDiff(detail.diff);
    body.innerHTML = `
      <div class="code-head">
        <span class="mono">${esc(rendered.summary)}</span>
        <span class="spacer"></span>
        <button class="btn small ghost" data-action="toggle-diff-raw">${
          ui.diffRaw ? "Colorized" : "Raw"
        }</button>
      </div>
      ${ui.diffRaw ? `<pre class="code">${esc(detail.diff)}</pre>` : rendered.html}`;
    return;
  }

  if (ui.tab === "tests") {
    body.innerHTML = detail.test
      ? `<pre class="code">${esc(detail.test)}</pre>`
      : '<div class="empty-panel">No test log yet. If the project has a test command, it runs before Done.</div>';
    return;
  }

  const events = [...(detail.events ?? [])].reverse();
  const runs = detail.runs ?? [];
  body.innerHTML = `
    ${
      events.length
        ? `<div class="events">${events.map(renderEvent).join("")}</div>`
        : '<div class="empty-panel">No events yet.</div>'
    }
    ${
      runs.length
        ? `<div class="run-summary">
            <h4>Runs</h4>
            ${runs
              .map(
                (run) => `<div class="run-row">
                  <span>${esc(run.step)} · ${esc(run.agent)}</span>
                  <span>${esc(String(run.started_at ?? "").slice(11, 19))}</span>
                  <span class="${run.status === "ok" ? "good" : run.status === "running" ? "" : "bad"}">${esc(
                    run.status,
                  )}</span>
                </div>`,
              )
              .join("")}
          </div>`
        : ""
    }`;
}

function renderEvent(event) {
  const type = String(event.type ?? "event");
  const tone = type.startsWith("run.failed") || type.startsWith("run.stopped") ? "failed" : type.startsWith("agent.") ? "agent" : "";
  return `
    <div class="event ${tone}">
      <div class="event-head">
        <span class="event-actor">${esc(event.actor ?? "orc")}</span>
        <span class="event-type">${esc(type)}</span>
        <time title="${esc(event.ts ?? "")}">${clockTime(event.ts)}</time>
      </div>
      ${event.text ? `<div class="event-text">${esc(event.text)}</div>` : ""}
    </div>`;
}

async function openTask(id) {
  ui.selectedTaskId = id;
  ui.tab = "spec";
  ui.detail = null;
  ui.specDraft = null;
  ui.specDirty = false;
  renderDrawer();
  await refreshDetail(true);
}

function closeDrawer() {
  ui.selectedTaskId = null;
  ui.detail = null;
  ui.specDraft = null;
  ui.specDirty = false;
  renderDrawer();
}

function setTab(tab) {
  ui.tab = tab;
  document.querySelectorAll(".tab").forEach((element) => {
    element.classList.toggle("active", element.dataset.tab === tab);
  });
  renderDrawerBody();
}

function selectProject(id) {
  ui.projectId = id || null;
  if (ui.selectedTaskId) closeDrawer();
  render();
  $("#board")?.scrollTo({ left: 0, behavior: "smooth" });
}

/* Actions ----------------------------------------------------------------- */

async function handleAction(action, element) {
  const id = ui.selectedTaskId;
  try {
    if (action === "refresh") {
      await refreshState();
      if (id) await refreshDetail(true);
      return;
    }

    if (action === "new-task") {
      openTaskModal();
      return;
    }

    if (action === "new-project") {
      openProjectModal();
      return;
    }

    if (action === "open-doctor") {
      openDoctorModal();
      return;
    }

    if (action === "edit-project") {
      const project = currentProject();
      if (project) openProjectSettingsModal(project);
      return;
    }

    if (action === "remove-project") {
      const projectId = element?.dataset?.projectId;
      if (!projectId) return;
      const name = projectName(projectId);
      if (!window.confirm(`Unregister project "${name}"? Local repository files on disk are not deleted.`)) return;
      await api(`/api/projects/${encodeURIComponent(projectId)}/remove`, { method: "POST" });
      closeModal();
      if (ui.projectId === projectId) ui.projectId = null;
      if (ui.selectedTaskId) closeDrawer();
      await refreshState();
      toast(`Unregistered ${name}`, "ok");
      return;
    }

    if (action === "toggle-spec-preview") {
      ui.specPreview = !ui.specPreview;
      renderDrawerBody();
      return;
    }

    if (action === "toggle-review-raw") {
      ui.reviewRaw = !ui.reviewRaw;
      renderDrawerBody();
      return;
    }

    if (action === "toggle-diff-raw") {
      ui.diffRaw = !ui.diffRaw;
      renderDrawerBody();
      return;
    }

    if (action === "clear-search") {
      ui.query = "";
      $("#search").value = "";
      render();
      return;
    }

    if (!id && ["run", "stop", "merge", "delete-task", "mark-done", "mark-blocked", "save-spec", "open-worktree", "open-spec"].includes(action)) {
      return;
    }

    if (action === "run") {
      await api(`/api/tasks/${encodeURIComponent(id)}/run`, { method: "POST" });
      if (ui.detail) ui.detail.running = true;
      renderDrawer();
      toast(`${id}: pipeline started`, "ok");
      scheduleStateRefresh(300);
      scheduleDetailRefresh(350);
      return;
    }

    if (action === "stop") {
      await api(`/api/tasks/${encodeURIComponent(id)}/stop`, { method: "POST" });
      toast(`${id}: stopping…`);
      scheduleStateRefresh(300);
      scheduleDetailRefresh(350);
      return;
    }

    if (action === "merge") {
      const detail = await api(`/api/tasks/${encodeURIComponent(id)}/merge`, { method: "POST" });
      ui.detail = detail;
      renderDrawer();
      await refreshState();
      toast(`${id}: merged and cleaned up`, "ok");
      return;
    }

    if (action === "delete-task") {
      const cleanWt = window.confirm(
        `Delete ${id} from the board? Click OK to also remove its worktree and .orc artifacts (your spec file under docs/specs/ stays intact).`,
      );
      if (!cleanWt) return;
      await api(`/api/tasks/${encodeURIComponent(id)}/delete`, {
        method: "POST",
        body: JSON.stringify({ cleanupWorktree: true }),
      });
      closeDrawer();
      await refreshState();
      toast(`${id}: deleted`, "ok");
      return;
    }

    if (action === "mark-done") {
      if (!window.confirm(`Mark ${id} as done without merging? The branch and worktree stay in place.`)) return;
      await api(`/api/tasks/${encodeURIComponent(id)}/state`, {
        method: "POST",
        body: JSON.stringify({ state: "done", note: "Marked done from dashboard" }),
      });
      toast(`${id} → done`, "ok");
      await refreshState();
      await refreshDetail(true);
      return;
    }

    if (action === "mark-blocked") {
      const note = window.prompt(`Why is ${id} blocked?`, "");
      if (note === null) return;
      await api(`/api/tasks/${encodeURIComponent(id)}/block`, {
        method: "POST",
        body: JSON.stringify({ note }),
      });
      toast(`${id} → blocked`, "ok");
      await refreshState();
      await refreshDetail(true);
      return;
    }

    if (action === "save-spec") {
      const editor = document.querySelector("#specEditor");
      const content = editor ? editor.value : "";
      const detail = await api(`/api/tasks/${encodeURIComponent(id)}/spec`, {
        method: "POST",
        body: JSON.stringify({ content }),
      });
      ui.detail = detail;
      ui.specDraft = null;
      ui.specDirty = false;
      renderDrawer();
      await refreshState();
      toast(`${id}: spec saved`, "ok");
      return;
    }

    if (action === "open-worktree") {
      await api(`/api/tasks/${encodeURIComponent(id)}/open`, {
        method: "POST",
        body: JSON.stringify({ target: "worktree" }),
      });
      return;
    }

    if (action === "open-spec") {
      await api(`/api/tasks/${encodeURIComponent(id)}/open`, {
        method: "POST",
        body: JSON.stringify({ target: "spec" }),
      });
      return;
    }

    if (element?.dataset?.tab) setTab(element.dataset.tab);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function changeState(next) {
  const id = ui.selectedTaskId;
  if (!id || !next) return;
  try {
    await api(`/api/tasks/${encodeURIComponent(id)}/state`, {
      method: "POST",
      body: JSON.stringify({ state: next, note: "Moved from dashboard" }),
    });
    toast(`${id} → ${next}`, "ok");
    await refreshState();
    await refreshDetail(true);
  } catch (error) {
    toast(error.message, "error");
    await refreshDetail(true);
  }
}

/* Modals ------------------------------------------------------------------ */

function closeModal() {
  $("#modalRoot").innerHTML = "";
}

function openTaskModal() {
  const projects = ui.data?.projects ?? [];
  if (!projects.length) {
    toast("Register a project first", "error");
    openProjectModal();
    return;
  }

  const selected = ui.projectId || projects[0].id;
  $("#modalRoot").innerHTML = `
    <div class="modal-backdrop">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="taskModalTitle">
        <header class="modal-head">
          <div>
            <h2 id="taskModalTitle">New task</h2>
            <p>A task, a spec file, and a branch name. Not a chat message.</p>
          </div>
          <button class="drawer-close" data-close-modal aria-label="Close">×</button>
        </header>
        <form id="taskForm">
          <label class="field">
            <span>Project</span>
            <select name="projectId" required>
              ${projects
                .map(
                  (project) =>
                    `<option value="${esc(project.id)}" ${project.id === selected ? "selected" : ""}>${esc(
                      project.name,
                    )}</option>`,
                )
                .join("")}
            </select>
          </label>
          <label class="field">
            <span>Title</span>
            <input name="title" required autofocus placeholder="Retry failed uploads once" />
          </label>
          <label class="field">
            <span>Problem / description</span>
            <textarea name="description" rows="4" placeholder="What hurts, for whom, why now. Leave empty for a title-only inbox item."></textarea>
          </label>
          <label class="field">
            <span>Acceptance criteria</span>
            <textarea name="acceptance" rows="3" placeholder="- [ ] uploads retry on 5xx&#10;- [ ] a test covers the retry"></textarea>
          </label>
          <label class="field">
            <span>Implementer</span>
            <select name="agent">
              <option value="claude">Claude Code</option>
              <option value="agy">Google Antigravity</option>
            </select>
          </label>
          <p class="hint">Title only starts in Inbox. A description or acceptance criteria starts in Ready. The reviewer is the other CLI.</p>
          <div class="modal-actions">
            <button type="button" class="btn" data-close-modal>Cancel</button>
            <button type="submit" class="btn primary">Create task</button>
          </div>
        </form>
      </div>
    </div>`;
  setTimeout(() => document.querySelector('#taskForm input[name="title"]')?.focus(), 0);
}

function modelDatalistHtml() {
  return `<datalist id="orcModels">${MODEL_SUGGESTIONS.map((m) => `<option value="${esc(m)}"></option>`).join("")}</datalist>`;
}

function reviewerOptionsHtml(selected = "") {
  const opts = [
    ["", "Default (opposite CLI / ORC_REVIEWER)"],
    ["auto", "Auto (opposite CLI, fallback to same)"],
    ["same", "Same CLI (fresh plan session)"],
    ["claude", "Always Claude Code"],
    ["agy", "Always Google Antigravity"],
  ];
  return opts
    .map(
      ([value, label]) =>
        `<option value="${esc(value)}" ${selected === value ? "selected" : ""}>${esc(label)}</option>`,
    )
    .join("");
}

function openProjectModal() {
  $("#modalRoot").innerHTML = `
    <div class="modal-backdrop">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="projectModalTitle">
        <header class="modal-head">
          <div>
            <h2 id="projectModalTitle">Add project</h2>
            <p>Point ORC at an existing git repository. Nothing is committed.</p>
          </div>
          <button class="drawer-close" data-close-modal aria-label="Close">×</button>
        </header>
        <form id="projectForm">
          <label class="field">
            <span>Path</span>
            <input name="path" required autofocus placeholder="C:\\Users\\you\\code\\my-app" />
          </label>
          <label class="field">
            <span>Display name</span>
            <input name="name" placeholder="my-app" />
          </label>
          <div class="field-row">
            <label class="field">
              <span>Base branch</span>
              <input name="baseBranch" value="main" />
            </label>
            <label class="field">
              <span>Reviewer policy</span>
              <select name="reviewer">${reviewerOptionsHtml("")}</select>
            </label>
          </div>
          <label class="field">
            <span>Test command</span>
            <input name="testCommand" placeholder="npm test" />
          </label>
          <label class="field">
            <span>Worktree setup command (optional)</span>
            <input name="setupCommand" placeholder="git submodule update --init" />
          </label>
          <div class="field-row">
            <label class="field">
              <span>Implementer model (optional)</span>
              <input name="implModel" list="orcModels" placeholder="CLI / env default" />
            </label>
            <label class="field">
              <span>Reviewer model (optional)</span>
              <input name="reviewModel" list="orcModels" placeholder="CLI / env default" />
            </label>
          </div>
          ${modelDatalistHtml()}
          <p class="hint">ORC writes AGENTS.md, docs/index.md, docs/specs/, docs/decisions/, and a .gitignore entry for .worktrees/. Existing files are left alone.</p>
          <div class="modal-actions">
            <button type="button" class="btn" data-close-modal>Cancel</button>
            <button type="submit" class="btn primary">Register project</button>
          </div>
        </form>
      </div>
    </div>`;
  setTimeout(() => document.querySelector('#projectForm input[name="path"]')?.focus(), 0);
}

function openProjectSettingsModal(project) {
  $("#modalRoot").innerHTML = `
    <div class="modal-backdrop">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="projectSettingsTitle">
        <header class="modal-head">
          <div>
            <h2 id="projectSettingsTitle">Project settings · ${esc(project.name)}</h2>
            <p class="mono">${esc(project.path)}</p>
          </div>
          <button class="drawer-close" data-close-modal aria-label="Close">×</button>
        </header>
        <form id="projectSettingsForm" data-project-id="${esc(project.id)}">
          <div class="field-row">
            <label class="field">
              <span>Display name</span>
              <input name="name" value="${esc(project.name)}" required />
            </label>
            <label class="field">
              <span>Base branch</span>
              <input name="baseBranch" value="${esc(project.baseBranch || "main")}" required />
            </label>
          </div>
          <label class="field">
            <span>Test command</span>
            <input name="testCommand" value="${esc(project.testCommand || "")}" placeholder="npm test" />
          </label>
          <label class="field">
            <span>Worktree setup command (runs on new worktree)</span>
            <input name="setupCommand" value="${esc(project.setupCommand || "")}" placeholder="git submodule update --init" />
          </label>
          <label class="field">
            <span>Reviewer policy</span>
            <select name="reviewer">${reviewerOptionsHtml(project.reviewer || "")}</select>
          </label>
          <div class="field-row">
            <label class="field">
              <span>Implementer model override</span>
              <input name="implModel" list="orcModels" value="${esc(project.implModel || "")}" placeholder="CLI / env default" />
            </label>
            <label class="field">
              <span>Reviewer model override</span>
              <input name="reviewModel" list="orcModels" value="${esc(project.reviewModel || "")}" placeholder="CLI / env default" />
            </label>
          </div>
          ${modelDatalistHtml()}
          <p class="hint">Changes take effect on the next task run without restarting ORC. Leave model overrides blank to use ORC_* environment variables or CLI defaults.</p>
          <div class="modal-actions">
            <button type="button" class="btn danger" data-action="remove-project" data-project-id="${esc(project.id)}">Unregister</button>
            <span class="spacer"></span>
            <button type="button" class="btn" data-close-modal>Cancel</button>
            <button type="submit" class="btn primary">Save settings</button>
          </div>
        </form>
      </div>
    </div>`;
}

function openDoctorModal() {
  const health = ui.data?.health ?? {};
  const rows = [
    ["Git", health.git, "https://git-scm.com/"],
    ["Claude Code (claude)", health.claude, "irm https://claude.ai/install.ps1 | iex"],
    ["Google Antigravity (agy)", health.agy, "irm https://antigravity.google/cli/install.ps1 | iex"],
  ];

  $("#modalRoot").innerHTML = `
    <div class="modal-backdrop">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="doctorModalTitle">
        <header class="modal-head">
          <div>
            <h2 id="doctorModalTitle">CLI health &amp; setup</h2>
            <p>ORC invokes official CLIs headlessly — each vendor keeps its own login and quota.</p>
          </div>
          <button class="drawer-close" data-close-modal aria-label="Close">×</button>
        </header>
        <div class="modal-body">
          <div class="doctor-list">
            ${rows
              .map(([label, entry, installHint]) => {
                const ok = Boolean(entry?.available);
                return `<div class="doctor-row">
                  <span class="state-pill ${ok ? "done" : "blocked"}">${ok ? "OK" : "MISSING"}</span>
                  <div>
                    <strong>${esc(label)}</strong>
                    <div class="mono">${esc(ok ? entry.path : installHint)}</div>
                  </div>
                </div>`;
              })
              .join("")}
          </div>
          <p class="hint">After installing a CLI, sign in interactively once (<code>claude</code> / <code>agy</code>), install the global launcher (<code>node scripts/install-skill.mjs</code>), then restart <code>orc serve</code>.</p>
          <div class="modal-actions">
            <button type="button" class="btn primary" data-close-modal>Close</button>
          </div>
        </div>
      </div>
    </div>`;
}

async function submitTaskForm(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  try {
    const result = await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        projectId: data.projectId,
        title: data.title,
        description: data.description,
        acceptance: data.acceptance,
        agent: data.agent,
      }),
    });
    closeModal();
    ui.projectId = result.task.project_id;
    await refreshState();
    toast(`Created ${result.task.id} · ${STATE_LABEL[result.task.state] ?? result.task.state}`, "ok");
    await openTask(result.task.id);
  } catch (error) {
    toast(error.message, "error");
    if (button) button.disabled = false;
  }
}

async function submitProjectForm(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  try {
    const result = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        path: data.path,
        name: data.name,
        baseBranch: data.baseBranch,
        testCommand: data.testCommand,
        setupCommand: data.setupCommand,
        reviewer: data.reviewer,
        implModel: data.implModel,
        reviewModel: data.reviewModel,
      }),
    });
    closeModal();
    ui.projectId = result.project.id;
    await refreshState();
    toast(`Registered ${result.project.name}`, "ok");
    if (result.init?.warnings?.length) toast(result.init.warnings[0], "error");
  } catch (error) {
    toast(error.message, "error");
    if (button) button.disabled = false;
  }
}

async function submitProjectSettingsForm(form) {
  const projectId = form.dataset.projectId;
  const data = Object.fromEntries(new FormData(form).entries());
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  try {
    const result = await api(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: "POST",
      body: JSON.stringify({
        name: data.name,
        baseBranch: data.baseBranch,
        testCommand: data.testCommand,
        setupCommand: data.setupCommand,
        reviewer: data.reviewer,
        implModel: data.implModel,
        reviewModel: data.reviewModel,
      }),
    });
    closeModal();
    await refreshState();
    toast(`Saved settings for ${result.project.name}`, "ok");
  } catch (error) {
    toast(error.message, "error");
    if (button) button.disabled = false;
  }
}

/* Live updates ------------------------------------------------------------ */

function connectEvents() {
  const source = new EventSource("/api/events");

  source.addEventListener("hello", () => {
    scheduleStateRefresh(0);
    if (ui.selectedTaskId) scheduleDetailRefresh(200);
  });

  source.addEventListener("refresh", () => {
    scheduleStateRefresh(250);
    if (ui.selectedTaskId) scheduleDetailRefresh(350);
  });

  source.addEventListener("task-event", (message) => {
    let event;
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }

    if (event.type === "run.failed") toast(event.text || "Run failed", "error");
    if (event.type === "run.stopped") toast("Run stopped", "");
    if (event.type === "agent.rate_limit") toast(`Rate limit: ${event.text}`, "error");

    if (ui.selectedTaskId && event.taskId === ui.selectedTaskId && ui.detail) {
      const exists = ui.detail.events.some((item) => item.id === event.id);
      if (!exists) ui.detail.events.push(event);
      if (ui.tab === "events" && !ui.specDirty) {
        const list = document.querySelector(".events");
        if (list) list.insertAdjacentHTML("afterbegin", renderEvent(event));
        else renderDrawerBody();
      }
    }

    if (
      [
        "state",
        "run.started",
        "run.failed",
        "run.stopped",
        "worktree.created",
        "review.approved",
        "review.changes_requested",
        "verify.passed",
        "verify.failed",
        "diff.captured",
        "task.created",
        "task.merged",
        "merge.refused",
        "run.refused",
      ].includes(event.type)
    ) {
      scheduleStateRefresh(350);
      scheduleDetailRefresh(450);
    }
  });
}

/* Events ------------------------------------------------------------------ */

document.addEventListener("click", (event) => {
  const target = event.target;

  if (target.classList?.contains("modal-backdrop")) {
    closeModal();
    return;
  }

  if (target.closest("[data-close-modal]")) {
    closeModal();
    return;
  }

  if (target.closest("[data-close-drawer]")) {
    closeDrawer();
    return;
  }

  const tab = target.closest("[data-tab]");
  if (tab) {
    event.preventDefault();
    setTab(tab.dataset.tab);
    return;
  }

  const action = target.closest("[data-action]");
  if (action) {
    event.preventDefault();
    handleAction(action.dataset.action, action);
    return;
  }

  const project = target.closest("[data-project]");
  if (project) {
    event.preventDefault();
    selectProject(project.dataset.project);
    return;
  }

  const card = target.closest("[data-task-id]");
  if (card) {
    event.preventDefault();
    openTask(card.dataset.taskId);
  }
});

document.addEventListener("change", (event) => {
  if (event.target.id === "stateSelect") {
    changeState(event.target.value);
  }
});

document.addEventListener("input", (event) => {
  if (event.target.id === "specEditor") {
    ui.specDraft = event.target.value;
    ui.specDirty = true;
    const save = document.querySelector('[data-action="save-spec"]');
    if (save) save.disabled = false;
  }
});

document.addEventListener("submit", (event) => {
  if (event.target.id === "taskForm") {
    event.preventDefault();
    submitTaskForm(event.target);
  } else if (event.target.id === "projectForm") {
    event.preventDefault();
    submitProjectForm(event.target);
  } else if (event.target.id === "projectSettingsForm") {
    event.preventDefault();
    submitProjectSettingsForm(event.target);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if ($("#modalRoot").innerHTML.trim()) {
      closeModal();
    } else if (ui.selectedTaskId) {
      closeDrawer();
    }
    return;
  }

  if (
    event.key === "/" &&
    !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)
  ) {
    event.preventDefault();
    $("#search")?.focus();
    return;
  }

  if (
    event.key === "Enter" &&
    document.activeElement?.matches?.("[data-task-id]")
  ) {
    event.preventDefault();
    openTask(document.activeElement.dataset.taskId);
  }
});

$("#search").addEventListener("input", (event) => {
  ui.query = event.target.value;
  renderHero();
  renderBoard();
});

connectEvents();
refreshState();
setInterval(refreshState, 30_000);
