import { X } from "lucide-react";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import styles from "../System.module.scss";

/** Command output (stdout and stderr) in a dismissible block; red when the command failed. */
export function OutputBlock({ output, ok, onDismiss }: { output: string; ok: boolean; onDismiss: () => void }) {
  return (
    <div className={styles.outputShell}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className={styles.outputDismiss}
        onClick={onDismiss}
        title="Dismiss"
      >
        <X size={12} />
      </Button>
      <pre className={cn("output-block", styles.outputBlock, !ok && "output-stderr")}>
        {output || "(no output)"}
      </pre>
    </div>
  );
}
