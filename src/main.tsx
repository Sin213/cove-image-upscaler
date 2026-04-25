import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./index.css";

// Theme class is applied synchronously by an inline script in index.html
// (before paint) to prevent a white flash on launch. Nothing to do here.

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
