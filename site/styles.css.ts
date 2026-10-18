/* The site's whole stylesheet, as a vanilla-extract module: a theme contract for the accent colour, then one globalStyle rule per element selector the generator's HTML uses. The generator emits plain semantic HTML with no class names of its own, so global styling is the whole surface and nothing has to thread generated class names into the page templates. The module is imported for its side effects by the client entry, so its CSS is compiled into the emitted stylesheet at build time and nothing runs in the browser. */

import { createGlobalTheme, globalStyle } from "@vanilla-extract/css";

createGlobalTheme(":root", {
  accent: "#1f4e79",
});

globalStyle(":root", {
  colorScheme: "light dark",
  fontFamily: "system-ui, sans-serif",
  lineHeight: 1.5,
});

globalStyle("body", {
  margin: "0 auto",
  maxWidth: "72rem",
  padding: "0 1rem",
});

globalStyle("header", {
  display: "flex",
  flexWrap: "wrap",
  gap: "1rem",
  alignItems: "baseline",
  padding: "1rem 0",
  borderBottom: "1px solid currentColor",
});

globalStyle("header .home", {
  fontWeight: "bold",
  fontSize: "1.25rem",
  color: "var(--accent)",
  textDecoration: "none",
});

globalStyle("nav", {
  display: "flex",
  gap: "1rem",
  flexWrap: "wrap",
});

globalStyle("footer", {
  margin: "2rem 0",
  fontSize: "0.875rem",
  opacity: 0.8,
});

globalStyle("table", {
  borderCollapse: "collapse",
  width: "100%",
  margin: "0.5rem 0 1.5rem",
});

globalStyle("th, td", {
  textAlign: "left",
  padding: "0.25rem 0.5rem",
  borderBottom: "1px solid rgb(128 128 128 / 30%)",
  verticalAlign: "top",
  overflowWrap: "anywhere",
});

globalStyle("table.facts th", {
  width: "12rem",
});

globalStyle("form.search", {
  display: "flex",
  flexWrap: "wrap",
  gap: "1rem",
  alignItems: "end",
  margin: "1rem 0",
});

globalStyle(".command code", {
  padding: "0.25rem 0.5rem",
  border: "1px solid rgb(128 128 128 / 50%)",
  borderRadius: "0.25rem",
});

globalStyle(".warning", {
  borderLeft: "4px solid #b35900",
  paddingLeft: "0.75rem",
});

/* The interactive listing replaces the static table once the island mounts; until then it must hold no space, so the mount is hidden by the stylesheet itself rather than an inline style the no-JS page would also carry. */
globalStyle("#island-root", {
  display: "none",
});

globalStyle("#island-root.island-live", {
  display: "block",
});

globalStyle(".island-hidden", {
  display: "none",
});
