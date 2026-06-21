// Control-panel UI. Talks only to window.servermind (exposed by preload).
// No imports here on purpose: this file must compile to a plain browser script.

type AuthMethod = "agent" | "key" | "password";

type ConnectionMode = "ssh" | "direct";

interface ControllerView {
  id: string;
  connection: ConnectionMode;
  label: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  keyPath?: string;
  remoteHost: string;
  remotePort: number;
  pinnedHostKey?: string;
}

interface TunnelStatus {
  id: string;
  state: "connecting" | "connected" | "reconnecting" | "closed" | "error";
  localPort?: number;
  url?: string;
  message?: string;
  hostKeyFingerprint?: string;
}

interface ServerMindApi {
  listControllers(): Promise<ControllerView[]>;
  saveController(input: Record<string, unknown>): Promise<ControllerView>;
  deleteController(id: string): Promise<void>;
  connect(id: string): Promise<TunnelStatus>;
  disconnect(id: string): Promise<void>;
  status(id: string): Promise<TunnelStatus>;
  openDashboard(id: string): Promise<void>;
  onStatus(cb: (s: TunnelStatus) => void): void;
}

// Cast rather than `declare global` so this file stays a plain browser script
// (a module would emit CommonJS `exports`, which throws in the renderer).
const api = (window as unknown as { servermind: ServerMindApi }).servermind;
const statuses = new Map<string, TunnelStatus>();

const $ = <T extends HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

const listEl = $("#list");
const emptyEl = $("#empty");
const dialog = $<HTMLDialogElement>("#dialog");
const form = $<HTMLFormElement>("#form");

function stateLabel(s?: TunnelStatus): string {
  switch (s?.state) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return "Reconnecting…";
    case "error":
      return "Error";
    default:
      return "Disconnected";
  }
}

async function render(): Promise<void> {
  const controllers = await api.listControllers();
  const has = controllers.length > 0;
  emptyEl.classList.toggle("hidden", has);
  $("#section-head").classList.toggle("hidden", !has);
  $("#count").textContent = has ? String(controllers.length) : "";
  listEl.replaceChildren();

  for (const c of controllers) {
    const st = statuses.get(c.id);
    const state = st?.state ?? "closed";
    const card = document.createElement("article");
    card.className = "card";

    const head = document.createElement("div");
    head.className = "card-head";
    head.innerHTML = `
      <div class="card-id">
        <span class="pulse ${state}" aria-hidden="true"></span>
        <div>
          <div class="card-title">${escapeHtml(c.label)}</div>
          <div class="card-sub">${
            c.connection === "direct"
              ? `${escapeHtml(c.host)}:${c.remotePort}`
              : `${escapeHtml(c.username)}@${escapeHtml(c.host)}:${c.port}`
          }</div>
        </div>
      </div>
      <span class="badge ${state}">${stateLabel(st)}</span>
    `;
    card.appendChild(head);

    // Meta row: connection-mode chip + the live tunnel endpoint when up.
    const meta = document.createElement("div");
    meta.className = "card-meta";
    const chip = c.connection === "direct" ? "Direct" : "SSH tunnel";
    meta.innerHTML = `<span class="chip">${chip}</span>`;
    if (st?.state === "connected" && st.url) {
      const ep = st.localPort
        ? `127.0.0.1:${st.localPort} → ${escapeHtml(c.host)}:${c.remotePort}`
        : escapeHtml(st.url.replace(/^https?:\/\//, ""));
      meta.innerHTML += `<span class="endpoint mono">${ep}</span>`;
    }
    card.appendChild(meta);

    if (st?.state === "error" && st.message) {
      const err = document.createElement("p");
      err.className = "card-err";
      err.textContent = st.message;
      card.appendChild(err);
    }

    const actions = document.createElement("div");
    actions.className = "card-actions";

    const connected = st?.state === "connected";
    if (connected) {
      actions.appendChild(button("Open dashboard", "primary", () => api.openDashboard(c.id)));
      actions.appendChild(button("Disconnect", "ghost", () => api.disconnect(c.id)));
    } else {
      const connecting = st?.state === "connecting" || st?.state === "reconnecting";
      const b = button(connecting ? "Connecting…" : "Connect", "primary", () =>
        api.connect(c.id).catch((e) => alert(String(e)))
      );
      b.toggleAttribute("disabled", connecting);
      actions.appendChild(b);
    }
    actions.appendChild(
      button("Remove", "ghost danger", async () => {
        if (confirm(`Remove ${c.label}?`)) {
          await api.deleteController(c.id);
          statuses.delete(c.id);
          void render();
        }
      })
    );
    card.appendChild(actions);
    listEl.appendChild(card);
  }
}

function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = cls;
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}

// ── Add-controller dialog ───────────────────────────────────────────────
function syncAuthFields(): void {
  const method = $<HTMLSelectElement>("#authMethod").value as AuthMethod;
  $(".auth-key").classList.toggle("hidden", method !== "key");
  $(".auth-secret").classList.toggle("hidden", method === "agent");
  $("#secret-label").firstChild!.textContent =
    method === "key" ? "Key passphrase " : "Password ";
}

// Show SSH fields only for the SSH-tunnel mode; direct mode needs just host+port.
function syncConnection(): void {
  const direct = $<HTMLSelectElement>("#connection").value === "direct";
  document.querySelectorAll(".ssh-only").forEach((el) =>
    el.classList.toggle("hidden", direct)
  );
  $<HTMLInputElement>("#host").placeholder = direct
    ? "localhost"
    : "controller.example.com";
  if (direct) {
    $(".auth-key").classList.add("hidden");
    $(".auth-secret").classList.add("hidden");
  } else {
    syncAuthFields();
  }
}

function openAddDialog(): void {
  form.reset();
  $("#form-err").classList.add("hidden");
  syncConnection();
  dialog.showModal();
}
$("#add-btn").addEventListener("click", openAddDialog);
$("#empty-add").addEventListener("click", openAddDialog);

$("#connection").addEventListener("change", syncConnection);
$("#authMethod").addEventListener("change", syncAuthFields);

form.addEventListener("submit", async (e) => {
  const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
  if (submitter?.value !== "save") return; // cancel just closes
  e.preventDefault();

  const fd = new FormData(form);
  const input = {
    connection: String(fd.get("connection") ?? "ssh") as ConnectionMode,
    label: String(fd.get("label") ?? ""),
    host: String(fd.get("host") ?? ""),
    port: Number(fd.get("port")) || 22,
    username: String(fd.get("username") ?? ""),
    authMethod: String(fd.get("authMethod") ?? "agent") as AuthMethod,
    keyPath: String(fd.get("keyPath") ?? ""),
    remotePort: Number(fd.get("remotePort")) || 5500,
    secret: String(fd.get("secret") ?? ""),
  };

  const errEl = $("#form-err");
  const needsUser = input.connection !== "direct";
  if (!input.host || (needsUser && !input.username)) {
    errEl.textContent = needsUser
      ? "Host and SSH user are required."
      : "Host is required.";
    errEl.classList.remove("hidden");
    return;
  }
  try {
    await api.saveController(input);
    dialog.close();
    void render();
  } catch (err) {
    errEl.textContent = String(err);
    errEl.classList.remove("hidden");
  }
});

// ── Live status from the main process ───────────────────────────────────
api.onStatus((s) => {
  statuses.set(s.id, s);
  void render();
});

void render();
