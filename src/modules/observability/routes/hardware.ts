import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../identity/middleware/session";
import { clampHours, getHardwareSnapshot } from "../snapshots/hardware";
export { getHardwareSnapshot } from "../snapshots/hardware";

const router = Router();
router.use(requireAuth);
router.get("/", async (req: Request, res: Response): Promise<void> => {
  res.json(await getHardwareSnapshot(clampHours(req.query.hours)));
});
export default router;
