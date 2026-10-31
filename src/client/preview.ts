import type { Item, Position } from "../shared/protocol.ts";
import { Overlay } from "./overlay.ts";
import { readPosition, type RevealApi, samePosition } from "./reveal.ts";

export interface PreviewRequest {
  live: "preview";
  position: Position;
  items: Item[];
}

export interface PreviewReply {
  live: "preview-ready" | "preview-shown";
  atEnd?: boolean;
}

/**
 * Read-only deck for the next-step preview. Reveal itself works out the next
 * step: the frame goes to the presenter's position and calls next().
 */
export function startPreview(reveal: RevealApi): void {
  reveal.configure({ keyboard: false, touch: false, overview: false, help: false, hideInactiveCursor: false });
  document.querySelector(".slide-menu-button")?.remove();
  const overlay = new Overlay(reveal);
  const parentWindow = window.parent;

  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.source !== parentWindow) return;
    const request = event.data as PreviewRequest;
    if (request?.live !== "preview") return;
    const { h, v, f } = request.position;
    reveal.slide(h, v, f);
    reveal.next();
    overlay.setItems(request.items);
    const reply: PreviewReply = { live: "preview-shown", atEnd: samePosition(readPosition(reveal), request.position) };
    parentWindow.postMessage(reply, location.origin);
  });

  const ready: PreviewReply = { live: "preview-ready" };
  parentWindow.postMessage(ready, location.origin);
}
