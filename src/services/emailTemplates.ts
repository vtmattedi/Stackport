type EmailTone = "danger" | "info" | "success";

interface EmailDetail {
  label: string;
  value: string;
  mono?: boolean;
}

interface EmailSection {
  title: string;
  body: string;
}

interface EmailAction {
  label: string;
  href: string;
}

interface StackPortEmailParams {
  previewText: string;
  eyebrow: string;
  title: string;
  intro: string;
  tone: EmailTone;
  statusLabel: string;
  details?: EmailDetail[];
  sections?: EmailSection[];
  action?: EmailAction;
  footerNote?: string;
}

interface HealthCheckFailureEmailParams {
  projectName: string;
  url: string;
  responseMs: number | null;
  occurredAt: Date;
}

interface DeployBlockedEmailParams {
  projectName: string;
  reason: string;
  occurredAt: Date;
}

interface ToneStyles {
  accent: string;
  accentDark: string;
  surface: string;
  border: string;
  text: string;
}

const BRAND = {
  indigo: "#6366f1",
  ink: "#0f172a",
  muted: "#64748b",
  panel: "#ffffff",
  page: "#eef2f7",
  line: "#dbe4f0",
};

const STACKPORT_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="100 55 305 305"><path fill="#6366f1" fill-rule="evenodd" d="M 272.07 252.59 C260.83,259.96 251.34,266.00 250.99,266.00 C250.28,266.00 224.30,250.39 185.50,226.65 C180.55,223.62 170.76,217.68 163.75,213.45 C156.74,209.22 151.00,205.60 151.00,205.41 C151.00,205.23 154.94,202.44 159.75,199.22 C164.56,196.00 187.06,180.89 209.75,165.64 L 251.00 137.91 L 251.00 160.75 L 233.75 172.18 C224.26,178.47 210.09,187.85 202.25,193.03 C194.41,198.21 188.02,202.91 188.04,203.47 C188.06,204.04 190.42,205.88 193.29,207.57 C196.15,209.26 203.45,213.71 209.50,217.47 C249.71,242.45 250.30,242.77 253.11,241.07 C254.54,240.21 269.28,230.54 285.86,219.60 L 316.00 199.69 L 316.00 121.24 L 313.24,120.10 C308.68,118.21 303.07,112.36 300.47,106.77 C294.51,93.96 299.40,78.54 311.71,71.33 C318.30,67.46 329.50,66.87 336.77,70.00 C342.64,72.52 349.13,78.99 351.51,84.68 C353.60,89.67 353.68,100.44 351.67,105.25 C349.29,110.94 345.16,115.82 340.34,118.64 L 336.00 121.19 L 336.00 210.87 L 327.25 216.54 C314.36,224.89 295.13,237.44 272.07,252.59 Z M 288.69 320.77 C268.45,334.15 251.35,345.26 250.69,345.45 C249.42,345.81 246.75,344.27 210.00,322.01 C197.07,314.18 178.29,302.83 168.25,296.79 L 150.00 285.81 L 150.00 275.47 C150.00,269.77 150.42,264.86 150.93,264.54 C151.44,264.23 157.85,267.65 165.18,272.14 C172.51,276.63 185.25,284.45 193.50,289.50 C201.75,294.56 213.23,301.61 219.00,305.18 C242.11,319.47 250.18,324.01 251.32,323.34 C251.97,322.96 271.05,310.35 293.72,295.32 C316.40,280.29 335.18,268.00 335.47,268.00 C335.76,268.00 336.00,272.90 336.00,278.90 L 336.00 289.79 L 330.75,293.11 C327.86,294.94 308.94,307.38 288.69,320.77 Z M 279.03 288.82 C264.47,298.44 251.87,306.46 251.03,306.65 C250.19,306.84 244.10,303.66 237.50,299.57 C230.90,295.49 224.38,291.51 223.00,290.73 C217.87,287.81 174.23,261.16 167.40,256.77 C163.50,254.26 158.87,251.46 157.10,250.55 C150.59,247.19 150.00,245.93 150.00,235.56 C150.00,230.37 150.35,225.90 150.78,225.64 C151.20,225.37 154.24,226.77 157.53,228.73 C165.12,233.28 193.38,250.59 198.00,253.52 C203.98,257.33 242.28,280.59 246.62,283.05 L 250.74 285.39 L 292.12 257.88 C314.88,242.75 334.06,230.04 334.75,229.63 C335.72,229.05 336.00,231.41 335.99,240.19 L 335.99 251.50 L 332.74,253.64 C330.96,254.82 324.10,259.29 317.50,263.56 C310.90,267.84 293.59,279.21 279.03,288.82 Z M 322.21 108.03 C329.34,109.74 334.80,107.10 338.06,100.38 C340.54,95.25 340.16,90.75 336.89,86.58 C328.75,76.24 312.02,81.43 312.00,94.30 C312.00,100.98 316.16,106.57 322.21,108.03 Z"/></svg>`;
const STACKPORT_LOGO_SRC = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(STACKPORT_LOGO_SVG)}`;

function toneStyles(tone: EmailTone): ToneStyles {
  switch (tone) {
    case "danger":
      return {
        accent: "#ef4444",
        accentDark: "#b91c1c",
        surface: "#fff1f2",
        border: "#fecdd3",
        text: "#991b1b",
      };
    case "success":
      return {
        accent: "#10b981",
        accentDark: "#047857",
        surface: "#ecfdf5",
        border: "#a7f3d0",
        text: "#065f46",
      };
    case "info":
      return {
        accent: "#0ea5e9",
        accentDark: "#0369a1",
        surface: "#eff6ff",
        border: "#bfdbfe",
        text: "#075985",
      };
  }
}

function escapeHtml(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function formatUtc(date: Date): string {
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function safeHttpHref(value: string): string | null {
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

function renderBrandHeader(): string {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr>
        <td style="padding:0 0 18px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
            <tr>
              <td width="48" height="48" style="background:#ffffff;border:1px solid ${BRAND.line};border-radius:14px;text-align:center;vertical-align:middle;">
                <img src="${escapeHtml(STACKPORT_LOGO_SRC)}" width="38" height="38" alt="" style="display:block;margin:5px auto;border:0;outline:none;text-decoration:none;" />
              </td>
              <td style="padding-left:13px;vertical-align:middle;">
                <div style="font-family:Arial,Helvetica,sans-serif;font-size:22px;line-height:24px;font-weight:800;letter-spacing:0;">
                  <span style="color:${BRAND.indigo};">STACK</span><span style="color:${BRAND.ink};">PORT</span>
                </div>
                <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:${BRAND.muted};font-weight:700;letter-spacing:0;text-transform:uppercase;">
                  MW VPS Manager
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>`;
}

function renderDetails(details: EmailDetail[]): string {
  if (details.length === 0) return "";

  const rows = details.map((detail) => {
    const valueStyle = detail.mono
      ? "font-family:'SFMono-Regular',Consolas,'Liberation Mono',monospace;font-size:13px;word-break:break-word;"
      : "font-family:Arial,Helvetica,sans-serif;font-size:14px;";
    return `
      <tr>
        <td style="padding:14px 0;border-top:1px solid ${BRAND.line};font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:${BRAND.muted};font-weight:700;text-transform:uppercase;letter-spacing:0;vertical-align:top;width:145px;">
          ${escapeHtml(detail.label)}
        </td>
        <td style="padding:14px 0;border-top:1px solid ${BRAND.line};${valueStyle}line-height:20px;color:${BRAND.ink};vertical-align:top;">
          ${escapeHtml(detail.value)}
        </td>
      </tr>`;
  }).join("");

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:26px;">
      ${rows}
    </table>`;
}

function renderSections(sections: EmailSection[]): string {
  if (sections.length === 0) return "";

  return sections.map((section) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:18px;background:#f8fafc;border:1px solid ${BRAND.line};border-radius:16px;">
      <tr>
        <td style="padding:18px 20px;">
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;font-weight:800;color:${BRAND.ink};">
            ${escapeHtml(section.title)}
          </div>
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#475569;margin-top:7px;">
            ${escapeHtml(section.body)}
          </div>
        </td>
      </tr>
    </table>`).join("");
}

function renderAction(action: EmailAction | undefined, styles: ToneStyles): string {
  if (!action) return "";

  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:30px;">
      <tr>
        <td style="border-radius:12px;background:${styles.accent};">
          <a href="${escapeHtml(action.href)}" style="display:inline-block;padding:13px 18px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:18px;font-weight:800;color:#ffffff;text-decoration:none;border-radius:12px;">
            ${escapeHtml(action.label)}
          </a>
        </td>
      </tr>
    </table>`;
}

function renderStackPortEmail(params: StackPortEmailParams): string {
  const styles = toneStyles(params.tone);
  const details = renderDetails(params.details ?? []);
  const sections = renderSections(params.sections ?? []);
  const action = renderAction(params.action, styles);
  const footerNote = params.footerNote
    ? `<div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#94a3b8;margin-top:10px;">${escapeHtml(params.footerNote)}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(params.title)}</title>
  </head>
  <body style="margin:0;padding:0;background:${BRAND.page};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
      ${escapeHtml(params.previewText)}
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:${BRAND.page};">
      <tr>
        <td align="center" style="padding:34px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;max-width:640px;">
            <tr>
              <td>
                ${renderBrandHeader()}
              </td>
            </tr>
            <tr>
              <td style="background:${BRAND.panel};border:1px solid ${BRAND.line};border-radius:24px;overflow:hidden;box-shadow:0 20px 48px rgba(15,23,42,0.10);">
                <div style="height:7px;background:${BRAND.indigo};background-image:linear-gradient(90deg,${BRAND.indigo},${styles.accent});font-size:0;line-height:0;">&nbsp;</div>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                  <tr>
                    <td style="padding:38px 40px 34px 40px;">
                      <div style="display:inline-block;padding:7px 11px;background:${styles.surface};border:1px solid ${styles.border};border-radius:999px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:16px;color:${styles.text};font-weight:800;">
                        ${escapeHtml(params.statusLabel)}
                      </div>
                      <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:18px;color:${styles.accentDark};font-weight:800;letter-spacing:0;text-transform:uppercase;margin-top:22px;">
                        ${escapeHtml(params.eyebrow)}
                      </div>
                      <h1 style="margin:8px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:30px;line-height:37px;color:${BRAND.ink};font-weight:800;letter-spacing:0;">
                        ${escapeHtml(params.title)}
                      </h1>
                      <p style="margin:14px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:25px;color:#475569;">
                        ${escapeHtml(params.intro)}
                      </p>
                      ${details}
                      ${sections}
                      ${action}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:20px 24px 0 24px;">
                <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#94a3b8;">
                  Sent by StackPort notification automation.
                </div>
                ${footerNote}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function renderTestNotificationEmail(occurredAt = new Date()): string {
  return renderStackPortEmail({
    previewText: "Your StackPort email notification setup is working correctly.",
    eyebrow: "Notification test",
    title: "Email notifications are ready",
    intro: "StackPort successfully delivered this test message. Future health check alerts will use this same branded notification channel.",
    tone: "success",
    statusLabel: "Configuration verified",
    details: [
      { label: "Status", value: "Working" },
      { label: "Checked at", value: formatUtc(occurredAt), mono: true },
    ],
    sections: [
      {
        title: "What this confirms",
        body: "The selected provider, API key credential, sender address, and recipient address can send mail from this StackPort instance.",
      },
    ],
  });
}

export function renderHealthCheckFailureEmail({
  projectName,
  url,
  responseMs,
  occurredAt,
}: HealthCheckFailureEmailParams): string {
  const href = safeHttpHref(url);
  return renderStackPortEmail({
    previewText: `${projectName} health check failed in StackPort.`,
    eyebrow: "Health monitor",
    title: "A project health check failed",
    intro: "StackPort could not confirm a healthy response for one of your monitored projects. Review the endpoint and recent deploy activity when you have a moment.",
    tone: "danger",
    statusLabel: "Attention needed",
    details: [
      { label: "Project", value: projectName },
      { label: "Checked URL", value: url, mono: true },
      {
        label: "Response",
        value: responseMs != null ? `${responseMs}ms` : "No response received (timeout or connection error)",
      },
      { label: "Detected at", value: formatUtc(occurredAt), mono: true },
    ],
    sections: [
      {
        title: "Suggested next checks",
        body: "Confirm the service is running, inspect recent deployment logs, and verify that DNS, firewall, and reverse proxy rules still point to the expected target.",
      },
    ],
    action: href ? { label: "Open checked URL", href } : undefined,
    footerNote: "This alert is generated only when notification delivery is enabled in StackPort settings.",
  });
}

export function renderDeployBlockedEmail({
  projectName,
  reason,
  occurredAt,
}: DeployBlockedEmailParams): string {
  return renderStackPortEmail({
    previewText: `${projectName} automatic deploy was blocked in StackPort.`,
    eyebrow: "Auto-deploy",
    title: "An automatic deploy was blocked",
    intro: "StackPort pulled a new commit for one of your projects but could not continue the deploy. The project has been left on its last known-good state.",
    tone: "danger",
    statusLabel: "Attention needed",
    details: [
      { label: "Project", value: projectName },
      { label: "Reason", value: reason },
      { label: "Detected at", value: formatUtc(occurredAt), mono: true },
    ],
    sections: [
      {
        title: "Suggested next checks",
        body: "Open the project in StackPort, confirm the expected docker-compose file still exists in the repository, and re-run the deploy manually once it's resolved.",
      },
    ],
    footerNote: "This alert is generated only when notification delivery is enabled in StackPort settings.",
  });
}
