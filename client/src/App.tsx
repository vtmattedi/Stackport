import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { isAuthenticated } from "./api/client";
import Nav from "./components/Nav";
import Login from "./pages/Login";
import Logs from "./pages/Logs";
import Projects from "./pages/Projects";
import ProjectDetails from "./pages/ProjectDetails";
import Credentials from "./pages/Credentials";
import System from "./pages/System";
import Infrastructure from "./pages/Infrastructure";
import Settings from "./pages/Settings";
import Integrations from "./pages/Integrations";
import Metrics from "./pages/Metrics";
import Traffic from "./pages/Traffic";
import { Toaster } from "./components/ui/sonner";
import { ConfirmProvider } from "./components/ConfirmDialog";
import { GlobalRealtime } from "./components/GlobalRealtime";
import { SystemProvider } from "./context/SystemContext";

function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <SystemProvider>
      <div className="app-shell">
        <Nav />
        <GlobalRealtime />
        <div className="app-content">{children}</div>
      </div>
    </SystemProvider>
  );
}

function PrivateRoute({ children }: { children: React.ReactNode }) {
  return isAuthenticated() ? <AppShell>{children}</AppShell> : <Navigate to="/" replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <ConfirmProvider>
        <Routes>
          <Route path="/" element={<Login />} />
          <Route path="/logs" element={<PrivateRoute><Logs /></PrivateRoute>} />
          <Route path="/projects" element={<PrivateRoute><Projects /></PrivateRoute>} />
          <Route path="/projects/:id" element={<PrivateRoute><ProjectDetails /></PrivateRoute>} />
          <Route path="/credentials" element={<PrivateRoute><Credentials /></PrivateRoute>} />
          <Route path="/system" element={<PrivateRoute><System /></PrivateRoute>} />
          <Route path="/infrastructure" element={<PrivateRoute><Infrastructure /></PrivateRoute>} />
          <Route path="/vps" element={<Navigate to="/infrastructure" replace />} />
          <Route path="/hardware" element={<Navigate to="/infrastructure" replace />} />
          <Route path="/settings" element={<PrivateRoute><Settings /></PrivateRoute>} />
          <Route path="/integrations" element={<PrivateRoute><Integrations /></PrivateRoute>} />
          <Route path="/metrics" element={<PrivateRoute><Metrics /></PrivateRoute>} />
          <Route path="/traffic" element={<PrivateRoute><Traffic /></PrivateRoute>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <Toaster position="top-right" />
      </ConfirmProvider>
    </BrowserRouter>
  );
}
