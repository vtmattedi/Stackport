import { StackPortAnimatedLogo } from "./StackPortAnimatedLogo";
import { StackPortWordmark } from "./StackPortBrand";

export function Header() {
  return (
    <div className="flex items-center gap-3">
      <StackPortAnimatedLogo size={56} />
      <span className="text-xl">
        <StackPortWordmark />
      </span>
    </div>
  );
}
