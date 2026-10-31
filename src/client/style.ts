import css from "./live.css";

export function addStyles(): void {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
}
