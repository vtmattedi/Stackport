const BRANCH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

/** Guards against git argument/flag injection — branch names flow into `git` argv as literal args. */
export function isValidBranchName(value: string): boolean {
  return BRANCH_NAME_RE.test(value)
    && !value.includes("..")
    && !value.includes("//")
    && !value.endsWith("/")
    && !value.endsWith(".lock");
}
