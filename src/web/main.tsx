import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import { LanguageProvider } from "./i18n.tsx";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("index.html is missing #root");

// Deliberately not wrapped in StrictMode: its double-invoked effects would open
// two sockets per tab in development.
createRoot(container).render(<LanguageProvider><App /></LanguageProvider>);
