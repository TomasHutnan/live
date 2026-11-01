import type { Position, Question, Screen, ServerMessage } from "../shared/protocol.ts";
import { Connection, type ConnectionState } from "./connection.ts";
import { Ink, uuid } from "./ink.ts";
import { JoinCode } from "./join.ts";
import { Overlay } from "./overlay.ts";
import { Pen, type PenSettings, type Tool } from "./pen.ts";
import type { PreviewReply, PreviewRequest } from "./preview.ts";
import { questionRow, Questions } from "./questions.ts";
import { onNavigation, readPosition, type RevealApi, samePosition } from "./reveal.ts";
import { addStyles } from "./style.ts";
import { audienceText, questionScreen } from "./viewer.ts";

const COLORS = ["#111111", "#d3261e", "#1f5fbf", "#1a8a4a", "#e08a00", "#ffffff"];
const WIDTHS = [
  { width: 3, textSize: 28, label: "Thin" },
  { width: 6, textSize: 40, label: "Medium" },
  { width: 12, textSize: 56, label: "Thick" },
];

const ICONS: Record<string, string> = {
  navigate: "M5 3l6 17 2.5-7L21 11z",
  pen: "M4 20l1-4L16 5l3 3L8 19zM14 7l3 3",
  highlighter: "M9 15l-4 5h6l2-3M9 15l3 3M9 15L18 5l3 3-9 10",
  text: "M5 6V4h14v2M12 4v16M9 20h6",
  eraser: "M8 20l-4-4 10-11 7 6-9 9zM8 20h12M9 10l7 6",
  undo: "M4 9h11a5 5 0 010 10H9M4 9l4-4M4 9l4 4",
  redo: "M20 9H9a5 5 0 000 10h6M20 9l-4-4M20 9l-4 4",
  clear: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  prev: "M15 5l-7 7 7 7",
  next: "M9 5l7 7-7 7",
  panel: "M4 5h16v14H4zM15 5v14",
  questions: "M4 5h16v11H10l-4 4v-4H4z",
  qr: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2M14 20h6v-2",
};

function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name]!);
  svg.append(path);
  return svg;
}

function div(className: string, ...children: (Node | string)[]): HTMLDivElement {
  const node = document.createElement("div");
  node.className = className;
  node.append(...children);
  return node;
}

const STATE_LABEL: Record<ConnectionState, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  over: "Session removed",
};

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const minutes = pad(Math.floor(total / 60) % 60);
  return `${Math.floor(total / 3600)}:${minutes}:${pad(total % 60)}`;
}

export function startControls(reveal: RevealApi, slug: string): void {
  addStyles();
  const root = document.documentElement;
  root.classList.add("live-controls");
  if (window.innerWidth < 820) root.classList.add("live-panel-closed");
  reveal.configure({ hideInactiveCursor: false });

  const settings: PenSettings = {
    tool: "navigate",
    color: COLORS[1]!,
    width: WIDTHS[0]!.width,
    textSize: WIDTHS[0]!.textSize,
  };
  let lastDrawingTool: Tool = "pen";
  let known: Position | undefined;
  /** Id of a local move the server hasn't acknowledged. */
  let unconfirmedMove: string | undefined;

  const overlay = new Overlay(reveal);
  const connection = new Connection({
    slug,
    fetchToken: async () => {
      const response = await fetch(`/controls/${slug}/token`, { method: "POST" });
      if (!response.ok) throw new Error(`token: ${response.status}`);
      return ((await response.json()) as { token: string }).token;
    },
    onMessage,
    onState,
  });
  const ink = new Ink(overlay, connection);
  const pen = new Pen(overlay, ink, connection, settings);
  const questions = new Questions(connection, slug);
  const join = new JoinCode(reveal, slug, audienceText().join);
  const wall = questionScreen(reveal);

  // Toolbar

  const bar = div("live-bar");
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Drawing tools");

  function button(label: string, content: Node, onClick: () => void): HTMLButtonElement {
    const node = document.createElement("button");
    node.type = "button";
    node.title = label;
    node.setAttribute("aria-label", label);
    node.append(content);
    node.addEventListener("click", () => {
      onClick();
      node.blur(); // Space and the arrows must keep driving reveal.
    });
    bar.append(node);
    return node;
  }

  const gap = () => bar.append(div("live-gap"));

  const toolButtons = new Map<Tool, HTMLButtonElement>();
  function chooseTool(tool: Tool): void {
    settings.tool = tool;
    if (tool !== "navigate") lastDrawingTool = tool;
    for (const [name, node] of toolButtons) node.setAttribute("aria-pressed", String(name === tool));
    pen.sync();
  }

  const TOOLS: [Tool, string][] = [
    ["navigate", "Navigate"],
    ["pen", "Pen"],
    ["highlighter", "Highlighter"],
    ["text", "Text"],
    ["eraser", "Eraser"],
  ];
  for (const [tool, label] of TOOLS) {
    const node = button(label, icon(tool), () => {
      chooseTool(tool === "navigate" && settings.tool === "navigate" ? lastDrawingTool : tool);
    });
    toolButtons.set(tool, node);
  }

  gap();
  const undo = button("Undo", icon("undo"), () => ink.undo());
  const redo = button("Redo", icon("redo"), () => ink.redo());
  button("Clear slide", icon("clear"), () => {
    if (window.confirm("Clear all ink on this slide?")) ink.clearSlide(readPosition(reveal));
  });

  gap();
  const colorButtons = COLORS.map((color) => {
    const swatch = document.createElement("span");
    swatch.className = "live-swatch";
    swatch.style.background = color;
    const node = button(`Colour ${color}`, swatch, () => chooseColor(color));
    node.dataset.color = color;
    return node;
  });
  function chooseColor(color: string): void {
    settings.color = color;
    for (const node of colorButtons) node.setAttribute("aria-pressed", String(node.dataset.color === color));
  }

  gap();
  const widthButtons = WIDTHS.map((choice) => {
    const dot = document.createElement("span");
    dot.className = "live-weight";
    dot.style.width = dot.style.height = `${4 + choice.width}px`;
    const node = button(`${choice.label} line`, dot, () => chooseWidth(choice));
    node.dataset.width = String(choice.width);
    return node;
  });
  function chooseWidth(choice: (typeof WIDTHS)[number]): void {
    settings.width = choice.width;
    settings.textSize = choice.textSize;
    for (const node of widthButtons) {
      node.setAttribute("aria-pressed", String(node.dataset.width === String(choice.width)));
    }
  }

  bar.append(div("live-spring"));
  button("Previous step", icon("prev"), () => reveal.prev());
  button("Next step", icon("next"), () => reveal.next());
  gap();
  const joinButton = button("Show join code (Q)", icon("qr"), () => toggleScreen("join"));
  const wallButton = button("Show questions (W)", icon("questions"), () => toggleScreen("questions"));
  const panelButton = button("Toggle side panel", icon("panel"), () => {
    root.classList.toggle("live-panel-closed");
    if (!root.classList.contains("live-panel-closed")) setUnread(0);
    reveal.layout();
  });
  const unreadBadge = document.createElement("span");
  unreadBadge.className = "live-badge";
  unreadBadge.hidden = true;
  panelButton.append(unreadBadge);

  let unread = 0;
  function setUnread(value: number): void {
    unread = value;
    unreadBadge.textContent = String(value);
    unreadBadge.hidden = value === 0;
  }

  let screen: Screen = null;
  function showScreen(shown: Screen): void {
    screen = shown;
    join.shown = shown === "join";
    wall.shown = shown === "questions";
    joinButton.setAttribute("aria-pressed", String(shown === "join"));
    wallButton.setAttribute("aria-pressed", String(shown === "questions"));
  }

  function toggleScreen(choice: Exclude<Screen, null>): void {
    const shown = screen === choice ? null : choice;
    showScreen(shown);
    questions.send({ t: "screen", screen: shown });
  }

  // Side panel. Sections stack in a flex column, so another can join them.

  const stateDot = document.createElement("span");
  stateDot.className = "live-dot";
  const stateLabel = document.createElement("span");
  stateLabel.dataset.liveRole = "connection";
  const viewers = document.createElement("span");
  viewers.dataset.liveRole = "viewers";
  viewers.textContent = "0 viewers";
  const timer = document.createElement("button");
  timer.type = "button";
  timer.className = "live-timer";
  timer.title = "Elapsed time. Click to restart.";

  const frame = document.createElement("iframe");
  frame.title = "Next step";
  frame.src = `/controls/${slug}/next`;
  frame.tabIndex = -1;
  const endNote = div("live-end-note", "End of deck");
  endNote.hidden = true;

  const notes = div("live-notes");
  const heading = (text: string) => {
    const node = document.createElement("h2");
    node.className = "live-heading";
    node.textContent = text;
    return node;
  };

  const questionsHeading = heading("Questions");
  const questionList = document.createElement("ul");
  questionList.className = "live-question-list";

  const panel = div(
    "live-panel",
    div("live-status", div("live-connection", stateDot, stateLabel), timer, viewers),
    div("", heading("Next step"), div("live-next-frame", frame, endNote)),
    div("live-questions-section", questionsHeading, questionList),
    div("live-notes-section", heading("Notes"), notes),
  );
  document.body.append(bar, panel);
  reveal.layout();

  // Timer. Restarting belongs to the tab: a reload keeps it, a new tab starts over.

  const TIMER_KEY = `live-timer-${slug}`;
  const readStart = () => {
    try {
      return Number(sessionStorage.getItem(TIMER_KEY)) || undefined;
    } catch {
      return undefined;
    }
  };
  const writeStart = (value: number) => {
    try {
      sessionStorage.setItem(TIMER_KEY, String(value));
    } catch {
      // Private mode: the timer simply restarts on reload.
    }
  };
  let startedAt = readStart() ?? Date.now();
  writeStart(startedAt);
  const tick = () => {
    timer.textContent = formatElapsed(Date.now() - startedAt);
  };
  timer.addEventListener("click", () => {
    startedAt = Date.now();
    writeStart(startedAt);
    tick();
    timer.blur();
  });
  tick();
  setInterval(tick, 1000);

  // Notes come from the deck, which only the owner can upload.

  function showNotes(): void {
    const current = reveal.getCurrentSlide();
    const aside = current?.querySelector("aside.notes");
    const attribute = current?.getAttribute("data-notes");
    if (aside) {
      notes.replaceChildren(...[...aside.childNodes].map((node) => node.cloneNode(true)));
    } else if (attribute) {
      notes.textContent = attribute;
    } else {
      const empty = document.createElement("span");
      empty.className = "live-empty";
      empty.textContent = "No notes on this slide.";
      notes.replaceChildren(empty);
    }
  }

  // Questions

  function questionAction(label: string, onClick: () => void): HTMLButtonElement {
    const node = document.createElement("button");
    node.type = "button";
    node.textContent = label;
    node.addEventListener("click", () => {
      onClick();
      node.blur();
    });
    return node;
  }

  function presenterRow(question: Question): HTMLLIElement {
    const { h, v } = question.slide;
    // The number the deck itself prints, which counts vertical slides too.
    const number = reveal.getSlides().indexOf(reveal.getSlide(h, v)!) + 1;
    const votes = document.createElement("span");
    votes.className = "live-votes";
    votes.textContent = `▲ ${question.votes}`;
    const answered = questionAction("Answered", () => {
      questions.send({ t: "question.answer", id: question.id, answered: !question.answered });
    });
    answered.setAttribute("aria-pressed", String(question.answered));
    return questionRow(
      question,
      votes,
      questionAction(`Slide ${number}`, () => reveal.slide(h, v)),
      answered,
      questionAction("Remove", () => questions.send({ t: "question.remove", id: question.id })),
    );
  }

  function showQuestions(): void {
    wall.show(questions.sorted());
    questionsHeading.textContent = questions.open ? `Questions (${questions.open})` : "Questions";
    const rows = questions.sorted().map(presenterRow);
    if (rows.length) {
      questionList.replaceChildren(...rows);
    } else {
      const empty = document.createElement("li");
      empty.className = "live-empty";
      empty.textContent = "No questions yet.";
      questionList.replaceChildren(empty);
    }
  }
  questions.onChange = showQuestions;
  questions.onAdded = () => {
    if (root.classList.contains("live-panel-closed")) setUnread(unread + 1);
  };

  // Next-step preview

  let previewReady = false;
  function updatePreview(): void {
    if (!previewReady) return;
    const request: PreviewRequest = {
      live: "preview",
      position: readPosition(reveal),
      items: overlay.allItems(),
    };
    frame.contentWindow?.postMessage(request, location.origin);
  }
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
    const reply = event.data as PreviewReply;
    if (reply?.live === "preview-ready") {
      previewReady = true;
      updatePreview();
    } else if (reply?.live === "preview-shown") {
      endNote.hidden = !reply.atEnd;
    }
  });

  // State

  function refreshButtons(): void {
    undo.disabled = !ink.canUndo;
    redo.disabled = !ink.canRedo;
    updatePreview();
  }
  ink.onChange = refreshButtons;

  function move(position: Position): void {
    known = position;
    if (!samePosition(readPosition(reveal), position)) reveal.slide(position.h, position.v, position.f);
  }

  function onNavigated(): void {
    showNotes();
    updatePreview();
    const position = readPosition(reveal);
    if (known && samePosition(position, known)) return;
    known = position;
    unconfirmedMove = uuid();
    connection.send({ t: "position", m: unconfirmedMove, position });
  }

  function onState(state: ConnectionState): void {
    root.dataset.liveState = state;
    root.classList.toggle("live-offline", state !== "connected");
    stateLabel.textContent = STATE_LABEL[state];
    if (state !== "connected") {
      ink.onDisconnect();
      questions.onDisconnect();
    }
  }

  function onMessage(message: ServerMessage): void {
    if (questions.onMessage(message)) return;
    switch (message.t) {
      case "snapshot":
        if (message.role !== "presenter") return;
        ink.onSnapshot(message.items, message.live, pen.drawingId);
        questions.onSnapshot(message.questions);
        showScreen(message.screen);
        // A move the server never confirmed, made during a drop, goes out now.
        // Otherwise the server decides.
        if (unconfirmedMove) connection.send({ t: "position", m: unconfirmedMove, position: readPosition(reveal) });
        else move(message.position);
        break;
      case "ack":
        if (message.m === unconfirmedMove) unconfirmedMove = undefined;
        else ink.onMessage(message);
        break;
      case "position":
        move(message.position);
        break;
      case "screen":
        showScreen(message.screen);
        break;
      case "presence":
        viewers.textContent = `${message.viewers} viewer${message.viewers === 1 ? "" : "s"}`;
        break;
      case "session.removed":
        stateLabel.textContent = STATE_LABEL.over;
        break;
      default:
        ink.onMessage(message);
    }
  }

  // Undo keys. Reveal has no binding for these.
  document.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (document.activeElement instanceof HTMLTextAreaElement) return;
    const key = event.key.toLowerCase();
    if (key === "z") {
      event.preventDefault();
      if (event.shiftKey) ink.redo();
      else ink.undo();
    } else if (key === "y") {
      event.preventDefault();
      ink.redo();
    }
  });

  // Q and W raise the full screens. Reveal has no binding for either.
  document.addEventListener("keydown", (event) => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (document.activeElement instanceof HTMLTextAreaElement) return;
    const key = event.key.toLowerCase();
    if (key === "q") toggleScreen("join");
    else if (key === "w") toggleScreen("questions");
  });

  chooseTool("navigate");
  chooseColor(settings.color);
  chooseWidth(WIDTHS[0]!);
  refreshButtons();
  showNotes();
  showQuestions();
  onNavigation(reveal, onNavigated);
  connection.start();
}
