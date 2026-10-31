import type { Position, ServerMessage } from "../shared/protocol.ts";
import { Connection } from "./connection.ts";
import { onNavigation, readPosition, type RevealApi, samePosition } from "./reveal.ts";
import { addStyles } from "./style.ts";

// The audience reads the deck's language. Unknown languages get English.
const STRINGS = {
  sk: {
    live: "Naživo",
    browsing: "Prezeráš sám",
    browse: "Prechádzať",
    back: "Späť na živo",
    offline: "Spojenie je prerušené. Pripájam sa znova…",
    over: "Prezentácia sa skončila.",
  },
  en: {
    live: "Live",
    browsing: "Browsing",
    browse: "Browse",
    back: "Back to live",
    offline: "Connection lost. Reconnecting…",
    over: "This session is over.",
  },
};

export function startViewer(reveal: RevealApi, slug: string): void {
  addStyles();
  const text = document.documentElement.lang.startsWith("sk") ? STRINGS.sk : STRINGS.en;
  const root = document.documentElement;

  let live: Position | undefined;
  let following = true;

  const pill = document.createElement("div");
  pill.className = "live-pill";
  const dot = document.createElement("span");
  dot.className = "live-dot";
  const label = document.createElement("span");
  const toggle = document.createElement("button");
  toggle.type = "button";
  pill.append(dot, label, toggle);

  const banner = document.createElement("div");
  banner.className = "live-banner";
  banner.setAttribute("role", "status");
  banner.textContent = text.offline;
  banner.hidden = true;

  const over = document.createElement("div");
  over.className = "live-over";
  over.textContent = text.over;
  over.hidden = true;
  document.body.append(pill, banner, over);

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

  // Anything that moves a following deck, a link in a slide for example, moves it back.
  onNavigation(reveal, follow);

  function onMessage(message: ServerMessage): void {
    switch (message.t) {
      case "snapshot":
        live = message.position;
        follow();
        break;
      case "position":
        live = message.position;
        follow();
        break;
      case "session.removed":
        over.hidden = false;
        break;
    }
  }

  reveal.configure({ overview: false, help: false, jumpToSlide: false });
  setFollowing(true);

  new Connection({
    slug,
    onMessage,
    onState: (state) => {
      root.dataset.liveState = state;
      root.classList.toggle("live-offline", state === "reconnecting");
      banner.hidden = state !== "reconnecting";
    },
  }).start();
}
