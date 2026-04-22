import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./index.css";

const stored = localStorage.getItem("cove:theme");
const initialTheme =
  stored === "light" || stored === "dark"
    ? stored
    : window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
document.documentElement.classList.toggle("dark", initialTheme === "dark");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
