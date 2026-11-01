import type { PresenterMessage, Question, ServerMessage, Slide, ViewerQuestionMessage } from "../shared/protocol.ts";
import type { Connection } from "./connection.ts";
import { uuid } from "./ink.ts";

type Sendable =
  | ViewerQuestionMessage
  | Extract<PresenterMessage, { t: "question.answer" | "question.remove" | "join" }>;
type Draft<M> = M extends unknown ? Omit<M, "m"> : never;

export type Rejected = Extract<ServerMessage, { t: "question.rejected" }>["reason"];

interface Ballot {
  voter: string;
  voted: string[];
}

/** The browser's voter id and votes. Private mode keeps them for this page load only. */
function loadBallot(key: string): Ballot {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? "null") as Ballot | null;
    if (stored?.voter) return stored;
  } catch {
    // Fall through to a new ballot.
  }
  return { voter: uuid(), voted: [] };
}

function saveBallot(key: string, ballot: Ballot): void {
  try {
    localStorage.setItem(key, JSON.stringify(ballot));
  } catch {
    // Private mode. See loadBallot.
  }
}

/**
 * The session's questions, shared by viewer and presenter. Messages stay in the
 * outbox until acknowledged and are resent after a reconnect, which is safe
 * because the server treats each one as idempotent.
 */
export class Questions {
  private readonly list = new Map<string, Question>();
  private readonly outbox = new Map<string, Sendable>();
  private readonly ballotKey: string;
  private readonly ballot: Ballot;
  private readonly voted: Set<string>;
  private ready = false;
  onChange: () => void = () => {};
  /** A question arrived from someone else, after the first snapshot. */
  onAdded: () => void = () => {};
  /** The server refused a question. `text` is what the sender wrote, to give back. */
  onRejected: (reason: Rejected, text?: string) => void = () => {};

  constructor(
    private readonly connection: Connection,
    slug: string,
  ) {
    this.ballotKey = `live-votes-${slug}`;
    this.ballot = loadBallot(this.ballotKey);
    this.voted = new Set(this.ballot.voted);
  }

  /** Unanswered first, then most votes. Ties keep the order they were asked in. */
  sorted(): Question[] {
    return [...this.list.values()].sort(
      (a, b) => Number(a.answered) - Number(b.answered) || b.votes - a.votes,
    );
  }

  get open(): number {
    let count = 0;
    for (const question of this.list.values()) if (!question.answered) count += 1;
    return count;
  }

  hasVoted(id: string): boolean {
    return this.voted.has(id);
  }

  send(draft: Draft<Sendable>): void {
    const message = { ...draft, m: uuid() } as Sendable;
    this.outbox.set(message.m, message);
    if (this.ready) this.connection.send(message);
  }

  private setVoted(id: string, on: boolean): void {
    if (on) this.voted.add(id);
    else this.voted.delete(id);
    this.ballot.voted = [...this.voted];
    saveBallot(this.ballotKey, this.ballot);
  }

  /** Viewer: the question shows at once, with the asker's own vote already counted. */
  ask(text: string, slide: Slide): void {
    const question = { id: uuid(), text, slide };
    this.list.set(question.id, { ...question, votes: 1, answered: false });
    this.setVoted(question.id, true);
    this.send({ t: "question.ask", question, voter: this.ballot.voter });
    this.onChange();
  }

  /** Viewer: flips this browser's vote. The count follows from the server. */
  vote(id: string): void {
    const on = !this.voted.has(id);
    this.setVoted(id, on);
    this.send({ t: "question.vote", id, voter: this.ballot.voter, on });
    this.onChange();
  }

  /** Takes the server's list, puts questions it hasn't confirmed on top and resends the outbox. */
  onSnapshot(questions: Question[]): void {
    this.list.clear();
    for (const question of questions) this.list.set(question.id, question);
    for (const message of this.outbox.values()) {
      if (message.t === "question.ask" && !this.list.has(message.question.id)) {
        this.list.set(message.question.id, { ...message.question, votes: 1, answered: false });
      }
    }
    this.ready = true;
    for (const message of this.outbox.values()) this.connection.send(message);
    this.onChange();
  }

  onDisconnect(): void {
    this.ready = false;
  }

  /** Returns true when the message was one of ours. */
  onMessage(message: ServerMessage): boolean {
    switch (message.t) {
      case "question.add": {
        const known = this.list.has(message.question.id);
        this.list.set(message.question.id, message.question);
        if (!known) this.onAdded();
        break;
      }
      case "question.update":
        this.list.set(message.question.id, message.question);
        break;
      case "question.remove":
        this.list.delete(message.id);
        break;
      case "question.rejected":
        this.reject(message.m, message.reason);
        break;
      case "ack":
        return this.outbox.delete(message.m);
      default:
        return false;
    }
    this.onChange();
    return true;
  }

  private reject(m: string, reason: Rejected): void {
    const message = this.outbox.get(m);
    this.outbox.delete(m);
    if (message?.t === "question.ask") {
      this.list.delete(message.question.id);
      this.setVoted(message.question.id, false);
      this.onRejected(reason, message.question.text);
    } else {
      if (message?.t === "question.vote") this.setVoted(message.id, !message.on);
      this.onRejected(reason);
    }
  }
}

/** One question: its text, then whatever the page lets you do with it. */
export function questionRow(question: Question, ...actions: Node[]): HTMLLIElement {
  const row = document.createElement("li");
  row.className = "live-question";
  row.classList.toggle("live-answered", question.answered);
  row.dataset.questionId = question.id;
  const text = document.createElement("p");
  text.className = "live-question-text";
  text.textContent = question.text;
  const bar = document.createElement("div");
  bar.className = "live-question-actions";
  bar.append(...actions);
  row.append(text, bar);
  return row;
}
