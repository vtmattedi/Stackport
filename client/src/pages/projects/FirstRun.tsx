import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle, Circle, Plus } from "lucide-react";
import { api } from "../../api/client";
import { Button } from "../../components/ui/button";
import { Stack } from "../../components/ui/stack";
import { Hint, Prose } from "../../components/ui/text";

interface Readiness { domain: boolean; github: boolean }

/** What an empty Projects page says instead of "No projects yet": the few things that make the first project go smoothly, each with
 *  whether it is already done. Only the base domain is needed; the GitHub App is the easy way to pick a repository. */
export function FirstRun({ onAdd }: { onAdd: () => void }) {
  const [ready, setReady] = useState<Readiness | null>(null);

  useEffect(() => {
    let live = true;
    Promise.allSettled([api.getManagedDomains(), api.getGithubSettings()]).then(([domains, github]) => {
      if (!live) return;
      setReady({
        domain: domains.status === "fulfilled" && domains.value.domains.length > 0,
        github: github.status === "fulfilled" && !!github.value.app && github.value.installations.some((installation) => installation.status === "linked"),
      });
    });
    return () => { live = false; };
  }, []);

  const steps = [
    {
      done: ready?.domain ?? false,
      title: "Add a base domain",
      text: <>A project is routed to a base domain you point at this server, or a subdomain of one. <Link className="ext-link" to="/settings/domains">Settings &gt; Domains</Link></>,
      needed: true,
    },
    {
      done: ready?.github ?? false,
      title: "Connect GitHub",
      text: <>Lets you pick a repository from a list, with short-lived tokens. You can skip it and use a token or upload files. <Link className="ext-link" to="/settings/github">Settings &gt; GitHub</Link></>,
      needed: false,
    },
  ];

  return (
    <Stack gap={4} className="mx-auto max-w-xl py-6">
      <Stack gap={1}>
        <h2 className="text-base font-semibold">Deploy your first project</h2>
        <Prose className="text-[var(--dim)]">Stackport runs Docker Compose projects from a GitHub repository or from files you upload.</Prose>
      </Stack>
      <ol className="grid gap-3">
        {steps.map((step) => (
          <li key={step.title} className="flex items-start gap-3">
            <span className={step.done ? "mt-0.5 text-[var(--success)]" : "mt-0.5 text-[var(--dim)]"}>{step.done ? <CheckCircle size={16} /> : <Circle size={16} />}</span>
            <div className="grid gap-0.5">
              <span className="text-[13px] font-medium">{step.title}{!step.needed && <span className="ml-2 text-xs font-normal text-[var(--dim)]">optional</span>}</span>
              <Hint>{step.text}</Hint>
            </div>
          </li>
        ))}
      </ol>
      <div>
        <Button type="button" onClick={onAdd}><Plus size={14} />Add your first project</Button>
      </div>
    </Stack>
  );
}
