import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate, Outlet } from "react-router-dom";
import { Loader } from "lucide-react";
import { isAuthenticated } from "./api/client";
import Nav from "./components/Nav";
import Login from "./pages/Login";
import { Toaster } from "./components/ui/sonner";
import { ConfirmProvider } from "./components/ConfirmDialog";
import { GlobalRealtime } from "./components/GlobalRealtime";
import { SystemProvider } from "./context/SystemContext";

// Each page is its own chunk, so the login screen and first page don't download
// every other page (and their charting/terminal libraries) up front.
const Logs = lazy(() => import("./pages/Logs"));
const Projects = lazy(() => import("./pages/Projects"));
const ProjectDetails = lazy(() => import("./pages/ProjectDetails"));
const Credentials = lazy(() => import("./pages/Credentials"));
const System = lazy(() => import("./pages/System"));
const Infrastructure = lazy(() => import("./pages/Infrastructure"));
const Settings = lazy(() => import("./pages/Settings"));
const Integrations = lazy(() => import("./pages/Integrations"));
const Metrics = lazy(() => import("./pages/Metrics"));
const Traffic = lazy(() => import("./pages/Traffic"));

/** Shared shell for every signed-in page. Mounted once as a layout route, so
 *  navigating between pages keeps SystemProvider (and its live subscriptions and
 *  loaded data) alive instead of tearing it down and refetching everything. */
function PrivateLayout() {
  if (!isAuthenticated()) return <Navigate to="/" replace />;
  return (
    <SystemProvider>
      <div className="app-shell">
        <Nav />
        <GlobalRealtime />
        <div className="app-content">
          <Suspense
            fallback={(
              <main className="main">
                <div className="empty" style={{ padding: 48 }}><Loader size={22} className="spin" /></div>
              </main>
            )}
          >
            <Outlet />
          </Suspense>
        </div>
      </div>
    </SystemProvider>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ConfirmProvider>
        <Routes>
          <Route path="/" element={<Login />} />
          <Route element={<PrivateLayout />}>
            <Route path="/logs" element={<Logs />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/projects/:id" element={<ProjectDetails />} />
            <Route path="/credentials" element={<Credentials />} />
            <Route path="/system" element={<System />} />
            <Route path="/infrastructure" element={<Infrastructure />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/integrations" element={<Integrations />} />
            <Route path="/metrics" element={<Metrics />} />
            <Route path="/traffic" element={<Traffic />} />
          </Route>
          <Route path="/vps" element={<Navigate to="/infrastructure" replace />} />
          <Route path="/hardware" element={<Navigate to="/infrastructure" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <Toaster position="top-right" />
      </ConfirmProvider>
    </BrowserRouter>
  );
}
