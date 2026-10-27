import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate, Outlet } from "react-router-dom";
import { Loader } from "lucide-react";
import { isAuthenticated } from "./api/client";
import Nav from "./components/Nav";
import Login from "./pages/Login";
import { Toaster } from "./components/ui/sonner";
import { ConfirmProvider } from "./components/ConfirmDialog";
import { GlobalRealtime } from "./components/GlobalRealtime";
import { GlobalActionToasts } from "./components/GlobalActionToasts";
import { SystemProvider } from "./context/SystemContext";

// Each page is its own chunk, so the login screen and first page don't download
// every other page (and their charting/terminal libraries) up front.
const Logs = lazy(() => import("./pages/Logs"));
const Projects = lazy(() => import("./pages/Projects"));
const ProjectDetails = lazy(() => import("./pages/ProjectDetails"));
const Credentials = lazy(() => import("./pages/Credentials"));
const System = lazy(() => import("./pages/System"));
const Infrastructure = lazy(() => import("./pages/Infrastructure"));
const SettingsLayout = lazy(() => import("./pages/settings/SettingsLayout"));
const GeneralSection = lazy(() => import("./pages/settings/GeneralSection"));
const DeployTriggersSection = lazy(() => import("./pages/settings/DeployTriggersSection"));
const NotificationsSection = lazy(() => import("./pages/settings/NotificationsSection"));
const MaintenanceSection = lazy(() => import("./pages/settings/MaintenanceSection"));
const McpSection = lazy(() => import("./pages/settings/McpSection"));
const InsightsLayout = lazy(() => import("./pages/insights/InsightsLayout"));
const InsightsOverview = lazy(() => import("./pages/insights/OverviewSection"));
const InsightsResources = lazy(() => import("./pages/insights/ResourcesSection"));
const InsightsTraffic = lazy(() => import("./pages/insights/TrafficSection"));
const InsightsRequests = lazy(() => import("./pages/insights/RequestsSection"));
const InsightsAnomalies = lazy(() => import("./pages/insights/AnomaliesSection"));

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
        <GlobalActionToasts />
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
            <Route path="/projects/:id/:tab?" element={<ProjectDetails />} />
            <Route path="/credentials" element={<Credentials />} />
            <Route path="/system/:section?" element={<System />} />
            <Route path="/infrastructure/:section?" element={<Infrastructure />} />
            <Route path="/settings" element={<SettingsLayout />}>
              <Route index element={<Navigate to="general" replace />} />
              <Route path="general" element={<GeneralSection />} />
              <Route path="deploy-triggers" element={<DeployTriggersSection />} />
              <Route path="infrastructure" element={<Navigate to="/settings/general" replace />} />
              <Route path="notifications" element={<NotificationsSection />} />
              <Route path="mcp" element={<McpSection />} />
              <Route path="maintenance" element={<MaintenanceSection />} />
              <Route path="*" element={<Navigate to="general" replace />} />
            </Route>
            <Route path="/insights" element={<InsightsLayout />}>
              <Route index element={<Navigate to="overview" replace />} />
              <Route path="overview" element={<InsightsOverview />} />
              <Route path="resources" element={<InsightsResources />} />
              <Route path="traffic" element={<InsightsTraffic />} />
              <Route path="requests" element={<InsightsRequests />} />
              <Route path="anomalies" element={<InsightsAnomalies />} />
              <Route path="*" element={<Navigate to="overview" replace />} />
            </Route>
            <Route path="/metrics" element={<Navigate to="/insights/overview" replace />} />
            <Route path="/traffic" element={<Navigate to="/insights/traffic" replace />} />
          </Route>
          <Route path="/integrations" element={<Navigate to="/settings/general" replace />} />
          <Route path="/vps" element={<Navigate to="/infrastructure/host" replace />} />
          <Route path="/hardware" element={<Navigate to="/infrastructure/host" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <Toaster position="top-right" />
      </ConfirmProvider>
    </BrowserRouter>
  );
}
