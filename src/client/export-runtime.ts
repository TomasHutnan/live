// Inlined into the annotated export. No WebSocket and no server calls: it reads
// the embedded items and draws them with the same overlay as the live client.
import type { Item } from "../shared/protocol.ts";
import { Overlay } from "./overlay.ts";
import { keepSlideView, whenReady } from "./reveal.ts";

const reveal = window.Reveal;
const data = JSON.parse(document.getElementById("live-data")!.textContent!) as { items: Item[] };

whenReady(reveal, () => {
  if (reveal.isPrintView?.()) return;
  keepSlideView(reveal);
  new Overlay(reveal).setItems(data.items);
});
