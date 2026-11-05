import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import { clampHours, getHardwareSnapshot } from "../services/hardwareSnapshot";
export { getHardwareSnapshot } from "../services/hardwareSnapshot";

const router = Router();
router.use(requireAuth);
router.get("/", async (req: Request, res: Response): Promise<void> => {
  res.json(await getHardwareSnapshot(clampHours(req.query.hours)));
});
export default router;
