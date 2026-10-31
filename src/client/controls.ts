import type { Position, ServerMessage } from "../shared/protocol.ts";
import { Connection } from "./connection.ts";
import { onNavigation, readPosition, type RevealApi, samePosition } from "./reveal.ts";
import { addStyles } from "./style.ts";

export function startControls(reveal: RevealApi, slug: string): void {
  addStyles();
  const root = document.documentElement;
  let known: Position | undefined;
  let moved = false;

  const connection = new Connection({
    slug,
    fetchToken: async () => {
      const response = await fetch(`/controls/${slug}/token`, { method: "POST" });
      if (!response.ok) throw new Error(`token: ${response.status}`);
      return ((await response.json()) as { token: string }).token;
    },
    onMessage,
    onState: (state) => {
      root.dataset.liveState = state;
    },
  });

  function move(position: Position): void {
    known = position;
    if (!samePosition(readPosition(reveal), position)) reveal.slide(position.h, position.v, position.f);
  }

  function report(): void {
    const position = readPosition(reveal);
    if (known && samePosition(position, known)) return;
    known = position;
    moved = !connection.send({ t: "position", position });
  }

  function onMessage(message: ServerMessage): void {
    switch (message.t) {
      case "snapshot":
        if (message.role !== "presenter") return;
        // Moves made during a drop reach the server now. Otherwise the server decides.
        if (moved) {
          moved = false;
          connection.send({ t: "position", position: readPosition(reveal) });
        } else {
          move(message.position);
        }
        break;
      case "position":
        move(message.position);
        break;
    }
  }

  onNavigation(reveal, report);
  connection.start();
}
