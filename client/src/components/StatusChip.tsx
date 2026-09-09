import { CheckCircle, XCircle } from "lucide-react";
import { Badge } from "./ui/badge";
import { cn } from "../lib/utils";
import styles from "./StatusChip.module.scss";

export function StatusChip({ ok, labels }: { ok: boolean; labels: [string, string] }) {
  return (
    <Badge variant="outline" className={cn(styles.statusChip, ok ? styles.statusOk : styles.statusFail)}>
      {ok ? <CheckCircle size={10} /> : <XCircle size={10} />}
      {ok ? labels[0] : labels[1]}
    </Badge>
  );
}
