import { suggestSlug } from "../shared/slug.ts";
import css from "./dashboard.css";

interface SessionRow {
  slug: string;
  title: string;
  deckTitle: string;
  items: number;
  viewers: number;
  presenters: number;
}

interface DeckRow {
  id: string;
  title: string;
  filename: string;
  size: number;
  sessions: number;
}

interface State {
  origin: string;
  sessions: SessionRow[];
  decks: DeckRow[];
}

const POLL_MS = 4000;

type Child = Node | string | null | undefined | false;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { class: className, ...rest } = props;
  if (className) node.className = className;
  Object.assign(node, rest);
  for (const child of children) if (child) node.append(child);
  return node;
}

async function api(method: string, url: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  return fetch(url, init);
}

async function errorText(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `Request failed (${response.status}).`;
}

const style = document.createElement("style");
style.textContent = css;
document.head.append(style);

let state: State = { origin: location.origin, sessions: [], decks: [] };
let lastJson = "";

const sessionsBox = el("div");
const decksBox = el("div");
const notice = el("p", { class: "notice" });
const deckSelect = el("select", { name: "deck", required: true });
const fileInput = el("input", { type: "file", accept: ".html,.htm,text/html" });
const slugInput = el("input", {
  type: "text",
  name: "slug",
  required: true,
  pattern: "[a-z0-9][a-z0-9\\-]{1,40}",
  autocapitalize: "off",
  spellcheck: false,
});
const titleInput = el("input", { type: "text", name: "title", maxLength: 200 });
const createButton = el("button", { type: "submit", class: "primary" }, "Create session");

function say(text: string, error = false): void {
  notice.textContent = text;
  notice.className = error ? "notice error" : "notice";
}

function suggestFromDeck(): void {
  const deck = state.decks.find((d) => d.id === deckSelect.value);
  if (!deck) return;
  const taken = new Set(state.sessions.map((s) => s.slug));
  slugInput.value = suggestSlug(deck.filename, deck.title, taken);
  titleInput.value = deck.title;
}

function showQr(session: SessionRow): void {
  const dialog = el(
    "dialog",
    { class: "qr-large" },
    el("img", { src: `/api/sessions/${session.slug}/qr.svg`, alt: `QR code for ${session.slug}` }),
  );
  dialog.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

function confirmRemove(session: SessionRow): void {
  const typed = el("input", {
    type: "text",
    autocomplete: "off",
    autocapitalize: "off",
    spellcheck: false,
    ariaLabel: "Slug",
  });
  const error = el("p", { class: "notice error" });
  const remove = el("button", { class: "danger", disabled: true }, "Remove session");
  const cancel = el("button", {}, "Cancel");
  const dialog = el(
    "dialog",
    {},
    el("h3", {}, `Remove ${session.slug}?`),
    el(
      "p",
      {},
      `This permanently deletes the session and its ${session.items} ink item(s). The deck stays. `,
      el("a", { href: `/controls/${session.slug}/export` }, "Download the annotated deck first"),
      ".",
    ),
    el("label", {}, `Type ${session.slug} to confirm`, typed),
    error,
    el("div", { class: "actions" }, cancel, remove),
  );
  typed.addEventListener("input", () => {
    remove.disabled = typed.value !== session.slug;
  });
  cancel.addEventListener("click", () => dialog.close());
  remove.addEventListener("click", async () => {
    const response = await api("DELETE", `/api/sessions/${session.slug}`, { confirm: typed.value });
    if (!response.ok) {
      error.textContent = await errorText(response);
      return;
    }
    dialog.close();
    await refresh();
  });
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

function sessionCard(session: SessionRow): HTMLElement {
  const url = `${state.origin}/${session.slug}`;
  const qr = el(
    "button",
    { class: "qr", title: "Show a large QR code", ariaLabel: `Show QR code for ${session.slug}` },
    el("img", { src: `/api/sessions/${session.slug}/qr.svg`, alt: "" }),
  );
  qr.addEventListener("click", () => showQr(session));
  const remove = el("button", { class: "linklike danger" }, "Remove");
  remove.addEventListener("click", () => confirmRemove(session));
  const card = el(
    "article",
    { class: "card session" },
    qr,
    el(
      "div",
      {},
      el("div", { class: "title" }, session.title),
      el(
        "div",
        { class: "meta" },
        `${session.deckTitle} · ${session.viewers} viewer${session.viewers === 1 ? "" : "s"} · ${session.items} ink item(s)`,
      ),
      el(
        "div",
        { class: "links" },
        el("a", { href: `/${session.slug}`, target: "_blank", rel: "noopener" }, url.replace(/^https?:\/\//, "")),
        el("a", { href: `/controls/${session.slug}`, target: "_blank" }, "Controls"),
        el("a", { href: `/controls/${session.slug}/export` }, "Export"),
        remove,
      ),
    ),
  );
  card.dataset.slug = session.slug;
  return card;
}

function deckCard(deck: DeckRow): HTMLElement {
  const remove = el("button", { class: "linklike danger", disabled: deck.sessions > 0 }, "Delete");
  if (deck.sessions > 0) remove.title = "A session still uses this deck.";
  remove.addEventListener("click", async () => {
    const response = await api("DELETE", `/api/decks/${deck.id}`);
    if (!response.ok) say(await errorText(response), true);
    await refresh();
  });
  const megabytes = (deck.size / 1024 / 1024).toFixed(1);
  return el(
    "article",
    { class: "card row" },
    el(
      "div",
      {},
      el("div", { class: "title" }, deck.title),
      el("div", { class: "meta" }, `${deck.filename} · ${megabytes} MB · ${deck.sessions} session(s)`),
    ),
    remove,
  );
}

function render(): void {
  sessionsBox.replaceChildren(
    ...(state.sessions.length
      ? state.sessions.map(sessionCard)
      : [el("p", { class: "empty" }, "No active sessions.")]),
  );
  decksBox.replaceChildren(
    ...(state.decks.length ? state.decks.map(deckCard) : [el("p", { class: "empty" }, "No decks uploaded.")]),
  );
  const chosen = deckSelect.value;
  deckSelect.replaceChildren(
    el("option", { value: "", disabled: true, selected: !chosen }, "Choose a deck"),
    ...state.decks.map((deck) => el("option", { value: deck.id }, `${deck.title} (${deck.filename})`)),
  );
  if (chosen) deckSelect.value = chosen;
}

async function refresh(): Promise<void> {
  const response = await fetch("/api/state").catch(() => null);
  if (!response?.ok) return;
  const json = await response.text();
  if (json === lastJson) return;
  lastJson = json;
  state = JSON.parse(json) as State;
  render();
}

async function upload(): Promise<void> {
  const file = fileInput.files?.[0];
  if (!file) return;
  const form = new FormData();
  form.append("file", file);
  say(`Uploading ${file.name}…`);
  const response = await api("POST", "/api/decks", form);
  fileInput.value = "";
  if (!response.ok) {
    say(await errorText(response), true);
    return;
  }
  const result = (await response.json()) as { deck: DeckRow; existing: boolean; warnings: string[] };
  await refresh();
  deckSelect.value = result.deck.id;
  suggestFromDeck();
  const warnings = result.warnings.join(" ");
  say(warnings || (result.existing ? "This exact deck was already uploaded, so it was reused." : "Deck uploaded."));
}

async function create(event: Event): Promise<void> {
  event.preventDefault();
  const response = await api("POST", "/api/sessions", {
    slug: slugInput.value,
    deckId: deckSelect.value,
    title: titleInput.value,
  });
  if (!response.ok) {
    say(await errorText(response), true);
    return;
  }
  say(`Session ${slugInput.value} created.`);
  await refresh();
  suggestFromDeck();
}

fileInput.addEventListener("change", upload);
deckSelect.addEventListener("change", suggestFromDeck);

const form = el(
  "form",
  { class: "card new" },
  el("label", {}, "Upload a built deck", fileInput),
  el("label", {}, "Deck", deckSelect),
  el("label", {}, "Slug", slugInput),
  el("label", {}, "Title", titleInput),
  el("div", {}, createButton),
  notice,
);
form.addEventListener("submit", create);

document
  .getElementById("app")!
  .append(
    el("h1", {}, "live"),
    el("h2", {}, "Active sessions"),
    sessionsBox,
    el("h2", {}, "New session"),
    form,
    el("h2", {}, "Decks"),
    decksBox,
  );

void refresh();
setInterval(refresh, POLL_MS);
