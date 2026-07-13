if (import.meta.env.DEV) {
  void import("react-grab");
  void import("react-scan");
}

import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";

ReactDOM.createRoot(globalThis.document.getElementById("root") as globalThis.HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
