import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.js";
import { initPromptMaster } from "./lib/prompt-master-init.js";
import "./styles/themes.css";

const root = document.getElementById("root");
if (!root) throw new Error("No #root element found");

// Fire-and-forget: optimization wires up in the background once the user's
// Anthropic settings are loaded. Never throws -- see initPromptMaster.
void initPromptMaster();

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
