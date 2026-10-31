// Injected into every served deck. The URL decides what this page is.
import { startControls } from "./controls.ts";
import { startPreview } from "./preview.ts";
import { whenReady } from "./reveal.ts";
import { startViewer } from "./viewer.ts";

const reveal = window.Reveal;
const [, first, second, third] = location.pathname.split("/");

whenReady(reveal, () => {
  if (reveal.isPrintView?.()) return;
  // The server owns the position, so the URL hash must not compete with it.
  reveal.configure({ hash: false, history: false, respondToHashChanges: false });
  if (first === "controls" && second && third === "next") startPreview(reveal);
  else if (first === "controls" && second) startControls(reveal, second);
  else if (first) startViewer(reveal, first);
});
