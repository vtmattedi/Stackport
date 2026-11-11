import EnforcementSection from "./EnforcementSection";
import HardeningSection from "./HardeningSection";
import styles from "../Settings.module.scss";

/** The container defaults every protected project gets, and which projects still lack a protection. */
export default function ProtectionsSection() {
  return (
    <div className={styles.sectionStack}>
      <HardeningSection />
      <EnforcementSection />
    </div>
  );
}
