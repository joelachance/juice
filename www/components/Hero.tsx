import JuicePoster from "./JuicePoster";
import styles from "./Hero.module.css";

export default function Hero() {
  return (
    <section className={styles.hero}>
      <div className={styles.posterContainer}>
        <div className={styles.posterInner}>
          <JuicePoster />
        </div>
      </div>

      <div className={styles.content}>
        <div className={styles.textBlock}>
          <p className={styles.kicker}>
            <span className={styles.kickerMark} />
            Secrets management
          </p>
          <h1 className={styles.title}>Easiest way to manage secrets</h1>
          <p className={styles.subtitle}>
            Agent secrets without copy/paste. Local or remote, transparent
            encryption, scoped access.
          </p>
          <a
            className={styles.cta}
            href="https://github.com/satoricorp/juice#getting-started"
          >
            Get started for free
          </a>
        </div>
      </div>
    </section>
  );
}
