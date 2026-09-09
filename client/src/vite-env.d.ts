/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare module "*.module.scss" {
  const classes: Record<string, string>;
  export default classes;
}
