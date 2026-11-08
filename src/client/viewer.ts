import { MAX_QUESTION_TEXT, type Position, type Question, type Screen, type ServerMessage } from "../shared/protocol.ts";
import { Connection } from "./connection.ts";
import { JoinCode } from "./join.ts";
import { applyInkMessage, Overlay } from "./overlay.ts";
import { QuestionScreen, questionRow, Questions, type Rejected } from "./questions.ts";
import { onNavigation, readPosition, type RevealApi, samePosition } from "./reveal.ts";
import { addStyles } from "./style.ts";

// The audience reads the deck's language. Unknown languages get English.
const STRINGS = {
  sk: {
    live: "Naživo",
    browsing: "Voľné prezeranie",
    browse: "Prechádzať",
    back: "Späť na živo",
    offline: "Spojenie je prerušené. Pripájam sa znova…",
    over: "Prezentácia sa skončila.",
    join: "Pripojte sa a pýtajte sa",
    questions: "Otázky",
    placeholder: "Napíšte otázku…",
    send: "Odoslať",
    close: "Zavrieť",
    noQuestions: "Zatiaľ žiadne otázky.",
    moreQuestions: "Ďalšie otázky:",
    answered: "Zodpovedané",
    vote: "Podporiť otázku",
    rate: "Posielate príliš rýchlo. Skúste to o chvíľu.",
    full: "Ďalšie otázky sa už nedajú pridať.",
    fullscreen: "Celá obrazovka",
  },
  en: {
    live: "Live",
    browsing: "Browsing",
    browse: "Browse",
    back: "Back to live",
    offline: "Connection lost. Reconnecting…",
    over: "This session is over.",
    join: "Join and ask questions",
    questions: "Questions",
    placeholder: "Write a question…",
    send: "Send",
    close: "Close",
    noQuestions: "No questions yet.",
    moreQuestions: "More questions:",
    answered: "Answered",
    vote: "Support this question",
    rate: "You're sending too fast. Try again in a moment.",
    full: "No more questions can be added.",
    fullscreen: "Full screen",
  },
};

export const audienceText = () => (document.documentElement.lang.startsWith("sk") ? STRINGS.sk : STRINGS.en);

export const questionScreen = (reveal: RevealApi) => {
  const text = audienceText();
  return new QuestionScreen(reveal.getRevealElement(), {
    heading: text.questions,
    empty: text.noQuestions,
    more: text.moreQuestions,
  });
};

/** Four corners, drawn rather than typed: no system font has a dependable glyph for it. */
function fullscreenIcon(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M1 5V1h4M11 1h4v4M15 11v4h-4M5 15H1v-4");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  svg.append(path);
  return svg;
}

export function startViewer(reveal: RevealApi, slug: string): void {
  addStyles();
  const text = audienceText();
  const root = document.documentElement;
  root.classList.add("live-viewer");

  const overlay = new Overlay(reveal);
  let live: Position | undefined;
  let following = true;

  const pill = document.createElement("div");
  pill.className = "live-pill";
  const dot = document.createElement("span");
  dot.className = "live-dot";
  const label = document.createElement("span");
  label.className = "live-pill-label";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "live-browse";
  const askLabel = document.createElement("span");
  askLabel.textContent = text.questions;
  const askCount = document.createElement("span");
  askCount.className = "live-count";
  const ask = document.createElement("button");
  ask.type = "button";
  ask.className = "live-ask";
  ask.append(askLabel, askCount);
  // iPhone Safari has no Fullscreen API, and nobody projects from a phone.
  const fullscreen = document.createElement("button");
  fullscreen.type = "button";
  fullscreen.className = "live-fullscreen-button";
  fullscreen.append(fullscreenIcon());
  fullscreen.title = text.fullscreen;
  fullscreen.setAttribute("aria-label", text.fullscreen);
  fullscreen.hidden = !document.fullscreenEnabled;
  pill.append(dot, label, ask, toggle, fullscreen);

  const banner = document.createElement("div");
  banner.className = "live-banner";
  banner.setAttribute("role", "status");
  banner.textContent = text.offline;
  banner.hidden = true;

  const over = document.createElement("div");
  over.className = "live-over";
  over.textContent = text.over;
  over.hidden = true;

  const sheetTitle = document.createElement("h2");
  sheetTitle.textContent = text.questions;
  const closeSheet = document.createElement("button");
  closeSheet.type = "button";
  closeSheet.textContent = text.close;
  const sheetHead = document.createElement("header");
  sheetHead.append(sheetTitle, closeSheet);
  const list = document.createElement("ul");
  list.className = "live-question-list";
  const field = document.createElement("textarea");
  field.placeholder = text.placeholder;
  field.setAttribute("aria-label", text.placeholder);
  field.maxLength = MAX_QUESTION_TEXT;
  field.rows = 2;
  const send = document.createElement("button");
  send.type = "submit";
  send.textContent = text.send;
  const form = document.createElement("form");
  form.append(field, send);
  const note = document.createElement("p");
  note.className = "live-sheet-note";
  note.setAttribute("role", "status");
  const sheet = document.createElement("aside");
  sheet.className = "live-sheet";
  sheet.hidden = true;
  sheet.append(sheetHead, list, note, form);

  document.body.append(pill, banner, over, sheet);

  function follow(): void {
    if (live && following && !samePosition(readPosition(reveal), live)) reveal.slide(live.h, live.v, live.f);
  }

  function setFollowing(value: boolean): void {
    following = value;
    root.classList.toggle("live-following", value);
    root.classList.toggle("live-browsing", !value);
    label.textContent = value ? text.live : text.browsing;
    toggle.textContent = value ? text.browse : text.back;
    reveal.configure({ keyboard: !value, touch: !value });
    follow();
  }

  toggle.addEventListener("click", () => {
    setFollowing(!following);
    toggle.blur(); // Space and arrows belong to reveal, not to this button.
  });

  function setSheetOpen(open: boolean): void {
    sheet.hidden = !open;
    ask.blur();
    closeSheet.blur();
    if (!open) field.blur(); // Keys go back to reveal.
  }
  ask.addEventListener("click", () => setSheetOpen(!!sheet.hidden));
  closeSheet.addEventListener("click", () => setSheetOpen(false));

  function voteButton(question: Question): HTMLButtonElement {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "live-vote";
    node.textContent = `▲ ${question.votes}`;
    node.title = text.vote;
    node.setAttribute("aria-label", `${text.vote}: ${question.votes}`);
    node.setAttribute("aria-pressed", String(questions.hasVoted(question.id)));
    node.addEventListener("click", () => {
      note.textContent = "";
      questions.vote(question.id);
    });
    return node;
  }

  function showQuestions(): void {
    wall.show(questions.sorted());
    askCount.textContent = questions.open ? String(questions.open) : "";
    const rows = questions.sorted().map((question) => {
      if (!question.answered) return questionRow(question, voteButton(question));
      const tag = document.createElement("span");
      tag.textContent = `${text.answered} · ▲ ${question.votes}`;
      return questionRow(question, tag);
    });
    if (rows.length) {
      list.replaceChildren(...rows);
    } else {
      const empty = document.createElement("li");
      empty.className = "live-empty";
      empty.textContent = text.noQuestions;
      list.replaceChildren(empty);
    }
  }

  function submit(): void {
    const question = field.value.trim();
    if (!question) return;
    field.value = "";
    note.textContent = "";
    const { h, v } = readPosition(reveal);
    questions.ask(question, { h, v });
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit();
  });
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });

  // Anything that moves a following deck, a link in a slide for example, moves it back.
  onNavigation(reveal, follow);

  function onMessage(message: ServerMessage): void {
    switch (message.t) {
      case "snapshot":
        live = message.position;
        overlay.setItems(message.items);
        overlay.setLive(message.live);
        questions.onSnapshot(message.questions);
        showScreen(message.screen);
        follow();
        break;
      case "position":
        live = message.position;
        follow();
        break;
      case "screen":
        showScreen(message.screen);
        break;
      case "session.removed":
        over.hidden = false;
        break;
      default:
        if (!questions.onMessage(message)) applyInkMessage(overlay, message);
    }
  }

  reveal.configure({ overview: false, help: false, jumpToSlide: false });
  setFollowing(true);

  const connection = new Connection({
    slug,
    onMessage,
    onState: (state) => {
      root.dataset.liveState = state;
      root.classList.toggle("live-offline", state === "reconnecting");
      banner.hidden = state !== "reconnecting";
      if (state !== "connected") questions.onDisconnect();
    },
  });
  const join = new JoinCode(reveal, slug, text.join);
  const wall = questionScreen(reveal);
  function showScreen(shown: Screen): void {
    join.shown = shown === "join";
    wall.shown = shown === "questions";
  }

  // A projected page shows the deck and nothing else, but only once someone asks
  // for full screen: with the button, or reveal's F key. Esc brings the bar back.
  // Reconnect and session-over messages still appear: those need the presenter.
  fullscreen.addEventListener("click", () => {
    fullscreen.blur();
    void root.requestFullscreen().catch(() => {});
  });
  const syncFullscreen = () => root.classList.toggle("live-fullscreen", !!document.fullscreenElement);
  document.addEventListener("fullscreenchange", syncFullscreen);
  syncFullscreen();

  const questions = new Questions(connection, slug);
  const refused: Record<Rejected, string> = { rate: text.rate, full: text.full };
  questions.onChange = showQuestions;
  questions.onRejected = (reason, question) => {
    note.textContent = refused[reason];
    if (question && !field.value) field.value = question;
  };
  showQuestions();
  connection.start();
}
