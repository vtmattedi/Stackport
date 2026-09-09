import { Router } from "express";
import authRouter from "./auth";
import setupRouter from "./setup";
import logsRouter from "./logs";
import projectsRouter from "./projects";
import credentialsRouter from "./credentials";
import vpsRouter from "./vps";
import adminRouter from "./admin";
import systemRouter from "./system";
import notificationsRouter from "./notifications";
import githubPollerRouter from "./githubPoller";
import metricsRouter from "./metrics";
import hardwareRouter from "./hardware";

const router = Router();

router.use("/auth", authRouter);
router.use("/setup", setupRouter);
router.use("/logs", logsRouter);
router.use("/projects", projectsRouter);
router.use("/credentials", credentialsRouter);
router.use("/vps", vpsRouter);
router.use("/vpi", vpsRouter);
router.use("/admin", adminRouter);
router.use("/system", systemRouter);
router.use("/notifications", notificationsRouter);
router.use("/github-poller", githubPollerRouter);
router.use("/metrics", metricsRouter);
router.use("/hardware", hardwareRouter);

export default router;
