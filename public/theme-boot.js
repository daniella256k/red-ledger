// Applies the theme main.ts passes in the page URL (?theme=dark) before first
// paint, so a dark-mode start never shows the light theme. A separate file
// because the CSP allows no inline scripts. src/hooks/useDarkMode.ts reads it.
if (new URLSearchParams(window.location.search).get('theme') === 'dark') {
  document.documentElement.setAttribute('data-theme', 'red-ledger-dark')
}
