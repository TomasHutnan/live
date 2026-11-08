const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// The homepage is for students first, so Slovak or Czech browsers get Slovak.
const HOME_STRINGS = {
  sk: {
    lang: "sk",
    lead: "Prezentácie zo seminárov, naživo vo vašom zariadení.",
    body: "Slajdy sa posúvajú s prednášajúcim a vidíte všetko, čo na ne kreslí. Môžete sa vrátiť na predchádzajúci slajd a anonymne sa pýtať.",
    label: "Kód seminára",
    join: "Pripojiť sa",
    missing: (code: string) => `Seminár „${code}“ neexistuje. Skontrolujte kód na tabuli.`,
    about: "Ako to funguje",
  },
  en: {
    lang: "en",
    lead: "Seminar slides, live on your own device.",
    body: "The slides move with the presenter and show everything drawn on them. You can look back at earlier slides and ask questions anonymously.",
    label: "Session code",
    join: "Join",
    missing: (code: string) => `There is no session called “${code}”. Check the code on the board.`,
    about: "How it works",
  },
};

export function homeLanguage(acceptLanguage: string | undefined): keyof typeof HOME_STRINGS {
  return /^\s*(sk|cs)\b/i.test(acceptLanguage ?? "") ? "sk" : "en";
}

export function homePage(options: { lang: keyof typeof HOME_STRINGS; aboutUrl?: string; missing?: string }): string {
  const text = HOME_STRINGS[options.lang];
  const error = options.missing === undefined ? "" : `<p class="error" role="alert">${escapeHtml(text.missing(options.missing))}</p>`;
  const value = options.missing === undefined ? "" : ` value="${escapeHtml(options.missing)}"`;
  const about = options.aboutUrl ? `<footer><a href="${escapeHtml(options.aboutUrl)}">${text.about} →</a></footer>` : "";
  return `<!doctype html>
<html lang="${text.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Live</title>
<style>
:root { --bg: #f7f6f3; --fg: #1b1b1b; --muted: #5d5d5a; --card: #fff; --line: #d9d7d0; --accent: #1f5fbf; --error: #b3261e; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #151515; --fg: #ececea; --muted: #a2a29e; --card: #1f1f1f; --line: #3a3a38; --accent: #7aa7ec; --error: #f2877d; }
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; grid-template-columns: minmax(0, 30rem); place-content: center; padding: 24px 16px; background: var(--bg); color: var(--fg);
  font: 17px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { min-width: 0; }
h1 { margin: 0 0 .25em; font-size: 2.4rem; letter-spacing: -.02em; display: flex; align-items: center; gap: .4em; }
h1::before { content: ""; width: .32em; height: .32em; border-radius: 50%; background: #4cc26c; }
.lead { margin: 0 0 .5em; font-size: 1.2rem; }
.body { margin: 0 0 2em; color: var(--muted); }
form { display: grid; grid-template-columns: minmax(0, 1fr); gap: .5em; }
label { font-weight: 600; }
.row { display: flex; gap: .5em; }
input { flex: 1; min-width: 0; font: inherit; font-size: 1.3rem; padding: .5em .7em; border: 1px solid var(--line); border-radius: 8px;
  background: var(--card); color: var(--fg); }
input:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: transparent; }
button { font: inherit; font-weight: 600; padding: 0 1.2em; border: 0; border-radius: 8px; background: var(--accent); color: var(--bg); cursor: pointer; }
.error { margin: .25em 0 0; color: var(--error); }
footer { margin-top: 2.5em; }
a { color: var(--accent); }
</style>
</head>
<body>
<main>
<h1>Live</h1>
<p class="lead">${text.lead}</p>
<p class="body">${text.body}</p>
<form method="get" action="/">
<label for="code">${text.label}</label>
<div class="row">
<input id="code" name="code" placeholder="ib111" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="60" required autofocus${value}>
<button type="submit">${text.join}</button>
</div>
${error}
</form>
${about}
</main>
</body>
</html>
`;
}

export function dashboardPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>live — dashboard</title>
<script src="/assets/dashboard.js" defer></script>
</head>
<body><main id="app"></main></body>
</html>
`;
}

export function notFoundPage(): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Not found</title></head>
<body><h1>Not found</h1><p>There is no session at this address.</p></body>
</html>
`;
}
