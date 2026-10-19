import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme, loadStoredTheme, systemTheme } from "./theme";
import "./styles/tokens.css";
import "./styles/app.css";

applyTheme(loadStoredTheme() ?? systemTheme());

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");
createRoot(container).render(<App />);
