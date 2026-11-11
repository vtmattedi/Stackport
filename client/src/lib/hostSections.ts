import { Box, Gauge, Layers, Network, ShieldCheck } from "lucide-react";

/** The pages under /host, in the order they are listed. One list for the Host page, the nav's hover menu and the command palette. */
export const HOST_SECTIONS = [
  { tab: "hardware", label: "Hardware", icon: Gauge },
  { tab: "docker", label: "Docker", icon: Box },
  { tab: "networks", label: "Networks", icon: Network },
  { tab: "nginx", label: "Nginx", icon: Layers },
  { tab: "certbot", label: "Certbot", icon: ShieldCheck },
] as const;

export type HostTab = (typeof HOST_SECTIONS)[number]["tab"];

export function isHostTab(value: string): value is HostTab {
  return HOST_SECTIONS.some((section) => section.tab === value);
}
