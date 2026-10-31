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
