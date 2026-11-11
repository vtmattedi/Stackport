import { Router } from "express";
import authRouter from "../../modules/identity/routes/auth";
import setupRouter from "../../modules/identity/routes/setup";
import logsRouter from "../../modules/observability/routes/logs";
import projectsRouter from "./projects";
import credentialsRouter from "../../modules/credentials/routes";
import adminRouter from "../../modules/identity/routes/admin";
import systemRouter from "./system";
import notificationsRouter from "../../modules/notifications/routes";
import githubPollerRouter from "../../modules/automation/routes/polling";
import metricsRouter from "../../modules/observability/routes/metrics";
import hardwareRouter from "../../modules/observability/routes/hardware";
import apiTokensRouter from "../../modules/identity/routes/apiTokens";
import actionsRouter from "../../modules/actions/routes";
import githubAppRouter from "./githubApp";
import domainsRouter from "./domains";
import legacyMigrationsRouter from "../../modules/maintenance/migrations/routes"; // TEMPORARY, see modules/maintenance/migrations/types.ts

const router = Router();

router.use("/auth", authRouter);
router.use("/setup", setupRouter);
router.use("/logs", logsRouter);
router.use("/projects", projectsRouter);
router.use("/credentials", credentialsRouter);
router.use("/admin", adminRouter);
router.use("/system", systemRouter);
router.use("/notifications", notificationsRouter);
router.use("/github-poller", githubPollerRouter);
router.use("/metrics", metricsRouter);
router.use("/hardware", hardwareRouter);
router.use("/api-tokens", apiTokensRouter);
router.use("/actions", actionsRouter);
router.use("/github-app", githubAppRouter);
router.use("/domains", domainsRouter);
router.use("/legacy-migrations", legacyMigrationsRouter); // TEMPORARY

export default router;
