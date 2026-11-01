import { onNavigation, type RevealApi } from "./reveal.ts";

/**
 * The join code. It sits over the deck, not in it, so slide indices, stored ink
 * and the export never see it. A card shows by itself on the first slide, and
 * the presenter can raise it full screen on any slide. It sits inside the reveal
 * element so that it fits the slide area on the controls page too.
 */
export class JoinCode {
  private readonly root = document.createElement("div");
  private full = false;

  constructor(
    private readonly reveal: RevealApi,
    slug: string,
    caption: string,
  ) {
    this.root.className = "live-join";
    const image = document.createElement("img");
    image.src = `/${slug}/qr.svg`;
    image.alt = "";
    image.loading = "lazy"; // Hidden on phones, which then never fetch it.
    const heading = document.createElement("strong");
    heading.textContent = caption;
    const link = document.createElement("span");
    link.textContent = `${location.host}/${slug}`;
    const words = document.createElement("div");
    words.className = "live-join-words";
    words.append(heading, link);
    const card = document.createElement("div");
    card.className = "live-join-card";
    card.append(image, words);
    this.root.append(card);
    reveal.getRevealElement().append(this.root);
    onNavigation(reveal, () => this.sync());
    this.sync();
  }

  get shown(): boolean {
    return this.full;
  }

  set shown(value: boolean) {
    this.full = value;
    this.sync();
  }

  private sync(): void {
    const { h, v } = this.reveal.getIndices();
    this.root.classList.toggle("live-join-full", this.full);
    this.root.hidden = !this.full && (h !== 0 || v !== 0);
  }
}
