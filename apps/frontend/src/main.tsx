import "@fontsource/manrope/400.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/700.css";
import "@fontsource/newsreader/400.css";
import "@fontsource/newsreader/600.css";
import "@fontsource/newsreader/700.css";

import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { TooltipProvider } from "./components/ui/tooltip";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </React.StrictMode>,
);
