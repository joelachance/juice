(() => {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  document.querySelectorAll("[data-echo]").forEach((el) => {
    if (reducedMotion) return;

    el.addEventListener("pointermove", (event) => {
      const rect = el.getBoundingClientRect();
      const nx = (event.clientX - rect.left - rect.width / 2) / (rect.width / 2 || 1);
      const ny = (event.clientY - rect.top - rect.height / 2) / (rect.height / 2 || 1);
      el.style.setProperty("--echo-x", String(-nx));
      el.style.setProperty("--echo-y", String(-ny));
    });

    el.addEventListener("pointerleave", () => {
      el.style.removeProperty("--echo-x");
      el.style.removeProperty("--echo-y");
    });
  });

  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const text = btn.getAttribute("data-copy") || "";
      try {
        await navigator.clipboard.writeText(text);
        btn.dataset.copied = "true";
        const label = btn.textContent;
        btn.textContent = "Copied";
        setTimeout(() => {
          btn.dataset.copied = "false";
          btn.textContent = label;
        }, 1400);
      } catch {
        /* progressive enhancement — copy may fail on file:// */
      }
    });
  });
})();
