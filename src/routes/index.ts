import { Router } from "express";
import authRouter from "./auth";
import setupRouter from "./setup";
import logsRouter from "./logs";
import projectsRouter from "./projects";
import credentialsRouter from "./credentials";
import adminRouter from "./admin";
import systemRouter from "./system";
import notificationsRouter from "./notifications";
import githubPollerRouter from "./githubPoller";
import metricsRouter from "./metrics";
import hardwareRouter from "./hardware";
import apiTokensRouter from "./apiTokens";
import actionsRouter from "./actions";
import legacyMigrationsRouter from "../legacyMigrations/routes"; // TEMPORARY, see legacyMigrations/types.ts

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
router.use("/legacy-migrations", legacyMigrationsRouter); // TEMPORARY

export default router;
