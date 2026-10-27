import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { QueryClientProvider } from "@tanstack/react-query";
import { SocketProvider } from "./context/SocketContext";
import { ActionTrackerBridge } from "./context/ActionTracker";
import { queryClient } from "./lib/queryClient";
import { registerPwa } from "./pwa";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SocketProvider>
        <ActionTrackerBridge />
        <App />
      </SocketProvider>
    </QueryClientProvider>
  </StrictMode>
);

registerPwa();
